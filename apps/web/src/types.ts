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
    warningCodeTotals: Record<string, number>;
  };
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
