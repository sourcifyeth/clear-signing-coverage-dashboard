/**
 * The cumulative "what to build next" walk, shared by Stage B (buildReport)
 * and the live rolling-window summary.
 *
 * Baseline = covered_theory + token_native + eth_transfer (all already
 * clear-signable from the wallet's point of view). Not-covered contracts are
 * then added in descending tx-volume order; contractsToReach80/95 is the rank
 * at which the cumulative share first crosses the threshold, or null when the
 * window never gets there.
 */

import type { Bucket } from "./write.js";

export interface NotCoveredGroup {
  toAddress: string;
  selector: string;
  txCount: number;
}

export interface RankedContract {
  toAddress: string;
  txCount: number;
  topSelectors: { selector: string; txCount: number }[];
  cumulativePct: number;
}

export interface Ranking {
  contracts: RankedContract[];
  contractsToReach80: number | null;
  contractsToReach95: number | null;
  /** baseline % before any contract is added */
  baselinePct: number;
}

export const pct = (n: number, d: number): number => (d === 0 ? 0 : (n / d) * 100);

export function computeRanking(
  notCovered: NotCoveredGroup[],
  buckets: Record<Bucket, number>,
  totalTx: number,
  topSelectorsPerContract = 5,
): Ranking {
  const byContract = new Map<string, RankedContract>();
  for (const g of notCovered) {
    let rc = byContract.get(g.toAddress);
    if (!rc) {
      rc = { toAddress: g.toAddress, txCount: 0, topSelectors: [], cumulativePct: 0 };
      byContract.set(g.toAddress, rc);
    }
    rc.txCount += g.txCount;
    rc.topSelectors.push({ selector: g.selector, txCount: g.txCount });
  }
  const contracts = [...byContract.values()].sort((a, b) => b.txCount - a.txCount);
  for (const c of contracts) {
    c.topSelectors.sort((a, b) => b.txCount - a.txCount);
    c.topSelectors = c.topSelectors.slice(0, topSelectorsPerContract);
  }

  const baseline = buckets.covered_theory + buckets.token_native + buckets.eth_transfer;
  const baselinePct = pct(baseline, totalTx);
  let cumulative = baseline;
  let contractsToReach80: number | null = baselinePct >= 80 ? 0 : null;
  let contractsToReach95: number | null = baselinePct >= 95 ? 0 : null;
  contracts.forEach((c, i) => {
    cumulative += c.txCount;
    c.cumulativePct = pct(cumulative, totalTx);
    if (contractsToReach80 === null && c.cumulativePct >= 80) contractsToReach80 = i + 1;
    if (contractsToReach95 === null && c.cumulativePct >= 95) contractsToReach95 = i + 1;
  });

  return { contracts, contractsToReach80, contractsToReach95, baselinePct };
}

/**
 * Downsample a cumulative curve to at most `maxPoints`. The first 60% of the
 * budget keeps exact ranks (where the curve is steep); the rest is strided; the
 * last point is always kept.
 */
export function downsampleCurve(
  points: { n: number; pct: number }[],
  maxPoints: number,
): { n: number; pct: number }[] {
  if (points.length <= maxPoints) return points;
  const dense = Math.floor(maxPoints * 0.6);
  const head = points.slice(0, dense);
  const rest = points.slice(dense);
  const stride = Math.ceil(rest.length / (maxPoints - dense - 1));
  const tail = rest.filter((_, i) => i % stride === 0);
  const last = points[points.length - 1];
  if (tail[tail.length - 1] !== last) tail.push(last);
  return head.concat(tail);
}

/** Build the chart curve `[{n:0, baseline}, {n:1,..}, ...]` from a ranking. */
export function rankingCurve(
  ranking: Ranking,
  opts: { maxPoints?: number; cap?: number } = {},
): { n: number; pct: number }[] {
  const maxPoints = Math.max(10, Math.min(opts.maxPoints ?? 500, 2000));
  const cap = Math.min(
    ranking.contracts.length,
    opts.cap ?? Math.max((ranking.contractsToReach95 ?? 150) + 15, 150),
  );
  const pts = ranking.contracts.slice(0, cap).map((c, i) => ({ n: i + 1, pct: c.cumulativePct }));
  return [{ n: 0, pct: ranking.baselinePct }].concat(downsampleCurve(pts, maxPoints));
}
