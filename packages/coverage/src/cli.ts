#!/usr/bin/env tsx
/**
 * CLI for Stage A. Builds the coverage set from a local registry checkout and
 * writes it to JSON (and/or prints stats).
 *
 * Usage:
 *   tsx src/cli.ts [--registry <path>] [--chains 1,10] [--out coverage.json] [--stats]
 *
 * Defaults: --registry ../../../clear-signing-erc7730-registry (the sibling repo).
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildCoverageSet } from "./buildCoverage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function gitCommit(repoPath: string): string | null {
  try {
    return execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const defaultRegistry = path.resolve(
    __dirname,
    "../../../../clear-signing-erc7730-registry",
  );
  const registryPath = path.resolve(
    (args.registry as string) || process.env.REGISTRY_PATH || defaultRegistry,
  );

  const chainIds =
    typeof args.chains === "string"
      ? args.chains.split(",").map((s) => Number(s.trim())).filter(Number.isFinite)
      : undefined;

  const set = buildCoverageSet({
    registryPath,
    registryCommit: gitCommit(registryPath),
    generatedAtIso: new Date().toISOString(),
    chainIds,
  });

  process.stderr.write(
    `registry: ${set.registryPath}\n` +
      `commit:   ${set.registryCommit ?? "(unknown)"}\n` +
      `index entries:        ${set.stats.indexEntries}\n` +
      `descriptors read:     ${set.stats.descriptorsRead}\n` +
      `coverage rows:        ${set.stats.rows}\n` +
      `unparsable signatures:${set.stats.unparsableSignatures}\n` +
      `chains (rows each):   ${JSON.stringify(set.stats.chains)}\n`,
  );

  if (typeof args.out === "string") {
    const outPath = path.resolve(args.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(set, null, 2));
    process.stderr.write(`wrote ${outPath}\n`);
  } else if (!args.stats) {
    // Default: emit rows as JSON to stdout so it can be piped.
    process.stdout.write(JSON.stringify(set.rows, null, 2));
  }
}

main();
