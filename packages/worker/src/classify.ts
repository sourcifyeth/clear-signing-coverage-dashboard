/**
 * Classify each transaction group into one bucket, then compute the headline
 * coverage numbers and the "what to build to reach 80% / 95%" ranking.
 *
 * Bucket priority (first match wins):
 *   contract_creation  to_address is null
 *   eth_transfer       empty input ('0x')
 *   covered_theory     (chainId, to, selector) is in the registry coverage set
 *   token_native       a standard ERC-20/721 selector (wallets render natively)
 *   not_covered        everything else
 *
 * covered_theory is checked before token_native so a token whose transfer is in
 * the registry counts as covered, not merely native.
 */

import { computeRanking, STANDARD_TOKEN_SELECTORS } from "@ccd/db";
import type { CoveredCalldata } from "@ccd/coverage";
import type { TxGroup } from "./bq/aggregate.js";
import { type CoverageLookup, key3 } from "./coverage/loadCoverageSet.js";

export type Bucket =
  | "contract_creation"
  | "eth_transfer"
  | "covered_theory"
  | "token_native"
  | "not_covered";

/** Standard ERC-20 / ERC-721 selectors that wallets can render without a descriptor. */
// The list lives in @ccd/db so the API can exclude the same selectors in SQL.
export { STANDARD_TOKEN_SELECTORS };

export interface ClassifiedGroup extends TxGroup {
  chainId: number;
  bucket: Bucket;
  functionSig?: string;
  entity?: string;
  descriptorPath?: string;
}

/**
 * Bucket for one (to, selector) pair. Shared by Stage B (per group) and the
 * live follower (per transaction). Returns the coverage row on a hit.
 */
export function bucketFor(
  toAddress: string | null,
  selector: string,
  chainId: number,
  cov: CoverageLookup,
): { bucket: Bucket; hit?: CoveredCalldata } {
  if (toAddress === null) return { bucket: "contract_creation" };
  if (selector === "0x" || selector === "0x00000000") return { bucket: "eth_transfer" };
  const hit = cov.bySelector.get(key3(chainId, toAddress, selector));
  if (hit) return { bucket: "covered_theory", hit };
  if (STANDARD_TOKEN_SELECTORS.has(selector)) return { bucket: "token_native" };
  return { bucket: "not_covered" };
}

export function classifyGroup(
  g: TxGroup,
  chainId: number,
  cov: CoverageLookup,
): ClassifiedGroup {
  const { bucket, hit } = bucketFor(g.toAddress, g.selector, chainId, cov);
  if (hit) {
    return {
      ...g,
      chainId,
      bucket,
      functionSig: hit.functionSig,
      entity: hit.entity,
      descriptorPath: hit.descriptorPath,
    };
  }
  return { ...g, chainId, bucket };
}

export interface BucketTotals {
  contract_creation: number;
  eth_transfer: number;
  covered_theory: number;
  token_native: number;
  not_covered: number;
}

export interface RankedContract {
  toAddress: string;
  txCount: number; // total across its not-covered selectors in the window
  topSelectors: { selector: string; txCount: number }[];
  cumulativePct: number; // cumulative coverage % reached AFTER adding this contract
}

export interface CoverageReport {
  totalTx: number;
  buckets: BucketTotals;
  /** headline % under different denominator definitions */
  headline: {
    // denominator = all txs
    theoryPctOfAll: number;
    // denominator = all txs, counting eth+token native as clear-signable too
    theoryPlusNativePctOfAll: number;
    // denominator = contract calls only (exclude eth_transfer + contract_creation)
    theoryPctOfContractCalls: number;
  };
  /** ranked not-covered contracts and how many are needed to reach thresholds */
  ranking: {
    contracts: RankedContract[];
    contractsToReach80: number;
    contractsToReach95: number;
  };
}

function pct(n: number, d: number): number {
  return d === 0 ? 0 : (n / d) * 100;
}

export function buildReport(groups: ClassifiedGroup[]): CoverageReport {
  const buckets: BucketTotals = {
    contract_creation: 0,
    eth_transfer: 0,
    covered_theory: 0,
    token_native: 0,
    not_covered: 0,
  };
  for (const g of groups) buckets[g.bucket] += g.txCount;
  const totalTx = groups.reduce((s, g) => s + g.txCount, 0);

  // Denominators.
  const contractCalls = totalTx - buckets.eth_transfer - buckets.contract_creation;

  // Rank not-covered contracts by volume, then walk the cumulative coverage
  // (shared with the live rolling-window summary in @ccd/db). ETH transfers
  // and standard token transfers are already clear-signable natively, so the
  // walk starts from that baseline and adds each not-covered contract on top.
  // This makes "how many contracts to reach 80% / 95%" actionable.
  const notCovered = groups
    .filter((g) => g.bucket === "not_covered" && g.toAddress !== null)
    .map((g) => ({ toAddress: g.toAddress as string, selector: g.selector, txCount: g.txCount }));
  const ranking = computeRanking(notCovered, buckets, totalTx);
  const contracts: RankedContract[] = ranking.contracts;
  const contractsToReach80 = ranking.contractsToReach80 ?? Infinity;
  const contractsToReach95 = ranking.contractsToReach95 ?? Infinity;

  return {
    totalTx,
    buckets,
    headline: {
      theoryPctOfAll: pct(buckets.covered_theory, totalTx),
      theoryPlusNativePctOfAll: pct(
        buckets.covered_theory + buckets.token_native + buckets.eth_transfer,
        totalTx,
      ),
      theoryPctOfContractCalls: pct(buckets.covered_theory, contractCalls),
    },
    ranking: {
      contracts,
      contractsToReach80,
      contractsToReach95,
    },
  };
}
