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
 *
 * Env: OUT_DIR (default <repo>/out), PORT (default 8787).
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

interface ReportFile {
  name: string;
  generatedAtIso: string;
  timeframe: { endIso: string; hours: number };
  totalTx: number;
}

function listReports(): { file: string; json: any }[] {
  if (!fs.existsSync(OUT_DIR)) return [];
  return fs
    .readdirSync(OUT_DIR)
    .filter((f) => f.startsWith("report") && f.endsWith(".json"))
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

app.get("/api/report/:name", (req, res) => {
  const name = path.basename(req.params.name); // prevent path traversal
  const file = path.join(OUT_DIR, name);
  if (!file.startsWith(OUT_DIR) || !fs.existsSync(file)) {
    return res.status(404).json({ error: "not found" });
  }
  res.json(JSON.parse(fs.readFileSync(file, "utf8")));
});

app.listen(PORT, () => {
  console.log(`coverage API on http://localhost:${PORT}  (OUT_DIR=${OUT_DIR})`);
});
