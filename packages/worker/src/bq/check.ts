#!/usr/bin/env tsx
/**
 * Connectivity + schema check for BigQuery. Does NOT run a billed query beyond
 * a dry-run (which is free and returns only the bytes a real run would scan).
 *
 * Steps:
 *   1. Confirm auth by listing the service account's own project datasets.
 *   2. For each candidate public tx source, fetch the transactions table schema
 *      (metadata, free) and print the columns we care about.
 *   3. Dry-run a small per-(to, selector) aggregation over a 1-hour window to
 *      report bytes scanned, so we know the cost before running for real.
 */

import { makeClient, getProjectId, PUBLIC_PROJECT, TX_SOURCES } from "./client.js";

const WANTED_COLUMNS = [
  "to_address",
  "to",
  "input",
  "receipt_status",
  "value",
  "block_timestamp",
  "block_number",
  "hash",
  "transaction_hash",
];

async function main(): Promise<void> {
  const bq = makeClient();
  const projectId = getProjectId();
  console.log(`project (billing): ${projectId}`);
  console.log(
    `credentials: ${process.env.GOOGLE_APPLICATION_CREDENTIALS ? "service-account key file" : "application default"}\n`,
  );

  // 1. Auth smoke test.
  try {
    const [datasets] = await bq.getDatasets({ maxResults: 5 });
    console.log(
      `auth OK — can list datasets in ${projectId} (${datasets.length} found, showing up to 5): ` +
        datasets.map((d) => d.id).join(", ") || "(none yet)",
    );
  } catch (e) {
    console.error(`auth FAILED listing datasets in ${projectId}:`, (e as Error).message);
    throw e;
  }
  console.log("");

  // 2. Schema of each candidate source.
  let chosen: (typeof TX_SOURCES)[number] | null = null;
  for (const src of TX_SOURCES) {
    try {
      const [meta] = await bq
        .dataset(src.dataset, { projectId: PUBLIC_PROJECT })
        .table(src.table)
        .getMetadata();
      const fields: { name: string; type: string }[] = meta.schema?.fields ?? [];
      const names = new Set(fields.map((f) => f.name));
      const present = WANTED_COLUMNS.filter((c) => names.has(c));
      const partitioning =
        meta.timePartitioning?.field ??
        (meta.timePartitioning ? "(ingestion-time)" : "(none)");
      const sizeGb = meta.numBytes ? (Number(meta.numBytes) / 1e9).toFixed(1) : "?";
      console.log(`SOURCE ${PUBLIC_PROJECT}.${src.dataset}.${src.table} [${src.label}]`);
      console.log(`  exists: yes   size: ${sizeGb} GB   partition field: ${partitioning}`);
      console.log(`  relevant columns: ${present.join(", ")}`);
      if (!chosen) chosen = src;
    } catch (e) {
      console.log(`SOURCE ${PUBLIC_PROJECT}.${src.dataset}.${src.table} [${src.label}]`);
      console.log(`  exists: NO / not accessible — ${(e as Error).message.split("\n")[0]}`);
    }
    console.log("");
  }

  if (!chosen) {
    throw new Error("No candidate transaction source is accessible.");
  }

  // 3. Dry-run cost estimate for a 1-hour aggregation on the chosen source.
  const toCol = chosen.dataset.startsWith("goog_blockchain") ? "to_address" : "to_address";
  const tsCol = "block_timestamp";
  const sql = `
    SELECT ${toCol} AS to_address,
           SUBSTR(input, 1, 10) AS selector,
           COUNT(*) AS tx_count
    FROM \`${PUBLIC_PROJECT}.${chosen.dataset}.${chosen.table}\`
    WHERE ${tsCol} >= TIMESTAMP_SUB(TIMESTAMP('2025-08-01 01:00:00'), INTERVAL 1 HOUR)
      AND ${tsCol} <  TIMESTAMP('2025-08-01 01:00:00')
    GROUP BY to_address, selector
  `;
  const [job] = await bq.createQueryJob({ query: sql, dryRun: true });
  const bytes = Number(job.metadata.statistics?.totalBytesProcessed ?? 0);
  console.log("DRY RUN (1-hour window aggregation):");
  console.log(`  chosen source: ${PUBLIC_PROJECT}.${chosen.dataset}.${chosen.table}`);
  console.log(
    `  bytes scanned: ${(bytes / 1e9).toFixed(2)} GB   (~$${((bytes / 1e12) * 6.25).toFixed(4)} on-demand, first 1 TB/month free)`,
  );
}

main().catch((e) => {
  console.error("\ncheck failed:", (e as Error).message);
  process.exit(1);
});
