/**
 * On-demand transaction and block lookups for anything outside the live index
 * (older than the retention window, or never followed). The node supplies the
 * data, the shared classifier (packages/worker/src/live) runs the same
 * bucket + SDK logic the follower runs, and the answer takes the same shape
 * the modals already read. Results stay in memory only: the window tables and
 * the rankings must contain the followed blocks alone.
 */
import {
  displayTextOf,
  getContract,
  getContracts,
  serializeDisplay,
  upsertContracts,
  upsertSignatures,
  STANDARD_TOKEN_SELECTORS,
  type BlockDetail,
  type BlockStat,
  type Db,
  type LiveTxDetailOut,
  type LiveTxIn,
  type LiveTxOut,
} from "@ccd/db";
import type { Rpc, RpcTx } from "@ccd/rpc";
import { checkContract, createLiveClassifier, loadCoverageLookup, lookupSignatures, type LiveClassifier } from "@ccd/worker/live";

export type OnDemandTx = LiveTxDetailOut & { onDemand: true };
export type OnDemandBlock = BlockDetail & { onDemand: true };

interface RpcRawTx {
  hash: string;
  from: string;
  to: string | null;
  input: string;
  value: string;
  blockNumber: string | null;
  blockHash: string | null;
  transactionIndex: string | null;
}
interface RpcHeader {
  number: string;
  hash: string;
  timestamp: string;
}

/** Small insertion-ordered LRU: the oldest entry goes when the cap is reached. */
class Lru<V> {
  private m = new Map<string, V>();
  constructor(private max: number) {}
  get(k: string): V | undefined {
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }
  set(k: string, v: V): void {
    if (this.m.has(k)) this.m.delete(k);
    else if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value as string);
    this.m.set(k, v);
  }
}

export function createOnDemand(opts: { db: Db; rpc: Rpc; chainId: number; registryPath: string; log: (msg: string) => void }) {
  const { db, rpc, chainId, registryPath, log } = opts;
  let classifier: LiveClassifier | null = null;
  // Built on first use: the registry load takes a moment and most API
  // processes never need it.
  function getClassifier(): LiveClassifier {
    if (classifier) return classifier;
    const t0 = Date.now();
    const cov = loadCoverageLookup({ registryPath, chainIds: [chainId] });
    classifier = createLiveClassifier({ db, rpc, chainId, registryPath, cov });
    log(`on-demand classifier ready: coverage ${cov.rowCount} rows in ${Date.now() - t0} ms`);
    return classifier;
  }

  const txCache = new Lru<OnDemandTx>(500);
  const blockCache = new Lru<OnDemandBlock>(50);
  const inflight = new Map<string, Promise<unknown>>();
  function once<T>(key: string, run: () => Promise<T>): Promise<T> {
    const hit = inflight.get(key) as Promise<T> | undefined;
    if (hit) return hit;
    const p = run().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  // ---- enrichment shared by both paths --------------------------------------

  const sigSelect = db.prepare("SELECT selector, name FROM signatures WHERE selector IN (SELECT value FROM json_each(?))");
  /** selector -> canonical signature from the cache, then 4byte for the rest (stored for next time) */
  async function signaturesFor(selectors: Set<string>): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    const wanted = [...selectors].filter((s) => s !== "0x" && /^0x[0-9a-f]{8}$/.test(s));
    if (wanted.length === 0) return out;
    for (const r of sigSelect.all(JSON.stringify(wanted)) as { selector: string; name: string | null }[]) out.set(r.selector, r.name);
    const missing = wanted.filter((s) => !out.has(s));
    if (missing.length > 0) {
      try {
        const rows = await lookupSignatures(missing.slice(0, 100));
        upsertSignatures(db, rows);
        for (const r of rows) out.set(r.selector, r.name);
      } catch (e) {
        log(`on-demand: 4byte lookup failed: ${(e as Error).message}`);
      }
    }
    return out;
  }

  /** Sourcify verification: the cache first; one live check for a single unknown address */
  async function verificationFor(address: string | null, live: boolean): Promise<{ verified: boolean | null; name: string | null }> {
    if (!address) return { verified: null, name: null };
    const row = getContract(db, chainId, address);
    if (row) return { verified: row.verified, name: row.name };
    if (!live) return { verified: null, name: null };
    const c = await checkContract(chainId, address);
    if (c.kind === "skip") return { verified: null, name: null };
    const now = new Date();
    if (c.kind === "verified") {
      upsertContracts(db, [{ chainId, address, verified: true, match: c.match, name: c.name, verifiedAtIso: c.verifiedAtIso }], now);
      return { verified: true, name: c.name };
    }
    upsertContracts(db, [{ chainId, address, verified: false, match: null, name: null, verifiedAtIso: null }], now);
    return { verified: false, name: null };
  }

  function toOut(
    row: LiveTxIn,
    block: { number: number; timeIso: string },
    names: Map<string, string | null>,
    ver: { verified: boolean | null; name: string | null },
  ): LiveTxOut {
    const hit = getClassifier().covered(row.toAddress, row.selector);
    const displayJson = serializeDisplay(row.display);
    return {
      hash: row.hash.toLowerCase(),
      blockNumber: block.number,
      blockTimeIso: block.timeIso,
      toAddress: row.toAddress,
      selector: row.selector,
      bucket: row.bucket,
      status: row.status ?? null,
      warnings: row.warnings ?? [],
      intent: row.intent ?? null,
      displayText: displayTextOf(displayJson, row.intent ?? null),
      entity: hit?.entity ?? null,
      functionSig: hit?.functionSig ?? names.get(row.selector) ?? null,
      descriptorPath: hit?.descriptorPath ?? null,
      verified: ver.verified,
      sourcifyName: ver.name,
    };
  }

  // ---- transaction ------------------------------------------------------------

  async function tx(hashIn: string): Promise<OnDemandTx | null> {
    const hash = hashIn.toLowerCase();
    const hit = txCache.get(hash);
    if (hit) return hit;
    return once(`tx:${hash}`, async () => {
      const raw = await rpc.call<RpcRawTx | null>("eth_getTransactionByHash", [hash], { timeoutMs: 8000 });
      // Pending transactions have no block yet: nothing to classify against.
      if (!raw || !raw.blockNumber) return null;
      const header = await rpc.call<RpcHeader | null>("eth_getBlockByNumber", [raw.blockNumber, false], { timeoutMs: 8000 });
      if (!header) return null;
      const block = { number: Number(raw.blockNumber), timeIso: new Date(Number(header.timestamp) * 1000).toISOString() };
      const t0 = Date.now();
      const row = await getClassifier().classify({
        hash: raw.hash,
        from: raw.from,
        to: raw.to,
        input: raw.input,
        value: raw.value,
        transactionIndex: raw.transactionIndex ?? "0x0",
      });
      const [names, ver] = await Promise.all([signaturesFor(new Set([row.selector])), verificationFor(row.toAddress, true)]);
      const out: OnDemandTx = {
        ...toOut(row, block, names, ver),
        blockHash: header.hash ?? raw.blockHash,
        display: row.display === undefined ? null : JSON.parse(serializeDisplay(row.display) ?? "null"),
        onDemand: true,
      };
      log(`on-demand tx ${hash.slice(0, 10)} (block ${block.number}, ${row.bucket}) in ${Date.now() - t0} ms`);
      txCache.set(hash, out);
      return out;
    });
  }

  // ---- block ----------------------------------------------------------------------

  async function block(number: number): Promise<OnDemandBlock | null> {
    const key = String(number);
    const hit = blockCache.get(key);
    if (hit) return hit;
    return once(`block:${key}`, async () => {
      const b = await rpc.blockWithTxs(number);
      if (!b) return null;
      const t0 = Date.now();
      const timeIso = new Date(Number(b.timestamp) * 1000).toISOString();
      const cls = getClassifier();
      const rows: LiveTxIn[] = [];
      for (const t of b.transactions as RpcTx[]) rows.push(await cls.classify(t));

      const selectors = new Set(rows.map((r) => r.selector));
      const addresses = [...new Set(rows.map((r) => r.toAddress).filter((a): a is string => a !== null))];
      // Verification from the cache only: a block can touch hundreds of
      // contracts, and the "unverified" split is a lower bound in the live
      // index too.
      const [names, known] = await Promise.all([signaturesFor(selectors), Promise.resolve(getContracts(db, chainId, addresses))]);

      const stat: BlockStat = { number, timeIso, total: rows.length, eth: 0, tokenStd: 0, coveredOther: 0, notCovered: 0, notCoveredUnverified: 0, creation: 0 };
      const txs: LiveTxOut[] = [];
      for (const r of rows) {
        const std = STANDARD_TOKEN_SELECTORS.has(r.selector);
        if (r.bucket === "eth_transfer") stat.eth++;
        if (std) stat.tokenStd++;
        if (r.bucket === "covered_theory" && !std) stat.coveredOther++;
        if (r.bucket === "contract_creation") stat.creation++;
        const k = r.toAddress ? known.get(r.toAddress) : undefined;
        if (r.bucket === "not_covered") {
          stat.notCovered++;
          if (k && !k.verified) stat.notCoveredUnverified++;
        }
        txs.push(toOut(r, { number, timeIso }, names, { verified: k ? k.verified : null, name: k?.name ?? null }));
      }
      const out: OnDemandBlock = {
        block: { number, hash: b.hash, timeIso, txCount: rows.length, processedAtIso: new Date().toISOString() },
        stat,
        txs,
        onDemand: true,
      };
      log(`on-demand block ${number} (${rows.length} txs, ${stat.coveredOther} covered) in ${Date.now() - t0} ms`);
      blockCache.set(key, out);
      return out;
    });
  }

  return { tx, block };
}
