/**
 * Load the Stage A coverage set and build fast lookups for classifying
 * transaction groups.
 *
 * Only ~1250 mainnet rows, so we keep it in memory and join in Node rather than
 * uploading a table to BigQuery (which would need dataEditor on a dataset).
 */

import { buildCoverageSet, type CoveredCalldata } from "@ccd/coverage";

export interface CoverageLookup {
  registryCommit: string | null;
  /** key `${chainId}|${address}|${selector}` -> covered row */
  bySelector: Map<string, CoveredCalldata>;
  /** key `${chainId}|${address}` -> true if any selector covered */
  coveredAddresses: Set<string>;
  rowCount: number;
}

export function key3(chainId: number, address: string, selector: string): string {
  return `${chainId}|${address.toLowerCase()}|${selector.toLowerCase()}`;
}
export function key2(chainId: number, address: string): string {
  return `${chainId}|${address.toLowerCase()}`;
}

export function loadCoverageLookup(opts: {
  registryPath: string;
  registryCommit?: string | null;
  chainIds?: number[];
}): CoverageLookup {
  const set = buildCoverageSet({
    registryPath: opts.registryPath,
    registryCommit: opts.registryCommit ?? null,
    chainIds: opts.chainIds,
  });
  const bySelector = new Map<string, CoveredCalldata>();
  const coveredAddresses = new Set<string>();
  for (const r of set.rows) {
    bySelector.set(key3(r.chainId, r.address, r.selector), r);
    coveredAddresses.add(key2(r.chainId, r.address));
  }
  return {
    registryCommit: set.registryCommit,
    bySelector,
    coveredAddresses,
    rowCount: set.rows.length,
  };
}
