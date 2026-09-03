#!/usr/bin/env tsx
/**
 * Stage B runner: aggregate a timeframe of mainnet transactions, classify each
 * group against the coverage set, and print + write the coverage report.
 *
 * Usage:
 *   tsx src/cli.ts [--hours 24] [--end 2025-08-01T00:00:00Z] [--registry <path>]
 *                  [--out out/report.json] [--dry-run] [--limit-print 20]
 *                  [--no-db] [--db <path>]
 *
 * The run is written to the SQLite database ($DB_PATH) unless --no-db. The
 * --out JSON is optional and kept for debugging.
 *
 * Env: GCP_PROJECT_ID, GOOGLE_APPLICATION_CREDENTIALS, REGISTRY_PATH, DB_PATH.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openDb, defaultDbPath, insertCoverage, insertAggregateRun } from "@ccd/db";
import { makeClient } from "./bq/client.js";
import { aggregateTxGroups } from "./bq/aggregate.js";
import { loadCoverageLookup } from "./coverage/loadCoverageSet.js";
import { classifyGroup, buildReport } from "./classify.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAIN_ID = 1; // mainnet, v1

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : fallback;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const hours = Number(arg("hours", "24"));
  // Default end: top of the current hour (UTC). Data may lag; pass --end for a
  // known-complete window.
  const endIso = arg("end") ?? new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
  const registryPath = path.resolve(
    arg("registry") ??
      process.env.REGISTRY_PATH ??
      path.resolve(__dirname, "../../../../clear-signing-erc7730-registry"),
  );
  const dryRun = flag("dry-run");
  const limitPrint = Number(arg("limit-print", "20"));

  let registryCommit: string | null = null;
  try {
    registryCommit = execFileSync("git", ["-C", registryPath, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    /* not a git checkout — leave null */
  }

  process.stderr.write(`Loading coverage set from ${registryPath} ...\n`);
  const cov = loadCoverageLookup({ registryPath, registryCommit, chainIds: [CHAIN_ID] });
  process.stderr.write(
    `  ${cov.rowCount} covered (address, selector) rows; registry ${cov.registryCommit?.slice(0, 8) ?? "?"}\n`,
  );

  const bq = makeClient();
  const timeframe = { endIso, hours };
  process.stderr.write(`Aggregating ${hours}h ending ${endIso} ...\n`);

  const agg = await aggregateTxGroups(bq, timeframe, { dryRun });
  if (dryRun) {
    process.stderr.write(
      `DRY RUN — would scan ${(agg.bytesProcessed / 1e9).toFixed(2)} GB. No results fetched.\n`,
    );
    return;
  }
  process.stderr.write(
    `  ${agg.groups.length} groups, ${agg.totalTx.toLocaleString()} txs, scanned ${(agg.bytesProcessed / 1e9).toFixed(2)} GB\n\n`,
  );

  const classified = agg.groups.map((g) => classifyGroup(g, CHAIN_ID, cov));
  const report = buildReport(classified);

  // ---- print summary ----
  const b = report.buckets;
  const fmtPct = (n: number) => `${n.toFixed(2)}%`;
  const fmtN = (n: number) => n.toLocaleString();
  console.log(`Window: ${hours}h ending ${endIso}`);
  console.log(`Total transactions: ${fmtN(report.totalTx)}\n`);
  console.log("Buckets (by tx count):");
  console.log(`  covered by descriptor (theory): ${fmtN(b.covered_theory)}  ${fmtPct((b.covered_theory / report.totalTx) * 100)}`);
  console.log(`  ETH transfer (native):          ${fmtN(b.eth_transfer)}  ${fmtPct((b.eth_transfer / report.totalTx) * 100)}`);
  console.log(`  token transfer/approve (native):${fmtN(b.token_native)}  ${fmtPct((b.token_native / report.totalTx) * 100)}`);
  console.log(`  not covered:                    ${fmtN(b.not_covered)}  ${fmtPct((b.not_covered / report.totalTx) * 100)}`);
  console.log(`  contract creation:              ${fmtN(b.contract_creation)}  ${fmtPct((b.contract_creation / report.totalTx) * 100)}`);
  console.log("\nHeadline clear-signable %:");
  console.log(`  descriptors only, of all txs:            ${fmtPct(report.headline.theoryPctOfAll)}`);
  console.log(`  descriptors + ETH/token native, of all:  ${fmtPct(report.headline.theoryPlusNativePctOfAll)}`);
  console.log(`  descriptors only, of contract calls:     ${fmtPct(report.headline.theoryPctOfContractCalls)}`);
  console.log("\nTo reach coverage of ALL txs (native cases count as signable):");
  console.log(`  contracts to add for 80%: ${report.ranking.contractsToReach80}`);
  console.log(`  contracts to add for 95%: ${report.ranking.contractsToReach95}`);
  console.log(`\nTop ${limitPrint} not-covered contracts to add (by tx volume):`);
  report.ranking.contracts.slice(0, limitPrint).forEach((c, i) => {
    const sels = c.topSelectors.map((s) => `${s.selector}×${fmtN(s.txCount)}`).join(" ");
    console.log(
      `  ${String(i + 1).padStart(3)}. ${c.toAddress}  ${fmtN(c.txCount).padStart(10)} txs  → cum ${fmtPct(c.cumulativePct)}  [${sels}]`,
    );
  });

  const generatedAtIso = new Date().toISOString();

  // ---- write DB ----
  if (!flag("no-db")) {
    const dbPath = path.resolve(arg("db") ?? defaultDbPath());
    const db = openDb(dbPath);
    insertCoverage(db, [...cov.bySelector.values()], cov.registryCommit);
    const runId = insertAggregateRun(db, {
      generatedAtIso,
      chainId: CHAIN_ID,
      windowEndIso: endIso,
      windowHours: hours,
      source: agg.source,
      registryCommit: cov.registryCommit,
      bytesProcessed: agg.bytesProcessed,
      groups: classified,
      buckets: report.buckets,
      totalTx: report.totalTx,
      ranking: report.ranking,
    });
    db.close();
    process.stderr.write(`\ndb: aggregate run ${runId} written to ${dbPath}\n`);
  }

  // ---- write JSON ----
  const outArg = arg("out");
  if (outArg) {
    const outPath = path.resolve(outArg);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          generatedAtIso,
          chainId: CHAIN_ID,
          registryCommit: cov.registryCommit,
          source: agg.source,
          timeframe,
          bytesProcessed: agg.bytesProcessed,
          report,
        },
        null,
        2,
      ),
    );
    process.stderr.write(`\nwrote ${outPath}\n`);
  }
}

main().catch((e) => {
  console.error("\nStage B failed:", (e as Error).message);
  process.exit(1);
});
