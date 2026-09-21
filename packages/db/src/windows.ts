/**
 * Rolling-window running totals.
 *
 * `block_groups` has one row per (block, contract, selector, status); summing
 * it over a window costs one row-read per row in the window, which is about
 * 46,000 rows per hour and 8 million for a week. Instead the follower keeps,
 * per window, the sum of every included block in `window_groups` and the
 * block range / totals in `window_meta`:
 *
 *   - a new block adds its groups (+tx_count) and becomes the window's end;
 *   - blocks whose time falls before `end - windowSeconds` are subtracted
 *     again (their rows are still in `block_groups`, which is pruned later);
 *   - a reorg rewind subtracts the removed blocks and re-includes the ones the
 *     shorter end time brings back, so the result equals a fresh rebuild.
 *
 * Membership rule, identical to the old range query: a block is in the window
 * iff block_time >= to_time - windowSeconds, where to_time is the time of the
 * newest included block (not the wall clock).
 *
 * Every function here must run inside the caller's transaction (insertBlock,
 * deleteBlocksFrom) so a block and its window updates are atomic.
 */

import type { Db } from "./index.js";
import { STANDARD_TOKEN_SELECTORS, STANDARD_TOKEN_SELECTORS_SQL, LIVE_CHAIN_ID, unverifiedExistsSql } from "./selectors.js";

export { LIVE_CHAIN_ID };

export const WINDOWS = { "1h": 3_600, "24h": 86_400, "7d": 604_800 } as const;

/** Buckets that are calls to a contract; the ranking and window_contracts cover these. */
export const CALL_BUCKETS = ["covered_theory", "token_native", "not_covered"] as const;
export const CALL_BUCKETS_SQL = `('covered_theory','token_native','not_covered')`;
export type WindowKey = keyof typeof WINDOWS;
export const WINDOW_KEYS = Object.keys(WINDOWS) as WindowKey[];

/** The window key for an `hours` value (1, 24, 168); anything else is an error. */
export function windowKeyForHours(hours: number): WindowKey {
  for (const k of WINDOW_KEYS) if (WINDOWS[k] === hours * 3600) return k;
  throw new Error(`unsupported window: ${hours}h (use 1, 24 or 168)`);
}

export interface WindowMeta {
  window: WindowKey;
  fromBlock: number | null;
  toBlock: number | null;
  blockCount: number;
  txTotal: number;
  toTime: string | null;
}

const isoMinus = (iso: string, seconds: number) => new Date(new Date(iso).getTime() - seconds * 1000).toISOString();

export function windowMeta(db: Db, key: WindowKey): WindowMeta {
  const r = db
    .prepare("SELECT from_block, to_block, block_count, tx_total, to_time FROM window_meta WHERE window = ?")
    .get(key) as { from_block: number | null; to_block: number | null; block_count: number; tx_total: number; to_time: string | null } | undefined;
  return {
    window: key,
    fromBlock: r?.from_block ?? null,
    toBlock: r?.to_block ?? null,
    blockCount: r?.block_count ?? 0,
    txTotal: r?.tx_total ?? 0,
    toTime: r?.to_time ?? null,
  };
}

/** [from, to] ISO bounds of a window as the API reports them. */
export function windowBounds(meta: WindowMeta, fallbackToIso: string): { fromIso: string; toIso: string } {
  const toIso = meta.toTime ?? fallbackToIso;
  return { fromIso: isoMinus(toIso, WINDOWS[meta.window]), toIso };
}

function writeMeta(db: Db, m: WindowMeta): void {
  db.prepare(
    `INSERT INTO window_meta (window, from_block, to_block, block_count, tx_total, to_time) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(window) DO UPDATE SET from_block = excluded.from_block, to_block = excluded.to_block,
       block_count = excluded.block_count, tx_total = excluded.tx_total, to_time = excluded.to_time`,
  ).run(m.window, m.fromBlock, m.toBlock, m.blockCount, m.txTotal, m.toTime);
}

const EMPTY = (key: WindowKey): WindowMeta => ({ window: key, fromBlock: null, toBlock: null, blockCount: 0, txTotal: 0, toTime: null });

// ---------------------------------------------------------------------------
// Group arithmetic (per block, per window)

interface GroupRow {
  to_address: string;
  selector: string;
  bucket: string;
  status: string;
  tx_count: number;
}

function stmts(db: Db) {
  return {
    groupsOf: db.prepare("SELECT to_address, selector, bucket, status, tx_count FROM block_groups WHERE block_number = ?"),
    add: db.prepare(
      `INSERT INTO window_groups (window, to_address, selector, bucket, status, tx_count) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(window, to_address, selector, bucket, status) DO UPDATE SET tx_count = tx_count + excluded.tx_count`,
    ),
    sub: db.prepare(
      "UPDATE window_groups SET tx_count = tx_count - ? WHERE window = ? AND to_address = ? AND selector = ? AND bucket = ? AND status = ?",
    ),
    delZero: db.prepare(
      "DELETE FROM window_groups WHERE window = ? AND to_address = ? AND selector = ? AND bucket = ? AND status = ? AND tx_count <= 0",
    ),
    // Per-contract totals and the bucket counters take signed deltas through
    // the same upsert; rows that reach zero are deleted afterwards.
    contractDelta: db.prepare(
      `INSERT INTO window_contracts (window, to_address, tx_count, tx_ex_token, covered_tx, covered_ex_token, not_covered_tx, verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT verified FROM contracts WHERE chain_id = ${LIVE_CHAIN_ID} AND address = ?))
       ON CONFLICT(window, to_address) DO UPDATE SET
         tx_count = tx_count + excluded.tx_count, tx_ex_token = tx_ex_token + excluded.tx_ex_token,
         covered_tx = covered_tx + excluded.covered_tx, covered_ex_token = covered_ex_token + excluded.covered_ex_token,
         not_covered_tx = not_covered_tx + excluded.not_covered_tx`,
    ),
    contractDelZero: db.prepare("DELETE FROM window_contracts WHERE window = ? AND to_address = ? AND tx_count <= 0"),
    counterDelta: db.prepare(
      `INSERT INTO window_counters (window, bucket, status, tx_count, std_count, unv_count) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(window, bucket, status) DO UPDATE SET tx_count = tx_count + excluded.tx_count,
         std_count = std_count + excluded.std_count, unv_count = unv_count + excluded.unv_count`,
    ),
    counterDelZero: db.prepare("DELETE FROM window_counters WHERE window = ? AND bucket = ? AND status = ? AND tx_count <= 0"),
    // Whether a contract is known-unverified, for the not-covered counter's unv_count.
    isUnverified: db.prepare(`SELECT ${unverifiedExistsSql("?")} AS u`),
    blocksBetweenOlderThan: db.prepare(
      "SELECT number, tx_count FROM blocks WHERE number >= ? AND number <= ? AND block_time < ? ORDER BY number",
    ),
    blocksBetween: db.prepare("SELECT number, tx_count, block_time FROM blocks WHERE number >= ? AND number <= ? ORDER BY number"),
    included: db.prepare(
      "SELECT MIN(number) AS lo, COUNT(*) AS n, COALESCE(SUM(tx_count), 0) AS tx FROM blocks WHERE number <= ? AND block_time >= ?",
    ),
    toInclude: db.prepare("SELECT number FROM blocks WHERE number < ? AND number <= ? AND block_time >= ? ORDER BY number DESC"),
    blockRow: db.prepare("SELECT number, tx_count, block_time FROM blocks WHERE number = ?"),
    newestBelow: db.prepare("SELECT number, tx_count, block_time FROM blocks WHERE number < ? ORDER BY number DESC LIMIT 1"),
  };
}
type Stmts = ReturnType<typeof stmts>;

/**
 * Apply one block's groups to a window with sign +1 (include) or -1 (exclude):
 * the group rows, the per-contract totals, and the bucket counters.
 */
function applyBlockGroups(s: Stmts, key: WindowKey, number: number, sign: 1 | -1): void {
  const contracts = new Map<string, { tx: number; ex: number; cov: number; covEx: number; nc: number }>();
  const counters = new Map<string, { bucket: string; status: string; tx: number; std: number; unv: number }>();
  const isCall = new Set<string>(CALL_BUCKETS);
  // verified = 0 lookups, once per address per call (the not-covered rows only)
  const unverifiedOf = new Map<string, boolean>();
  const isUnverified = (addr: string): boolean => {
    let v = unverifiedOf.get(addr);
    if (v === undefined) {
      v = (s.isUnverified.get(addr) as { u: number }).u === 1;
      unverifiedOf.set(addr, v);
    }
    return v;
  };
  for (const g of s.groupsOf.all(number) as GroupRow[]) {
    const n = sign * g.tx_count;
    if (sign > 0) s.add.run(key, g.to_address, g.selector, g.bucket, g.status, g.tx_count);
    else {
      s.sub.run(g.tx_count, key, g.to_address, g.selector, g.bucket, g.status);
      s.delZero.run(key, g.to_address, g.selector, g.bucket, g.status);
    }
    const std = STANDARD_TOKEN_SELECTORS.has(g.selector);
    const ck = `${g.bucket}|${g.status}`;
    const c = counters.get(ck) ?? { bucket: g.bucket, status: g.status, tx: 0, std: 0, unv: 0 };
    c.tx += n;
    if (std) c.std += n;
    if (g.bucket === "not_covered" && isUnverified(g.to_address)) c.unv += n;
    counters.set(ck, c);
    if (!isCall.has(g.bucket)) continue;
    const a = contracts.get(g.to_address) ?? { tx: 0, ex: 0, cov: 0, covEx: 0, nc: 0 };
    a.tx += n;
    if (!std) a.ex += n;
    if (g.bucket === "covered_theory") {
      a.cov += n;
      if (!std) a.covEx += n;
    } else if (g.bucket === "not_covered") a.nc += n;
    contracts.set(g.to_address, a);
  }
  for (const [addr, a] of contracts) {
    s.contractDelta.run(key, addr, a.tx, a.ex, a.cov, a.covEx, a.nc, addr);
    if (sign < 0) s.contractDelZero.run(key, addr);
  }
  for (const c of counters.values()) {
    s.counterDelta.run(key, c.bucket, c.status, c.tx, c.std, c.unv);
    if (sign < 0) s.counterDelZero.run(key, c.bucket, c.status);
  }
}

const addBlockGroups = (s: Stmts, key: WindowKey, number: number) => applyBlockGroups(s, key, number, 1);
const subBlockGroups = (s: Stmts, key: WindowKey, number: number) => applyBlockGroups(s, key, number, -1);

/** Subtract expired blocks so the window again holds exactly the blocks with block_time >= to_time - seconds. */
function expire(db: Db, s: Stmts, m: WindowMeta): WindowMeta {
  if (m.toBlock === null || m.fromBlock === null || m.toTime === null) return m;
  const cutoff = isoMinus(m.toTime, WINDOWS[m.window]);
  const expired = s.blocksBetweenOlderThan.all(m.fromBlock, m.toBlock, cutoff) as { number: number; tx_count: number }[];
  for (const b of expired) {
    subBlockGroups(s, m.window, b.number);
    m.blockCount -= 1;
    m.txTotal -= b.tx_count;
  }
  if (expired.length > 0) {
    const inc = s.included.get(m.toBlock, cutoff) as { lo: number | null; n: number; tx: number };
    if (inc.lo === null) return EMPTY(m.window);
    m.fromBlock = inc.lo;
    // Recomputed from `blocks`, which is what the incremental counts track.
    m.blockCount = inc.n;
    m.txTotal = inc.tx;
  }
  return m;
}

/**
 * Register a block that was just written to `blocks` / `block_groups`. Call
 * inside the same transaction. A block re-inserted under an existing number
 * must have been removed with `removeBlockFromWindows` first.
 */
export function addBlockToWindows(db: Db, block: { number: number; timeIso: string; txCount: number }): void {
  const s = stmts(db);
  for (const key of WINDOW_KEYS) {
    let m = windowMeta(db, key);
    const toTime = m.toTime === null || block.timeIso > m.toTime ? block.timeIso : m.toTime;
    const cutoff = isoMinus(toTime, WINDOWS[key]);
    if (block.timeIso < cutoff) continue; // older than the window: never part of it
    addBlockGroups(s, key, block.number);
    m = {
      window: key,
      fromBlock: m.fromBlock === null ? block.number : Math.min(m.fromBlock, block.number),
      toBlock: m.toBlock === null ? block.number : Math.max(m.toBlock, block.number),
      blockCount: m.blockCount + 1,
      txTotal: m.txTotal + block.txCount,
      toTime,
    };
    m = expire(db, s, m);
    writeMeta(db, m);
  }
}

/**
 * Take one block out of every window that includes it (before its rows are
 * replaced). Only used for a re-insert under an existing block number.
 */
export function removeBlockFromWindows(db: Db, number: number): void {
  const s = stmts(db);
  const b = s.blockRow.get(number) as { number: number; tx_count: number; block_time: string } | undefined;
  if (!b) return;
  for (const key of WINDOW_KEYS) {
    const m = windowMeta(db, key);
    if (m.fromBlock === null || m.toBlock === null || number < m.fromBlock || number > m.toBlock) continue;
    subBlockGroups(s, key, number);
    m.blockCount -= 1;
    m.txTotal -= b.tx_count;
    writeMeta(db, m);
  }
}

/**
 * Reorg rewind: every block >= `fromNumber` leaves every window; the window
 * end moves back to the newest surviving block, and blocks that end brings
 * back into range are re-included. Call before deleting the blocks' rows.
 */
export function removeBlocksFromWindows(db: Db, fromNumber: number): void {
  const s = stmts(db);
  for (const key of WINDOW_KEYS) {
    let m = windowMeta(db, key);
    if (m.toBlock === null || m.fromBlock === null || fromNumber > m.toBlock) continue;
    const removed = s.blocksBetween.all(Math.max(fromNumber, m.fromBlock), m.toBlock) as { number: number; tx_count: number }[];
    for (const b of removed) subBlockGroups(s, key, b.number);
    const end = s.newestBelow.get(fromNumber) as { number: number; tx_count: number; block_time: string } | undefined;
    if (!end) {
      writeMeta(db, EMPTY(key));
      continue;
    }
    const cutoff = isoMinus(end.block_time, WINDOWS[key]);
    // Blocks older than the old from_block that the earlier end time brings back.
    const back = s.toInclude.all(m.fromBlock, end.number, cutoff) as { number: number }[];
    for (const b of back) addBlockGroups(s, key, b.number);
    const inc = s.included.get(end.number, cutoff) as { lo: number | null; n: number; tx: number };
    m = inc.lo === null ? EMPTY(key) : { window: key, fromBlock: inc.lo, toBlock: end.number, blockCount: inc.n, txTotal: inc.tx, toTime: end.block_time };
    // Blocks in [inc.lo, old fromBlock) that were not in `back` cannot exist:
    // `back` is exactly the blocks below the old from_block with time >= cutoff.
    writeMeta(db, m);
  }
}

/** Oldest block any window still includes; pruning must stop below it. */
export function minWindowFromBlock(db: Db): number | null {
  const r = db.prepare("SELECT MIN(from_block) AS n FROM window_meta").get() as { n: number | null };
  return r.n;
}

// ---------------------------------------------------------------------------
// Rebuild and check

const REBUILD_GROUPS_SQL = `
  INSERT INTO window_groups (window, to_address, selector, bucket, status, tx_count)
  SELECT ?, to_address, selector, bucket, status, SUM(tx_count)
  FROM block_groups
  WHERE block_time >= ?
  GROUP BY to_address, selector, bucket, status`;
// No `block_number <= latest` predicate: every stored block is <= latest, and
// with it the planner walks the primary key over the whole table (12 minutes on
// a week of data) instead of a range read on block_time (~40 s).

/** Per-contract totals and bucket counters, derived from a window's group rows (`src` = table with window_groups columns). */
const rebuildDerivedSql = (src: string, contracts: string, counters: string) => [
  `INSERT INTO ${contracts} (window, to_address, tx_count, tx_ex_token, covered_tx, covered_ex_token, not_covered_tx, verified)
   SELECT window, to_address, SUM(tx_count),
          SUM(CASE WHEN selector NOT IN (${STANDARD_TOKEN_SELECTORS_SQL}) THEN tx_count ELSE 0 END),
          SUM(CASE WHEN bucket = 'covered_theory' THEN tx_count ELSE 0 END),
          SUM(CASE WHEN bucket = 'covered_theory' AND selector NOT IN (${STANDARD_TOKEN_SELECTORS_SQL}) THEN tx_count ELSE 0 END),
          SUM(CASE WHEN bucket = 'not_covered' THEN tx_count ELSE 0 END),
          (SELECT verified FROM contracts k WHERE k.chain_id = ${LIVE_CHAIN_ID} AND k.address = g.to_address)
   FROM ${src} g WHERE window = ? AND bucket IN ${CALL_BUCKETS_SQL}
   GROUP BY window, to_address`,
  `INSERT INTO ${counters} (window, bucket, status, tx_count, std_count, unv_count)
   SELECT g.window, g.bucket, g.status, SUM(g.tx_count),
          SUM(CASE WHEN g.selector IN (${STANDARD_TOKEN_SELECTORS_SQL}) THEN g.tx_count ELSE 0 END),
          SUM(CASE WHEN g.bucket = 'not_covered' AND ${unverifiedExistsSql("g.to_address")} THEN g.tx_count ELSE 0 END)
   FROM ${src} g WHERE g.window = ? GROUP BY g.window, g.bucket, g.status`,
];

/**
 * Drop and recompute every window from `block_groups` + `blocks`, relative to
 * the newest stored block. Used at follower start (covers databases created
 * before the window tables existed) and by the consistency check. The stored
 * rankings are cleared here and rebuilt by `refreshWindowRankings`.
 */
export function rebuildWindows(db: Db): { ms: number; rows: number } {
  const t0 = Date.now();
  let rows = 0;
  db.transaction(() => {
    db.prepare("DELETE FROM window_groups").run();
    db.prepare("DELETE FROM window_contracts").run();
    db.prepare("DELETE FROM window_counters").run();
    db.prepare("DELETE FROM window_ranking").run();
    db.prepare("DELETE FROM window_meta").run();
    const latest = db.prepare("SELECT number, block_time FROM blocks ORDER BY number DESC LIMIT 1").get() as
      | { number: number; block_time: string }
      | undefined;
    for (const key of WINDOW_KEYS) {
      if (!latest) {
        writeMeta(db, EMPTY(key));
        continue;
      }
      const cutoff = isoMinus(latest.block_time, WINDOWS[key]);
      rows += Number(db.prepare(REBUILD_GROUPS_SQL).run(key, cutoff).changes);
      for (const sql of rebuildDerivedSql("window_groups", "window_contracts", "window_counters")) db.prepare(sql).run(key);
      const inc = db
        .prepare("SELECT MIN(number) AS lo, COUNT(*) AS n, COALESCE(SUM(tx_count), 0) AS tx FROM blocks WHERE number <= ? AND block_time >= ?")
        .get(latest.number, cutoff) as { lo: number | null; n: number; tx: number };
      writeMeta(
        db,
        inc.lo === null
          ? EMPTY(key)
          : { window: key, fromBlock: inc.lo, toBlock: latest.number, blockCount: inc.n, txTotal: inc.tx, toTime: latest.block_time },
      );
    }
  })();
  return { ms: Date.now() - t0, rows };
}

/**
 * Compare the running totals with a fresh computation. Returns the first
 * differences found (empty = consistent). Read-only apart from a TEMP table.
 */
export function checkWindows(db: Db, opts: { maxDiffs?: number } = {}): string[] {
  const max = opts.maxDiffs ?? 5;
  const diffs: string[] = [];
  const latest = db.prepare("SELECT number, block_time FROM blocks ORDER BY number DESC LIMIT 1").get() as
    | { number: number; block_time: string }
    | undefined;
  db.exec("DROP TABLE IF EXISTS temp.expected_groups");
  db.exec(
    "CREATE TEMP TABLE expected_groups (window TEXT, to_address TEXT, selector TEXT, bucket TEXT, status TEXT, tx_count INTEGER, PRIMARY KEY (window, to_address, selector, bucket, status))",
  );
  for (const key of WINDOW_KEYS) {
    const m = windowMeta(db, key);
    if (!latest) {
      if (m.blockCount !== 0 || m.toBlock !== null) diffs.push(`${key}: meta not empty although no blocks are stored`);
      continue;
    }
    const cutoff = isoMinus(latest.block_time, WINDOWS[key]);
    db.prepare(REBUILD_GROUPS_SQL.replace("INSERT INTO window_groups", "INSERT INTO temp.expected_groups")).run(key, cutoff);
    const inc = db
      .prepare("SELECT MIN(number) AS lo, COUNT(*) AS n, COALESCE(SUM(tx_count), 0) AS tx FROM blocks WHERE number <= ? AND block_time >= ?")
      .get(latest.number, cutoff) as { lo: number | null; n: number; tx: number };
    const exp = { fromBlock: inc.lo, toBlock: inc.lo === null ? null : latest.number, blockCount: inc.n, txTotal: inc.tx, toTime: inc.lo === null ? null : latest.block_time };
    for (const f of ["fromBlock", "toBlock", "blockCount", "txTotal", "toTime"] as const) {
      if (m[f] !== exp[f]) diffs.push(`${key}: meta.${f} is ${String(m[f])}, expected ${String(exp[f])}`);
    }
    const missing = db
      .prepare(
        `SELECT to_address, selector, bucket, status, tx_count FROM temp.expected_groups WHERE window = ?
         EXCEPT SELECT to_address, selector, bucket, status, tx_count FROM window_groups WHERE window = ? LIMIT ?`,
      )
      .all(key, key, max) as GroupRow[];
    for (const r of missing) {
      const actual = db
        .prepare("SELECT tx_count FROM window_groups WHERE window = ? AND to_address = ? AND selector = ? AND bucket = ? AND status = ?")
        .get(key, r.to_address, r.selector, r.bucket, r.status) as { tx_count: number } | undefined;
      diffs.push(`${key}: ${r.to_address} ${r.selector} ${r.bucket}/${r.status || "-"}: expected ${r.tx_count}, have ${actual?.tx_count ?? 0}`);
    }
    const extra = db
      .prepare(
        `SELECT to_address, selector, bucket, status, tx_count FROM window_groups WHERE window = ?
         EXCEPT SELECT to_address, selector, bucket, status, tx_count FROM temp.expected_groups WHERE window = ? LIMIT ?`,
      )
      .all(key, key, max) as GroupRow[];
    for (const r of extra) {
      const shouldBe = db
        .prepare("SELECT tx_count FROM temp.expected_groups WHERE window = ? AND to_address = ? AND selector = ? AND bucket = ? AND status = ?")
        .get(key, r.to_address, r.selector, r.bucket, r.status) as { tx_count: number } | undefined;
      if (!shouldBe) diffs.push(`${key}: ${r.to_address} ${r.selector} ${r.bucket}/${r.status || "-"}: have ${r.tx_count}, expected no row`);
    }
    // The derived tables must equal what the expected groups derive to
    // (verified is a mirror of the contracts cache and is not compared).
    db.exec("DROP TABLE IF EXISTS temp.expected_contracts");
    db.exec("DROP TABLE IF EXISTS temp.expected_counters");
    db.exec(
      "CREATE TEMP TABLE expected_contracts (window TEXT, to_address TEXT, tx_count INTEGER, tx_ex_token INTEGER, covered_tx INTEGER, covered_ex_token INTEGER, not_covered_tx INTEGER, verified INTEGER)",
    );
    db.exec("CREATE TEMP TABLE expected_counters (window TEXT, bucket TEXT, status TEXT, tx_count INTEGER, std_count INTEGER, unv_count INTEGER)");
    for (const sql of rebuildDerivedSql("temp.expected_groups", "temp.expected_contracts", "temp.expected_counters")) db.prepare(sql).run(key);
    const cCols = "window, to_address, tx_count, tx_ex_token, covered_tx, covered_ex_token, not_covered_tx";
    const cDiff = db
      .prepare(
        `SELECT * FROM (SELECT ${cCols} FROM temp.expected_contracts WHERE window = ? EXCEPT SELECT ${cCols} FROM window_contracts WHERE window = ?)
         UNION ALL
         SELECT * FROM (SELECT ${cCols} FROM window_contracts WHERE window = ? EXCEPT SELECT ${cCols} FROM temp.expected_contracts WHERE window = ?) LIMIT ?`,
      )
      .all(key, key, key, key, max) as { to_address: string; tx_count: number }[];
    for (const r of cDiff) diffs.push(`${key}: window_contracts ${r.to_address} differs (tx_count ${r.tx_count} on one side)`);
    const kCols = "window, bucket, status, tx_count, std_count, unv_count";
    const kDiff = db
      .prepare(
        `SELECT * FROM (SELECT ${kCols} FROM temp.expected_counters WHERE window = ? EXCEPT SELECT ${kCols} FROM window_counters WHERE window = ?)
         UNION ALL
         SELECT * FROM (SELECT ${kCols} FROM window_counters WHERE window = ? EXCEPT SELECT ${kCols} FROM temp.expected_counters WHERE window = ?) LIMIT ?`,
      )
      .all(key, key, key, key, max) as { bucket: string; status: string; tx_count: number; std_count: number }[];
    for (const r of kDiff) diffs.push(`${key}: window_counters ${r.bucket}/${r.status || "-"} differs (${r.tx_count}/${r.std_count} on one side)`);
    db.exec("DROP TABLE IF EXISTS temp.expected_contracts");
    db.exec("DROP TABLE IF EXISTS temp.expected_counters");
    if (diffs.length >= max) break;
  }
  db.exec("DROP TABLE IF EXISTS temp.expected_groups");
  return diffs.slice(0, max);
}

// ---------------------------------------------------------------------------
// Counters (read side)

export interface WindowCounter {
  bucket: string;
  status: string;
  txCount: number;
  /** calls with a standard token selector */
  stdCount: number;
  /** calls to contracts Sourcify knows to be unverified (not_covered rows only) */
  unvCount: number;
}

export function windowCounters(db: Db, key: WindowKey): WindowCounter[] {
  return (
    db.prepare("SELECT bucket, status, tx_count, std_count, unv_count FROM window_counters WHERE window = ?").all(key) as {
      bucket: string;
      status: string;
      tx_count: number;
      std_count: number;
      unv_count: number;
    }[]
  ).map((r) => ({ bucket: r.bucket, status: r.status, txCount: r.tx_count, stdCount: r.std_count, unvCount: r.unv_count ?? 0 }));
}
