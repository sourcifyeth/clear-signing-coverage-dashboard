/**
 * Caller statistics per busy contract: the bot & infrastructure signal of the
 * ERC-7730 target study of 2026-10-16 (see the README, "Bots & infrastructure
 * list").
 *
 * The study took the last 600 transactions sent to each of the 40 busiest
 * mainnet contracts and grouped them by sender. Bundlers, relayers, bot
 * fleets and operator wallets send from the same few keys again and again, so
 * few of their senders appear only once. People who swap, bridge or mint
 * mostly appear once. With two gates (verified source with the proxy
 * resolved, at least 20 distinct senders), "at least 40% of the senders
 * appear exactly once" matched all 40 hand verdicts, and the study asks to
 * treat 35% to 50% as "review", not as a pass or a fail.
 *
 * Here the follower keeps the last SENDER_SAMPLE senders of the busiest
 * TRACKED_CONTRACTS of the 24h window in `contract_senders`, and the API
 * computes the numbers for the rows it serves.
 *
 * The verdict also feeds the bots & infrastructure exclusion. At each prune
 * cycle the follower runs updateBotContracts: a contract with the verdict
 * "bots" goes in the table bot_contracts, and the exclusion removes its calls
 * the same way as the calls to the hand-kept list in infra.ts. A contract
 * leaves the table only when its verdict becomes "users". In the review band
 * it keeps its state, so a contract near a limit does not change state
 * between two cycles.
 */

import type { Db } from "./index.js";
import { INFRA_ADDRESSES, botInfraTag, infraTagOf, type InfraTag } from "./infra.js";

/** Senders kept per contract: the study's sample size. */
export const SENDER_SAMPLE = 600;
/** How many of the 24h window's busiest contracts get their senders recorded. */
export const TRACKED_CONTRACTS = 2000;
/** Below this many recorded calls the numbers are shown but get no verdict. */
export const MIN_SAMPLE = 50;
/** The study's floor: fewer distinct senders than this and any share is noise. */
export const MIN_SIGNERS = 20;
/** One-shot share below this: bot-like. */
export const BOT_BELOW_PCT = 35;
/** One-shot share from BOT_BELOW_PCT up to this: review. At or above: users. */
export const USERS_FROM_PCT = 50;

/** seq = block * SEQ_PER_BLOCK + position in the block. */
const SEQ_PER_BLOCK = 100_000;

export type CallerVerdict = "users" | "review" | "bots" | "collecting";

export interface CallerStats {
  /** calls in the sample (at most SENDER_SAMPLE) */
  sample: number;
  /** distinct senders in the sample */
  signers: number;
  /** % of the senders that appear exactly once */
  oneShotPct: number;
  /** % of the senders that appear at most twice */
  twoShotPct: number;
  /** % of the sample sent by the busiest sender */
  topSenderPct: number;
  verdict: CallerVerdict;
  /** one line: why this verdict */
  reason: string;
}

export interface SenderIn {
  /** the transaction's to, lowercase */
  address: string;
  /** the transaction's from, lowercase */
  sender: string;
  /** position of the transaction in its block */
  position: number;
}

/**
 * The contracts whose senders the follower records: the busiest `limit` of
 * the 24h window by transaction count (an index read on window_contracts).
 */
export function trackedContracts(db: Db, limit: number = TRACKED_CONTRACTS): Set<string> {
  if (limit <= 0) return new Set();
  const rows = db
    .prepare(
      `SELECT to_address FROM window_contracts
        WHERE window = '24h' AND to_address <> ''
        ORDER BY tx_count DESC, to_address
        LIMIT ?`,
    )
    .all(limit) as { to_address: string }[];
  return new Set(rows.map((r) => r.to_address));
}

/** Record one block's senders for the tracked contracts. */
export function insertSenders(db: Db, blockNumber: number, rows: SenderIn[]): void {
  if (rows.length === 0) return;
  const stmt = db.prepare("INSERT OR REPLACE INTO contract_senders (address, seq, sender) VALUES (?, ?, ?)");
  db.transaction((rs: SenderIn[]) => {
    for (const r of rs) stmt.run(r.address, blockNumber * SEQ_PER_BLOCK + r.position, r.sender);
  })(rows);
}

/**
 * Keep the newest `keep` rows of each given contract, and drop every row of a
 * block before `oldestBlock` (the retention window). Returns rows removed.
 */
export function trimSenders(db: Db, addresses: Iterable<string>, oldestBlock: number | null, keep: number = SENDER_SAMPLE): number {
  const cut = db.prepare(
    `DELETE FROM contract_senders
      WHERE address = ?
        AND seq < (SELECT seq FROM contract_senders WHERE address = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)`,
  );
  return db.transaction((): number => {
    let removed = 0;
    for (const a of addresses) removed += Number(cut.run(a, a, keep - 1).changes);
    if (oldestBlock !== null) {
      removed += Number(db.prepare("DELETE FROM contract_senders WHERE seq < ?").run(oldestBlock * SEQ_PER_BLOCK).changes);
    }
    return removed;
  })();
}

/** Remove the senders of blocks >= `number` (reorg rewind). */
export function deleteSendersFrom(db: Db, number: number): number {
  return Number(db.prepare("DELETE FROM contract_senders WHERE seq >= ?").run(number * SEQ_PER_BLOCK).changes);
}

/**
 * The study's rule as a hint. `verified` is the Sourcify cache flag with the
 * proxy resolved (null = not checked yet).
 */
export function callerVerdict(s: Omit<CallerStats, "verdict" | "reason">, verified: boolean | null): { verdict: CallerVerdict; reason: string } {
  if (s.sample < MIN_SAMPLE) return { verdict: "collecting", reason: `only ${s.sample} calls recorded so far; a verdict needs ${MIN_SAMPLE}` };
  if (s.signers < MIN_SIGNERS)
    return { verdict: "bots", reason: `${s.signers} distinct senders in ${s.sample} calls: operator keys, not a crowd` };
  const pct = s.oneShotPct.toFixed(0);
  if (s.oneShotPct < BOT_BELOW_PCT)
    return { verdict: "bots", reason: `${pct}% of the senders call once; bots, bundlers and relayers repeat from the same keys` };
  if (s.oneShotPct < USERS_FROM_PCT)
    return { verdict: "review", reason: `${pct}% of the senders call once: between ${BOT_BELOW_PCT}% and ${USERS_FROM_PCT}%, the study's review band` };
  // A crowd of one-time senders on an unverified contract is how the study's
  // wash-trading farm looked; only the verified-source gate caught it.
  if (verified === false) return { verdict: "review", reason: `${pct}% of the senders call once, but the source is not verified` };
  return { verdict: "users", reason: `${pct}% of the senders call once, like people using a product` };
}

/**
 * Caller statistics for the given contracts from their recorded senders.
 * Contracts with no recorded sender are left out of the map.
 */
export function callerStats(db: Db, addresses: string[], verifiedOf: (address: string) => boolean | null): Map<string, CallerStats> {
  const out = new Map<string, CallerStats>();
  const stmt = db.prepare(
    `SELECT sender, COUNT(*) AS n FROM (
       SELECT sender FROM contract_senders WHERE address = ? ORDER BY seq DESC LIMIT ?
     ) GROUP BY sender`,
  );
  for (const a of new Set(addresses)) {
    const rows = stmt.all(a, SENDER_SAMPLE) as { sender: string; n: number }[];
    if (rows.length === 0) continue;
    let sample = 0;
    let once = 0;
    let twice = 0;
    let top = 0;
    for (const r of rows) {
      sample += r.n;
      if (r.n === 1) once++;
      if (r.n <= 2) twice++;
      if (r.n > top) top = r.n;
    }
    const base = {
      sample,
      signers: rows.length,
      oneShotPct: (100 * once) / rows.length,
      twoShotPct: (100 * twice) / rows.length,
      topSenderPct: (100 * top) / sample,
    };
    out.set(a, { ...base, ...callerVerdict(base, verifiedOf(a)) });
  }
  return out;
}

export interface BotContract {
  address: string;
  reason: string;
  sinceBlock: number;
  updatedBlock: number;
}

/**
 * Update bot_contracts from the recorded senders of `addresses` (the tracked
 * contracts) at block `blockNumber`:
 * - verdict "bots": add the contract, or refresh its reason;
 * - verdict "users": remove it;
 * - "review" or "collecting": no change.
 * A contract with no recorded sender left (its calls aged out of the
 * retention window) is removed too.
 */
export function updateBotContracts(db: Db, addresses: Iterable<string>, blockNumber: number): { added: number; removed: number; total: number } {
  const stats = callerStats(db, [...addresses], () => null);
  const exists = db.prepare("SELECT 1 FROM bot_contracts WHERE address = ?");
  const upsert = db.prepare(
    `INSERT INTO bot_contracts (address, reason, since_block, updated_block) VALUES (?, ?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET reason = excluded.reason, updated_block = excluded.updated_block`,
  );
  const del = db.prepare("DELETE FROM bot_contracts WHERE address = ?");
  return db.transaction(() => {
    let added = 0;
    let removed = 0;
    for (const [a, s] of stats) {
      if (s.verdict === "bots") {
        if (!exists.get(a)) added++;
        upsert.run(a, s.reason, blockNumber, blockNumber);
      } else if (s.verdict === "users") {
        removed += Number(del.run(a).changes);
      }
    }
    removed += Number(
      db.prepare("DELETE FROM bot_contracts WHERE address NOT IN (SELECT DISTINCT address FROM contract_senders)").run().changes,
    );
    const total = (db.prepare("SELECT COUNT(*) AS n FROM bot_contracts").get() as { n: number }).n;
    return { added, removed, total };
  })();
}

/** Every contract in bot_contracts, newest mark first. */
export function listBotContracts(db: Db): BotContract[] {
  return (
    db.prepare("SELECT address, reason, since_block, updated_block FROM bot_contracts ORDER BY since_block DESC, address").all() as {
      address: string;
      reason: string;
      since_block: number;
      updated_block: number;
    }[]
  ).map((r) => ({ address: r.address, reason: r.reason, sinceBlock: r.since_block, updatedBlock: r.updated_block }));
}

/** The hand-kept list plus bot_contracts, lowercase. */
export function infraAddresses(db: Db): Set<string> {
  const out = new Set<string>();
  for (const r of db.prepare("SELECT address FROM bot_contracts").all() as { address: string }[]) out.add(r.address);
  for (const a of INFRA_ADDRESSES) out.add(a);
  return out;
}

/** The tag for a contract on the hand-kept list or in bot_contracts (null when on neither). */
export function infraTagFor(db: Db, address: string | null | undefined): InfraTag | null {
  if (!address) return null;
  const listed = infraTagOf(address);
  if (listed) return listed;
  const r = db.prepare("SELECT reason FROM bot_contracts WHERE address = ?").get(address.toLowerCase()) as { reason: string } | undefined;
  return r ? botInfraTag(r.reason) : null;
}
