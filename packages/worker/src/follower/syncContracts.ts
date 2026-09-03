#!/usr/bin/env tsx
/**
 * Sourcify verification sync: keeps the `contracts` table in step with
 * sourcify.dev for every contract the live window calls.
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
 * Runs next to the follower and the API; it writes only the contracts table.
 *
 * Env:  DB_PATH            SQLite file (default <repo>/out/coverage.sqlite)
 *       CONTRACTS_BATCH    addresses per round, default 100
 *       CONTRACTS_RATE     requests per second, default 4
 * Flags: --once            drain one round and exit (for tests)
 *
 * Usage: npm run contracts:sync [-- --once]
 */

import { openDb, defaultDbPath, contractsToCheck, contractsQueueSize, upsertContracts, contractCounts, type ContractIn, type MatchKind } from "@ccd/db";

const CHAIN_ID = 1;
const SOURCIFY = "https://sourcify.dev/server";
const ROUND_MS = 30_000;
const BATCH = Math.max(1, Number(process.env.CONTRACTS_BATCH ?? 100));
const RATE_PER_S = Math.max(0.1, Number(process.env.CONTRACTS_RATE ?? 4));
const TIMEOUT_MS = 8000;
const ONCE = process.argv.includes("--once");

const log = (msg: string) => process.stderr.write(`${new Date().toISOString()} contracts: ${msg}\n`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Minimum spacing between requests; awaited before each one. */
let nextSlot = 0;
async function throttle(): Promise<void> {
  const gap = 1000 / RATE_PER_S;
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + gap;
  if (at > now) await sleep(at - now);
}

type Check = { kind: "verified"; match: MatchKind; name: string | null; verifiedAtIso: string | null } | { kind: "unverified" } | { kind: "skip"; why: string };

interface SourcifyContract {
  match?: string;
  verifiedAt?: string;
  compilation?: { name?: string };
}

async function check(address: string): Promise<Check> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${SOURCIFY}/v2/contract/${CHAIN_ID}/${address}?fields=compilation`, { signal: ctl.signal });
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

async function round(db: ReturnType<typeof openDb>): Promise<{ checked: number; verified: number; unverified: number; skipped: number }> {
  const todo = contractsToCheck(db, { chainId: CHAIN_ID, limit: BATCH });
  const out: ContractIn[] = [];
  let skipped = 0;
  let verified = 0;
  let unverified = 0;
  let lastSkip = "";
  for (const t of todo) {
    await throttle();
    const r = await check(t.address);
    if (r.kind === "skip") {
      skipped++;
      lastSkip = r.why;
      continue;
    }
    if (r.kind === "verified") {
      verified++;
      out.push({ chainId: CHAIN_ID, address: t.address, verified: true, match: r.match, name: r.name, verifiedAtIso: r.verifiedAtIso });
    } else {
      unverified++;
      out.push({ chainId: CHAIN_ID, address: t.address, verified: false, match: null, name: null, verifiedAtIso: null });
    }
  }
  upsertContracts(db, out);
  const queue = contractsQueueSize(db, CHAIN_ID);
  const totals = contractCounts(db, CHAIN_ID);
  log(
    `round: checked ${out.length} (${verified} verified, ${unverified} unverified), skipped ${skipped}${skipped ? ` (last: ${lastSkip})` : ""}; queue ${queue}; cache ${totals.total} rows (${totals.verified} verified)`,
  );
  return { checked: out.length, verified, unverified, skipped };
}

async function main(): Promise<void> {
  const dbPath = process.env.DB_PATH ?? defaultDbPath();
  const db = openDb(dbPath);
  log(`db=${dbPath} batch=${BATCH} rate=${RATE_PER_S}/s${ONCE ? " (once)" : ""}`);

  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
  });
  process.on("SIGTERM", () => {
    stopping = true;
  });

  do {
    const t0 = Date.now();
    try {
      await round(db);
    } catch (e) {
      log(`round failed: ${(e as Error).message}`);
    }
    if (ONCE || stopping) break;
    const wait = Math.max(1000, ROUND_MS - (Date.now() - t0));
    await sleep(wait);
  } while (!stopping);

  db.close();
  log("stopped");
}

main().catch((e) => {
  log(`fatal: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
