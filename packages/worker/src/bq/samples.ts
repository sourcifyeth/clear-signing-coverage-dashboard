/**
 * Pull one representative sample transaction per (to_address, selector) group,
 * restricted to a set of contract addresses (the covered set) and a short time
 * window. One sample is enough to test whether the library decodes the group,
 * since decode success is a property of the (contract, selector), not the tx.
 *
 * ANY_VALUE picks an arbitrary member of each group — cheaper than a window
 * function and sufficient for a representative sample.
 */

import type { BigQuery } from "@google-cloud/bigquery";
import { PUBLIC_PROJECT } from "./client.js";

export interface TxSample {
  toAddress: string;
  fromAddress: string;
  selector: string;
  hash: string;
  input: string;
  value: string;
  txCount: number; // occurrences of this (to, selector) in the sample window
}

const DEFAULT_DATASET = "goog_blockchain_ethereum_mainnet_us";
const DEFAULT_TABLE = "transactions";

export async function sampleTxsForAddresses(
  bq: BigQuery,
  opts: {
    addresses: string[]; // lowercased contract addresses (the covered set)
    endIso: string;
    hours: number; // window length back from endIso
    dataset?: string;
    table?: string;
    dryRun?: boolean;
  },
): Promise<{ samples: TxSample[]; bytesProcessed: number }> {
  const dataset = opts.dataset ?? DEFAULT_DATASET;
  const table = opts.table ?? DEFAULT_TABLE;
  const source = `${PUBLIC_PROJECT}.${dataset}.${table}`;

  const sql = `
    SELECT
      to_address AS to_address,
      SUBSTR(input, 1, 10) AS selector,
      ANY_VALUE(transaction_hash) AS tx_hash,
      ANY_VALUE(from_address) AS tx_from,
      ANY_VALUE(input) AS tx_input,
      ANY_VALUE(CAST(value AS STRING)) AS tx_value,
      COUNT(*) AS tx_count
    FROM \`${source}\`
    WHERE block_timestamp >= TIMESTAMP_SUB(TIMESTAMP(@endIso), INTERVAL @hours HOUR)
      AND block_timestamp <  TIMESTAMP(@endIso)
      AND to_address IN UNNEST(@addresses)
      AND LENGTH(input) >= 10
    GROUP BY to_address, selector
  `;
  const params = { endIso: opts.endIso, hours: opts.hours, addresses: opts.addresses };

  if (opts.dryRun) {
    const [job] = await bq.createQueryJob({ query: sql, params, dryRun: true });
    return { samples: [], bytesProcessed: Number(job.metadata.statistics?.totalBytesProcessed ?? 0) };
  }

  const [job] = await bq.createQueryJob({ query: sql, params });
  const [rows] = await job.getQueryResults();
  const bytesProcessed = Number(
    (await job.getMetadata())[0].statistics?.query?.totalBytesProcessed ?? 0,
  );

  const samples: TxSample[] = rows.map((r: any) => ({
    toAddress: String(r.to_address).toLowerCase(),
    fromAddress: r.tx_from ? String(r.tx_from).toLowerCase() : "",
    selector: String(r.selector).toLowerCase(),
    hash: String(r.tx_hash),
    input: String(r.tx_input),
    value: r.tx_value != null ? String(r.tx_value) : "0",
    txCount: Number(r.tx_count),
  }));
  return { samples, bytesProcessed };
}
