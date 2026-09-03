/**
 * Write side: the worker inserts one run at a time. Every insert runs inside a
 * single transaction so a crashed run never leaves a half-written snapshot.
 *
 * Types here are deliberately minimal and self-contained so @ccd/db does not
 * depend on @ccd/coverage or @ccd/worker (which depend on it).
 */

import type { Db } from "./index.js";

export type Bucket =
  | "contract_creation"
  | "eth_transfer"
  | "covered_theory"
  | "token_native"
  | "not_covered";

export type PracticalStatus = "pass" | "partial" | "failed";

export interface CoverageRowIn {
  chainId: number;
  address: string;
  selector: string;
  functionSig?: string;
  descriptorPath?: string;
  entity?: string;
  standardKind?: string;
}

export interface TxGroupIn {
  toAddress: string | null;
  selector: string;
  txCount: number;
  bucket: Bucket;
}

export interface RankedContractIn {
  toAddress: string;
  txCount: number;
  topSelectors: { selector: string; txCount: number }[];
  cumulativePct: number;
}

export interface AggregateRunIn {
  generatedAtIso: string;
  chainId: number;
  windowEndIso: string;
  windowHours: number;
  source: string;
  registryCommit: string | null;
  bytesProcessed: number;
  groups: TxGroupIn[];
  buckets: Record<Bucket, number>;
  totalTx: number;
  ranking: {
    contracts: RankedContractIn[];
    contractsToReach80: number; // Infinity allowed -> stored NULL
    contractsToReach95: number;
  };
}

export interface PracticalRowIn {
  toAddress: string;
  selector: string;
  txCount: number;
  status: PracticalStatus;
  intent?: string;
  warnings: { code: string; message: string }[];
  sampleTxHash: string;
  functionSig?: string;
  entity?: string;
  descriptorPath?: string;
}

export interface PracticalRunIn {
  generatedAtIso: string;
  chainId: number;
  windowEndIso: string;
  windowHours: number;
  registryCommit: string | null;
  bytesProcessed: number;
  source?: string;
  results: PracticalRowIn[];
}

export interface TxIndexRowIn {
  txHash: string;
  blockNumber: number;
  blockTimeIso: string;
  toAddress: string | null;
  selector: string;
  bucket: Bucket;
}

const finiteOrNull = (n: number) => (Number.isFinite(n) ? n : null);

/**
 * Replace the coverage set for the chains present in `rows`. Chains not in
 * `rows` are left untouched, so a mainnet-only run does not wipe other chains.
 */
export function insertCoverage(db: Db, rows: CoverageRowIn[], registryCommit: string | null): number {
  const chains = [...new Set(rows.map((r) => r.chainId))];
  const del = db.prepare("DELETE FROM coverage WHERE chain_id = ?");
  const ins = db.prepare(
    `INSERT OR REPLACE INTO coverage
       (chain_id, address, selector, function_sig, descriptor_path, entity, standard_kind, registry_commit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const c of chains) del.run(c);
    for (const r of rows) {
      ins.run(
        r.chainId,
        r.address.toLowerCase(),
        r.selector.toLowerCase(),
        r.functionSig ?? null,
        r.descriptorPath ?? null,
        r.entity ?? null,
        r.standardKind ?? null,
        registryCommit,
      );
    }
  })();
  return rows.length;
}

/** Insert a Stage B run: runs + tx_groups + ranking + headline. Returns run id. */
export function insertAggregateRun(db: Db, run: AggregateRunIn): number {
  const insRun = db.prepare(
    `INSERT INTO runs (kind, generated_at, chain_id, window_end, window_hours, source, registry_commit, bytes_processed)
     VALUES ('aggregate', ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insGroup = db.prepare(
    `INSERT OR REPLACE INTO tx_groups (run_id, to_address, selector, tx_count, bucket) VALUES (?, ?, ?, ?, ?)`,
  );
  const insRank = db.prepare(
    `INSERT INTO ranking (run_id, rank, to_address, tx_count, top_selectors_json, cumulative_pct)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insHead = db.prepare(
    `INSERT INTO headline (run_id, total_tx, contract_creation, eth_transfer, covered_theory, token_native, not_covered, contracts_to_80, contracts_to_95)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return db.transaction((): number => {
    const runId = Number(
      insRun.run(
        run.generatedAtIso,
        run.chainId,
        run.windowEndIso,
        run.windowHours,
        run.source,
        run.registryCommit,
        run.bytesProcessed,
      ).lastInsertRowid,
    );
    for (const g of run.groups) {
      insGroup.run(runId, g.toAddress?.toLowerCase() ?? null, g.selector.toLowerCase(), g.txCount, g.bucket);
    }
    run.ranking.contracts.forEach((c, i) => {
      insRank.run(runId, i + 1, c.toAddress.toLowerCase(), c.txCount, JSON.stringify(c.topSelectors), c.cumulativePct);
    });
    const b = run.buckets;
    insHead.run(
      runId,
      run.totalTx,
      b.contract_creation,
      b.eth_transfer,
      b.covered_theory,
      b.token_native,
      b.not_covered,
      finiteOrNull(run.ranking.contractsToReach80),
      finiteOrNull(run.ranking.contractsToReach95),
    );
    return runId;
  })();
}

/** Insert a Stage C run: runs + practical rows. Returns run id. */
export function insertPracticalRun(db: Db, run: PracticalRunIn): number {
  const insRun = db.prepare(
    `INSERT INTO runs (kind, generated_at, chain_id, window_end, window_hours, source, registry_commit, bytes_processed)
     VALUES ('practical', ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insRow = db.prepare(
    `INSERT OR REPLACE INTO practical
       (run_id, to_address, selector, tx_count, status, intent, warnings_json, sample_tx_hash, function_sig, entity, descriptor_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return db.transaction((): number => {
    const runId = Number(
      insRun.run(
        run.generatedAtIso,
        run.chainId,
        run.windowEndIso,
        run.windowHours,
        run.source ?? "bigquery-sample",
        run.registryCommit,
        run.bytesProcessed,
      ).lastInsertRowid,
    );
    for (const r of run.results) {
      insRow.run(
        runId,
        r.toAddress.toLowerCase(),
        r.selector.toLowerCase(),
        r.txCount,
        r.status,
        r.intent ?? null,
        JSON.stringify(r.warnings ?? []),
        r.sampleTxHash,
        r.functionSig ?? null,
        r.entity ?? null,
        r.descriptorPath ?? null,
      );
    }
    return runId;
  })();
}

/** Upsert per-transaction index rows (hash + labels only, never contents). */
export function insertTxIndex(db: Db, rows: TxIndexRowIn[]): number {
  const ins = db.prepare(
    `INSERT OR REPLACE INTO tx_index (tx_hash, block_number, block_time, to_address, selector, bucket)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const r of rows) {
      ins.run(
        r.txHash.toLowerCase(),
        r.blockNumber,
        r.blockTimeIso,
        r.toAddress?.toLowerCase() ?? null,
        r.selector.toLowerCase(),
        r.bucket,
      );
    }
  })();
  return rows.length;
}

/** Delete tx_index rows older than `days`. Returns the number of rows removed. */
export function pruneTxIndex(db: Db, days: number, now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const res = db.prepare("DELETE FROM tx_index WHERE block_time < ?").run(cutoff);
  return Number(res.changes);
}
