#!/usr/bin/env tsx
/**
 * One-off: load existing out/*.json snapshots into the SQLite database so the
 * API can serve them without re-running BigQuery.
 *
 * Usage:
 *   tsx src/importJson.ts [--out-dir out] [--db out/coverage.sqlite]
 *
 * Imports, when present:
 *   coverage-mainnet.json  -> coverage
 *   report*.json           -> runs(aggregate) + headline + ranking (+ tx_groups
 *                             for the ranked contracts' top selectors only; the
 *                             JSON does not hold the full group list)
 *   practical*.json        -> runs(practical) + practical
 *
 * Re-running is safe: a snapshot whose generatedAtIso already exists as a run
 * is skipped.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  openDb,
  defaultDbPath,
  insertCoverage,
  insertAggregateRun,
  insertPracticalRun,
  countTable,
  type Bucket,
  type PracticalRowIn,
  type TxGroupIn,
} from "@ccd/db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : fallback;
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function main(): void {
  const outDir = path.resolve(arg("out-dir") ?? process.env.OUT_DIR ?? path.join(REPO_ROOT, "out"));
  const dbPath = path.resolve(arg("db") ?? defaultDbPath());
  const db = openDb(dbPath);
  const log = (s: string) => process.stderr.write(s + "\n");
  log(`db: ${dbPath}`);

  const files = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];
  const existing = new Set(
    (db.prepare("SELECT generated_at FROM runs").all() as { generated_at: string }[]).map(
      (r) => r.generated_at,
    ),
  );

  // --- coverage ---
  for (const f of files.filter((f) => f.startsWith("coverage") && f.endsWith(".json"))) {
    const set = readJson(path.join(outDir, f));
    if (!Array.isArray(set.rows)) continue;
    const n = insertCoverage(db, set.rows, set.registryCommit ?? null);
    log(`coverage: ${f} -> ${n} rows (registry ${String(set.registryCommit ?? "?").slice(0, 8)})`);
  }

  // --- aggregate reports ---
  for (const f of files.filter((f) => f.startsWith("report") && f.endsWith(".json"))) {
    const j = readJson(path.join(outDir, f));
    if (!j.report?.buckets || !j.report?.ranking) continue;
    if (existing.has(j.generatedAtIso)) {
      log(`report: ${f} already imported (generated ${j.generatedAtIso}), skipping`);
      continue;
    }
    const contracts = j.report.ranking.contracts as {
      toAddress: string;
      txCount: number;
      topSelectors: { selector: string; txCount: number }[];
      cumulativePct: number;
    }[];
    // Partial tx_groups: only the top selectors per ranked contract are in the JSON.
    const groups: TxGroupIn[] = [];
    for (const c of contracts) {
      for (const s of c.topSelectors) {
        groups.push({ toAddress: c.toAddress, selector: s.selector, txCount: s.txCount, bucket: "not_covered" });
      }
    }
    const runId = insertAggregateRun(db, {
      generatedAtIso: j.generatedAtIso,
      chainId: j.chainId ?? 1,
      windowEndIso: j.timeframe.endIso,
      windowHours: j.timeframe.hours,
      source: `${j.source ?? "bigquery"} (imported from ${f}; tx_groups partial)`,
      registryCommit: j.registryCommit ?? null,
      bytesProcessed: j.bytesProcessed ?? 0,
      groups,
      buckets: j.report.buckets as Record<Bucket, number>,
      totalTx: j.report.totalTx,
      ranking: {
        contracts,
        contractsToReach80: j.report.ranking.contractsToReach80 ?? Infinity,
        contractsToReach95: j.report.ranking.contractsToReach95 ?? Infinity,
      },
    });
    log(`report: ${f} -> run ${runId}, ${contracts.length} ranked contracts, totalTx ${j.report.totalTx}`);
  }

  // --- practical runs ---
  const descriptorByKey = new Map<string, string>();
  for (const r of db
    .prepare("SELECT address, selector, descriptor_path FROM coverage WHERE chain_id = 1")
    .all() as { address: string; selector: string; descriptor_path: string | null }[]) {
    if (r.descriptor_path) descriptorByKey.set(`${r.address}|${r.selector}`, r.descriptor_path);
  }
  for (const f of files.filter((f) => f.startsWith("practical") && f.endsWith(".json"))) {
    const j = readJson(path.join(outDir, f));
    if (!Array.isArray(j.report?.feed)) continue;
    if (existing.has(j.generatedAtIso)) {
      log(`practical: ${f} already imported (generated ${j.generatedAtIso}), skipping`);
      continue;
    }
    const problems = new Map<string, any>();
    for (const p of j.report.problems ?? []) problems.set(`${p.toAddress}|${p.selector}`, p);
    const results: PracticalRowIn[] = (j.report.feed as any[]).map((it) => {
      const key = `${it.toAddress.toLowerCase()}|${it.selector.toLowerCase()}`;
      const p = problems.get(`${it.toAddress}|${it.selector}`);
      return {
        toAddress: it.toAddress,
        selector: it.selector,
        txCount: it.txCount,
        status: it.status,
        intent: it.intent,
        warnings: p?.warnings ?? [],
        sampleTxHash: it.hash,
        functionSig: it.functionSig,
        entity: it.entity,
        descriptorPath: p?.descriptorPath ?? descriptorByKey.get(key),
      };
    });
    const runId = insertPracticalRun(db, {
      generatedAtIso: j.generatedAtIso,
      chainId: j.chainId ?? 1,
      windowEndIso: j.sampleWindow.endIso,
      windowHours: j.sampleWindow.hours,
      registryCommit: j.registryCommit ?? null,
      bytesProcessed: j.bytesProcessed ?? 0,
      source: `bigquery-sample (imported from ${f})`,
      results,
    });
    log(`practical: ${f} -> run ${runId}, ${results.length} groups`);
  }

  log(
    `totals: coverage ${countTable(db, "coverage")}, runs ${countTable(db, "runs")}, ` +
      `tx_groups ${countTable(db, "tx_groups")}, ranking ${countTable(db, "ranking")}, ` +
      `practical ${countTable(db, "practical")}, tx_index ${countTable(db, "tx_index")}`,
  );
  db.close();
}

main();
