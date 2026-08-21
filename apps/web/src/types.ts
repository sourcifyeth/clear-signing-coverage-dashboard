// Shape of the report JSON served by the API (mirrors packages/worker output).

export interface Buckets {
  contract_creation: number;
  eth_transfer: number;
  covered_theory: number;
  token_native: number;
  not_covered: number;
}

export interface RankedContract {
  toAddress: string;
  txCount: number;
  topSelectors: { selector: string; txCount: number }[];
  cumulativePct: number;
}

export interface Report {
  generatedAtIso: string;
  chainId: number;
  registryCommit: string | null;
  source: string;
  timeframe: { endIso: string; hours: number };
  bytesProcessed: number;
  report: {
    totalTx: number;
    buckets: Buckets;
    headline: {
      theoryPctOfAll: number;
      theoryPlusNativePctOfAll: number;
      theoryPctOfContractCalls: number;
    };
    ranking: {
      contracts: RankedContract[];
      contractsToReach80: number;
      contractsToReach95: number;
    };
  };
}
