#!/usr/bin/env tsx
/**
 * Read-only API for the dashboard. Reads the SQLite database the worker
 * writes (see @ccd/db) and serves the latest aggregate / practical runs in the
 * shapes the web app consumes.
 *
 * Endpoints:
 *   GET /api/health                 -> { ok, dbPath, runs }
 *   GET /api/runs[?kind=aggregate]  -> [{ id, kind, generatedAtIso, window, totalTx?, ... }]
 *   GET /api/reports                -> aggregate runs only (legacy alias of /api/runs?kind=aggregate)
 *   GET /api/report/latest?limit=200&curve=500
 *                                   -> latest aggregate run; ranking limited to the
 *                                      top `limit` contracts plus a downsampled curve
 *   GET /api/report/:id             -> same, for a run id
 *   GET /api/practical/latest       -> latest practical run
 *   GET /api/practical/:id          -> practical run by id
 *   GET /api/registry-index         -> { calldataIndex, typedDataIndex } for the browser resolver
 *   GET /api/descriptor?path=       -> one descriptor JSON from the registry checkout
 *   GET /api/tx/:hash               -> { chainId, hash, to, from, input, value } via RPC
 *
 * Live (written by the block follower, `npm run follow`):
 *   GET /api/live/latest            -> { latest: { number, hash, timeIso, txCount } | null, blocks }
 *   GET /api/live/summary?window=1h|24h|7d&limit=200&curve=500
 *                                   -> rolling-window buckets, practice, ranking
 *   GET /api/live/recent?limit=100&bucket=&since=
 *                                   -> newest tx rows (hash + labels + intent, no contents)
 *   GET /api/live/tx/:hash          -> one stored row incl. the library's DisplayModel
 *   GET /api/live/tx/:hash/raw      -> the transaction as the node has it (from, to,
 *                                      value, calldata, nonce, gas, type), via RPC, cached
 *   GET /api/live/stream            -> SSE; `block` events as new blocks land
 *
 * Env: DB_PATH (default <repo>/out/coverage.sqlite), PORT (default 8787),
 *      HOST (bind address, default 127.0.0.1),
 *      REGISTRY_PATH (default sibling ../clear-signing-erc7730-registry),
 *      RPC_URL (else DRPC_API_KEY -> DRPC, else a public mainnet endpoint).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import {
  openDb,
  defaultDbPath,
  listRuns,
  readReport,
  readPractical,
  countTable,
  latestBlock,
  liveBlockCount,
  liveSummary,
  recentTxs,
  liveTx,
  blockStats,
  blockDetail,
  liveRanking,
  registryCommit,
  type Bucket,
  type LiveSummary,
  type LiveRanking,
} from "@ccd/db";
import { makeRpc, rpcFromEnv } from "@ccd/rpc";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const DB_PATH = defaultDbPath();
const PORT = Number(process.env.PORT ?? 8787);
// Bind address. Loopback by default: in production nginx sits in front, and
// in development Vite proxies to localhost. Set HOST=0.0.0.0 to expose it.
const HOST = process.env.HOST || "127.0.0.1";
const REGISTRY_PATH = path.resolve(
  process.env.REGISTRY_PATH ?? path.join(REPO_ROOT, "../clear-signing-erc7730-registry"),
);
// Same endpoint resolution as the follower (RPC_URL, else DRPC_API_KEY, else a
// public node). The URL may embed a key: only `rpc.label` is ever logged.
const rpc = makeRpc(rpcFromEnv(), { timeoutMs: 8000 });

const WINDOWS: Record<string, number> = { "1h": 1, "24h": 24, "7d": 168 };
const BUCKET_NAMES = new Set<string>(["contract_creation", "eth_transfer", "covered_theory", "token_native", "not_covered"]);

// One long-lived connection. WAL mode lets the worker write while we read.
const db = openDb(DB_PATH);

const app = express();
app.use(cors());

function idParam(raw: string): number | "latest" | null {
  if (raw === "latest") return "latest";
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function intQuery(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

app.get("/api/health", (_req, res) =>
  res.json({ ok: true, dbPath: DB_PATH, runs: countTable(db, "runs"), liveBlocks: liveBlockCount(db) }),
);

app.get("/api/runs", (req, res) => {
  const kind = req.query.kind === "aggregate" || req.query.kind === "practical" ? req.query.kind : undefined;
  res.json(listRuns(db, kind, intQuery(req.query.limit, 100)));
});

// Legacy alias used by the first UI: aggregate runs only.
app.get("/api/reports", (req, res) => {
  res.json(listRuns(db, "aggregate", intQuery(req.query.limit, 100)));
});

app.get("/api/report/:id", (req, res) => {
  const id = idParam(req.params.id);
  if (id === null) return res.status(400).json({ error: "id must be a run id or 'latest'" });
  const report = readReport(db, id, {
    limit: intQuery(req.query.limit, 200),
    curvePoints: intQuery(req.query.curve, 500),
  });
  if (!report) return res.status(404).json({ error: "no aggregate run found" });
  res.json(report);
});

app.get("/api/practical/:id", (req, res) => {
  const id = idParam(req.params.id);
  if (id === null) return res.status(400).json({ error: "id must be a run id or 'latest'" });
  const report = readPractical(db, id);
  if (!report) return res.status(404).json({ error: "no practical run found" });
  res.json(report);
});

// --- live (block follower) ---

app.get("/api/live/latest", (_req, res) => {
  res.set("Cache-Control", "no-cache");
  res.json({ latest: latestBlock(db), blocks: liveBlockCount(db), registryCommit: registryCommit(db) });
});

// Per-block breakdown for the newest blocks (oldest first).
app.get("/api/live/blocks", (req, res) => {
  res.set("Cache-Control", "no-cache");
  res.json(blockStats(db, intQuery(req.query.limit, 60)));
});

// One block: header, breakdown, and all of its stored transaction rows.
app.get("/api/live/block/:number", (req, res) => {
  const n = Number(req.params.number);
  if (!Number.isInteger(n) || n < 0) return res.status(400).json({ error: "invalid block number" });
  const d = blockDetail(db, n);
  if (!d) return res.status(404).json({ error: "block not in the live index" });
  res.set("Cache-Control", "no-cache");
  res.json(d);
});

// ---------------------------------------------------------------------------
// Per-block caches. The follower writes one block every ~12 s; nothing the
// summary or ranking endpoints return changes in between. So each response is
// computed at most once per block and served from memory until the next one.

const log = (msg: string) => process.stderr.write(`${new Date().toISOString()} api: ${msg}\n`);

/** Summaries: one entry per (window, excludeEth, excludeToken); 12 at most. */
interface SummaryEntry {
  value: LiveSummary;
  /** the latest block when it was computed */
  block: number | null;
  computedAtIso: string;
  /** last time a request asked for it; idle entries are not refreshed */
  lastRequestedAt: number;
}
const SUMMARY_LIMIT = 200;
const SUMMARY_CURVE = 500;
/** an entry is refreshed on new blocks only while it was requested within this long */
const SUMMARY_ACTIVE_MS = 10 * 60_000;
const summaryCache = new Map<string, SummaryEntry>();
const summaryKey = (hours: number, f: { excludeEth: boolean; excludeToken: boolean }) =>
  `${hours}|${f.excludeEth ? 1 : 0}|${f.excludeToken ? 1 : 0}`;

function computeSummary(hours: number, f: { excludeEth: boolean; excludeToken: boolean }, why: string): SummaryEntry {
  const t0 = Date.now();
  const block = latestBlock(db)?.number ?? null;
  const value = liveSummary(db, hours, { limit: SUMMARY_LIMIT, curvePoints: SUMMARY_CURVE, ...f });
  const key = summaryKey(hours, f);
  const prev = summaryCache.get(key);
  const entry: SummaryEntry = { value, block, computedAtIso: new Date().toISOString(), lastRequestedAt: prev?.lastRequestedAt ?? Date.now() };
  summaryCache.set(key, entry);
  log(`summary ${key} recomputed in ${Date.now() - t0} ms (${why}, block ${block ?? "-"})`);
  return entry;
}

/** The cached summary for a request, computed on a miss. */
function cachedSummary(hours: number, f: { excludeEth: boolean; excludeToken: boolean }): SummaryEntry {
  const key = summaryKey(hours, f);
  let e = summaryCache.get(key);
  if (!e) e = computeSummary(hours, f, "miss");
  e.lastRequestedAt = Date.now();
  return e;
}

/**
 * New block: recompute the 24h plain summary now (the SSE payload carries it),
 * then the other active entries one per event-loop turn, so requests
 * interleave with the refreshes instead of waiting behind all of them.
 */
function refreshSummariesForBlock(): void {
  const now = Date.now();
  computeSummary(24, { excludeEth: false, excludeToken: false }, "new block");
  const stale = [...summaryCache.entries()].filter(
    ([k, e]) => k !== summaryKey(24, { excludeEth: false, excludeToken: false }) && now - e.lastRequestedAt <= SUMMARY_ACTIVE_MS,
  );
  const step = () => {
    const next = stale.shift();
    if (!next) return;
    const [hours, eth, token] = next[0].split("|");
    computeSummary(Number(hours), { excludeEth: eth === "1", excludeToken: token === "1" }, "new block, active");
    setImmediate(step);
  };
  setImmediate(step);
}

/** Rankings: keyed by the full query, valid for one block. */
const rankingCache = new Map<string, LiveRanking>();
let rankingCacheBlock: number | null = null;
function cachedRanking(key: string, compute: () => LiveRanking): LiveRanking {
  const block = latestBlock(db)?.number ?? null;
  if (block !== rankingCacheBlock) {
    rankingCache.clear();
    rankingCacheBlock = block;
  }
  let v = rankingCache.get(key);
  if (!v) {
    const t0 = Date.now();
    v = compute();
    rankingCache.set(key, v);
    log(`ranking ${key} computed in ${Date.now() - t0} ms (block ${block ?? "-"})`);
  }
  return v;
}

// Contracts or functions in the window, ranked by transaction count, with coverage.
app.get("/api/live/ranking", (req, res) => {
  const w = String(req.query.window ?? "24h");
  const hours = WINDOWS[w];
  if (!hours) return res.status(400).json({ error: "window must be 1h, 24h or 7d" });
  const by = req.query.by === "function" ? "function" : "contract";
  const opts = {
    by,
    limit: intQuery(req.query.limit, 100),
    offset: intQuery(req.query.offset, 0),
    // `verified=only`: contracts the Sourcify cache marks verified
    verifiedOnly: req.query.verified === "only",
    ...excludeQuery(req.query.exclude),
  } as const;
  res.set("Cache-Control", "no-cache");
  res.json(cachedRanking(`${w}|${JSON.stringify(opts)}`, () => liveRanking(db, hours, opts)));
});

/**
 * `?exclude=eth,token` leaves wallet-native transactions out of a query:
 * `eth` = plain ETH sends, `token` = standard ERC-20/721 transfer and approval
 * calls, whether or not the token has a descriptor.
 */
function excludeQuery(q: unknown): { excludeEth: boolean; excludeToken: boolean } {
  const parts = typeof q === "string" ? q.split(",").map((s) => s.trim()) : [];
  return { excludeEth: parts.includes("eth"), excludeToken: parts.includes("token") };
}

app.get("/api/live/summary", (req, res) => {
  const w = String(req.query.window ?? "24h");
  const hours = WINDOWS[w];
  if (!hours) return res.status(400).json({ error: "window must be 1h, 24h or 7d" });
  const limit = intQuery(req.query.limit, SUMMARY_LIMIT);
  const curvePoints = intQuery(req.query.curve, SUMMARY_CURVE);
  const f = excludeQuery(req.query.exclude);
  res.set("Cache-Control", "no-cache");
  // Larger-than-cached requests are computed on the spot; the web app asks for 50.
  if (limit > SUMMARY_LIMIT || curvePoints !== SUMMARY_CURVE) {
    return res.json(liveSummary(db, hours, { limit, curvePoints, ...f }));
  }
  const e = cachedSummary(hours, f);
  res.json({
    ...e.value,
    ranking: { ...e.value.ranking, contracts: e.value.ranking.contracts.slice(0, limit) },
    computedAtIso: e.computedAtIso,
    latestBlock: e.block,
  });
});

app.get("/api/live/recent", (req, res) => {
  const bucket = typeof req.query.bucket === "string" && BUCKET_NAMES.has(req.query.bucket) ? (req.query.bucket as Bucket) : undefined;
  const since = req.query.since !== undefined ? Number(req.query.since) : undefined;
  res.set("Cache-Control", "no-cache");
  res.json(
    recentTxs(db, {
      limit: intQuery(req.query.limit, 100),
      bucket,
      sinceBlock: Number.isFinite(since) ? since : undefined,
      signableOnly: req.query.signable === "1",
      ...excludeQuery(req.query.exclude),
    }),
  );
});

// A stored transaction with the library result the follower recorded.
app.get("/api/live/tx/:hash", (req, res) => {
  const hash = String(req.params.hash).trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return res.status(400).json({ error: "invalid tx hash" });
  const row = liveTx(db, hash);
  if (!row) return res.status(404).json({ error: "transaction not in the live index" });
  res.set("Cache-Control", "no-cache");
  res.json(row);
});

// One poller: check the head every 2s. When it advances, refresh the cached
// summaries (always) and, when SSE clients are connected, build the block
// payload once and broadcast it.
const sseClients = new Set<express.Response>();
let ssePrevBlock = latestBlock(db)?.number ?? null;
setInterval(() => {
  const lb = latestBlock(db);
  if (!lb || (ssePrevBlock !== null && lb.number <= ssePrevBlock)) return;
  const prev = ssePrevBlock;
  ssePrevBlock = lb.number;
  refreshSummariesForBlock();
  if (sseClients.size === 0) return;
  const newBlocks = prev === null ? 1 : Math.max(1, lb.number - prev);
  const s = cachedSummary(24, { excludeEth: false, excludeToken: false }).value;
  const payload = JSON.stringify({
    block: { number: lb.number, hash: lb.hash, timeIso: lb.timeIso, txCount: lb.txCount },
    txs: recentTxs(db, { limit: 300, sinceBlock: prev ?? lb.number - 1 }),
    summary: { ...s, ranking: { ...s.ranking, contracts: s.ranking.contracts.slice(0, 50) } },
    blocks: blockStats(db, newBlocks),
  });
  for (const c of sseClients) c.write(`event: block\ndata: ${payload}\n\n`);
}, 2000);
setInterval(() => {
  for (const c of sseClients) c.write(`: ping\n\n`);
}, 15_000);

app.get("/api/live/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write(`event: hello\ndata: ${JSON.stringify({ latest: latestBlock(db) })}\n\n`);
  sseClients.add(res);
  req.on("close", () => {
    sseClients.delete(res);
  });
});

// --- browser live-decode support ---

// The RegistryIndex the Sourcify library needs, from the local checkout.
app.get("/api/registry-index", (_req, res) => {
  try {
    const calldataIndex = JSON.parse(
      fs.readFileSync(path.join(REGISTRY_PATH, "index.calldata.json"), "utf8"),
    );
    const eip712Path = path.join(REGISTRY_PATH, "index.eip712.json");
    const typedDataIndex = fs.existsSync(eip712Path)
      ? JSON.parse(fs.readFileSync(eip712Path, "utf8"))
      : {};
    res.json({ calldataIndex, typedDataIndex });
  } catch (e) {
    res.status(500).json({ error: `registry index unreadable: ${(e as Error).message}` });
  }
});

// One descriptor file, by its repo-relative path. Path-guarded to the registry.
app.get("/api/descriptor", (req, res) => {
  const rel = String(req.query.path ?? "");
  if (!rel.endsWith(".json")) return res.status(400).json({ error: "path must be a .json file" });
  const abs = path.resolve(REGISTRY_PATH, rel);
  if (!abs.startsWith(REGISTRY_PATH + path.sep) || !fs.existsSync(abs)) {
    return res.status(404).json({ error: "descriptor not found" });
  }
  res.type("application/json").send(fs.readFileSync(abs, "utf8"));
});

// --- raw transactions on demand ---

/** What eth_getTransactionByHash returns; quantities are hex strings. */
interface RpcRawTx {
  hash: string;
  from: string;
  to: string | null;
  input: string;
  value: string;
  nonce: string;
  gas: string;
  type?: string;
  blockNumber: string | null;
}

/** The shape the transaction modal consumes: decimal strings for big quantities. */
interface RawTxOut {
  hash: string;
  from: string;
  to: string | null;
  /** wei, decimal string */
  value: string;
  input: string;
  nonce: number;
  /** gas limit, decimal string */
  gas: string;
  /** EIP-2718 type, e.g. 0, 1, 2, 3, 4 */
  type: number;
  blockNumber: number | null;
}

/**
 * Small LRU for raw transactions: a modal reopened for the same hash must not
 * cost another RPC round trip. Map keeps insertion order, so the oldest entry
 * is the first key.
 */
const RAW_TX_CACHE_MAX = 500;
const rawTxCache = new Map<string, RawTxOut>();
function rawTxRemember(tx: RawTxOut): void {
  rawTxCache.delete(tx.hash);
  rawTxCache.set(tx.hash, tx);
  if (rawTxCache.size > RAW_TX_CACHE_MAX) rawTxCache.delete(rawTxCache.keys().next().value as string);
}

function hexToDecimalString(hex: string | undefined | null): string {
  try {
    return BigInt(hex ?? "0x0").toString();
  } catch {
    return "0";
  }
}

/** Fetch one transaction over RPC (cached). Null when the node has no such hash. */
async function fetchRawTx(hash: string): Promise<RawTxOut | null> {
  const key = hash.toLowerCase();
  const hit = rawTxCache.get(key);
  if (hit) {
    rawTxRemember(hit); // refresh recency
    return hit;
  }
  const tx = await rpc.call<RpcRawTx | null>("eth_getTransactionByHash", [key], { timeoutMs: 8000 });
  if (!tx) return null;
  const out: RawTxOut = {
    hash: key,
    from: tx.from,
    to: tx.to ?? null,
    value: hexToDecimalString(tx.value),
    input: tx.input,
    nonce: Number(tx.nonce),
    gas: hexToDecimalString(tx.gas),
    type: tx.type === undefined ? 0 : Number(tx.type),
    blockNumber: tx.blockNumber ? Number(tx.blockNumber) : null,
  };
  // Only cache mined transactions: a pending one changes once it lands.
  if (out.blockNumber !== null) rawTxRemember(out);
  return out;
}

// The transaction as the node has it (from, to, value, calldata, ...), fetched
// on demand for the transaction modal. The follower never stores calldata.
app.get("/api/live/tx/:hash/raw", async (req, res) => {
  const hash = String(req.params.hash).trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return res.status(400).json({ error: "invalid tx hash" });
  try {
    const tx = await fetchRawTx(hash);
    if (!tx) return res.status(404).json({ error: "transaction not found on the node" });
    res.set("Cache-Control", "public, max-age=3600");
    res.json(tx);
  } catch (e) {
    res.status(502).json({ error: `RPC request failed: ${(e as Error).message}` });
  }
});

// Older alias used by the browser decoder: same data, hex quantities.
app.get("/api/tx/:hash", async (req, res) => {
  const hash = String(req.params.hash).trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return res.status(400).json({ error: "invalid tx hash" });
  try {
    const tx = await fetchRawTx(hash);
    if (!tx) return res.status(404).json({ error: "transaction not found" });
    res.json({
      chainId: 1,
      hash: tx.hash,
      to: tx.to, // null for contract creation
      from: tx.from,
      input: tx.input,
      value: `0x${BigInt(tx.value).toString(16)}`,
      blockNumber: tx.blockNumber === null ? null : `0x${tx.blockNumber.toString(16)}`,
    });
  } catch (e) {
    res.status(502).json({ error: `RPC request failed: ${(e as Error).message}` });
  }
});

app.listen(PORT, HOST, () => {
  console.log(
    `coverage API on http://${HOST}:${PORT}  (DB_PATH=${DB_PATH}, REGISTRY_PATH=${REGISTRY_PATH})`,
  );
});
