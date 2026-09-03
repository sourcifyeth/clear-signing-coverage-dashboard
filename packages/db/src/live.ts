/**
 * Live block follower storage: one transaction per block on the write side,
 * rolling-window sums on the read side.
 *
 * We store, per transaction: hash, block, time, to, selector, bucket, and (for
 * covered ones) the library's pass/partial/failed status + warning codes.
 * Never calldata, value, or sender.
 */

import type { Db } from "./index.js";
import type { Bucket, PracticalStatus } from "./write.js";
import { computeRanking, rankingCurve, pct, type RankedContract } from "./ranking.js";
import { STANDARD_TOKEN_SELECTORS_SQL, excludeSql, type ExcludeOptions } from "./selectors.js";

// ---------------------------------------------------------------------------
// Write

export interface BlockIn {
  number: number;
  hash: string;
  parentHash: string;
  timeIso: string;
  txCount: number;
}

export interface LiveTxIn {
  hash: string;
  toAddress: string | null;
  selector: string;
  bucket: Bucket;
  status?: PracticalStatus;
  warnings?: { code: string; message: string }[];
  /** one-line intent (interpolatedIntent if present, else intent) */
  intent?: string;
  /** full DisplayModel from the library; stored as JSON, capped (see DISPLAY_JSON_MAX) */
  display?: unknown;
}

/** Max bytes of display_json per tx. Larger models are stored in a reduced form. */
export const DISPLAY_JSON_MAX = 8 * 1024;

const jsonReplacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

/**
 * Serialize a DisplayModel for storage. If it exceeds DISPLAY_JSON_MAX, keep a
 * reduced record: { truncated: true, intent, interpolatedIntent, warnings, fieldCount }.
 */
export function serializeDisplay(display: unknown): string | null {
  if (display === undefined || display === null) return null;
  const full = JSON.stringify(display, jsonReplacer);
  if (full.length <= DISPLAY_JSON_MAX) return full;
  const d = display as {
    intent?: unknown;
    interpolatedIntent?: unknown;
    warnings?: unknown;
    fields?: unknown[];
  };
  return JSON.stringify(
    {
      truncated: true,
      intent: d.intent,
      interpolatedIntent: d.interpolatedIntent,
      warnings: d.warnings ?? [],
      fieldCount: Array.isArray(d.fields) ? d.fields.length : 0,
    },
    jsonReplacer,
  );
}

export interface BlockGroupIn {
  toAddress: string | null;
  selector: string;
  bucket: Bucket;
  status?: PracticalStatus;
  txCount: number;
}

/** Insert one block with all its tx rows and group rows, atomically. */
export function insertBlock(db: Db, block: BlockIn, txs: LiveTxIn[], groups: BlockGroupIn[]): void {
  const insBlock = db.prepare(
    `INSERT OR REPLACE INTO blocks (number, hash, parent_hash, block_time, tx_count, processed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insTx = db.prepare(
    `INSERT OR REPLACE INTO tx_index
       (tx_hash, block_number, block_hash, block_time, to_address, selector, bucket, status, warnings_json, intent, display_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insGroup = db.prepare(
    `INSERT OR REPLACE INTO block_groups (block_number, block_time, to_address, selector, bucket, status, tx_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    // A reprocessed block (reorg) replaces its previous rows.
    db.prepare("DELETE FROM tx_index WHERE block_number = ?").run(block.number);
    db.prepare("DELETE FROM block_groups WHERE block_number = ?").run(block.number);
    insBlock.run(
      block.number,
      block.hash.toLowerCase(),
      block.parentHash.toLowerCase(),
      block.timeIso,
      block.txCount,
      new Date().toISOString(),
    );
    for (const t of txs) {
      insTx.run(
        t.hash.toLowerCase(),
        block.number,
        block.hash.toLowerCase(),
        block.timeIso,
        t.toAddress?.toLowerCase() ?? null,
        t.selector.toLowerCase(),
        t.bucket,
        t.status ?? null,
        t.warnings && t.warnings.length ? JSON.stringify(t.warnings.map((w) => ({ code: w.code, message: w.message }))) : null,
        t.intent ?? null,
        serializeDisplay(t.display),
      );
    }
    for (const g of groups) {
      insGroup.run(
        block.number,
        block.timeIso,
        g.toAddress?.toLowerCase() ?? "",
        g.selector.toLowerCase(),
        g.bucket,
        g.status ?? "",
        g.txCount,
      );
    }
  })();
}

/** Remove every block >= `number` (and its tx / group rows). Used on reorgs. */
export function deleteBlocksFrom(db: Db, number: number): number {
  return db.transaction((): number => {
    db.prepare("DELETE FROM tx_index WHERE block_number >= ?").run(number);
    db.prepare("DELETE FROM block_groups WHERE block_number >= ?").run(number);
    const res = db.prepare("DELETE FROM blocks WHERE number >= ?").run(number);
    return Number(res.changes);
  })();
}

/** Delete live rows older than `days`. Returns blocks removed. */
export function pruneLive(db: Db, days: number, now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  return db.transaction((): number => {
    const maxOld = db
      .prepare("SELECT MAX(number) AS n FROM blocks WHERE block_time < ?")
      .get(cutoff) as { n: number | null };
    if (maxOld.n === null) return 0;
    db.prepare("DELETE FROM tx_index WHERE block_number <= ?").run(maxOld.n);
    db.prepare("DELETE FROM block_groups WHERE block_number <= ?").run(maxOld.n);
    const res = db.prepare("DELETE FROM blocks WHERE number <= ?").run(maxOld.n);
    return Number(res.changes);
  })();
}

/** Stored hash of a block, for parent-hash verification. */
export function blockHash(db: Db, number: number): string | null {
  const r = db.prepare("SELECT hash FROM blocks WHERE number = ?").get(number) as { hash: string } | undefined;
  return r?.hash ?? null;
}

// ---------------------------------------------------------------------------
// Read

export interface LatestBlock {
  number: number;
  hash: string;
  timeIso: string;
  txCount: number;
  processedAtIso: string;
}

export function latestBlock(db: Db): LatestBlock | null {
  const r = db
    .prepare("SELECT number, hash, block_time, tx_count, processed_at FROM blocks ORDER BY number DESC LIMIT 1")
    .get() as
    | { number: number; hash: string; block_time: string; tx_count: number; processed_at: string }
    | undefined;
  if (!r) return null;
  return { number: r.number, hash: r.hash, timeIso: r.block_time, txCount: r.tx_count, processedAtIso: r.processed_at };
}

export function liveBlockCount(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM blocks").get() as { n: number }).n;
}

export interface LiveSummary {
  window: { hours: number; fromIso: string; toIso: string };
  blocks: number;
  firstBlock: number | null;
  lastBlock: number | null;
  /** transactions the numbers below are computed over (after exclusions) */
  totalTx: number;
  /** every transaction in the window, before exclusions */
  allTx: number;
  filter: { excludeEth: boolean; excludeToken: boolean };
  /** wallet-native counts in the window, always measured: plain ETH sends, and standard token calls (covered or not) */
  native: { ethTransfers: number; tokenTransfers: number };
  /** the part of `native` the filter removed from totalTx */
  excluded: { ethTransfers: number; tokenTransfers: number };
  buckets: Record<Bucket, number>;
  headline: {
    theoryPctOfAll: number;
    theoryPlusNativePctOfAll: number;
    theoryPctOfContractCalls: number;
  };
  /** library outcome over covered_theory txs in the window */
  practice: { passTx: number; partialTx: number; failedTx: number; practicePct: number };
  ranking: {
    contracts: RankedContract[];
    totalContracts: number;
    contractsToReach80: number | null;
    contractsToReach95: number | null;
    curve: { n: number; pct: number }[];
  };
}

const EMPTY_BUCKETS = (): Record<Bucket, number> => ({
  contract_creation: 0,
  eth_transfer: 0,
  covered_theory: 0,
  token_native: 0,
  not_covered: 0,
});

/**
 * Rolling-window summary. The window ends at the latest processed block (not
 * wall-clock now), so a paused follower still shows its last complete window.
 */
export function liveSummary(
  db: Db,
  windowHours: number,
  opts: { limit?: number; curvePoints?: number } & ExcludeOptions = {},
): LiveSummary {
  const latest = latestBlock(db);
  const toIso = latest?.timeIso ?? new Date().toISOString();
  const fromIso = new Date(new Date(toIso).getTime() - windowHours * 3_600_000).toISOString();
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 5000));
  const filter = { excludeEth: !!opts.excludeEth, excludeToken: !!opts.excludeToken };
  const ex = excludeSql(filter);

  const range = db
    .prepare(
      "SELECT MIN(number) AS lo, MAX(number) AS hi, COUNT(*) AS n, COALESCE(SUM(tx_count), 0) AS tx FROM blocks WHERE block_time >= ? AND block_time <= ?",
    )
    .get(fromIso, toIso) as { lo: number | null; hi: number | null; n: number; tx: number };

  const buckets = EMPTY_BUCKETS();
  const practice = { passTx: 0, partialTx: 0, failedTx: 0, practicePct: 0 };
  const native = { ethTransfers: 0, tokenTransfers: 0 };
  let notCovered: { toAddress: string; selector: string; txCount: number }[] = [];

  if (range.lo !== null && range.hi !== null) {
    // block_groups carries block_time, so the window is a range on the covering
    // index with no join to blocks. The exclusion clauses apply to every query
    // here, so buckets, practice, and the ranking agree with each other.
    const bucketRows = db
      .prepare(
        `SELECT bucket, SUM(tx_count) AS n FROM block_groups WHERE block_time >= ? AND block_time <= ?${ex} GROUP BY bucket`,
      )
      .all(fromIso, toIso) as { bucket: Bucket; n: number }[];
    for (const r of bucketRows) if (r.bucket in buckets) buckets[r.bucket] = r.n;

    native.ethTransfers = (
      db
        .prepare(
          "SELECT COALESCE(SUM(tx_count), 0) AS n FROM block_groups WHERE block_time >= ? AND block_time <= ? AND bucket = 'eth_transfer'",
        )
        .get(fromIso, toIso) as { n: number }
    ).n;
    native.tokenTransfers = (
      db
        .prepare(
          `SELECT COALESCE(SUM(tx_count), 0) AS n FROM block_groups WHERE block_time >= ? AND block_time <= ? AND selector IN (${STANDARD_TOKEN_SELECTORS_SQL})`,
        )
        .get(fromIso, toIso) as { n: number }
    ).n;

    const statusRows = db
      .prepare(
        `SELECT status, SUM(tx_count) AS n FROM block_groups WHERE block_time >= ? AND block_time <= ? AND bucket = 'covered_theory'${ex} GROUP BY status`,
      )
      .all(fromIso, toIso) as { status: string; n: number }[];
    for (const r of statusRows) {
      if (r.status === "pass") practice.passTx = r.n;
      else if (r.status === "partial") practice.partialTx = r.n;
      else if (r.status === "failed") practice.failedTx = r.n;
    }
    const covered = practice.passTx + practice.partialTx + practice.failedTx;
    practice.practicePct = pct(practice.passTx + practice.partialTx, covered);

    notCovered = (
      db
        .prepare(
          `SELECT to_address, selector, SUM(tx_count) AS n FROM block_groups
           WHERE block_time >= ? AND block_time <= ? AND bucket = 'not_covered'${ex}
           GROUP BY to_address, selector`,
        )
        .all(fromIso, toIso) as { to_address: string; selector: string; n: number }[]
    ).map((r) => ({ toAddress: r.to_address, selector: r.selector, txCount: r.n }));
  }

  const allTx = range.tx;
  const excluded = {
    ethTransfers: filter.excludeEth ? native.ethTransfers : 0,
    tokenTransfers: filter.excludeToken ? native.tokenTransfers : 0,
  };
  const totalTx = allTx - excluded.ethTransfers - excluded.tokenTransfers;
  // With a bucket excluded its count is 0 here, so the ranking baseline shrinks
  // to what is still counted (e.g. descriptors only).
  const ranking = computeRanking(notCovered, buckets, totalTx);
  const contractCalls = totalTx - buckets.eth_transfer - buckets.contract_creation;

  return {
    window: { hours: windowHours, fromIso, toIso },
    blocks: range.n,
    firstBlock: range.lo,
    lastBlock: range.hi,
    totalTx,
    allTx,
    filter,
    native,
    excluded,
    buckets,
    headline: {
      theoryPctOfAll: pct(buckets.covered_theory, totalTx),
      theoryPlusNativePctOfAll: ranking.baselinePct,
      theoryPctOfContractCalls: pct(buckets.covered_theory, contractCalls),
    },
    practice,
    ranking: {
      contracts: ranking.contracts.slice(0, limit),
      totalContracts: ranking.contracts.length,
      contractsToReach80: ranking.contractsToReach80,
      contractsToReach95: ranking.contractsToReach95,
      curve: rankingCurve(ranking, { maxPoints: opts.curvePoints }),
    },
  };
}

export interface LiveTxOut {
  hash: string;
  blockNumber: number;
  blockTimeIso: string;
  toAddress: string | null;
  selector: string;
  bucket: Bucket;
  status: PracticalStatus | null;
  warnings: { code: string; message: string }[];
  intent: string | null;
  /**
   * The whole clear-signed text, built from the stored display model:
   * the intent followed by every field as "Label: value", joined with " · ".
   * Null when no model is stored (non-covered txs, or rows before the column existed).
   */
  displayText: string | null;
  entity: string | null;
  functionSig: string | null;
  /** registry path of the descriptor that covers this call, e.g. "registry/lido/calldata-wstETH.json" */
  descriptorPath: string | null;
}

export interface LiveTxDetailOut extends LiveTxOut {
  blockHash: string | null;
  /** parsed display_json (a DisplayModel, or the reduced { truncated: true, ... } record) */
  display: unknown | null;
}

interface RawLiveTx {
  tx_hash: string;
  block_number: number;
  block_hash: string | null;
  block_time: string;
  to_address: string | null;
  selector: string;
  bucket: Bucket;
  status: PracticalStatus | null;
  warnings_json: string | null;
  intent: string | null;
  display_json: string | null;
  entity: string | null;
  function_sig: string | null;
  descriptor_path: string | null;
  sig_name: string | null;
}

const LIVE_TX_SELECT = `
  SELECT t.tx_hash, t.block_number, t.block_hash, t.block_time, t.to_address, t.selector, t.bucket, t.status,
         t.warnings_json, t.intent, t.display_json, c.entity, c.function_sig, c.descriptor_path, s.name AS sig_name
  FROM tx_index t
  LEFT JOIN coverage c ON c.chain_id = ? AND c.address = t.to_address AND c.selector = t.selector
  LEFT JOIN signatures s ON s.selector = t.selector`;

// ---------------------------------------------------------------------------
// Selector -> signature cache (filled by the follower from 4byte.sourcify.dev)

export interface SignatureIn {
  selector: string;
  /** canonical signature, or null when the lookup found nothing */
  name: string | null;
  verified: boolean;
}

/**
 * Selectors that need no lookup: known names, plus unknown ones looked up
 * less than `retryAfterHours` ago.
 */
export function knownSelectors(db: Db, retryAfterHours = 24): Set<string> {
  const cutoff = new Date(Date.now() - retryAfterHours * 3600_000).toISOString();
  const rows = db
    .prepare(`SELECT selector FROM signatures WHERE name IS NOT NULL OR fetched_at > ?`)
    .all(cutoff) as { selector: string }[];
  return new Set(rows.map((r) => r.selector));
}

export function upsertSignatures(db: Db, rows: SignatureIn[]): void {
  if (rows.length === 0) return;
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO signatures (selector, name, verified, fetched_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(selector) DO UPDATE SET name = excluded.name, verified = excluded.verified, fetched_at = excluded.fetched_at`,
  );
  const run = db.transaction((rs: SignatureIn[]) => {
    for (const r of rs) stmt.run(r.selector.toLowerCase(), r.name, r.verified ? 1 : 0, now);
  });
  run(rows);
}

interface StoredField {
  label?: string;
  value?: unknown;
  fields?: StoredField[];
}

/** Flatten fields and field groups into "Label: value" parts, in display order. */
function fieldParts(fields: StoredField[] | undefined, out: string[] = []): string[] {
  for (const f of fields ?? []) {
    if (Array.isArray(f.fields)) fieldParts(f.fields, out);
    else if (f.value !== undefined && f.value !== null) {
      const v = typeof f.value === "string" ? f.value : JSON.stringify(f.value);
      out.push(f.label ? `${f.label}: ${v}` : v);
    }
  }
  return out;
}

/** Full clear-signed line from a stored display model, or null if there is none. */
export function displayTextOf(displayJson: string | null, intent: string | null): string | null {
  if (!displayJson) return null;
  let d: { intent?: unknown; interpolatedIntent?: unknown; fields?: StoredField[]; rawCalldataFallback?: unknown };
  try {
    d = JSON.parse(displayJson);
  } catch {
    return intent;
  }
  if (d.rawCalldataFallback) return null;
  const head =
    typeof d.interpolatedIntent === "string"
      ? d.interpolatedIntent
      : typeof d.intent === "string"
        ? d.intent
        : intent ?? "";
  const parts = fieldParts(d.fields);
  return [head, ...parts].filter(Boolean).join(" · ") || null;
}

function toLiveTx(r: RawLiveTx): LiveTxOut {
  return {
    hash: r.tx_hash,
    blockNumber: r.block_number,
    blockTimeIso: r.block_time,
    toAddress: r.to_address,
    selector: r.selector,
    bucket: r.bucket,
    status: r.status,
    warnings: r.warnings_json ? JSON.parse(r.warnings_json) : [],
    intent: r.intent,
    displayText: displayTextOf(r.display_json, r.intent),
    entity: r.entity,
    // registry signature (has parameter names) first, else the 4byte lookup
    functionSig: r.function_sig ?? r.sig_name,
    descriptorPath: r.descriptor_path,
  };
}

/** Most recent transactions, newest first. `sinceBlock` = strictly after that block. */
export function recentTxs(
  db: Db,
  opts: { limit?: number; bucket?: Bucket; sinceBlock?: number; chainId?: number } & ExcludeOptions = {},
): LiveTxOut[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
  const chainId = opts.chainId ?? 1;
  const where: string[] = ["1 = 1"];
  const params: unknown[] = [chainId];
  if (opts.bucket) {
    where.push("t.bucket = ?");
    params.push(opts.bucket);
  }
  if (opts.sinceBlock !== undefined) {
    where.push("t.block_number > ?");
    params.push(opts.sinceBlock);
  }
  params.push(limit);
  const rows = db
    .prepare(
      `${LIVE_TX_SELECT}
       WHERE ${where.join(" AND ")}${excludeSql(opts, "t")}
       ORDER BY t.block_number DESC, t.rowid DESC
       LIMIT ?`,
    )
    .all(...params) as RawLiveTx[];
  return rows.map(toLiveTx);
}

// ---------------------------------------------------------------------------
// Per-block breakdown (for the "last blocks" strip)

export interface BlockStat {
  number: number;
  timeIso: string;
  total: number;
  /** plain ETH sends */
  eth: number;
  /** standard token transfer/approval calls, covered or not */
  tokenStd: number;
  /** covered_theory calls that are NOT standard token calls */
  coveredOther: number;
  notCovered: number;
  creation: number;
}

/** The newest `limit` blocks, oldest first, each with its bucket breakdown. */
export function blockStats(db: Db, limit = 60): BlockStat[] {
  const n = Math.max(1, Math.min(limit, 1000));
  const rows = db
    .prepare(
      `SELECT g.block_number AS number, MAX(g.block_time) AS block_time,
              SUM(g.tx_count) AS total,
              SUM(CASE WHEN g.bucket = 'eth_transfer' THEN g.tx_count ELSE 0 END) AS eth,
              SUM(CASE WHEN g.selector IN (${STANDARD_TOKEN_SELECTORS_SQL}) THEN g.tx_count ELSE 0 END) AS token_std,
              SUM(CASE WHEN g.bucket = 'covered_theory' AND g.selector NOT IN (${STANDARD_TOKEN_SELECTORS_SQL}) THEN g.tx_count ELSE 0 END) AS covered_other,
              SUM(CASE WHEN g.bucket = 'not_covered' THEN g.tx_count ELSE 0 END) AS not_covered,
              SUM(CASE WHEN g.bucket = 'contract_creation' THEN g.tx_count ELSE 0 END) AS creation
       FROM block_groups g
       WHERE g.block_number IN (SELECT number FROM blocks ORDER BY number DESC LIMIT ?)
       GROUP BY g.block_number
       ORDER BY g.block_number ASC`,
    )
    .all(n) as {
    number: number;
    block_time: string;
    total: number;
    eth: number;
    token_std: number;
    covered_other: number;
    not_covered: number;
    creation: number;
  }[];
  return rows.map((r) => ({
    number: r.number,
    timeIso: r.block_time,
    total: r.total,
    eth: r.eth,
    tokenStd: r.token_std,
    coveredOther: r.covered_other,
    notCovered: r.not_covered,
    creation: r.creation,
  }));
}

export interface BlockDetail {
  block: LatestBlock;
  stat: BlockStat;
  txs: LiveTxOut[];
}

/** One block: header, bucket breakdown, and every stored transaction row (in block order). */
export function blockDetail(db: Db, number: number, chainId = 1): BlockDetail | undefined {
  const b = db
    .prepare("SELECT number, hash, block_time, tx_count, processed_at FROM blocks WHERE number = ?")
    .get(number) as { number: number; hash: string; block_time: string; tx_count: number; processed_at: string } | undefined;
  if (!b) return undefined;
  const stat = blockStatsFor(db, [number])[0] ?? {
    number,
    timeIso: b.block_time,
    total: 0,
    eth: 0,
    tokenStd: 0,
    coveredOther: 0,
    notCovered: 0,
    creation: 0,
  };
  const rows = db
    .prepare(`${LIVE_TX_SELECT} WHERE t.block_number = ? ORDER BY t.rowid ASC`)
    .all(chainId, number) as RawLiveTx[];
  return {
    block: { number: b.number, hash: b.hash, timeIso: b.block_time, txCount: b.tx_count, processedAtIso: b.processed_at },
    stat,
    txs: rows.map(toLiveTx),
  };
}

/** Bucket breakdown for specific block numbers (same shape as blockStats). */
function blockStatsFor(db: Db, numbers: number[]): BlockStat[] {
  if (numbers.length === 0) return [];
  const inList = numbers.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT g.block_number AS number, MAX(g.block_time) AS block_time,
              SUM(g.tx_count) AS total,
              SUM(CASE WHEN g.bucket = 'eth_transfer' THEN g.tx_count ELSE 0 END) AS eth,
              SUM(CASE WHEN g.selector IN (${STANDARD_TOKEN_SELECTORS_SQL}) THEN g.tx_count ELSE 0 END) AS token_std,
              SUM(CASE WHEN g.bucket = 'covered_theory' AND g.selector NOT IN (${STANDARD_TOKEN_SELECTORS_SQL}) THEN g.tx_count ELSE 0 END) AS covered_other,
              SUM(CASE WHEN g.bucket = 'not_covered' THEN g.tx_count ELSE 0 END) AS not_covered,
              SUM(CASE WHEN g.bucket = 'contract_creation' THEN g.tx_count ELSE 0 END) AS creation
       FROM block_groups g
       WHERE g.block_number IN (${inList})
       GROUP BY g.block_number
       ORDER BY g.block_number ASC`,
    )
    .all(...numbers) as {
    number: number;
    block_time: string;
    total: number;
    eth: number;
    token_std: number;
    covered_other: number;
    not_covered: number;
    creation: number;
  }[];
  return rows.map((r) => ({
    number: r.number,
    timeIso: r.block_time,
    total: r.total,
    eth: r.eth,
    tokenStd: r.token_std,
    coveredOther: r.covered_other,
    notCovered: r.not_covered,
    creation: r.creation,
  }));
}

/** The registry commit the follower last loaded the coverage set from. */
export function registryCommit(db: Db): string | null {
  const r = db.prepare("SELECT registry_commit FROM coverage LIMIT 1").get() as { registry_commit: string | null } | undefined;
  return r?.registry_commit ?? null;
}

// ---------------------------------------------------------------------------
// Window rankings: contracts and functions by transaction count, with coverage

export interface RankedSelector {
  selector: string;
  /** registry signature, else the 4byte name, else null */
  functionSig: string | null;
  txCount: number;
  covered: boolean;
}

export interface RankedContractRow {
  toAddress: string;
  entity: string | null;
  /** the address has a descriptor in the registry (even if the called functions are not all covered) */
  inRegistry: boolean;
  txCount: number;
  sharePct: number;
  cumulativePct: number;
  coveredTx: number;
  coveredPct: number;
  distinctSelectors: number;
  topSelectors: RankedSelector[];
}

export interface RankedFunctionRow {
  toAddress: string;
  entity: string | null;
  selector: string;
  functionSig: string | null;
  bucket: Bucket;
  covered: boolean;
  txCount: number;
  sharePct: number;
  cumulativePct: number;
}

export interface LiveRanking {
  window: { hours: number; fromIso: string; toIso: string };
  by: "contract" | "function";
  /** contract calls counted in the window after exclusions (the denominator of sharePct) */
  totalTx: number;
  contracts?: RankedContractRow[];
  functions?: RankedFunctionRow[];
}

const CALL_BUCKETS_SQL = "('covered_theory','token_native','not_covered')";

export function liveRanking(
  db: Db,
  windowHours: number,
  opts: { by: "contract" | "function"; limit?: number; chainId?: number } & ExcludeOptions,
): LiveRanking {
  const latest = latestBlock(db);
  const toIso = latest?.timeIso ?? new Date().toISOString();
  const fromIso = new Date(new Date(toIso).getTime() - windowHours * 3_600_000).toISOString();
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
  const chainId = opts.chainId ?? 1;
  // Queries that join coverage/signatures need the block_groups columns
  // qualified, since those tables have a `selector` column too.
  const whereFor = (alias: string) => {
    const p = alias ? `${alias}.` : "";
    return `${p}block_time >= ? AND ${p}block_time <= ? AND ${p}bucket IN ${CALL_BUCKETS_SQL}${excludeSql(opts, alias)}`;
  };
  const where = whereFor("");
  const whereG = whereFor("g");

  const totalTx = (
    db.prepare(`SELECT COALESCE(SUM(tx_count), 0) AS n FROM block_groups WHERE ${where}`).get(fromIso, toIso) as {
      n: number;
    }
  ).n;
  const window = { hours: windowHours, fromIso, toIso };

  if (opts.by === "function") {
    const rows = db
      .prepare(
        `SELECT g.to_address, g.selector, MAX(g.bucket) AS bucket, SUM(g.tx_count) AS n,
                c.function_sig, c.entity, s.name AS sig_name
         FROM block_groups g
         LEFT JOIN coverage c ON c.chain_id = ? AND c.address = g.to_address AND c.selector = g.selector
         LEFT JOIN signatures s ON s.selector = g.selector
         WHERE ${whereG}
         GROUP BY g.to_address, g.selector
         ORDER BY n DESC
         LIMIT ?`,
      )
      .all(chainId, fromIso, toIso, limit) as {
      to_address: string;
      selector: string;
      bucket: Bucket;
      n: number;
      function_sig: string | null;
      entity: string | null;
      sig_name: string | null;
    }[];
    let cum = 0;
    const functions: RankedFunctionRow[] = rows.map((r) => {
      cum += r.n;
      return {
        toAddress: r.to_address,
        entity: r.entity,
        selector: r.selector,
        functionSig: r.function_sig ?? r.sig_name,
        bucket: r.bucket,
        covered: r.bucket === "covered_theory",
        txCount: r.n,
        sharePct: pct(r.n, totalTx),
        cumulativePct: pct(cum, totalTx),
      };
    });
    return { window, by: "function", totalTx, functions };
  }

  const rows = db
    .prepare(
      `SELECT to_address, SUM(tx_count) AS n,
              SUM(CASE WHEN bucket = 'covered_theory' THEN tx_count ELSE 0 END) AS covered,
              COUNT(DISTINCT selector) AS selectors
       FROM block_groups
       WHERE ${where}
       GROUP BY to_address
       ORDER BY n DESC
       LIMIT ?`,
    )
    .all(fromIso, toIso, limit) as { to_address: string; n: number; covered: number; selectors: number }[];
  if (rows.length === 0) return { window, by: "contract", totalTx, contracts: [] };

  const addrs = rows.map((r) => r.to_address);
  const inList = addrs.map(() => "?").join(",");

  // Entity + "is in the registry" per address.
  const entityRows = db
    .prepare(`SELECT address, MIN(entity) AS entity FROM coverage WHERE chain_id = ? AND address IN (${inList}) GROUP BY address`)
    .all(chainId, ...addrs) as { address: string; entity: string | null }[];
  const entityOf = new Map(entityRows.map((r) => [r.address, r.entity]));

  // Per-selector volume for the listed contracts, with names.
  const selRows = db
    .prepare(
      `SELECT g.to_address, g.selector, MAX(g.bucket) AS bucket, SUM(g.tx_count) AS n,
              c.function_sig, s.name AS sig_name
       FROM block_groups g
       LEFT JOIN coverage c ON c.chain_id = ? AND c.address = g.to_address AND c.selector = g.selector
       LEFT JOIN signatures s ON s.selector = g.selector
       WHERE ${whereG} AND g.to_address IN (${inList})
       GROUP BY g.to_address, g.selector
       ORDER BY n DESC`,
    )
    .all(chainId, fromIso, toIso, ...addrs) as {
    to_address: string;
    selector: string;
    bucket: Bucket;
    n: number;
    function_sig: string | null;
    sig_name: string | null;
  }[];
  const selsOf = new Map<string, RankedSelector[]>();
  for (const r of selRows) {
    const list = selsOf.get(r.to_address) ?? [];
    if (list.length < 6) {
      list.push({
        selector: r.selector,
        functionSig: r.function_sig ?? r.sig_name,
        txCount: r.n,
        covered: r.bucket === "covered_theory",
      });
    }
    selsOf.set(r.to_address, list);
  }

  let cum = 0;
  const contracts: RankedContractRow[] = rows.map((r) => {
    cum += r.n;
    return {
      toAddress: r.to_address,
      entity: entityOf.get(r.to_address) ?? null,
      inRegistry: entityOf.has(r.to_address),
      txCount: r.n,
      sharePct: pct(r.n, totalTx),
      cumulativePct: pct(cum, totalTx),
      coveredTx: r.covered,
      coveredPct: pct(r.covered, r.n),
      distinctSelectors: r.selectors,
      topSelectors: selsOf.get(r.to_address) ?? [],
    };
  });
  return { window, by: "contract", totalTx, contracts };
}

/** One stored transaction with its library result, or undefined if not indexed. */
export function liveTx(db: Db, hash: string, chainId = 1): LiveTxDetailOut | undefined {
  const r = db
    .prepare(`${LIVE_TX_SELECT} WHERE t.tx_hash = ?`)
    .get(chainId, hash.toLowerCase()) as RawLiveTx | undefined;
  if (!r) return undefined;
  return {
    ...toLiveTx(r),
    blockHash: r.block_hash,
    display: r.display_json ? JSON.parse(r.display_json) : null,
  };
}
