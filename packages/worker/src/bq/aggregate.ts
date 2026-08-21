/**
 * Stage B query: aggregate mainnet transactions in a timeframe by
 * (to_address, selector), returning one row per group with a count.
 *
 * Cheap by construction: it reads only to_address and the first 10 chars of
 * input, and filters on the block_timestamp partition column so BigQuery prunes
 * to just the timeframe's partitions.
 */

import type { BigQuery } from "@google-cloud/bigquery";
import { PUBLIC_PROJECT } from "./client.js";

export interface TxGroup {
  toAddress: string | null; // null = contract creation
  selector: string; // '0x' for empty input, else 0x + 8 hex (or shorter if malformed)
  txCount: number;
}

export interface Timeframe {
  endIso: string; // exclusive upper bound, ISO 8601
  hours: number; // window length back from endIso
}

export interface AggregateResult {
  source: string;
  timeframe: Timeframe;
  totalTx: number;
  groups: TxGroup[];
  bytesProcessed: number;
}

const DEFAULT_DATASET = "goog_blockchain_ethereum_mainnet_us";
const DEFAULT_TABLE = "transactions";

export async function aggregateTxGroups(
  bq: BigQuery,
  timeframe: Timeframe,
  opts?: { dataset?: string; table?: string; dryRun?: boolean },
): Promise<AggregateResult> {
  const dataset = opts?.dataset ?? DEFAULT_DATASET;
  const table = opts?.table ?? DEFAULT_TABLE;
  const source = `${PUBLIC_PROJECT}.${dataset}.${table}`;

  const sql = `
    SELECT
      to_address AS to_address,
      SUBSTR(input, 1, 10) AS selector,
      COUNT(*) AS tx_count
    FROM \`${source}\`
    WHERE block_timestamp >= TIMESTAMP_SUB(TIMESTAMP(@endIso), INTERVAL @hours HOUR)
      AND block_timestamp <  TIMESTAMP(@endIso)
    GROUP BY to_address, selector
  `;
  const params = { endIso: timeframe.endIso, hours: timeframe.hours };

  if (opts?.dryRun) {
    const [job] = await bq.createQueryJob({ query: sql, params, dryRun: true });
    return {
      source,
      timeframe,
      totalTx: 0,
      groups: [],
      bytesProcessed: Number(job.metadata.statistics?.totalBytesProcessed ?? 0),
    };
  }

  const [job] = await bq.createQueryJob({ query: sql, params });
  const [rows] = await job.getQueryResults();
  const bytesProcessed = Number(
    (await job.getMetadata())[0].statistics?.query?.totalBytesProcessed ?? 0,
  );

  const groups: TxGroup[] = rows.map((r: any) => ({
    toAddress: r.to_address ? String(r.to_address).toLowerCase() : null,
    selector: r.selector ? String(r.selector).toLowerCase() : "0x",
    txCount: Number(r.tx_count),
  }));
  const totalTx = groups.reduce((s, g) => s + g.txCount, 0);

  return { source, timeframe, totalTx, groups, bytesProcessed };
}
