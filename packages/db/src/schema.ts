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
 *               retention via pruneTxIndex()/pruneLive(). Filled by the live
 *               block follower.
 *   blocks      Live follower. One row per processed block (hash + parent hash
 *               for reorg detection, time, tx count).
 *   tokens      Live follower. Token metadata cache (name/symbol/decimals) for
 *               the library's resolveToken / resolveNftCollectionName.
 *   contracts   contracts:sync worker. Sourcify verification cache per address
 *               (verified, match kind, contract name); see contracts.ts.
 *   block_groups Live follower. Per-block aggregate: one row per
 *               (to, selector, bucket, status) with its tx count. Rolling-window
 *               stats (1h / 24h / 7d) are sums over this table.
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
CREATE INDEX IF NOT EXISTS tx_index_block_number ON tx_index (block_number DESC);

CREATE TABLE IF NOT EXISTS blocks (
  number       INTEGER PRIMARY KEY,
  hash         TEXT    NOT NULL,
  parent_hash  TEXT    NOT NULL,
  block_time   TEXT    NOT NULL,
  tx_count     INTEGER NOT NULL,
  processed_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS blocks_time ON blocks (block_time);

CREATE TABLE IF NOT EXISTS block_groups (
  block_number INTEGER NOT NULL,
  block_time   TEXT    NOT NULL DEFAULT '',   -- denormalized from blocks, so window queries need no join
  to_address   TEXT    NOT NULL DEFAULT '',   -- '' for contract creation
  selector     TEXT    NOT NULL,
  bucket       TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT '',   -- pass/partial/failed for covered_theory, else ''
  tx_count     INTEGER NOT NULL,
  PRIMARY KEY (block_number, to_address, selector, status)
);

-- 4-byte selector -> canonical function signature, looked up once from
-- api.4byte.sourcify.dev by the follower. name NULL = looked up, unknown
-- (retried after a day). Never pruned: a few thousand small rows.
CREATE TABLE IF NOT EXISTS signatures (
  selector   TEXT PRIMARY KEY,
  name       TEXT,
  verified   INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT    NOT NULL
);

-- Token metadata cache, filled by the follower's ExternalDataProvider from
-- eth_call (name / symbol / decimals). kind 'erc20' has decimals, 'erc721' has
-- a name only, 'none' is a negative entry (ok = 0) retried after a week.
-- Never pruned: a few hundred rows on mainnet.
CREATE TABLE IF NOT EXISTS tokens (
  chain_id   INTEGER NOT NULL,
  address    TEXT    NOT NULL,   -- lowercase 0x
  kind       TEXT    NOT NULL CHECK (kind IN ('erc20', 'erc721', 'none')),
  name       TEXT,
  symbol     TEXT,
  decimals   INTEGER,
  ok         INTEGER NOT NULL DEFAULT 1,
  fetched_at TEXT    NOT NULL,
  PRIMARY KEY (chain_id, address)
);

-- Sourcify verification cache, filled by the contracts:sync worker (one
-- request per address against sourcify.dev/server/v2). verified 0 rows are
-- rechecked after 24h, verified 1 rows after 30 days. Pruned with the blocks:
-- a row survives only while some block in the retention window calls it.
CREATE TABLE IF NOT EXISTS contracts (
  chain_id    INTEGER NOT NULL,
  address     TEXT    NOT NULL,   -- lowercase 0x
  verified    INTEGER NOT NULL DEFAULT 0,
  match       TEXT    CHECK (match IN ('exact_match', 'match')),
  name        TEXT,               -- Sourcify compilation.name; NULL when unverified
  checked_at  TEXT    NOT NULL,
  verified_at TEXT,
  PRIMARY KEY (chain_id, address)
);
`;

/**
 * Indexes over columns that may have been added by migration; created after
 * ADDED_COLUMNS are applied.
 */
export const POST_MIGRATION_SQL = `
-- Covering index for the rolling-window queries (range on block_time, then
-- group by bucket / to_address / selector / status).
CREATE INDEX IF NOT EXISTS block_groups_window
  ON block_groups (block_time, bucket, to_address, selector, status, tx_count);
`;

/**
 * Columns added after a table's first version. Applied with
 * ALTER TABLE ... ADD COLUMN when missing, so an existing database migrates in
 * place. `backfill` runs once right after the column is added.
 */
export const ADDED_COLUMNS: { table: string; name: string; ddl: string; backfill?: string }[] = [
  { table: "tx_index", name: "block_hash", ddl: "block_hash TEXT" },
  { table: "tx_index", name: "status", ddl: "status TEXT" },
  { table: "tx_index", name: "warnings_json", ddl: "warnings_json TEXT" },
  // Library result for covered transactions: a one-line intent, and the full
  // DisplayModel JSON (capped at 8 KB, see live.ts).
  { table: "tx_index", name: "intent", ddl: "intent TEXT" },
  { table: "tx_index", name: "display_json", ddl: "display_json TEXT" },
  {
    table: "block_groups",
    name: "block_time",
    ddl: "block_time TEXT NOT NULL DEFAULT ''",
    backfill:
      "UPDATE block_groups SET block_time = COALESCE((SELECT b.block_time FROM blocks b WHERE b.number = block_groups.block_number), '')",
  },
];
