/**
 * BigQuery client setup.
 *
 * Auth + billing come from env:
 *   GCP_PROJECT_ID                 project that query jobs are billed to
 *   GOOGLE_APPLICATION_CREDENTIALS path to a service-account JSON key
 *
 * The service-account key is a secret: it is only referenced by path, never
 * read or logged here. On a deployed Cloud Run job the key file is unnecessary
 * (the attached service account is picked up automatically).
 */

import { BigQuery } from "@google-cloud/bigquery";

export const PUBLIC_PROJECT = "bigquery-public-data";

/** Candidate public Ethereum transaction sources, in preference order. */
export const TX_SOURCES = [
  {
    dataset: "goog_blockchain_ethereum_mainnet_us",
    table: "transactions",
    label: "goog_blockchain (maintained)",
  },
  {
    dataset: "crypto_ethereum",
    table: "transactions",
    label: "crypto_ethereum (legacy)",
  },
] as const;

export function getProjectId(): string {
  const id = process.env.GCP_PROJECT_ID;
  if (!id) {
    throw new Error("GCP_PROJECT_ID is not set (the project to bill query jobs to).");
  }
  return id;
}

export function makeClient(): BigQuery {
  const projectId = getProjectId();
  const keyFilename = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  // If keyFilename is unset the client falls back to Application Default
  // Credentials, which is what we want on Cloud Run.
  return new BigQuery(keyFilename ? { projectId, keyFilename } : { projectId });
}
