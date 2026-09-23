# Clear-Signing Coverage Dashboard

Measures **what share of Ethereum transactions can be clear-signed** with the
ERC-7730 descriptors in the [clear-signing-erc7730-registry], and shows **which
contracts to add next** to reach 80% / 95% coverage.

"Clear-signable" means: given a transaction's `to` address and its calldata, a
wallet can show a human-readable description instead of raw hex, because a
descriptor exists for that `(address, function)`.

Two levels are measured:

- **In theory** — `(chainId, to, selector)` is present in the registry.
- **In practice** — the Sourcify [`@ethereum-sourcify/clear-signing`][lib]
  library actually produces a display for a real transaction, instead of falling
  back to raw calldata. The gap between the two, with the failure reason, is a
  first-class view.

Weighting is by **transaction count**. Ethereum mainnet only for v1. Transaction
data comes from the Google BigQuery public Ethereum dataset. See the full design
in the plan (kept outside this repo).

[clear-signing-erc7730-registry]: https://github.com/ethereum/clear-signing-erc7730-registry
[lib]: https://github.com/sourcifyeth/clear-signing

## Layout

```
packages/
  coverage/   Stage A — build the (chainId, address, selector) coverage set
              from a local registry checkout.
  worker/     Stages B + C, and the live block follower.
              B aggregates a timeframe of mainnet txs from BigQuery, classifies
              each (to, selector) group against the coverage set, and ranks the
              contracts needed to reach 80% / 95%.
              C runs the Sourcify library on a sample tx per covered group to
              check it renders in practice (theory-vs-practice gap).
              follower/ follows the chain head over RPC and does both, per
              transaction, as blocks land (see "Live block follower").
  db/         SQLite storage (better-sqlite3). Schema, writers for the worker,
              readers for the API.
  api/        Read-only Express server over the SQLite database, plus an SSE
              stream of new blocks.
apps/
  web/        Vite + React dashboard.
```

There are two data paths. The **live follower** is the primary one: it runs
continuously and the dashboard's top section updates with every block. The
**BigQuery stages** produce one-off 24h snapshots and are kept for backfill and
for cross-checking the live numbers.

## Storage

Everything lives in one SQLite file, `out/coverage.sqlite` (override with
`DB_PATH`). The worker is the only writer and the API the only reader, so
SQLite in WAL mode is enough; no database server is needed. Tables:

| Table       | Written by | Holds |
|-------------|------------|-------|
| `coverage`  | Stage A/B  | one row per clear-signable (chain, address, selector); current registry state |
| `runs`      | Stage B/C  | one row per worker run (`kind` = aggregate or practical), with window + registry commit |
| `tx_groups` | Stage B    | one row per (to, selector) group per run, with its bucket and tx count |
| `ranking`   | Stage B    | the cumulative "what to build next" walk, one row per not-covered contract |
| `headline`  | Stage B    | bucket totals and the 80% / 95% thresholds per run |
| `practical` | Stage C    | one row per covered group tested with the library: status, intent, warnings, sample tx hash |
| `blocks`    | follower   | one row per processed block: hash, parent hash (reorg detection), time, tx count |
| `block_groups` | follower | per-block aggregate, one row per (to, selector, bucket, status) with its tx count and the block time. Source of the window totals below and of the per-block stats |
| `window_groups`, `window_meta` | follower | running totals per rolling window (1h / 24h / 7d): one row per (to, selector, bucket, status) summed over the blocks the window includes, plus the block range and totals. Updated with every block (add the new one, subtract the expired ones). At start the follower keeps them when they end at the stored head, and rebuilds them only when the logic version (`WINDOWS_VERSION`) changed, the tables lag the blocks, or `REBUILD_WINDOWS=1` is set; a rebuild takes minutes on a week of data. `npm run windows:check` compares them with a fresh computation |
| `window_counters`, `window_contracts` | follower | derived from the window groups with every block: per-window counts per (bucket, status) with the standard-token-selector share, and per-window totals per contract (calls, calls without standard selectors, covered calls, not-covered calls, Sourcify verified flag) with indexes on the counts. The summary reads the counters; the ranking pages read the contracts through the indexes, so no request groups the long tail |
| `window_ranking` | follower | the "what to build next" result per window (top 100 not-covered contracts with selectors, the cumulative curve, the 80% / 95% ranks for each exclusion combination, the verification split), computed once per block from `window_contracts` and returned by the summary as is |
| `tx_index`  | follower   | one row per transaction: hash, block, to, selector, bucket, and for covered ones the library's status, warning codes, one-line intent and the full display model as JSON (capped at 8 KB). 7-day retention via `pruneLive()` |

SQLite settings, applied by `openDb()` on every connection: WAL journal, a
256 MB page cache, a 1 GB memory map, and in-memory temp storage. The
defaults (a 2 MB cache, no memory map) made every request re-read the window
tables from disk once the file passed a few gigabytes. The follower also runs
`PRAGMA wal_checkpoint(TRUNCATE)` with each prune cycle (every 100 blocks), so
the write-ahead log does not grow past a few hundred megabytes while the API
holds read transactions.

We never store transaction contents (calldata, value, sender). The browser
fetches a transaction over RPC and decodes it on demand; for transactions the
follower already processed, its stored result is shown next to the fresh run.

The API serves the latest run in the same JSON shapes as before, except that
`/api/report/latest` returns only the top `?limit=` ranked contracts (default
200) plus a downsampled cumulative curve, instead of every ranked contract.
That takes the payload from ~8 MB to ~60 KB.

## Run the dashboard

```bash
npm install

# 0. Already have out/*.json snapshots from an earlier run? Load them into the
#    database instead of re-running BigQuery.
npm run import-json

# 1. Generate a report snapshot (needs BigQuery credentials, see .env.example).
#    Writes a run into the database; --out additionally keeps a JSON copy.
GCP_PROJECT_ID=... GOOGLE_APPLICATION_CREDENTIALS=/path/key.json \
  npm run stage-b -- --hours 24 --out out/report-24h.json

# 2. (optional) Run the practical check — the Sourcify library on covered groups.
GCP_PROJECT_ID=... GOOGLE_APPLICATION_CREDENTIALS=/path/key.json \
  npm run stage-c -- --sample-hours 6 --out out/practical.json

# 3. Start the live follower (keeps running; see below), the API and the web app.
npm run follow       # follows the chain head, writes every block to the database
npm run api          # http://localhost:8787
npm run web          # http://localhost:5273  (proxies /api to the API)
```

Stage B prints the headline coverage and the ranked backlog and writes the run
to the database (`--no-db` skips that). A `--dry-run` flag reports the BigQuery
bytes a run would scan without executing it. `GET /api/runs` lists the runs.

## Open a transaction or a block by URL

The web app understands two explorer-style paths. Both open the matching
details modal on top of the dashboard, so a link can be shared or bookmarked:

| Path | Opens |
|---|---|
| `/tx/<hash>` | the transaction modal: bucket, descriptor status, what a wallet shows, raw and decoded calldata |
| `/block/<number>` | the block modal: per-bucket counts and every counted transaction |

Examples on the deployed site:

```
https://erc7730.sourcify.dev/tx/0x11b4a41c2d479bcbb2dada95b6e73aff2b4c1de82d3656e4b85b9aa5e3876801
https://erc7730.sourcify.dev/block/25983122
```

The same lookup is available in the page: the box next to the "Blocks" title
takes a block number, the box next to the "Transactions" title takes a
transaction hash. A full explorer URL that contains one also works; the app
pulls the hash or the number out of it.

Rules:

- The hash is 32 bytes in hex with the `0x` prefix (66 characters). Case does
  not matter.
- The block number is the decimal number, with or without thousands separators.
- Only the live index answers: the follower keeps the last 7 days
  (`RETENTION_DAYS`). An older transaction or block opens the modal with a
  "not in the live index" note and a link to the explorer.
- Opening a modal pushes a browser history entry, so the back button closes it.
  A transaction opened from inside a block modal returns to that block.

The web app is a single page. nginx (`deploy/nginx/ccd.conf`) and the Vite dev
server serve `index.html` for every path that is not `/api/…` or an asset, so a
direct load or a reload of `/tx/…` and `/block/…` works.

## Live block follower

`npm run follow` is a long-running process. Every few seconds it asks the RPC
node for the head block number, fetches each new block with its transactions,
and for every transaction:

1. computes the 4-byte selector from the calldata and looks up `(to, selector)`
   in the coverage set → one of the five buckets (same rules as Stage B);
2. for `covered_theory` transactions, runs the Sourcify library `format()` with
   the local registry as descriptor source and records pass / partial / failed,
   the warning codes, the one-line intent, and the full display model;
3. writes the block, its transaction rows and its per-block aggregates in one
   SQLite transaction.

Throughput is not a concern: a mainnet block has 150–400 transactions and the
follower processes one in 10–50 ms including the library runs.

**Reorgs.** Each block's `parentHash` is checked against the stored hash of the
previous block. On a mismatch the follower walks back (up to 8 blocks) to the
last matching block, deletes everything after it, and reprocesses.

**Gaps.** The follower keeps the last processed block in the database and
resumes from there on restart, fetching every missed block by number. RPC
errors back off from 1 s to 30 s and never stop the loop.

**Retention.** Every 100 blocks, live rows older than `RETENTION_DAYS` are
pruned.

**Stats fill up from the moment the follower starts.** A 24h window is complete
24 hours after the first start; until then the UI shows how many blocks it
holds. Backfilling older blocks (from BigQuery or by walking back over RPC) is
not built yet.

Environment:

| Variable | Default | Meaning |
|---|---|---|
| `RPC_URL` | — | JSON-RPC endpoint. If unset and `DRPC_API_KEY` is set, `https://lb.drpc.org/ethereum/<key>` is used; else a public endpoint. Never logged. |
| `DB_PATH` | `out/coverage.sqlite` | SQLite file |
| `REGISTRY_PATH` | `../clear-signing-erc7730-registry` | local registry checkout |
| `POLL_MS` | `4000` | head poll interval |
| `START_BLOCK` | current head | first block to process (else: continue after the stored head) |
| `RETENTION_DAYS` | `7` | prune live rows older than this |

Live endpoints on the API:

| Endpoint | Returns |
|---|---|
| `GET /api/live/latest` | the latest processed block, or `null` if the follower has not run |
| `GET /api/live/summary?window=1h\|24h\|7d&limit=200&curve=500` | rolling-window buckets, headline %, library pass/partial/failed totals, and the 80% / 95% ranking for that window |
| `GET /api/live/recent?limit=100&bucket=&since=` | newest transaction rows (hash + labels + intent, no contents) |
| `GET /api/live/tx/:hash` | one stored row including the library's display model |
| `GET /api/live/stream` | Server-Sent Events: a `block` event per new block with the block, its new transaction rows, and the 24h summary |

The window in `summary` ends at the latest processed block, not at wall-clock
now, so a stopped follower still reports its last complete window.

`summary`, `recent` and `ranking` accept `exclude=eth,token,unverified`. `eth`
drops plain ETH sends; `token` drops every call whose selector is a standard
ERC-20/721 transfer or approval, whether or not the token has a descriptor (so
Tether transfers go too); `unverified` drops the not-covered calls to contracts
the Sourcify cache knows to be unverified (no source, so no descriptor can be
written; contracts not yet checked stay in). Excluded transactions leave the
denominator as well as the numerator: `totalTx` shrinks, the ranking baseline
shrinks, and `excluded` / `allTx` say what was removed. The dashboard excludes
ETH and token transfers by default and shows a disclaimer, because the question
it answers is about the calls that need a descriptor. In the ranking, an
unverified contract leaves as a whole row (its rare covered calls with it), so
the page stays an ordered index read.

Each row in `recent` carries `functionSig` and `displayText`. The signature
comes from the registry descriptor for covered transactions, and from
Sourcify's 4-byte database (`api.4byte.sourcify.dev`) for everything else. The
follower looks up the selectors of each block once and caches them in the
`signatures` table (unknown ones are retried after a day). After an upgrade,
`npm run signatures:backfill` names the selectors that are already in
`tx_index`. `displayText` is the whole clear-signed line built from the stored
display model: the intent followed by every field as `Label: value`.

## Stage A — build the coverage set

Reads the registry's published `index.calldata.json` (address → descriptor),
resolves each descriptor's `includes`, reads its `display.formats` function
signatures, and computes each 4-byte selector. Output is one row per
`(chainId, address, selector)`.

The include-resolution and selector logic are ported faithfully from the registry
repo (`.github/scripts/resolve-erc7730-includes.js` and
`tools/scripts/check-contract-functions.js`) so this project stays self-contained
and produces identical selectors — see `packages/coverage/src/erc7730.ts`.

### Run

```bash
npm install

# Point --registry at a local checkout of the registry (defaults to the sibling
# ../clear-signing-erc7730-registry). Mainnet only, write the full set to JSON:
npx tsx packages/coverage/src/cli.ts --chains 1 --out out/coverage-mainnet.json

# All chains, stats only (no file):
npx tsx packages/coverage/src/cli.ts --stats
```

Environment: `REGISTRY_PATH` sets the registry checkout path if `--registry` is
omitted.

### Output shape

`out/coverage-mainnet.json` holds `{ registryPath, registryCommit, generatedAtIso,
rows, stats }`, where each row is:

```json
{
  "chainId": 1,
  "address": "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
  "selector": "0xea598cb0",
  "functionSig": "wrap(uint256 _stETHAmount)",
  "descriptorPath": "registry/lido/calldata-wstETH.json",
  "entity": "lido"
}
```

`standardKind` (`"erc20"` / `"erc721"` / ...) is present only on rows from the
registry's `ercs/` standard descriptors, so the aggregator can label the native
token-transfer bucket.

As of the current registry commit: **1250 mainnet `(address, selector)` rows**
from 172 descriptors, 0 unparsable signatures.

## Deployment

One Ubuntu VM: nginx in front, two systemd services (follower and API), SQLite
on local disk. Sizing, the install script and the day-to-day commands are in
[`deploy/README.md`](deploy/README.md).

## Requirements

Node >= 20.
