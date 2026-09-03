#!/usr/bin/env tsx
/**
 * Stage C runner: for each covered (to, selector) group, pull a sample tx from
 * BigQuery and run the Sourcify library to see whether it renders in practice.
 *
 * Usage:
 *   tsx src/cliC.ts [--sample-hours 6] [--end 2025-08-15T00:00:00Z]
 *                   [--registry <path>] [--out out/practical.json]
 *                   [--dry-run] [--limit-print 25] [--no-db] [--db <path>]
 *
 * The run is written to the SQLite database ($DB_PATH) unless --no-db.
 *
 * Env: GCP_PROJECT_ID, GOOGLE_APPLICATION_CREDENTIALS, REGISTRY_PATH, DB_PATH.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openDb, defaultDbPath, insertPracticalRun } from "@ccd/db";
import { makeClient } from "./bq/client.js";
import { sampleTxsForAddresses } from "./bq/samples.js";
import { loadCoverageLookup } from "./coverage/loadCoverageSet.js";
import { runPractical } from "./practical.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAIN_ID = 1;

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const sampleHours = Number(arg("sample-hours", "6"));
  const endIso = arg("end") ?? new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
  const registryPath = path.resolve(
    arg("registry") ??
      process.env.REGISTRY_PATH ??
      path.resolve(__dirname, "../../../../clear-signing-erc7730-registry"),
  );
  const dryRun = flag("dry-run");
  const limitPrint = Number(arg("limit-print", "25"));

  let registryCommit: string | null = null;
  try {
    registryCommit = execFileSync("git", ["-C", registryPath, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    /* ignore */
  }

  const cov = loadCoverageLookup({ registryPath, registryCommit, chainIds: [CHAIN_ID] });
  const addresses = [...new Set([...cov.coveredAddresses].map((k) => k.split("|")[1]))];
  process.stderr.write(
    `Coverage: ${cov.rowCount} rows across ${addresses.length} addresses (registry ${registryCommit?.slice(0, 8) ?? "?"})\n`,
  );

  const bq = makeClient();
  process.stderr.write(`Sampling ${sampleHours}h ending ${endIso} for covered addresses ...\n`);
  const { samples, bytesProcessed } = await sampleTxsForAddresses(bq, {
    addresses,
    endIso,
    hours: sampleHours,
    dryRun,
  });
  if (dryRun) {
    process.stderr.write(`DRY RUN — would scan ${(bytesProcessed / 1e9).toFixed(2)} GB.\n`);
    return;
  }
  process.stderr.write(
    `  ${samples.length} sampled (to, selector) groups, scanned ${(bytesProcessed / 1e9).toFixed(2)} GB\n`,
  );
  process.stderr.write(`Running the clear-signing library ...\n`);

  const report = await runPractical({
    samples,
    cov,
    registryPath,
    chainId: CHAIN_ID,
    onProgress: (d, t) => {
      if (d % 25 === 0 || d === t) process.stderr.write(`  ${d}/${t}\r`);
    },
  });
  process.stderr.write("\n");

  const fmtN = (n: number) => n.toLocaleString("en-US");
  const c = report.counts;
  console.log(`\nPractical run over ${report.sampledGroups} covered groups (sampled ${sampleHours}h):`);
  console.log(`  pass:    ${c.pass}`);
  console.log(`  partial: ${c.partial}`);
  console.log(`  failed:  ${c.failed}`);
  const w = report.txWeighted;
  console.log(`\nTx-weighted (of covered sampled txs = ${fmtN(w.coveredSampledTx)}):`);
  console.log(`  renders in practice (pass+partial): ${w.practicePct.toFixed(2)}%`);
  console.log(`  pass ${fmtN(w.passTx)} · partial ${fmtN(w.partialTx)} · failed ${fmtN(w.failedTx)}`);
  if (Object.keys(report.warningCodeTotals).length) {
    console.log(`\nWarning codes (group occurrences):`);
    for (const [code, n] of Object.entries(report.warningCodeTotals).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${code}: ${n}`);
    }
  }
  console.log(`\nTop ${limitPrint} theory-vs-practice gaps (covered but not clean, by tx volume):`);
  report.problems.slice(0, limitPrint).forEach((p, i) => {
    const codes = p.warnings.map((x) => x.code).join(",") || "-";
    console.log(
      `  ${String(i + 1).padStart(3)}. [${p.status}] ${p.entity ?? "?"} ${p.toAddress} ${p.selector}` +
        `  ${fmtN(p.txCount).padStart(8)} txs  {${codes}}`,
    );
    if (p.warnings[0]) console.log(`        ${p.warnings[0].message}`);
  });

  const generatedAtIso = new Date().toISOString();

  if (!flag("no-db")) {
    const dbPath = path.resolve(arg("db") ?? defaultDbPath());
    const db = openDb(dbPath);
    const runId = insertPracticalRun(db, {
      generatedAtIso,
      chainId: CHAIN_ID,
      windowEndIso: endIso,
      windowHours: sampleHours,
      registryCommit,
      bytesProcessed,
      results: report.results,
    });
    db.close();
    process.stderr.write(`\ndb: practical run ${runId} written to ${dbPath}\n`);
  }

  const outArg = arg("out");
  if (outArg) {
    const outPath = path.resolve(outArg);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const { results: _omit, ...reportForJson } = report; // rows live in the DB; feed/problems cover the JSON
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          generatedAtIso,
          chainId: CHAIN_ID,
          registryCommit,
          sampleWindow: { endIso, hours: sampleHours },
          bytesProcessed,
          report: reportForJson,
        },
        null,
        2,
      ),
    );
    process.stderr.write(`\nwrote ${outPath}\n`);
  }
}

main().catch((e) => {
  console.error("\nStage C failed:", (e as Error).message);
  process.exit(1);
});
