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

export interface PracticalProblem {
  toAddress: string;
  selector: string;
  functionSig?: string;
  entity?: string;
  descriptorPath?: string;
  txCount: number;
  status: "pass" | "partial" | "failed";
  intent?: string;
  warnings: { code: string; message: string }[];
  sampleTxHash: string;
}

export interface PracticalReport {
  generatedAtIso: string;
  chainId: number;
  registryCommit: string | null;
  sampleWindow: { endIso: string; hours: number };
  bytesProcessed: number;
  report: {
    sampledGroups: number;
    counts: { pass: number; partial: number; failed: number };
    txWeighted: {
      coveredSampledTx: number;
      passTx: number;
      partialTx: number;
      failedTx: number;
      practicePct: number;
    };
    problems: PracticalProblem[];
    examples: { hash: string; entity?: string; functionSig?: string; toAddress: string }[];
    feed: FeedItem[];
    warningCodeTotals: Record<string, number>;
  };
}

export interface FeedItem {
  hash: string;
  toAddress: string;
  selector: string;
  entity?: string;
  functionSig?: string;
  status: "pass" | "partial" | "failed";
  intent?: string;
  txCount: number;
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
      /** top N ranked not-covered contracts (the API limits this; see ?limit=) */
      contracts: RankedContract[];
      /** number of ranked contracts in the full set */
      totalContracts?: number;
      contractsToReach80: number | null;
      contractsToReach95: number | null;
      /** downsampled cumulative coverage curve; n = contracts added, n=0 is the baseline */
      curve?: { n: number; pct: number }[];
    };
  };
}
