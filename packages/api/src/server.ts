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
 * Env: DB_PATH (default <repo>/out/coverage.sqlite), PORT (default 8787),
 *      REGISTRY_PATH (default sibling ../clear-signing-erc7730-registry),
 *      RPC_URL (default a public mainnet endpoint).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { openDb, defaultDbPath, listRuns, readReport, readPractical, countTable } from "@ccd/db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const DB_PATH = defaultDbPath();
const PORT = Number(process.env.PORT ?? 8787);
const REGISTRY_PATH = path.resolve(
  process.env.REGISTRY_PATH ?? path.join(REPO_ROOT, "../clear-signing-erc7730-registry"),
);
const RPC_URL = process.env.RPC_URL ?? "https://ethereum-rpc.publicnode.com";

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
  res.json({ ok: true, dbPath: DB_PATH, runs: countTable(db, "runs") }),
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
