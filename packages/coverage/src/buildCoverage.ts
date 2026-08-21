/**
 * Stage A: build the clear-signing coverage set from a local checkout of the
 * ERC-7730 registry.
 *
 * Input:  <registry>/index.calldata.json  (eip155:<chainId>:<address> -> path)
 * Output: one CoveredCalldata row per (chainId, address, selector).
 *
 * The index is address-level only. To know whether a *specific* transaction is
 * clear-signable we also need the function selector, so for each descriptor we
 * resolve its `includes`, read display.formats keys (human-readable function
 * signatures), and compute each selector.
 *
 * The ercs/ standard descriptors (erc20, erc721, ...) are enumerated too and
 * tagged `standardKind` so the aggregator can label the "native token" bucket.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveDescriptor, computeSelector } from "./erc7730.js";

export interface CoveredCalldata {
  chainId: number;
  address: string; // lowercased, as in the index
  selector: string; // 0x + 8 hex
  functionSig: string; // the human-readable format key, verbatim
  descriptorPath: string; // repo-relative
  entity: string; // registry/<entity>/... folder name
  standardKind?: "erc20" | "erc721" | "erc4626" | "other-erc"; // set for ercs/* descriptors
}

export interface CoverageSet {
  registryPath: string;
  registryCommit: string | null;
  generatedAtIso: string; // caller supplies; kept out of pure build for reproducibility
  rows: CoveredCalldata[];
  stats: {
    indexEntries: number;
    descriptorsRead: number;
    rows: number;
    unparsableSignatures: number;
    chains: Record<string, number>; // chainId -> distinct (address,selector) count
  };
}

const CALLDATA_INDEX = "index.calldata.json";

function parseCaipKey(key: string): { chainId: number; address: string } | null {
  // eip155:<chainId>:<address>
  const parts = key.split(":");
  if (parts.length !== 3 || parts[0] !== "eip155") return null;
  const chainId = Number(parts[1]);
  if (!Number.isFinite(chainId)) return null;
  return { chainId, address: parts[2].toLowerCase() };
}

function entityFromPath(descriptorPath: string): string {
  // registry/<entity>/calldata-Foo.json  ->  <entity>
  // ercs/calldata-erc20-tokens.json       ->  ercs
  const parts = descriptorPath.split("/");
  return parts.length >= 2 ? parts[parts.length - 2] : parts[0];
}

function standardKindFor(descriptorPath: string): CoveredCalldata["standardKind"] {
  if (!descriptorPath.startsWith("ercs/")) return undefined;
  const name = descriptorPath.toLowerCase();
  if (name.includes("erc20")) return "erc20";
  if (name.includes("erc721")) return "erc721";
  if (name.includes("erc4626") || name.includes("erc7540")) return "erc4626";
  return "other-erc";
}

/**
 * Build the coverage set. `chainIds` optionally restricts output (e.g. [1] for
 * mainnet only); omit to include every chain the index covers.
 */
export function buildCoverageSet(opts: {
  registryPath: string;
  registryCommit?: string | null;
  generatedAtIso?: string;
  chainIds?: number[];
}): CoverageSet {
  const registryPath = path.resolve(opts.registryPath);
  const indexAbs = path.join(registryPath, CALLDATA_INDEX);
  if (!fs.existsSync(indexAbs)) {
    throw new Error(
      `${CALLDATA_INDEX} not found at ${indexAbs}. Point --registry at a checkout of clear-signing-erc7730-registry.`,
    );
  }
  const index = JSON.parse(fs.readFileSync(indexAbs, "utf8")) as Record<string, string>;

  const chainFilter = opts.chainIds ? new Set(opts.chainIds) : null;

  // Cache descriptor -> selectors (many index keys share one descriptor file).
  const formatsCache = new Map<string, { sig: string; selector: string }[]>();
  let unparsable = 0;

  function selectorsFor(descriptorPath: string): { sig: string; selector: string }[] {
    const cached = formatsCache.get(descriptorPath);
    if (cached) return cached;
    const abs = path.join(registryPath, descriptorPath);
    const merged = resolveDescriptor(abs);
    const formats = merged.display?.formats ?? {};
    const out: { sig: string; selector: string }[] = [];
    for (const sig of Object.keys(formats)) {
      const selector = computeSelector(sig);
      if (!selector) {
        unparsable++;
        continue;
      }
      out.push({ sig, selector });
    }
    formatsCache.set(descriptorPath, out);
    return out;
  }

  const rows: CoveredCalldata[] = [];
  const seen = new Set<string>(); // chainId|address|selector dedup
  let indexEntries = 0;

  for (const [key, descriptorPath] of Object.entries(index)) {
    indexEntries++;
    const parsed = parseCaipKey(key);
    if (!parsed) continue;
    if (chainFilter && !chainFilter.has(parsed.chainId)) continue;

    const entity = entityFromPath(descriptorPath);
    const standardKind = standardKindFor(descriptorPath);

    for (const { sig, selector } of selectorsFor(descriptorPath)) {
      const dedupKey = `${parsed.chainId}|${parsed.address}|${selector}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      rows.push({
        chainId: parsed.chainId,
        address: parsed.address,
        selector,
        functionSig: sig,
        descriptorPath,
        entity,
        standardKind,
      });
    }
  }

  const chains: Record<string, number> = {};
  for (const r of rows) chains[r.chainId] = (chains[r.chainId] ?? 0) + 1;

  return {
    registryPath,
    registryCommit: opts.registryCommit ?? null,
    generatedAtIso: opts.generatedAtIso ?? "",
    rows,
    stats: {
      indexEntries,
      descriptorsRead: formatsCache.size,
      rows: rows.length,
      unparsableSignatures: unparsable,
      chains,
    },
  };
}
