/**
 * ERC-7730 helpers, ported faithfully from the registry repo so this project
 * stays self-contained. Two pieces:
 *
 *  1. resolveDescriptor — inlines a descriptor's `includes` (shared common-*.json
 *     fragments) into one merged document. Ported from
 *     clear-signing-erc7730-registry/.github/scripts/resolve-erc7730-includes.js
 *     Merge rule: the including file wins; display.formats[].fields merge by path.
 *
 *  2. normalizeSignature / computeSelector — turn a human-readable format key
 *     ("repay(address asset, uint256 amount, ...)") into a 4-byte selector.
 *     Ported from
 *     clear-signing-erc7730-registry/tools/scripts/check-contract-functions.js
 *
 * Keeping keccak on js-sha3 (as the registry does) guarantees identical selectors.
 */

import fs from "node:fs";
import path from "node:path";
import sha3 from "js-sha3";
const { keccak256 } = sha3;

// ---------------------------------------------------------------------------
// Descriptor types (only the parts we read)
// ---------------------------------------------------------------------------

export interface Deployment {
  chainId: number;
  address: string;
}

export interface Erc7730Descriptor {
  includes?: string;
  context?: {
    contract?: { deployments?: Deployment[] };
    eip712?: { deployments?: Deployment[] };
  };
  metadata?: { owner?: string; [k: string]: unknown };
  display?: { formats?: Record<string, unknown> };
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// 1. Include resolution
// ---------------------------------------------------------------------------

function loadDescriptor(filePath: string): { doc: Erc7730Descriptor; dir: string } {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Descriptor not found: ${absPath}`);
  }
  const raw = fs.readFileSync(absPath, "utf8");
  return { doc: JSON.parse(raw) as Erc7730Descriptor, dir: path.dirname(absPath) };
}

function resolveInclude(includeRef: string, fromDir: string): string {
  const resolved = path.resolve(fromDir, includeRef);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Include not found: ${includeRef} (resolved to ${resolved})`);
  }
  return resolved;
}

/**
 * Merge fields arrays by path: same path => single object with including
 * overriding included; then append including's fields whose path is new.
 */
function mergeFields(includedFields: any, includingFields: any): any[] {
  if (!includedFields || !Array.isArray(includedFields)) return includingFields || [];
  if (!includingFields || !Array.isArray(includingFields)) return includedFields;

  const byPath = new Map<unknown, any>();
  for (const f of includedFields) {
    const p = f.path;
    if (p !== undefined) byPath.set(p, { ...f });
  }
  for (const f of includingFields) {
    const p = f.path;
    if (p !== undefined) {
      const existing = byPath.get(p);
      byPath.set(p, existing ? { ...existing, ...f } : { ...f });
    }
  }
  const order = includedFields.map((f: any) => f.path).filter((p: unknown) => p !== undefined);
  const appended = includingFields.filter(
    (f: any) => f.path !== undefined && !order.includes(f.path),
  );
  return [...order.map((p: unknown) => byPath.get(p)), ...appended].filter(Boolean);
}

/** Deep merge; value from b (the including file) wins on conflicts. */
function deepMerge(a: any, b: any): any {
  if (a === null || a === undefined) return b;
  if (b === null || b === undefined) return a;
  if (typeof a !== "object" || typeof b !== "object") return b;
  if (Array.isArray(a) && Array.isArray(b)) return b;

  const out: any = { ...a };
  for (const key of Object.keys(b)) {
    if (key === "fields" && Array.isArray(a.fields) && Array.isArray(b.fields)) {
      out.fields = mergeFields(a.fields, b.fields);
    } else if (
      key === "formats" &&
      typeof a.formats === "object" &&
      a.formats !== null &&
      typeof b.formats === "object" &&
      b.formats !== null
    ) {
      out.formats = {};
      const allSigs = new Set([...Object.keys(a.formats), ...Object.keys(b.formats)]);
      for (const sig of allSigs) {
        out.formats[sig] = deepMerge(a.formats[sig] || {}, b.formats[sig] || {});
      }
    } else if (
      typeof b[key] === "object" &&
      b[key] !== null &&
      !Array.isArray(b[key]) &&
      typeof a[key] === "object" &&
      a[key] !== null &&
      !Array.isArray(a[key])
    ) {
      out[key] = deepMerge(a[key], b[key]);
    } else {
      out[key] = b[key];
    }
  }
  return out;
}

/** Load a descriptor and inline its `includes` chain into one document. */
export function resolveDescriptor(inputPath: string): Erc7730Descriptor {
  const { doc, dir } = loadDescriptor(inputPath);
  const includesRef = doc.includes;
  if (includesRef == null || includesRef === "") {
    return { ...doc };
  }
  const includePath = resolveInclude(includesRef, dir);
  const includedMerged = resolveDescriptor(includePath);
  const includingDoc = { ...doc };
  delete includingDoc.includes;
  return deepMerge(includedMerged, includingDoc);
}

// ---------------------------------------------------------------------------
// 2. Signature -> 4-byte selector
// ---------------------------------------------------------------------------

function findMatchingParen(str: string, start: number): number {
  let depth = 0;
  for (let i = start; i < str.length; i++) {
    if (str[i] === "(") depth++;
    if (str[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractType(param: string): string {
  const p = String(param || "").trim();
  if (!p) return "";

  if (p.startsWith("(")) {
    const tupleEnd = findMatchingParen(p, 0);
    if (tupleEnd === -1) return p;
    const tupleContent = p.slice(1, tupleEnd);
    const innerTypes = extractTypes(tupleContent);
    const suffix = p.slice(tupleEnd + 1).trim();
    const arrayMatch = suffix.match(/^(\[\d*\])+/);
    const arraySuffix = arrayMatch ? arrayMatch[0] : "";
    return `(${innerTypes.join(",")})${arraySuffix}`;
  }

  const typeMatch = p.match(/^([A-Za-z_]\w*(?:\[\d*\])*)/);
  return typeMatch ? typeMatch[1] : p;
}

function extractTypes(paramsStr: string): string[] {
  const raw = String(paramsStr || "").trim();
  if (!raw) return [];

  const types: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      if (current.trim()) types.push(extractType(current.trim()));
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) types.push(extractType(current.trim()));
  return types;
}

/** "repay(address asset, uint256 amount)" -> "repay(address,uint256)" */
export function normalizeSignature(signature: string): string | null {
  const sig = String(signature || "").trim();
  const match = sig.match(/^([A-Za-z_]\w*)\s*\(/);
  if (!match) return null;
  const name = match[1];
  const start = sig.indexOf("(");
  const end = findMatchingParen(sig, start);
  if (start === -1 || end === -1) return null;
  const types = extractTypes(sig.slice(start + 1, end));
  return `${name}(${types.join(",")})`;
}

/** Human-readable signature -> "0x" + first 4 bytes of keccak256, or null. */
export function computeSelector(signature: string): string | null {
  const normalized = normalizeSignature(signature);
  if (!normalized) return null;
  return `0x${keccak256(normalized).slice(0, 8)}`;
}
