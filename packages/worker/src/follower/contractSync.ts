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
const ROUND_MS = 30_000;
const TIMEOUT_MS = 8000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Check = { kind: "verified"; match: MatchKind; name: string | null; verifiedAtIso: string | null } | { kind: "unverified" } | { kind: "skip"; why: string };

interface SourcifyContract {
  match?: string;
  verifiedAt?: string;
  compilation?: { name?: string };
}

async function check(chainId: number, address: string): Promise<Check> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${SOURCIFY}/v2/contract/${chainId}/${address}?fields=compilation`, { signal: ctl.signal });
    if (res.status === 404) return { kind: "unverified" };
    if (!res.ok) return { kind: "skip", why: `HTTP ${res.status}` };
    const body = (await res.json()) as SourcifyContract;
    const match: MatchKind = body.match === "exact_match" ? "exact_match" : "match";
    return { kind: "verified", match, name: body.compilation?.name ?? null, verifiedAtIso: body.verifiedAt ?? null };
  } catch (e) {
    return { kind: "skip", why: (e as Error).name === "AbortError" ? "timeout" : (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
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
    let lastSkip = "";
    for (const t of todo) {
      if (stopping) break;
      await throttle();
      const r = await check(opts.chainId, t.address);
      if (r.kind === "skip") {
        skipped++;
        lastSkip = r.why;
        continue;
      }
      if (r.kind === "verified") {
        verified++;
        out.push({ chainId: opts.chainId, address: t.address, verified: true, match: r.match, name: r.name, verifiedAtIso: r.verifiedAtIso });
      } else {
        unverified++;
        out.push({ chainId: opts.chainId, address: t.address, verified: false, match: null, name: null, verifiedAtIso: null });
      }
    }
    if (out.length > 0) upsertContracts(db, out);
    const queue = contractsQueueSize(db, opts.chainId);
    const totals = contractCounts(db, opts.chainId);
    log(
      `checked ${out.length} (${verified} verified, ${unverified} unverified), skipped ${skipped}${skipped ? ` (last: ${lastSkip})` : ""}; queue ${queue}; cache ${totals.total} rows (${totals.verified} verified)`,
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
