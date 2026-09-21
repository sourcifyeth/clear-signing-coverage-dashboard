#!/usr/bin/env tsx
/**
 * Live block follower.
 *
 * Polls the chain head over JSON-RPC, fetches every new block with its
 * transactions, classifies each transaction into a bucket against the registry
 * coverage set, runs the Sourcify clear-signing library on every covered
 * transaction (pass / partial / failed + warning codes), and writes one SQLite
 * transaction per block: a `blocks` row, one `tx_index` row per transaction
 * (hash + labels + the library's result for covered ones — never calldata,
 * value or sender), and per-block `block_groups` aggregates that the
 * rolling-window stats sum over.
 *
 * Reorgs: each new block's parentHash is checked against the stored hash of
 * block n-1. On mismatch the follower walks back (up to REORG_DEPTH blocks)
 * until the stored hash matches the chain, deletes everything after that
 * point, and reprocesses.
 *
 * Env:
 *   RPC_URL          JSON-RPC endpoint. If unset and DRPC_API_KEY is set, DRPC
 *                    is used; otherwise a public endpoint. Never logged.
 *   DB_PATH          SQLite file (default <repo>/out/coverage.sqlite)
 *   REGISTRY_PATH    local registry checkout (descriptors + index files)
 *   POLL_MS          head poll interval, default 4000
 *   START_BLOCK      first block to process (default: current head)
 *   RETENTION_DAYS   prune live rows older than this, default 7
 *   CONTRACTS_SYNC   "0" turns off the background Sourcify verification sync
 *   CONTRACTS_BATCH  addresses checked per 30 s round, default 100
 *   CONTRACTS_RATE   Sourcify requests per second, default 4
 *
 * Usage: npm run follow
 */

import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { format } from "@ethereum-sourcify/clear-signing";
import { createFilesystemResolver } from "@ethereum-sourcify/clear-signing/filesystem";
import type { DisplayModel, ExternalDataProvider } from "@ethereum-sourcify/clear-signing";
import {
  openDb,
  defaultDbPath,
  insertCoverage,
  insertBlock,
  deleteBlocksFrom,
  pruneLive,
  rebuildWindowsAndRankings,
  pruneContracts,
  blockHash,
  latestBlock,
  type Bucket,
  type PracticalStatus,
  type LiveTxIn,
  type BlockGroupIn,
} from "@ccd/db";
import { loadCoverageLookup, type CoverageLookup } from "../coverage/loadCoverageSet.js";
import { loadRegistryIndex } from "../coverage/registryIndex.js";
import { bucketFor } from "../classify.js";
import { classifyModel, intentToString } from "../practical.js";
import { makeRpc, rpcFromEnv, type RpcBlock, type RpcTx } from "@ccd/rpc";
import { SignatureCache } from "./signatures.js";
import { contractSyncEnabled, startContractSync } from "./contractSync.js";
import { TokenCache, createExternalDataProvider } from "./externalData.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAIN_ID = 1;
const REORG_DEPTH = 8;
const PRUNE_EVERY_BLOCKS = 100;

const POLL_MS = Number(process.env.POLL_MS ?? 4000);
// At least 7: the 7d window needs its blocks kept until they expire from it.
const RETENTION_DAYS = Math.max(7, Number(process.env.RETENTION_DAYS ?? 7));
const REGISTRY_PATH = path.resolve(
  process.env.REGISTRY_PATH ?? path.resolve(__dirname, "../../../../../clear-signing-erc7730-registry"),
);

const log = (msg: string) => process.stderr.write(`${new Date().toISOString()} ${msg}\n`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Per-transaction classification

interface Classified {
  tx: LiveTxIn;
}

function selectorOf(input: string): string {
  if (!input || input === "0x") return "0x";
  return input.length >= 10 ? input.slice(0, 10).toLowerCase() : input.toLowerCase();
}

async function classifyTx(
  t: RpcTx,
  cov: CoverageLookup,
  resolverOptions: NonNullable<Parameters<typeof format>[1]>["descriptorResolverOptions"],
  externalDataProvider: ExternalDataProvider,
): Promise<Classified> {
  const to = t.to ? t.to.toLowerCase() : null;
  const selector = selectorOf(t.input);
  const { bucket } = bucketFor(to, selector, CHAIN_ID, cov);
  const row: LiveTxIn = { hash: t.hash, toAddress: to, selector, bucket };
  if (bucket !== "covered_theory" || to === null) return { tx: row };

  let model: DisplayModel;
  try {
    let value: bigint | undefined;
    try {
      value = t.value ? BigInt(t.value) : undefined;
    } catch {
      value = undefined;
    }
    model = await format(
      { chainId: CHAIN_ID, to, data: t.input, value, from: t.from },
      { descriptorResolverOptions: resolverOptions, externalDataProvider },
    );
  } catch (e) {
    model = { warnings: [{ code: "UNEXPECTED_LIB_ERROR" as never, message: String(e) }] };
  }
  row.status = classifyModel(model);
  row.warnings = (model.warnings ?? []).map((w) => ({ code: String(w.code), message: w.message }));
  row.intent = model.interpolatedIntent ?? intentToString(model.intent);
  row.display = model; // stored for pass, partial and failed alike (capped in @ccd/db)
  return { tx: row };
}

function groupRows(txs: LiveTxIn[]): BlockGroupIn[] {
  const map = new Map<string, BlockGroupIn>();
  for (const t of txs) {
    const key = `${t.toAddress ?? ""}|${t.selector}|${t.status ?? ""}`;
    const g = map.get(key);
    if (g) g.txCount++;
    else map.set(key, { toAddress: t.toAddress, selector: t.selector, bucket: t.bucket, status: t.status, txCount: 1 });
  }
  return [...map.values()];
}

// ---------------------------------------------------------------------------
// Main loop

async function main(): Promise<void> {
  const rpcCfg = rpcFromEnv();
  const rpc = makeRpc(rpcCfg);
  const dbPath = defaultDbPath();
  const db = openDb(dbPath);
  // Rolling-window running totals and the stored rankings: recompute once from
  // block_groups so an older database (or one that stopped mid-way) starts
  // consistent. Seconds on a week of data.
  const rebuilt = rebuildWindowsAndRankings(db);
  log(`follower: window totals rebuilt in ${rebuilt.ms} ms (${rebuilt.rows} rows; rankings ${rebuilt.rankingMs} ms)`);

  let registryCommit: string | null = null;
  try {
    registryCommit = execFileSync("git", ["-C", REGISTRY_PATH, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    /* not a git checkout */
  }

  const cov = loadCoverageLookup({ registryPath: REGISTRY_PATH, registryCommit, chainIds: [CHAIN_ID] });
  // Keep the DB's coverage table in step with what we classify against, so the
  // API can join entity / function names onto live rows.
  insertCoverage(
    db,
    [...cov.bySelector.values()].map((r) => ({
      chainId: r.chainId,
      address: r.address,
      selector: r.selector,
      functionSig: r.functionSig,
      descriptorPath: r.descriptorPath,
      entity: r.entity,
      standardKind: r.standardKind,
    })),
    cov.registryCommit,
  );
  const resolverOptions = {
    type: "custom" as const,
    resolver: createFilesystemResolver({ index: loadRegistryIndex(REGISTRY_PATH), descriptorDirectory: REGISTRY_PATH }),
  };

  const sigs = new SignatureCache(db);
  const tokens = new TokenCache(db, rpc, CHAIN_ID);
  const externalData = createExternalDataProvider({ db, rpc, chainId: CHAIN_ID, tokens });
  // Sourcify verification runs in the background on this same connection; the
  // block loop never waits on it.
  const contractSync = contractSyncEnabled() ? startContractSync(db, { chainId: CHAIN_ID, log }) : null;

  log(`follower: rpc=${rpc.label} db=${dbPath}`);
  log(
    `follower: coverage ${cov.rowCount} rows (registry ${cov.registryCommit?.slice(0, 8) ?? "?"}), retention ${RETENTION_DAYS}d, poll ${POLL_MS}ms, ${sigs.size} cached signatures, ${tokens.size} cached tokens`,
  );

  let stopping = false;
  process.on("SIGINT", () => {
    log("follower: SIGINT, finishing current block ...");
    stopping = true;
  });
  process.on("SIGTERM", () => {
    stopping = true;
  });

  // Where to start: explicit START_BLOCK, else continue after the stored head,
  // else the chain head right now.
  const stored = latestBlock(db);
  let next: number;
  if (process.env.START_BLOCK) next = Number(process.env.START_BLOCK);
  else if (stored) next = stored.number + 1;
  else next = await rpc.blockNumber();
  log(`follower: starting at block ${next}${stored ? ` (stored head ${stored.number})` : ""}`);

  let backoff = 1000;
  let processed = 0;

  while (!stopping) {
    try {
      const head = await rpc.blockNumber();
      if (next > head) {
        await sleep(POLL_MS);
        continue;
      }

      const block = await rpc.blockWithTxs(next);
      if (!block) {
        // Load-balanced nodes can lag the head they just reported.
        await sleep(Math.min(POLL_MS, 2000));
        continue;
      }

      // Reorg check: does the chain's parent match what we stored for n-1?
      const storedParent = blockHash(db, next - 1);
      if (storedParent && storedParent !== block.parentHash.toLowerCase()) {
        const forkPoint = await findForkPoint(rpc, db, next - 1);
        log(`follower: REORG detected at ${next} (stored parent ${storedParent.slice(0, 10)} != ${block.parentHash.slice(0, 10)}); rewinding to ${forkPoint + 1}`);
        deleteBlocksFrom(db, forkPoint + 1);
        next = forkPoint + 1;
        continue;
      }

      const t0 = Date.now();
      const txs: LiveTxIn[] = [];
      for (const t of block.transactions) txs.push((await classifyTx(t, cov, resolverOptions, externalData)).tx);
      const groups = groupRows(txs);
      const timeIso = new Date(Number(block.timestamp) * 1000).toISOString();
      insertBlock(
        db,
        { number: next, hash: block.hash, parentHash: block.parentHash, timeIso, txCount: txs.length },
        txs,
        groups,
      );

      const counts: Record<Bucket, number> = { contract_creation: 0, eth_transfer: 0, covered_theory: 0, token_native: 0, not_covered: 0 };
      const st: Record<PracticalStatus, number> = { pass: 0, partial: 0, failed: 0 };
      for (const t of txs) {
        counts[t.bucket]++;
        if (t.status) st[t.status]++;
      }
      log(
        `block ${next} txs=${txs.length} eth=${counts.eth_transfer} cov=${counts.covered_theory}(${st.pass}/${st.partial}/${st.failed}) tok=${counts.token_native} not=${counts.not_covered} new=${counts.contract_creation} lag=${head - next} ${Date.now() - t0}ms`,
      );

      const newTokens = tokens.drainLookups();
      if (newTokens) log(`follower: looked up ${newTokens} new tokens on-chain (${tokens.size} cached)`);

      // Resolve function names for the selectors in this block (cached; one
      // request per new batch). A failure here must not stall the follower.
      try {
        const looked = await sigs.ensure(txs.map((t) => t.selector));
        if (looked) log(`follower: looked up ${looked} new selectors on 4byte.sourcify.dev (${sigs.size} cached)`);
      } catch (e) {
        log(`follower: signature lookup failed: ${(e as Error).message}`);
      }

      processed++;
      next++;
      backoff = 1000;
      if (processed % PRUNE_EVERY_BLOCKS === 0) {
        const removed = pruneLive(db, RETENTION_DAYS);
        if (removed) log(`follower: pruned ${removed} blocks older than ${RETENTION_DAYS}d`);
        // Verification cache rows outlive their last call only until this prune.
        const staleContracts = pruneContracts(db, CHAIN_ID);
        if (staleContracts) log(`follower: pruned ${staleContracts} contract rows no block in the window calls`);
      }
    } catch (e) {
      log(`follower: error: ${(e as Error).message}; retry in ${backoff}ms`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }

  if (contractSync) await contractSync.stop();
  db.close();
  log(`follower: stopped after ${processed} blocks`);
}

/**
 * Walk back from `from` until the stored hash equals the chain's hash for that
 * number. Returns the last block number that is still valid. Gives up after
 * REORG_DEPTH blocks and returns the rewind boundary.
 */
async function findForkPoint(rpc: ReturnType<typeof makeRpc>, db: ReturnType<typeof openDb>, from: number): Promise<number> {
  for (let n = from; n > from - REORG_DEPTH; n--) {
    const stored = blockHash(db, n);
    if (!stored) return n; // nothing stored below here; reprocess from n+1
    const header: RpcBlock<string> | null = await rpc.blockHeader(n);
    if (header && header.hash.toLowerCase() === stored) return n;
  }
  return from - REORG_DEPTH;
}

main().catch((e) => {
  log(`follower: fatal: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
