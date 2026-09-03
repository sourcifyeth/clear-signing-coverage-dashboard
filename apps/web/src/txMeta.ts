/**
 * Small pure helpers shared by the ticker, the ranking tables, and the
 * transaction modal: how to name a contract, a function, and which icon a
 * transaction gets.
 */

import type { LiveTx } from "./types.ts";
import { labelFor } from "./labels.ts";
import { short } from "./buckets.ts";

/**
 * Canonical form of a signature: parameter names dropped, e.g.
 * "transfer(address _to, uint256 _value)" -> "transfer(address,uint256)".
 * Tuples keep their nesting. Already-canonical input passes through unchanged.
 */
export function canonicalSig(sig: string): string {
  const open = sig.indexOf("(");
  if (open < 0) return sig;
  const name = sig.slice(0, open).trim();
  const body = sig.slice(open + 1, sig.lastIndexOf(")"));
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  const types = parts.map((p) => {
    const s = p.trim();
    if (s.startsWith("(")) {
      // tuple: "(address a, uint256 b)[] name" -> "(address,uint256)[]"
      const end = s.lastIndexOf(")");
      // keep only array suffixes such as "[]" or "[2]", drop the parameter name
      const after = s.slice(end + 1).trim().match(/^(\[[^\]]*\])+/)?.[0] ?? "";
      return canonicalSig(`_${s.slice(0, end + 1)}`).slice(1) + after;
    }
    return s.split(/\s+/)[0];
  });
  return `${name}(${types.join(",")})`;
}

/** Just the function name: "transfer(address,uint256)" -> "transfer". */
export function fnShort(sig: string | null): string | null {
  return sig ? sig.split("(")[0] : null;
}

/** Contract label for a row: entity from the registry, else a known label, else the short address. */
/** A real name for the contract (registry entity or a known label), or null when we only have the address. */
export function knownName(toAddress: string | null, entity: string | null): string | null {
  if (entity) return entity;
  return toAddress ? labelFor(toAddress) : null;
}

export function contractName(toAddress: string | null, entity: string | null): string {
  if (entity) return entity;
  if (!toAddress) return "?";
  return labelFor(toAddress) ?? short(toAddress);
}

export function who(t: LiveTx): string {
  if (t.bucket === "contract_creation") return "contract creation";
  return contractName(t.toAddress, t.entity);
}

/** Function column: the canonical signature when we know one, else null (the selector is shown next to it). */
export function fnName(t: LiveTx): string | null {
  if (t.bucket === "eth_transfer") return "ETH transfer";
  if (t.bucket === "contract_creation") return null;
  return t.functionSig ? canonicalSig(t.functionSig) : null;
}

export interface TxIcon {
  glyph: string;
  tip: string;
  cls?: string;
}

/**
 * Row icon: what a wallet user gets for this transaction.
 *   ✅ clear-signed by a descriptor   ⚠️ clear-signed with warnings
 *   ❌ raw hex (no descriptor, or the library failed)
 *   💸 token transfer / approve (wallet-native)   Ξ plain ETH transfer   📦 contract creation
 */
export function iconFor(t: Pick<LiveTx, "bucket" | "status">): TxIcon {
  switch (t.bucket) {
    case "eth_transfer":
      return { glyph: "Ξ", tip: "ETH transfer — wallets show this natively", cls: "eth" };
    case "token_native":
      return { glyph: "💸", tip: "Token transfer / approve — wallets show this natively" };
    case "contract_creation":
      return { glyph: "📦", tip: "Contract creation" };
    case "covered_theory":
      if (t.status === "failed") return { glyph: "❌", tip: "Descriptor exists, but the library failed" };
      if (t.status === "partial") return { glyph: "⚠️", tip: "Clear-signed, with warnings" };
      return { glyph: "✅", tip: "Clear-signed by an ERC-7730 descriptor" };
    default:
      return { glyph: "❌", tip: "Not clear-signable — the wallet shows raw hex" };
  }
}

export const REGISTRY_REPO = "https://github.com/ethereum/clear-signing-erc7730-registry";
/** The Sourcify Clear-Signing SDK (`@ethereum-sourcify/clear-signing`), which renders the display models. */
export const SDK_REPO = "https://github.com/sourcifyeth/clear-signing";

/**
 * Where a contract address links to: Sourcify's repository page for it
 * (verified source, ABI, metadata). Transactions and blocks keep their
 * Etherscan links; contracts never link to Etherscan.
 */
export function contractUrl(chainId: number, address: string): string {
  return `https://repo.sourcify.dev/${chainId}/${address}`;
}

/** Character limits for table cells: short labels (names, signatures) and running text (clear-signed text, field values). */
export const CLIP_NAME = 48;
export const CLIP_TEXT = 120;

/**
 * Cut a cell's text past `max` characters and end it with an ellipsis. Callers
 * put the full text in the cell's `title` so hover still shows all of it.
 */
export function clip(text: string, max: number = CLIP_NAME): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
