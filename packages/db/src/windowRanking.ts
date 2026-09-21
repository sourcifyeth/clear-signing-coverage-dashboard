/**
 * The "what to build next" ranking per window, computed once per block by the
 * follower and stored in `window_ranking`, so the summary endpoint returns it
 * without walking the long tail on every request.
 *
 * The not-covered rows never carry a standard token selector (a standard
 * selector on an uncovered contract is bucket token_native), so the sorted
 * list of not-covered contracts is the same under every exclusion. What the
 * exclusions change is the denominator (totalTx) and the baseline, and those
 * are cheap. So one stored row per window holds:
 *
 *   - the top `TOP_CONTRACTS` not-covered contracts with their selectors,
 *   - the cumulative not-covered call count at sampled ranks (the curve, as
 *     counts, so each exclusion derives its own percentages),
 *   - the 80% / 95% ranks for each of the four exclusion combinations,
 *   - the verification split (unverified calls, checked / total contracts).
 *
 * `windowRankingFor` turns a stored row into the summary's `ranking` block for
 * one exclusion combination; `liveSummary` calls it.
 */

import type { Db } from "./index.js";
import type { Bucket } from "./write.js";
import { pct, downsampleCurve, type RankedContract } from "./ranking.js";
import type { ExcludeOptions } from "./selectors.js";
import { WINDOW_KEYS, windowMeta, windowCounters, rebuildWindows, type WindowKey } from "./windows.js";

/** How many top contracts the stored row carries; the summary's `limit` is capped here. */
export const TOP_CONTRACTS = 100;
/** Sampled points of the cumulative curve kept in the stored row. */
export const CURVE_POINTS = 500;
const TOP_SELECTORS = 5;

export interface StoredRanking {
  toBlock: number | null;
  /** top not-covered contracts, most calls first; cumulativeTx = not-covered calls up to and including this rank */
  contracts: { toAddress: string; txCount: number; cumulativeTx: number; topSelectors: { selector: string; txCount: number }[] }[];
  totalContracts: number;
  /** cumulative not-covered calls at sampled ranks (rank n, sum of the first n contracts) */
  curve: { n: number; cum: number }[];
  /** [excludeEth][excludeToken] -> rank at which the cumulative share first reaches 80 / 95, or null */
  reach: { eth: boolean; token: boolean; r80: number | null; r95: number | null }[];
  notCoveredUnverified: number;
  verificationCoverage: { checked: number; total: number };
}

/** The summary numbers every exclusion combination needs, from the counters. */
export interface WindowTotals {
  buckets: Record<Bucket, number>;
  practice: { passTx: number; partialTx: number; failedTx: number };
  native: { ethTransfers: number; tokenTransfers: number };
  allTx: number;
  totalTx: number;
}

const EMPTY_BUCKETS = (): Record<Bucket, number> => ({
  contract_creation: 0,
  eth_transfer: 0,
  covered_theory: 0,
  token_native: 0,
  not_covered: 0,
});

/**
 * Bucket, practice and native totals of a window under an exclusion, read from
 * `window_counters`: excludeEth zeroes the eth_transfer bucket, excludeToken
 * removes the standard-selector calls from every bucket.
 */
export function windowTotals(db: Db, key: WindowKey, filter: ExcludeOptions): WindowTotals {
  const counters = windowCounters(db, key);
  const meta = windowMeta(db, key);
  const buckets = EMPTY_BUCKETS();
  const practice = { passTx: 0, partialTx: 0, failedTx: 0 };
  const native = { ethTransfers: 0, tokenTransfers: 0 };
  for (const c of counters) {
    if (c.bucket === "eth_transfer") native.ethTransfers += c.txCount;
    native.tokenTransfers += c.stdCount;
    if (filter.excludeEth && c.bucket === "eth_transfer") continue;
    const n = filter.excludeToken ? c.txCount - c.stdCount : c.txCount;
    if (c.bucket in buckets) buckets[c.bucket as Bucket] += n;
    if (c.bucket === "covered_theory") {
      if (c.status === "pass") practice.passTx += n;
      else if (c.status === "partial") practice.partialTx += n;
      else if (c.status === "failed") practice.failedTx += n;
    }
  }
  const allTx = meta.txTotal;
  const totalTx = allTx - (filter.excludeEth ? native.ethTransfers : 0) - (filter.excludeToken ? native.tokenTransfers : 0);
  return { buckets, practice, native, allTx, totalTx };
}

const COMBOS: { eth: boolean; token: boolean }[] = [
  { eth: false, token: false },
  { eth: true, token: false },
  { eth: false, token: true },
  { eth: true, token: true },
];

/** Baseline = calls a wallet already shows: covered + token-native + ETH sends (under the exclusion). */
const baselineOf = (t: WindowTotals) => t.buckets.covered_theory + t.buckets.token_native + t.buckets.eth_transfer;

/** Compute one window's ranking from `window_contracts` (one index-ordered read of the not-covered rows). */
export function computeWindowRanking(db: Db, key: WindowKey): StoredRanking {
  const meta = windowMeta(db, key);
  const rows = db
    .prepare(
      "SELECT to_address, not_covered_tx, verified FROM window_contracts WHERE window = ? AND not_covered_tx > 0 ORDER BY not_covered_tx DESC, to_address",
    )
    .all(key) as { to_address: string; not_covered_tx: number; verified: number | null }[];

  const totals = COMBOS.map((c) => windowTotals(db, key, { excludeEth: c.eth, excludeToken: c.token }));
  const reach = COMBOS.map((c, i) => {
    const t = totals[i];
    const b = pct(baselineOf(t), t.totalTx);
    return { eth: c.eth, token: c.token, r80: b >= 80 ? 0 : null as number | null, r95: b >= 95 ? 0 : null as number | null };
  });

  let cum = 0;
  let unverified = 0;
  let checked = 0;
  const cumAt: number[] = new Array(rows.length);
  rows.forEach((r, i) => {
    cum += r.not_covered_tx;
    cumAt[i] = cum;
    if (r.verified === 0) unverified += r.not_covered_tx;
    if (r.verified !== null) checked++;
    for (let k = 0; k < COMBOS.length; k++) {
      const t = totals[k];
      if (reach[k].r80 !== null && reach[k].r95 !== null) continue;
      const p = pct(baselineOf(t) + cum, t.totalTx);
      if (reach[k].r80 === null && p >= 80) reach[k].r80 = i + 1;
      if (reach[k].r95 === null && p >= 95) reach[k].r95 = i + 1;
    }
  });

  // Curve: the dense cumulative counts up to the largest cap any exclusion
  // combination needs (rankingCurve's rule: reach95 + 15, at least 150).
  // windowRankingFor re-caps and downsamples per combination, so the sampled
  // ranks equal what the on-the-fly computation produced.
  const maxReach95 = Math.max(0, ...reach.map((r) => r.r95 ?? 0));
  const cap = Math.min(rows.length, Math.max(maxReach95 + 15, 150));
  const curve = Array.from({ length: cap }, (_, i) => ({ n: i + 1, cum: cumAt[i] }));

  // Selectors of the top contracts (not-covered rows only, most calls first).
  const top = rows.slice(0, TOP_CONTRACTS);
  const selsOf = new Map<string, { selector: string; txCount: number }[]>();
  if (top.length > 0) {
    const inList = top.map(() => "?").join(",");
    const sel = db
      .prepare(
        `SELECT to_address, selector, tx_count FROM window_groups
         WHERE window = ? AND bucket = 'not_covered' AND to_address IN (${inList})
         ORDER BY tx_count DESC, selector`,
      )
      .all(key, ...top.map((r) => r.to_address)) as { to_address: string; selector: string; tx_count: number }[];
    for (const s of sel) {
      const list = selsOf.get(s.to_address) ?? [];
      if (list.length < TOP_SELECTORS) list.push({ selector: s.selector, txCount: s.tx_count });
      selsOf.set(s.to_address, list);
    }
  }

  return {
    toBlock: meta.toBlock,
    contracts: top.map((r, i) => ({ toAddress: r.to_address, txCount: r.not_covered_tx, cumulativeTx: cumAt[i], topSelectors: selsOf.get(r.to_address) ?? [] })),
    totalContracts: rows.length,
    curve,
    reach,
    notCoveredUnverified: unverified,
    verificationCoverage: { checked, total: rows.length },
  };
}

/** Compute and store every window's ranking. Call after a block is written (inside or right after its transaction). */
export function refreshWindowRankings(db: Db): { ms: number } {
  const t0 = Date.now();
  const put = db.prepare(
    `INSERT INTO window_ranking (window, exclude_eth, exclude_token, json, to_block, computed_at) VALUES (?, 0, 0, ?, ?, ?)
     ON CONFLICT(window, exclude_eth, exclude_token) DO UPDATE SET json = excluded.json, to_block = excluded.to_block, computed_at = excluded.computed_at`,
  );
  const now = new Date().toISOString();
  for (const key of WINDOW_KEYS) {
    const r = computeWindowRanking(db, key);
    put.run(key, JSON.stringify(r), r.toBlock, now);
  }
  return { ms: Date.now() - t0 };
}

/** The stored ranking of a window, or null when the follower has not written one yet. */
export function readWindowRanking(db: Db, key: WindowKey): StoredRanking | null {
  const r = db.prepare("SELECT json FROM window_ranking WHERE window = ? AND exclude_eth = 0 AND exclude_token = 0").get(key) as
    | { json: string }
    | undefined;
  return r ? (JSON.parse(r.json) as StoredRanking) : null;
}

/** Rebuild the window totals and then the stored rankings (follower start). */
export function rebuildWindowsAndRankings(db: Db): { ms: number; rows: number; rankingMs: number } {
  const w = rebuildWindows(db);
  const r = refreshWindowRankings(db);
  return { ms: w.ms + r.ms, rows: w.rows, rankingMs: r.ms };
}

/**
 * The summary's `ranking` block for one exclusion combination, derived from a
 * stored row and the window totals under that exclusion.
 */
export function windowRankingFor(
  stored: StoredRanking,
  totals: WindowTotals,
  filter: ExcludeOptions,
  opts: { limit?: number; curvePoints?: number } = {},
): {
  contracts: RankedContract[];
  totalContracts: number;
  contractsToReach80: number | null;
  contractsToReach95: number | null;
  curve: { n: number; pct: number }[];
  baselinePct: number;
} {
  const limit = Math.max(1, Math.min(opts.limit ?? TOP_CONTRACTS, TOP_CONTRACTS));
  const maxPoints = Math.max(10, Math.min(opts.curvePoints ?? CURVE_POINTS, 2000));
  const baseline = baselineOf(totals);
  const baselinePct = pct(baseline, totals.totalTx);
  const reach = stored.reach.find((r) => r.eth === !!filter.excludeEth && r.token === !!filter.excludeToken);
  const contracts: RankedContract[] = stored.contracts.slice(0, limit).map((c) => ({
    toAddress: c.toAddress,
    txCount: c.txCount,
    topSelectors: c.topSelectors,
    cumulativePct: pct(baseline + c.cumulativeTx, totals.totalTx),
  }));
  // Same cap rule as rankingCurve, for this combination's reach95.
  const cap = Math.min(stored.curve.length, Math.max((reach?.r95 ?? 150) + 15, 150));
  const pts = stored.curve.slice(0, cap).map((p) => ({ n: p.n, pct: pct(baseline + p.cum, totals.totalTx) }));
  return {
    contracts,
    totalContracts: stored.totalContracts,
    contractsToReach80: reach?.r80 ?? null,
    contractsToReach95: reach?.r95 ?? null,
    curve: [{ n: 0, pct: baselinePct }].concat(downsampleCurve(pts, maxPoints)),
    baselinePct,
  };
}
