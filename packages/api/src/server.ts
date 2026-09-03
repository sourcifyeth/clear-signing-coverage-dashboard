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
 *   GET /api/live/stream            -> SSE; `block` events as new blocks land
 *
 * Env: DB_PATH (default <repo>/out/coverage.sqlite), PORT (default 8787),
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
  liveRanking,
  registryCommit,
  type Bucket,
} from "@ccd/db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const DB_PATH = defaultDbPath();
const PORT = Number(process.env.PORT ?? 8787);
const REGISTRY_PATH = path.resolve(
  process.env.REGISTRY_PATH ?? path.join(REPO_ROOT, "../clear-signing-erc7730-registry"),
);
// Same resolution as the follower. The URL may embed a key: never log it.
const RPC_URL =
  process.env.RPC_URL ??
  (process.env.DRPC_API_KEY
    ? `https://lb.drpc.org/ethereum/${process.env.DRPC_API_KEY}`
    : "https://ethereum-rpc.publicnode.com");

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

// Contracts or functions in the window, ranked by transaction count, with coverage.
app.get("/api/live/ranking", (req, res) => {
  const w = String(req.query.window ?? "24h");
  const hours = WINDOWS[w];
  if (!hours) return res.status(400).json({ error: "window must be 1h, 24h or 7d" });
  const by = req.query.by === "function" ? "function" : "contract";
  res.set("Cache-Control", "no-cache");
  res.json(
    liveRanking(db, hours, {
      by,
      limit: intQuery(req.query.limit, 100),
      ...excludeQuery(req.query.exclude),
    }),
  );
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
  res.set("Cache-Control", "no-cache");
  res.json(
    liveSummary(db, hours, {
      limit: intQuery(req.query.limit, 200),
      curvePoints: intQuery(req.query.curve, 500),
      ...excludeQuery(req.query.exclude),
    }),
  );
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

// One poller for all SSE clients: check the head every 2s; when it advances,
// build the payload once and broadcast it.
const sseClients = new Set<express.Response>();
let ssePrevBlock = latestBlock(db)?.number ?? null;
setInterval(() => {
  if (sseClients.size === 0) {
    ssePrevBlock = latestBlock(db)?.number ?? ssePrevBlock;
    return;
  }
  const lb = latestBlock(db);
  if (!lb || (ssePrevBlock !== null && lb.number <= ssePrevBlock)) return;
  const newBlocks = ssePrevBlock === null ? 1 : Math.max(1, lb.number - ssePrevBlock);
  const payload = JSON.stringify({
    block: { number: lb.number, hash: lb.hash, timeIso: lb.timeIso, txCount: lb.txCount },
    txs: recentTxs(db, { limit: 300, sinceBlock: ssePrevBlock ?? lb.number - 1 }),
    summary: liveSummary(db, 24, { limit: 50 }),
    blocks: blockStats(db, newBlocks),
  });
  ssePrevBlock = lb.number;
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

// Fetch a transaction by hash via RPC (server-side, so no CORS / key exposure).
// Returns only what the decoder needs; nothing is stored.
app.get("/api/tx/:hash", async (req, res) => {
  const hash = String(req.params.hash).trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    return res.status(400).json({ error: "invalid tx hash" });
  }
  try {
    const rpcRes = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getTransactionByHash",
        params: [hash],
      }),
    });
    const body = (await rpcRes.json()) as { result?: any; error?: any };
    if (body.error) return res.status(502).json({ error: `RPC: ${body.error.message}` });
    const tx = body.result;
    if (!tx) return res.status(404).json({ error: "transaction not found" });
    res.json({
      chainId: 1,
      hash: tx.hash,
      to: tx.to, // null for contract creation
      from: tx.from,
      input: tx.input,
      value: tx.value, // hex quantity
      blockNumber: tx.blockNumber,
    });
  } catch (e) {
    res.status(502).json({ error: `RPC request failed: ${(e as Error).message}` });
  }
});

app.listen(PORT, () => {
  console.log(
    `coverage API on http://localhost:${PORT}  (DB_PATH=${DB_PATH}, REGISTRY_PATH=${REGISTRY_PATH})`,
  );
});
