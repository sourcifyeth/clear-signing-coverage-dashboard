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
  totalTx: number;
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
  opts: { limit?: number; curvePoints?: number } = {},
): LiveSummary {
  const latest = latestBlock(db);
  const toIso = latest?.timeIso ?? new Date().toISOString();
  const fromIso = new Date(new Date(toIso).getTime() - windowHours * 3_600_000).toISOString();
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 5000));

  const range = db
    .prepare(
      "SELECT MIN(number) AS lo, MAX(number) AS hi, COUNT(*) AS n, COALESCE(SUM(tx_count), 0) AS tx FROM blocks WHERE block_time >= ? AND block_time <= ?",
    )
    .get(fromIso, toIso) as { lo: number | null; hi: number | null; n: number; tx: number };

  const buckets = EMPTY_BUCKETS();
  const practice = { passTx: 0, partialTx: 0, failedTx: 0, practicePct: 0 };
  let notCovered: { toAddress: string; selector: string; txCount: number }[] = [];

  if (range.lo !== null && range.hi !== null) {
    // block_groups carries block_time, so the window is a range on the covering
    // index with no join to blocks.
    const bucketRows = db
      .prepare(
        "SELECT bucket, SUM(tx_count) AS n FROM block_groups WHERE block_time >= ? AND block_time <= ? GROUP BY bucket",
      )
      .all(fromIso, toIso) as { bucket: Bucket; n: number }[];
    for (const r of bucketRows) if (r.bucket in buckets) buckets[r.bucket] = r.n;

    const statusRows = db
      .prepare(
        "SELECT status, SUM(tx_count) AS n FROM block_groups WHERE block_time >= ? AND block_time <= ? AND bucket = 'covered_theory' GROUP BY status",
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
           WHERE block_time >= ? AND block_time <= ? AND bucket = 'not_covered'
           GROUP BY to_address, selector`,
        )
        .all(fromIso, toIso) as { to_address: string; selector: string; n: number }[]
    ).map((r) => ({ toAddress: r.to_address, selector: r.selector, txCount: r.n }));
  }

  const totalTx = range.tx;
  const ranking = computeRanking(notCovered, buckets, totalTx);
  const contractCalls = totalTx - buckets.eth_transfer - buckets.contract_creation;

  return {
    window: { hours: windowHours, fromIso, toIso },
    blocks: range.n,
    firstBlock: range.lo,
    lastBlock: range.hi,
    totalTx,
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
  sig_name: string | null;
}

const LIVE_TX_SELECT = `
  SELECT t.tx_hash, t.block_number, t.block_hash, t.block_time, t.to_address, t.selector, t.bucket, t.status,
         t.warnings_json, t.intent, t.display_json, c.entity, c.function_sig, s.name AS sig_name
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
  };
}

/** Most recent transactions, newest first. `sinceBlock` = strictly after that block. */
export function recentTxs(
  db: Db,
  opts: { limit?: number; bucket?: Bucket; sinceBlock?: number; chainId?: number } = {},
): LiveTxOut[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
  const chainId = opts.chainId ?? 1;
  const where: string[] = [];
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
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY t.block_number DESC, t.rowid DESC
       LIMIT ?`,
    )
    .all(...params) as RawLiveTx[];
  return rows.map(toLiveTx);
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
