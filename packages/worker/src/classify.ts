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

import type { TxGroup } from "./bq/aggregate.js";
import { type CoverageLookup, key3 } from "./coverage/loadCoverageSet.js";

export type Bucket =
  | "contract_creation"
  | "eth_transfer"
  | "covered_theory"
  | "token_native"
  | "not_covered";

/** Standard ERC-20 / ERC-721 selectors that wallets can render without a descriptor. */
export const STANDARD_TOKEN_SELECTORS = new Set<string>([
  "0xa9059cbb", // transfer(address,uint256)
  "0x23b872dd", // transferFrom(address,address,uint256)
  "0x095ea7b3", // approve(address,uint256)
  "0x39509351", // increaseAllowance(address,uint256)
  "0xa457c2d7", // decreaseAllowance(address,uint256)
  "0x42842e0e", // safeTransferFrom(address,address,uint256)
  "0xb88d4fde", // safeTransferFrom(address,address,uint256,bytes)
  "0xa22cb465", // setApprovalForAll(address,bool)
]);

export interface ClassifiedGroup extends TxGroup {
  chainId: number;
  bucket: Bucket;
  functionSig?: string;
  entity?: string;
  descriptorPath?: string;
}

export function classifyGroup(
  g: TxGroup,
  chainId: number,
  cov: CoverageLookup,
): ClassifiedGroup {
  if (g.toAddress === null) return { ...g, chainId, bucket: "contract_creation" };
  if (g.selector === "0x" || g.selector === "0x00000000") {
    return { ...g, chainId, bucket: "eth_transfer" };
  }
  const hit = cov.bySelector.get(key3(chainId, g.toAddress, g.selector));
  if (hit) {
    return {
      ...g,
      chainId,
      bucket: "covered_theory",
      functionSig: hit.functionSig,
      entity: hit.entity,
      descriptorPath: hit.descriptorPath,
    };
  }
  if (STANDARD_TOKEN_SELECTORS.has(g.selector)) {
    return { ...g, chainId, bucket: "token_native" };
  }
  return { ...g, chainId, bucket: "not_covered" };
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

  // Rank not-covered contracts by volume, then walk the cumulative coverage.
  const byContract = new Map<string, RankedContract>();
  for (const g of groups) {
    if (g.bucket !== "not_covered" || g.toAddress === null) continue;
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
    c.topSelectors = c.topSelectors.slice(0, 5);
  }

  // Cumulative coverage over the "all txs" denominator. ETH transfers and
  // standard token transfers are already clear-signable natively, so the walk
  // starts from that baseline and adds each not-covered contract on top. This
  // makes "how many contracts to reach 80% / 95%" actionable.
  const baseline = buckets.covered_theory + buckets.token_native + buckets.eth_transfer;
  let cumulativeCovered = baseline;
  let contractsToReach80 = pct(baseline, totalTx) >= 80 ? 0 : Infinity;
  let contractsToReach95 = pct(baseline, totalTx) >= 95 ? 0 : Infinity;
  contracts.forEach((c, i) => {
    cumulativeCovered += c.txCount;
    c.cumulativePct = pct(cumulativeCovered, totalTx);
    if (contractsToReach80 === Infinity && c.cumulativePct >= 80) contractsToReach80 = i + 1;
    if (contractsToReach95 === Infinity && c.cumulativePct >= 95) contractsToReach95 = i + 1;
  });

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
