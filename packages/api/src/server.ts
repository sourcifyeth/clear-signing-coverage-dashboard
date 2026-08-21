#!/usr/bin/env tsx
/**
 * Read-only API for the dashboard. Serves the coverage report snapshots that
 * Stage B writes to the out/ directory. No database yet — the reports are JSON
 * files on disk, newest wins.
 *
 * Endpoints:
 *   GET /api/health            -> { ok: true }
 *   GET /api/reports           -> [{ name, generatedAtIso, timeframe, totalTx }]
 *   GET /api/report/latest     -> full report JSON (most recent by generatedAtIso)
 *   GET /api/report/:name      -> full report JSON for a named file
 *   GET /api/practical/latest  -> latest practical-run JSON
 *   GET /api/registry-index    -> { calldataIndex, typedDataIndex } for the browser resolver
 *   GET /api/descriptor?path=  -> one descriptor JSON from the registry checkout
 *   GET /api/tx/:hash          -> { chainId, hash, to, from, input, value } via RPC
 *
 * Env: OUT_DIR (default <repo>/out), PORT (default 8787),
 *      REGISTRY_PATH (default sibling ../clear-signing-erc7730-registry),
 *      RPC_URL (default a public mainnet endpoint).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const OUT_DIR = path.resolve(process.env.OUT_DIR ?? path.join(REPO_ROOT, "out"));
const PORT = Number(process.env.PORT ?? 8787);
const REGISTRY_PATH = path.resolve(
  process.env.REGISTRY_PATH ?? path.join(REPO_ROOT, "../clear-signing-erc7730-registry"),
);
const RPC_URL = process.env.RPC_URL ?? "https://ethereum-rpc.publicnode.com";

interface ReportFile {
  name: string;
  generatedAtIso: string;
  timeframe: { endIso: string; hours: number };
  totalTx: number;
}

function listByPrefix(prefix: string): { file: string; json: any }[] {
  if (!fs.existsSync(OUT_DIR)) return [];
  return fs
    .readdirSync(OUT_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .map((f) => {
      try {
        const json = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), "utf8"));
        return { file: f, json };
      } catch {
        return null;
      }
    })
    .filter((x): x is { file: string; json: any } => x !== null)
    .sort((a, b) =>
      String(b.json.generatedAtIso ?? "").localeCompare(String(a.json.generatedAtIso ?? "")),
    );
}

// Coverage reports are report*.json; practical runs are practical*.json.
const listReports = () => listByPrefix("report");
const listPractical = () => listByPrefix("practical");

const app = express();
app.use(cors());

app.get("/api/health", (_req, res) => res.json({ ok: true, outDir: OUT_DIR }));

app.get("/api/reports", (_req, res) => {
  const meta: ReportFile[] = listReports().map(({ file, json }) => ({
    name: file,
    generatedAtIso: json.generatedAtIso ?? "",
    timeframe: json.timeframe ?? { endIso: "", hours: 0 },
    totalTx: json.report?.totalTx ?? 0,
  }));
  res.json(meta);
});

app.get("/api/report/latest", (_req, res) => {
  const all = listReports();
  if (all.length === 0) return res.status(404).json({ error: "no reports in out/" });
  res.json(all[0].json);
});

app.get("/api/practical/latest", (_req, res) => {
  const all = listPractical();
  if (all.length === 0) return res.status(404).json({ error: "no practical runs in out/" });
  res.json(all[0].json);
});

app.get("/api/report/:name", (req, res) => {
  const name = path.basename(req.params.name); // prevent path traversal
  const file = path.join(OUT_DIR, name);
  if (!file.startsWith(OUT_DIR) || !fs.existsSync(file)) {
    return res.status(404).json({ error: "not found" });
  }
  res.json(JSON.parse(fs.readFileSync(file, "utf8")));
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
    `coverage API on http://localhost:${PORT}  (OUT_DIR=${OUT_DIR}, REGISTRY_PATH=${REGISTRY_PATH})`,
  );
});
