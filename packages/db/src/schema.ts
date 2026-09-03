/**
 * SQLite schema. Applied idempotently on every open (CREATE ... IF NOT EXISTS).
 *
 * One writer (the worker), one reader (the API). WAL mode lets the API read
 * while the worker inserts a new run.
 *
 * Tables
 *   coverage    Stage A. One row per clear-signable (chain, address, selector).
 *               Current registry state only; `registry_commit` stamps it.
 *   runs        One row per worker run. kind = 'aggregate' (Stage B) or
 *               'practical' (Stage C).
 *   tx_groups   Stage B. One row per (to, selector) group per aggregate run,
 *               with its bucket. Full detail; drives per-address queries.
 *   ranking     Stage B. The cumulative "what to build next" walk, one row per
 *               not-covered contract, in rank order. Computed by the worker from
 *               tx_groups (see buildReport) so the API only reads.
 *   headline    Stage B. Bucket totals + the 80/95 thresholds per aggregate run.
 *   practical   Stage C. One row per covered group tested with the library.
 *   tx_index    Per-transaction index (hash + labels, never contents). 7-day
 *               retention via pruneTxIndex(). Empty until the per-tx Stage B
 *               query lands.
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS coverage (
  chain_id        INTEGER NOT NULL,
  address         TEXT    NOT NULL,
  selector        TEXT    NOT NULL,
  function_sig    TEXT,
  descriptor_path TEXT,
  entity          TEXT,
  standard_kind   TEXT,
  registry_commit TEXT,
  PRIMARY KEY (chain_id, address, selector)
);

CREATE TABLE IF NOT EXISTS runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT    NOT NULL CHECK (kind IN ('aggregate', 'practical')),
  generated_at    TEXT    NOT NULL,
  chain_id        INTEGER NOT NULL,
  window_end      TEXT    NOT NULL,
  window_hours    INTEGER NOT NULL,
  source          TEXT,
  registry_commit TEXT,
  bytes_processed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS runs_kind_generated ON runs (kind, generated_at DESC);

CREATE TABLE IF NOT EXISTS tx_groups (
  run_id     INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  to_address TEXT,
  selector   TEXT    NOT NULL,
  tx_count   INTEGER NOT NULL,
  bucket     TEXT    NOT NULL,
  PRIMARY KEY (run_id, to_address, selector)
);
CREATE INDEX IF NOT EXISTS tx_groups_run_bucket_count ON tx_groups (run_id, bucket, tx_count DESC);

CREATE TABLE IF NOT EXISTS ranking (
  run_id             INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  rank               INTEGER NOT NULL,
  to_address         TEXT    NOT NULL,
  tx_count           INTEGER NOT NULL,
  top_selectors_json TEXT    NOT NULL,
  cumulative_pct     REAL    NOT NULL,
  PRIMARY KEY (run_id, rank)
);

CREATE TABLE IF NOT EXISTS headline (
  run_id            INTEGER PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  total_tx          INTEGER NOT NULL,
  contract_creation INTEGER NOT NULL,
  eth_transfer      INTEGER NOT NULL,
  covered_theory    INTEGER NOT NULL,
  token_native      INTEGER NOT NULL,
  not_covered       INTEGER NOT NULL,
  contracts_to_80   INTEGER,
  contracts_to_95   INTEGER
);

CREATE TABLE IF NOT EXISTS practical (
  run_id          INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  to_address      TEXT    NOT NULL,
  selector        TEXT    NOT NULL,
  tx_count        INTEGER NOT NULL,
  status          TEXT    NOT NULL CHECK (status IN ('pass', 'partial', 'failed')),
  intent          TEXT,
  warnings_json   TEXT    NOT NULL DEFAULT '[]',
  sample_tx_hash  TEXT    NOT NULL,
  function_sig    TEXT,
  entity          TEXT,
  descriptor_path TEXT,
  PRIMARY KEY (run_id, to_address, selector)
);
CREATE INDEX IF NOT EXISTS practical_run_count ON practical (run_id, tx_count DESC);

CREATE TABLE IF NOT EXISTS tx_index (
  tx_hash      TEXT PRIMARY KEY,
  block_number INTEGER NOT NULL,
  block_time   TEXT    NOT NULL,
  to_address   TEXT,
  selector     TEXT    NOT NULL,
  bucket       TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS tx_index_block_time ON tx_index (block_time);
CREATE INDEX IF NOT EXISTS tx_index_to_address ON tx_index (to_address);
`;
