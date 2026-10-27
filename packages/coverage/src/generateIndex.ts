/**
 * Build the registry's two index files in memory from the descriptors on
 * disk, instead of reading the committed `index.calldata.json` and
 * `index.eip712.json`.
 *
 * Why: the registry regenerates those files on master through a "chore:
 * update index files" pull request that someone has to merge, so they lag the
 * descriptors by days or weeks (on 2026-10-27 the committed index was six days
 * old and missed 209 descriptor files). A dashboard that reads the files
 * reports those contracts as not covered. Walking the descriptors gives the
 * same index the registry would publish, at the registry commit checked out.
 *
 * Ported from the registry's `tools/scripts/generate-index.js` with one
 * difference: a collision (two descriptors claiming one address, or an
 * include that cannot be resolved) is reported in `warnings` and the first
 * descriptor in sorted path order wins, where the registry's script exits.
 * The dashboard must keep running on a registry commit with such a problem.
 */

import fs from "node:fs";
import path from "node:path";
import sha3 from "js-sha3";
import { resolveDescriptor } from "./erc7730.js";

const { keccak256 } = sha3;

/** `eip155:<chainId>:<lowercase address>` -> repo-relative descriptor path */
export type CalldataIndex = Record<string, string>;
/** `eip155:<chainId>:<lowercase address>` -> primary type -> descriptors with the keccak of each encodeType they format */
export type Eip712Index = Record<string, Record<string, { path: string; encodeTypeHashes: string[] }[]>>;

export interface GeneratedIndexes {
  calldata: CalldataIndex;
  eip712: Eip712Index;
  /** descriptors walked (calldata and eip712 files, tests and attestations left out) */
  descriptorFiles: number;
  /** one line per descriptor skipped or collision resolved */
  warnings: string[];
}

/** Test fixtures and auditor attestations live next to descriptors but are never indexed. */
const EXCLUDED_DIRS = new Set(["tests", "testsv2", "sigs"]);
const REGISTRY_DIR = "registry";

/** Repo-relative descriptor paths under registry/, forward slashes, sorted. */
export function findDescriptors(registryPath: string): string[] {
  const root = path.resolve(registryPath);
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) walk(abs);
      } else if (/^(calldata|eip712)-.*\.json$/.test(entry.name) && !entry.name.endsWith(".tests.json")) {
        found.push(path.relative(root, abs).split(path.sep).join("/"));
      }
    }
  };
  const regDir = path.join(root, REGISTRY_DIR);
  if (fs.existsSync(regDir)) walk(regDir);
  return found.sort();
}

const caip = (chainId: number | string, address: string) => `eip155:${chainId}:${address.trim().toLowerCase()}`;

/** EIP-712 encodeType strings are keyed by "PrimaryType(...)": take the head. */
function primaryTypeOf(encodeType: string): string | undefined {
  const open = encodeType.indexOf("(");
  return open <= 0 ? undefined : encodeType.slice(0, open);
}

/** Build both indexes from a registry checkout (its repo root). */
export function generateIndexes(registryPath: string): GeneratedIndexes {
  const root = path.resolve(registryPath);
  const calldata: CalldataIndex = {};
  const eip712: Eip712Index = {};
  const warnings: string[] = [];
  const files = findDescriptors(root);

  for (const descriptorPath of files) {
    let d: ReturnType<typeof resolveDescriptor>;
    try {
      d = resolveDescriptor(path.join(root, descriptorPath));
    } catch (e) {
      warnings.push(`${descriptorPath}: ${(e as Error).message}`);
      continue;
    }
    const ctx = d.context;
    if (!ctx) continue;

    if (ctx.contract) {
      for (const dep of ctx.contract.deployments ?? []) {
        if (dep.chainId === undefined || !dep.address) continue;
        const key = caip(dep.chainId, dep.address);
        const existing = calldata[key];
        if (existing && existing !== descriptorPath) {
          warnings.push(`duplicate calldata deployment ${key}: ${existing} kept, ${descriptorPath} ignored`);
          continue;
        }
        calldata[key] = descriptorPath;
      }
      continue;
    }

    if (!ctx.eip712) continue;
    const deployments = ctx.eip712.deployments ?? [];
    const formats = d.display?.formats;
    if (deployments.length === 0 || !formats) continue;
    const hashesByPrimaryType = new Map<string, string[]>();
    for (const encodeType of Object.keys(formats)) {
      const pt = primaryTypeOf(encodeType);
      if (!pt) continue;
      const list = hashesByPrimaryType.get(pt) ?? [];
      list.push(`0x${keccak256(encodeType)}`);
      hashesByPrimaryType.set(pt, list);
    }
    if (hashesByPrimaryType.size === 0) continue;
    for (const dep of deployments) {
      if (dep.chainId === undefined || !dep.address) continue;
      const key = caip(dep.chainId, dep.address);
      const byPrimaryType = (eip712[key] ??= {});
      for (const [pt, encodeTypeHashes] of hashesByPrimaryType) {
        const entries = (byPrimaryType[pt] ??= []);
        const clash = entries.find((e) => e.path !== descriptorPath && e.encodeTypeHashes.some((h) => encodeTypeHashes.includes(h)));
        if (clash) {
          warnings.push(`duplicate eip712 encodeType for ${key} (${pt}): ${clash.path} kept, ${descriptorPath} ignored`);
          continue;
        }
        entries.push({ path: descriptorPath, encodeTypeHashes });
      }
    }
  }

  return { calldata: sortKeys(calldata), eip712: sortKeys(eip712), descriptorFiles: files.length, warnings };
}

/** Canonical key order, so two runs give the same object (arrays untouched). */
function sortKeys<T>(value: T): T {
  if (Array.isArray(value) || value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as object)
      .sort()
      .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
  ) as T;
}
