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

// --- live (block follower) ---

export type BucketKey = keyof Buckets;
export type LiveStatus = "pass" | "partial" | "failed";

export interface LatestBlock {
  number: number;
  hash: string;
  timeIso: string;
  txCount: number;
  processedAtIso?: string;
}

export interface LiveSummary {
  window: { hours: number; fromIso: string; toIso: string };
  blocks: number;
  firstBlock: number | null;
  lastBlock: number | null;
  /** transactions the numbers are computed over, after exclusions */
  totalTx: number;
  /** every transaction in the window, before exclusions */
  allTx: number;
  filter: { excludeEth: boolean; excludeToken: boolean };
  /** wallet-native counts, always measured */
  native: { ethTransfers: number; tokenTransfers: number };
  /** the part of `native` removed from totalTx by the filter */
  excluded: { ethTransfers: number; tokenTransfers: number };
  buckets: Buckets;
  headline: {
    theoryPctOfAll: number;
    theoryPlusNativePctOfAll: number;
    theoryPctOfContractCalls: number;
  };
  practice: { passTx: number; partialTx: number; failedTx: number; practicePct: number };
  ranking: {
    contracts: RankedContract[];
    totalContracts: number;
    contractsToReach80: number | null;
    contractsToReach95: number | null;
    curve: { n: number; pct: number }[];
  };
}

export interface LiveTx {
  hash: string;
  blockNumber: number;
  blockTimeIso: string;
  toAddress: string | null;
  selector: string;
  bucket: BucketKey;
  status: LiveStatus | null;
  warnings: { code: string; message: string }[];
  /** one-line intent the library produced (covered txs only) */
  intent: string | null;
  /** the whole clear-signed text: intent plus every field, "Label: value" joined by " · " */
  displayText: string | null;
  entity: string | null;
  functionSig: string | null;
}

/** /api/live/tx/:hash — a stored row plus the library's DisplayModel. */
export interface LiveTxDetail extends LiveTx {
  blockHash: string | null;
  /** a DisplayModel, or { truncated: true, intent, interpolatedIntent, warnings, fieldCount } */
  display: unknown | null;
}

/** /api/live/blocks — one block's bucket breakdown. */
export interface BlockStat {
  number: number;
  timeIso: string;
  total: number;
  eth: number;
  /** standard token transfer/approval calls, covered or not */
  tokenStd: number;
  /** covered calls that are not standard token calls */
  coveredOther: number;
  notCovered: number;
  creation: number;
}

export interface LiveBlockEvent {
  block: LatestBlock;
  txs: LiveTx[];
  summary: LiveSummary;
  /** the block(s) this event announces */
  blocks: BlockStat[];
}

/** /api/live/block/:number */
export interface BlockDetail {
  block: LatestBlock;
  stat: BlockStat;
  txs: LiveTx[];
}

export interface LiveLatest {
  latest: LatestBlock | null;
  blocks: number;
  registryCommit: string | null;
}

// --- window rankings ---

export interface RankedSelector {
  selector: string;
  functionSig: string | null;
  txCount: number;
  covered: boolean;
}

export interface RankedContractRow {
  toAddress: string;
  entity: string | null;
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
  bucket: BucketKey;
  covered: boolean;
  txCount: number;
  sharePct: number;
  cumulativePct: number;
}

export interface LiveRanking {
  window: { hours: number; fromIso: string; toIso: string };
  by: "contract" | "function";
  totalTx: number;
  contracts?: RankedContractRow[];
  functions?: RankedFunctionRow[];
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
