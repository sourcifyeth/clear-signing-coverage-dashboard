/**
 * Read side: the API asks for the latest (or a specific) run and gets back the
 * same JSON shapes the web app consumed from the out/*.json files, except that
 * the ranking is limited to the top N contracts plus a downsampled curve.
 */

import type { Db } from "./index.js";
import type { Bucket, PracticalStatus } from "./write.js";

export interface RunRow {
  id: number;
  kind: "aggregate" | "practical";
  generatedAtIso: string;
  chainId: number;
  window: { endIso: string; hours: number };
  source: string | null;
  registryCommit: string | null;
  bytesProcessed: number;
  totalTx?: number;
}

interface RawRun {
  id: number;
  kind: "aggregate" | "practical";
  generated_at: string;
  chain_id: number;
  window_end: string;
  window_hours: number;
  source: string | null;
  registry_commit: string | null;
  bytes_processed: number;
  total_tx: number | null;
}

const RUN_SELECT = `
  SELECT r.id, r.kind, r.generated_at, r.chain_id, r.window_end, r.window_hours,
         r.source, r.registry_commit, r.bytes_processed, h.total_tx
  FROM runs r LEFT JOIN headline h ON h.run_id = r.id`;

function toRunRow(r: RawRun): RunRow {
  return {
    id: r.id,
    kind: r.kind,
    generatedAtIso: r.generated_at,
    chainId: r.chain_id,
    window: { endIso: r.window_end, hours: r.window_hours },
    source: r.source,
    registryCommit: r.registry_commit,
    bytesProcessed: r.bytes_processed,
    ...(r.total_tx !== null ? { totalTx: r.total_tx } : {}),
  };
}

export function listRuns(db: Db, kind?: "aggregate" | "practical", limit = 100): RunRow[] {
  const rows = kind
    ? db.prepare(`${RUN_SELECT} WHERE r.kind = ? ORDER BY r.generated_at DESC LIMIT ?`).all(kind, limit)
    : db.prepare(`${RUN_SELECT} ORDER BY r.generated_at DESC LIMIT ?`).all(limit);
  return (rows as RawRun[]).map(toRunRow);
}

function getRun(db: Db, kind: "aggregate" | "practical", id: number | "latest"): RawRun | undefined {
  if (id === "latest") {
    return db
      .prepare(`${RUN_SELECT} WHERE r.kind = ? ORDER BY r.generated_at DESC LIMIT 1`)
      .get(kind) as RawRun | undefined;
  }
  return db.prepare(`${RUN_SELECT} WHERE r.kind = ? AND r.id = ?`).get(kind, id) as RawRun | undefined;
}

// ---------------------------------------------------------------------------
// Aggregate report (Stage B)

export interface RankedContractOut {
  toAddress: string;
  txCount: number;
  topSelectors: { selector: string; txCount: number }[];
  cumulativePct: number;
}

export interface ReportOut {
  runId: number;
  generatedAtIso: string;
  chainId: number;
  registryCommit: string | null;
  source: string;
  timeframe: { endIso: string; hours: number };
  bytesProcessed: number;
  report: {
    totalTx: number;
    buckets: Record<Bucket, number>;
    headline: {
      theoryPctOfAll: number;
      theoryPlusNativePctOfAll: number;
      theoryPctOfContractCalls: number;
    };
    ranking: {
      contracts: RankedContractOut[];
      /** number of ranked (not-covered) contracts in the full set */
      totalContracts: number;
      contractsToReach80: number | null;
      contractsToReach95: number | null;
      /** cumulative coverage curve, downsampled; n = contracts added */
      curve: { n: number; pct: number }[];
    };
  };
}

const pct = (n: number, d: number) => (d === 0 ? 0 : (n / d) * 100);

/**
 * Downsample the cumulative curve to at most `maxPoints`. The first `dense`
 * ranks are kept exact because that is where the curve is steep; the rest is
 * strided. The final rank is always included.
 */
function downsampleCurve(
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

export function readReport(
  db: Db,
  id: number | "latest",
  opts: { limit?: number; curvePoints?: number } = {},
): ReportOut | undefined {
  const run = getRun(db, "aggregate", id);
  if (!run) return undefined;
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 5000));
  const curvePoints = Math.max(10, Math.min(opts.curvePoints ?? 500, 2000));

  const h = db
    .prepare(
      `SELECT total_tx, contract_creation, eth_transfer, covered_theory, token_native, not_covered,
              contracts_to_80, contracts_to_95
       FROM headline WHERE run_id = ?`,
    )
    .get(run.id) as
    | {
        total_tx: number;
        contract_creation: number;
        eth_transfer: number;
        covered_theory: number;
        token_native: number;
        not_covered: number;
        contracts_to_80: number | null;
        contracts_to_95: number | null;
      }
    | undefined;
  if (!h) return undefined;

  const buckets: Record<Bucket, number> = {
    contract_creation: h.contract_creation,
    eth_transfer: h.eth_transfer,
    covered_theory: h.covered_theory,
    token_native: h.token_native,
    not_covered: h.not_covered,
  };
  const totalTx = h.total_tx;
  const contractCalls = totalTx - buckets.eth_transfer - buckets.contract_creation;

  const top = db
    .prepare(
      `SELECT rank, to_address, tx_count, top_selectors_json, cumulative_pct
       FROM ranking WHERE run_id = ? ORDER BY rank LIMIT ?`,
    )
    .all(run.id, limit) as {
    rank: number;
    to_address: string;
    tx_count: number;
    top_selectors_json: string;
    cumulative_pct: number;
  }[];

  const totalContracts = (
    db.prepare("SELECT COUNT(*) AS n FROM ranking WHERE run_id = ?").get(run.id) as { n: number }
  ).n;

  // Curve: same cap the chart used before (to95 + 15, at least 150), then
  // downsampled so the payload stays small for any ranking size.
  const cap = Math.min(totalContracts, Math.max((h.contracts_to_95 ?? 150) + 15, 150));
  const curveRows = db
    .prepare("SELECT rank, cumulative_pct FROM ranking WHERE run_id = ? AND rank <= ? ORDER BY rank")
    .all(run.id, cap) as { rank: number; cumulative_pct: number }[];
  const baseline = pct(buckets.covered_theory + buckets.token_native + buckets.eth_transfer, totalTx);
  const curve = [{ n: 0, pct: baseline }].concat(
    downsampleCurve(
      curveRows.map((r) => ({ n: r.rank, pct: r.cumulative_pct })),
      curvePoints,
    ),
  );

  return {
    runId: run.id,
    generatedAtIso: run.generated_at,
    chainId: run.chain_id,
    registryCommit: run.registry_commit,
    source: run.source ?? "",
    timeframe: { endIso: run.window_end, hours: run.window_hours },
    bytesProcessed: run.bytes_processed,
    report: {
      totalTx,
      buckets,
      headline: {
        theoryPctOfAll: pct(buckets.covered_theory, totalTx),
        theoryPlusNativePctOfAll: baseline,
        theoryPctOfContractCalls: pct(buckets.covered_theory, contractCalls),
      },
      ranking: {
        contracts: top.map((r) => ({
          toAddress: r.to_address,
          txCount: r.tx_count,
          topSelectors: JSON.parse(r.top_selectors_json),
          cumulativePct: r.cumulative_pct,
        })),
        totalContracts,
        contractsToReach80: h.contracts_to_80,
        contractsToReach95: h.contracts_to_95,
        curve,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Practical report (Stage C)

export interface PracticalRowOut {
  toAddress: string;
  selector: string;
  functionSig?: string;
  entity?: string;
  descriptorPath?: string;
  txCount: number;
  status: PracticalStatus;
  intent?: string;
  warnings: { code: string; message: string }[];
  sampleTxHash: string;
}

export interface FeedItemOut {
  hash: string;
  toAddress: string;
  selector: string;
  entity?: string;
  functionSig?: string;
  status: PracticalStatus;
  intent?: string;
  txCount: number;
}

export interface PracticalOut {
  runId: number;
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
    problems: PracticalRowOut[];
    examples: { hash: string; entity?: string; functionSig?: string; toAddress: string }[];
    feed: FeedItemOut[];
    warningCodeTotals: Record<string, number>;
  };
}

export function readPractical(db: Db, id: number | "latest"): PracticalOut | undefined {
  const run = getRun(db, "practical", id);
  if (!run) return undefined;

  const rows = (
    db
      .prepare(
        `SELECT to_address, selector, tx_count, status, intent, warnings_json, sample_tx_hash,
                function_sig, entity, descriptor_path
         FROM practical WHERE run_id = ? ORDER BY tx_count DESC`,
      )
      .all(run.id) as {
      to_address: string;
      selector: string;
      tx_count: number;
      status: PracticalStatus;
      intent: string | null;
      warnings_json: string;
      sample_tx_hash: string;
      function_sig: string | null;
      entity: string | null;
      descriptor_path: string | null;
    }[]
  ).map<PracticalRowOut>((r) => ({
    toAddress: r.to_address,
    selector: r.selector,
    ...(r.function_sig !== null ? { functionSig: r.function_sig } : {}),
    ...(r.entity !== null ? { entity: r.entity } : {}),
    ...(r.descriptor_path !== null ? { descriptorPath: r.descriptor_path } : {}),
    txCount: r.tx_count,
    status: r.status,
    ...(r.intent !== null ? { intent: r.intent } : {}),
    warnings: JSON.parse(r.warnings_json),
    sampleTxHash: r.sample_tx_hash,
  }));

  const counts = { pass: 0, partial: 0, failed: 0 };
  const tx = { coveredSampledTx: 0, passTx: 0, partialTx: 0, failedTx: 0 };
  const warningCodeTotals: Record<string, number> = {};
  for (const r of rows) {
    counts[r.status]++;
    tx.coveredSampledTx += r.txCount;
    if (r.status === "pass") tx.passTx += r.txCount;
    else if (r.status === "partial") tx.partialTx += r.txCount;
    else tx.failedTx += r.txCount;
    for (const w of r.warnings) warningCodeTotals[w.code] = (warningCodeTotals[w.code] ?? 0) + 1;
  }
  const practicePct = tx.coveredSampledTx ? ((tx.passTx + tx.partialTx) / tx.coveredSampledTx) * 100 : 0;

  return {
    runId: run.id,
    generatedAtIso: run.generated_at,
    chainId: run.chain_id,
    registryCommit: run.registry_commit,
    sampleWindow: { endIso: run.window_end, hours: run.window_hours },
    bytesProcessed: run.bytes_processed,
    report: {
      sampledGroups: rows.length,
      counts,
      txWeighted: { ...tx, practicePct },
      problems: rows.filter((r) => r.status !== "pass"),
      examples: rows
        .filter((r) => r.status === "pass")
        .slice(0, 8)
        .map((r) => ({
          hash: r.sampleTxHash,
          entity: r.entity,
          functionSig: r.functionSig,
          toAddress: r.toAddress,
        })),
      feed: rows.map((r) => ({
        hash: r.sampleTxHash,
        toAddress: r.toAddress,
        selector: r.selector,
        entity: r.entity,
        functionSig: r.functionSig,
        status: r.status,
        intent: r.intent,
        txCount: r.txCount,
      })),
      warningCodeTotals,
    },
  };
}

// ---------------------------------------------------------------------------
// Coverage + tx_index helpers

export interface CoverageRowOut {
  chainId: number;
  address: string;
  selector: string;
  functionSig: string | null;
  descriptorPath: string | null;
  entity: string | null;
  standardKind: string | null;
  registryCommit: string | null;
}

export function readCoverage(db: Db, chainId?: number): CoverageRowOut[] {
  const sql = `SELECT chain_id, address, selector, function_sig, descriptor_path, entity, standard_kind, registry_commit
               FROM coverage ${chainId !== undefined ? "WHERE chain_id = ?" : ""} ORDER BY address, selector`;
  const rows = (chainId !== undefined ? db.prepare(sql).all(chainId) : db.prepare(sql).all()) as {
    chain_id: number;
    address: string;
    selector: string;
    function_sig: string | null;
    descriptor_path: string | null;
    entity: string | null;
    standard_kind: string | null;
    registry_commit: string | null;
  }[];
  return rows.map((r) => ({
    chainId: r.chain_id,
    address: r.address,
    selector: r.selector,
    functionSig: r.function_sig,
    descriptorPath: r.descriptor_path,
    entity: r.entity,
    standardKind: r.standard_kind,
    registryCommit: r.registry_commit,
  }));
}

export function countTable(db: Db, table: "coverage" | "runs" | "tx_groups" | "ranking" | "practical" | "tx_index"): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}
