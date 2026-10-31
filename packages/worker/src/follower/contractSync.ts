/**
 * Sourcify verification sync, run inside the follower as a background task:
 * keeps the `contracts` table in step with sourcify.dev for every contract the
 * live window calls.
 *
 * Every ROUND_MS it asks the database which addresses need a (re)check
 * (`contractsToCheck`: no row, unverified older than 24h, verified older than
 * 30 days; busiest first) and queries Sourcify one address at a time, at most
 * RATE_PER_S requests per second:
 *
 *   200 -> verified (match kind, compilation name)
 *   404 -> not verified
 *   anything else, timeout, network error -> skipped, retried next round
 *
 * Proxies: the same request asks for Sourcify's proxy resolution. For a proxy,
 * every implementation is looked up too (one more request each, same rate
 * limit). The contract counts as verified only when they all are; then the
 * name is the implementation's (FiatTokenV2_2, not FiatTokenProxy). A failed
 * implementation lookup skips the whole address until the next round.
 *
 * The fetches are async, so block processing never waits on Sourcify; the
 * SQLite writes are one short transaction per round on the follower's own
 * connection, which is safe because better-sqlite3 calls are synchronous and
 * a round's write cannot interleave with a block's insert.
 *
 * Env:  CONTRACTS_SYNC     "0" disables the task
 *       CONTRACTS_BATCH    addresses per round, default 100
 *       CONTRACTS_RATE     requests per second, default 4
 */

import { contractsToCheck, contractsQueueSize, upsertContracts, contractCounts, type ContractIn, type MatchKind } from "@ccd/db";
import type { openDb } from "@ccd/db";

const SOURCIFY = "https://sourcify.dev/server";
// SOURCIFY_TOKEN: the header that lifts the rate limit on /server/v2/contract/.
// Optional; the sync runs at CONTRACTS_RATE either way.
const HEADERS: Record<string, string> = process.env.SOURCIFY_TOKEN ? { "x-sourcify-token": process.env.SOURCIFY_TOKEN } : {};
const ROUND_MS = 30_000;
const TIMEOUT_MS = 8000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A proxy's implementations and whether every one of them is verified on Sourcify. */
export interface ProxyCheck {
  implementations: string[];
  implementationVerified: boolean;
}

export type ContractCheck =
  | { kind: "verified"; match: MatchKind; name: string | null; verifiedAtIso: string | null; proxy: ProxyCheck | null }
  | { kind: "unverified" }
  | { kind: "skip"; why: string };
type Check = ContractCheck;

interface SourcifyContract {
  match?: string;
  verifiedAt?: string;
  compilation?: { name?: string };
  proxyResolution?: { isProxy?: boolean; implementations?: { address?: string; name?: string }[] } | null;
}

/** Diamonds list one implementation per facet; past this many the address is left as checked by its own source only. */
const MAX_IMPLEMENTATIONS = 10;

/** One Sourcify lookup (with SOURCIFY_TOKEN when set), proxy resolved. Shared with the API's on-demand path. */
export async function checkContract(chainId: number, address: string): Promise<ContractCheck> {
  return check(chainId, address, async () => {});
}

/** The cache row for a check, with the proxy rule applied: verified only when every implementation is. */
export function contractInFromCheck(chainId: number, address: string, c: Exclude<ContractCheck, { kind: "skip" }>): ContractIn {
  if (c.kind === "unverified") {
    return { chainId, address, verified: false, match: null, name: null, verifiedAtIso: null, proxyImplementations: null, implementationVerified: null };
  }
  return {
    chainId,
    address,
    verified: c.proxy ? c.proxy.implementationVerified : true,
    match: c.match,
    name: c.name,
    verifiedAtIso: c.verifiedAtIso,
    proxyImplementations: c.proxy?.implementations ?? null,
    implementationVerified: c.proxy?.implementationVerified ?? null,
  };
}

async function getJson(url: string): Promise<{ status: number; body: SourcifyContract | null } | { error: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: HEADERS });
    if (!res.ok) return { status: res.status, body: null };
    return { status: res.status, body: (await res.json()) as SourcifyContract };
  } catch (e) {
    return { error: (e as Error).name === "AbortError" ? "timeout" : (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/** `throttle` runs before every request, so the implementation lookups share the rate limit. */
async function check(chainId: number, address: string, throttle: () => Promise<void>): Promise<Check> {
  await throttle();
  const r = await getJson(`${SOURCIFY}/v2/contract/${chainId}/${address}?fields=compilation.name,proxyResolution`);
  if ("error" in r) return { kind: "skip", why: r.error };
  if (r.status === 404) return { kind: "unverified" };
  if (!r.body) return { kind: "skip", why: `HTTP ${r.status}` };
  const body = r.body;
  const match: MatchKind = body.match === "exact_match" ? "exact_match" : "match";
  const base = { kind: "verified" as const, match, name: body.compilation?.name ?? null, verifiedAtIso: body.verifiedAt ?? null };

  const impls = (body.proxyResolution?.isProxy ? (body.proxyResolution.implementations ?? []) : [])
    .map((i) => i.address?.toLowerCase())
    .filter((a): a is string => !!a && /^0x[0-9a-f]{40}$/.test(a));
  if (impls.length === 0 || impls.length > MAX_IMPLEMENTATIONS) return { ...base, proxy: null };

  let allVerified = true;
  let implName: string | null = null;
  for (const impl of impls) {
    await throttle();
    const ir = await getJson(`${SOURCIFY}/v2/contract/${chainId}/${impl}?fields=compilation.name`);
    if ("error" in ir) return { kind: "skip", why: `implementation ${impl}: ${ir.error}` };
    if (ir.status === 404) {
      allVerified = false;
      continue;
    }
    if (!ir.body) return { kind: "skip", why: `implementation ${impl}: HTTP ${ir.status}` };
    implName ??= ir.body.compilation?.name ?? null;
  }
  return {
    ...base,
    name: allVerified && implName ? implName : base.name,
    proxy: { implementations: impls, implementationVerified: allVerified },
  };
}

export interface ContractSyncOptions {
  chainId: number;
  log: (msg: string) => void;
  /** addresses per round (default env CONTRACTS_BATCH or 100) */
  batch?: number;
  /** requests per second (default env CONTRACTS_RATE or 4) */
  ratePerSecond?: number;
}

export interface ContractSync {
  /** Stop after the current request; resolves once the loop has exited. */
  stop(): Promise<void>;
}

/** Whether the task is enabled by the environment (`CONTRACTS_SYNC=0` turns it off). */
export function contractSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CONTRACTS_SYNC !== "0";
}

/**
 * Start the background loop on the follower's database connection. Returns
 * immediately; the loop runs rounds every ROUND_MS until `stop()` is called.
 */
export function startContractSync(db: ReturnType<typeof openDb>, opts: ContractSyncOptions): ContractSync {
  const batch = Math.max(1, opts.batch ?? Number(process.env.CONTRACTS_BATCH ?? 100));
  const rate = Math.max(0.1, opts.ratePerSecond ?? Number(process.env.CONTRACTS_RATE ?? 4));
  const log = (m: string) => opts.log(`contracts: ${m}`);
  let stopping = false;
  let nextSlot = 0;

  async function throttle(): Promise<void> {
    const gap = 1000 / rate;
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + gap;
    if (at > now) await sleep(at - now);
  }

  async function round(): Promise<void> {
    const todo = contractsToCheck(db, { chainId: opts.chainId, limit: batch });
    if (todo.length === 0) return;
    const out: ContractIn[] = [];
    let skipped = 0;
    let verified = 0;
    let unverified = 0;
    let proxyOnly = 0;
    let lastSkip = "";
    for (const t of todo) {
      if (stopping) break;
      const r = await check(opts.chainId, t.address, throttle);
      if (r.kind === "skip") {
        skipped++;
        lastSkip = r.why;
        continue;
      }
      const row = contractInFromCheck(opts.chainId, t.address, r);
      if (row.verified) verified++;
      else if (r.kind === "verified") proxyOnly++;
      else unverified++;
      out.push(row);
    }
    if (out.length > 0) upsertContracts(db, out);
    const queue = contractsQueueSize(db, opts.chainId);
    const totals = contractCounts(db, opts.chainId);
    log(
      `checked ${out.length} (${verified} verified, ${unverified} unverified, ${proxyOnly} verified proxies with unverified implementations), skipped ${skipped}${skipped ? ` (last: ${lastSkip})` : ""}; queue ${queue}; cache ${totals.total} rows (${totals.verified} verified)`,
    );
  }

  const done = (async () => {
    log(`sync on: batch ${batch}, ${rate} req/s, every ${ROUND_MS / 1000}s`);
    while (!stopping) {
      const t0 = Date.now();
      try {
        await round();
      } catch (e) {
        log(`round failed: ${(e as Error).message}`);
      }
      const wait = Math.max(1000, ROUND_MS - (Date.now() - t0));
      // Sleep in short steps so stop() takes effect quickly.
      for (let waited = 0; waited < wait && !stopping; waited += 500) await sleep(Math.min(500, wait - waited));
    }
    log("sync stopped");
  })();

  return {
    stop: () => {
      stopping = true;
      return done;
    },
  };
}
