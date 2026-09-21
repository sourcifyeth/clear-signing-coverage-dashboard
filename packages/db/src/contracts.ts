/**
 * Sourcify verification cache (`contracts` table): is a contract verified,
 * with which match kind, and what does Sourcify call it. Filled by the
 * follower's background Sourcify sync, read by the API to split "not covered" into
 * verified (a descriptor can be written) and unverified (no ABI, nothing to
 * build on).
 *
 * Recheck policy: unverified rows are rechecked after a flat 24 hours (someone
 * may verify the contract any day); verified rows after 30 days (only to catch
 * a plain match upgrading to an exact match).
 */

import type { Db } from "./index.js";
import { LIVE_CHAIN_ID, WINDOW_KEYS } from "./windows.js";

export type MatchKind = "exact_match" | "match";

export interface ContractRow {
  chainId: number;
  /** lowercase 0x address */
  address: string;
  verified: boolean;
  match: MatchKind | null;
  /** Sourcify's `compilation.name`, null when unverified */
  name: string | null;
  checkedAtIso: string;
  verifiedAtIso: string | null;
}

export type ContractIn = Omit<ContractRow, "checkedAtIso">;

interface Raw {
  chain_id: number;
  address: string;
  verified: number;
  match: MatchKind | null;
  name: string | null;
  checked_at: string;
  verified_at: string | null;
}

const COLS = "chain_id, address, verified, match, name, checked_at, verified_at";
const CALL_BUCKETS = "('not_covered','covered_theory','token_native')";

/** Flat recheck interval for unverified contracts. */
export const UNVERIFIED_RECHECK_HOURS = 24;
/** Recheck interval for verified contracts (match may upgrade to exact_match). */
export const VERIFIED_RECHECK_HOURS = 30 * 24;

function toRow(r: Raw): ContractRow {
  return {
    chainId: r.chain_id,
    address: r.address,
    verified: r.verified === 1,
    match: r.match,
    name: r.name,
    checkedAtIso: r.checked_at,
    verifiedAtIso: r.verified_at,
  };
}

export function getContract(db: Db, chainId: number, address: string): ContractRow | null {
  const r = db.prepare(`SELECT ${COLS} FROM contracts WHERE chain_id = ? AND address = ?`).get(chainId, address.toLowerCase()) as
    | Raw
    | undefined;
  return r ? toRow(r) : null;
}

/** Rows for the given addresses, keyed by lowercase address (missing = unknown). */
export function getContracts(db: Db, chainId: number, addresses: string[]): Map<string, ContractRow> {
  const out = new Map<string, ContractRow>();
  const addrs = [...new Set(addresses.map((a) => a.toLowerCase()))];
  // SQLite's default variable limit is 999 (32766 on newer builds); chunk to stay safe.
  for (let i = 0; i < addrs.length; i += 500) {
    const chunk = addrs.slice(i, i + 500);
    const inList = chunk.map(() => "?").join(",");
    const rows = db.prepare(`SELECT ${COLS} FROM contracts WHERE chain_id = ? AND address IN (${inList})`).all(chainId, ...chunk) as Raw[];
    for (const r of rows) out.set(r.address, toRow(r));
  }
  return out;
}

export function upsertContracts(db: Db, rows: ContractIn[], now: Date = new Date()): void {
  if (rows.length === 0) return;
  const nowIso = now.toISOString();
  const stmt = db.prepare(
    `INSERT INTO contracts (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chain_id, address) DO UPDATE SET
       verified = excluded.verified, match = excluded.match, name = excluded.name,
       checked_at = excluded.checked_at,
       verified_at = COALESCE(excluded.verified_at, contracts.verified_at)`,
  );
  // The per-window contract totals mirror the flag, so the summary needs no
  // join; and the not-covered counter's unv_count follows the flag flips, so
  // the `exclude=unverified` denominator stays exact without a scan.
  const current = db.prepare("SELECT verified, not_covered_tx FROM window_contracts WHERE window = ? AND to_address = ?");
  const mirror = db.prepare("UPDATE window_contracts SET verified = ? WHERE window = ? AND to_address = ?");
  const bumpUnv = db.prepare("UPDATE window_counters SET unv_count = unv_count + ? WHERE window = ? AND bucket = 'not_covered' AND status = ''");
  db.transaction((rs: ContractIn[]) => {
    for (const r of rs) {
      const addr = r.address.toLowerCase();
      const flag = r.verified ? 1 : 0;
      stmt.run(r.chainId, addr, flag, r.match, r.name, nowIso, r.verifiedAtIso);
      if (r.chainId !== LIVE_CHAIN_ID) continue;
      for (const w of WINDOW_KEYS) {
        const cur = current.get(w, addr) as { verified: number | null; not_covered_tx: number } | undefined;
        if (!cur) continue;
        const wasUnv = cur.verified === 0;
        const isUnv = flag === 0;
        if (wasUnv !== isUnv && cur.not_covered_tx > 0) bumpUnv.run(isUnv ? cur.not_covered_tx : -cur.not_covered_tx, w);
        mirror.run(flag, w, addr);
      }
    }
  })(rows);
}

export interface ContractToCheck {
  address: string;
  /** calls to it in the last 24h (the queue is ordered by this, busiest first) */
  txCount: number;
  /** null = never checked */
  checkedAtIso: string | null;
}

/**
 * Addresses the sync worker should (re)check next, busiest first: every
 * contract called in the last 24 hours (call buckets only) that has no row,
 * or an unverified row older than 24 hours, or a verified row older than 30
 * days. The 24-hour window ends at the latest processed block.
 */
export function contractsToCheck(db: Db, opts: { chainId: number; limit?: number; now?: Date }): ContractToCheck[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 5000));
  const latest = db.prepare("SELECT block_time FROM blocks ORDER BY number DESC LIMIT 1").get() as { block_time: string } | undefined;
  const toMs = latest ? new Date(latest.block_time).getTime() : (opts.now ?? new Date()).getTime();
  const fromIso = new Date(toMs - 24 * 3_600_000).toISOString();
  const nowMs = (opts.now ?? new Date()).getTime();
  const unverifiedCutoff = new Date(nowMs - UNVERIFIED_RECHECK_HOURS * 3_600_000).toISOString();
  const verifiedCutoff = new Date(nowMs - VERIFIED_RECHECK_HOURS * 3_600_000).toISOString();
  const rows = db
    .prepare(
      `SELECT g.to_address AS address, SUM(g.tx_count) AS n, MAX(c.checked_at) AS checked_at
         FROM block_groups g
         LEFT JOIN contracts c ON c.chain_id = ? AND c.address = g.to_address
        WHERE g.block_time >= ? AND g.bucket IN ${CALL_BUCKETS} AND g.to_address <> ''
          AND (c.address IS NULL
               OR (c.verified = 0 AND c.checked_at < ?)
               OR (c.verified = 1 AND c.checked_at < ?))
        GROUP BY g.to_address
        ORDER BY n DESC
        LIMIT ?`,
    )
    .all(opts.chainId, fromIso, unverifiedCutoff, verifiedCutoff, limit) as { address: string; n: number; checked_at: string | null }[];
  return rows.map((r) => ({ address: r.address, txCount: r.n, checkedAtIso: r.checked_at }));
}

/** How many addresses the queue holds right now (same rule as contractsToCheck, no limit). */
export function contractsQueueSize(db: Db, chainId: number, now: Date = new Date()): number {
  const latest = db.prepare("SELECT block_time FROM blocks ORDER BY number DESC LIMIT 1").get() as { block_time: string } | undefined;
  const toMs = latest ? new Date(latest.block_time).getTime() : now.getTime();
  const fromIso = new Date(toMs - 24 * 3_600_000).toISOString();
  const unverifiedCutoff = new Date(now.getTime() - UNVERIFIED_RECHECK_HOURS * 3_600_000).toISOString();
  const verifiedCutoff = new Date(now.getTime() - VERIFIED_RECHECK_HOURS * 3_600_000).toISOString();
  const r = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT g.to_address
           FROM block_groups g
           LEFT JOIN contracts c ON c.chain_id = ? AND c.address = g.to_address
          WHERE g.block_time >= ? AND g.bucket IN ${CALL_BUCKETS} AND g.to_address <> ''
            AND (c.address IS NULL OR (c.verified = 0 AND c.checked_at < ?) OR (c.verified = 1 AND c.checked_at < ?))
          GROUP BY g.to_address)`,
    )
    .get(chainId, fromIso, unverifiedCutoff, verifiedCutoff) as { n: number };
  return r.n;
}

/**
 * Drop cache rows for addresses no block in the retention window has called.
 * block_groups is already pruned to the retention window, so "not in
 * block_groups at all" is the test. One index scan; run it with the block prune.
 */
export function pruneContracts(db: Db, chainId: number): number {
  const res = db
    .prepare(`DELETE FROM contracts WHERE chain_id = ? AND address NOT IN (SELECT DISTINCT to_address FROM block_groups)`)
    .run(chainId);
  return Number(res.changes);
}

export function contractCounts(db: Db, chainId: number): { total: number; verified: number; unverified: number } {
  const r = db
    .prepare("SELECT COUNT(*) AS total, COALESCE(SUM(verified), 0) AS verified FROM contracts WHERE chain_id = ?")
    .get(chainId) as { total: number; verified: number };
  return { total: r.total, verified: r.verified, unverified: r.total - r.verified };
}
