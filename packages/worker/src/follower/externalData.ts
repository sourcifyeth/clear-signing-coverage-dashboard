/**
 * The follower's ExternalDataProvider: what the clear-signing library asks the
 * "wallet" for while it renders a covered transaction.
 *
 *   resolveChainInfo           static (mainnet only)
 *   resolveToken               `tokens` table, else eth_call name/symbol/decimals
 *   resolveNftCollectionName   `tokens` table, else eth_call name()
 *   resolveBlockTimestamp      `blocks` table, else one header call
 *
 * Address names (ENS / local) are deliberately not provided yet.
 *
 * Every RPC path has a short timeout and turns errors into null, so a slow or
 * broken endpoint only leaves a field warning (UNKNOWN_TOKEN, ...) and never
 * stalls the follower. Negative token results are cached for a week; positive
 * ones do not expire. An in-memory map sits in front of SQLite so a hot token
 * costs no query.
 */

import type { ExternalDataProvider, TokenResult } from "@ethereum-sourcify/clear-signing";
import { allTokens, blockTimeIso, upsertTokens, type Db, type TokenIn, type TokenRow } from "@ccd/db";
import type { Rpc } from "./rpc.js";

const CALL_TIMEOUT_MS = 8000;
const NEGATIVE_TTL_MS = 7 * 24 * 3600_000;

const SEL_NAME = "0x06fdde03";
const SEL_SYMBOL = "0x95d89b41";
const SEL_DECIMALS = "0x313ce567";

const CHAIN_INFO: Record<number, { name: string; nativeCurrency: { name: string; symbol: string; decimals: number } }> = {
  1: { name: "Ethereum Mainnet", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } },
};

// ---------------------------------------------------------------------------
// ABI return decoding (just enough for the three getters)

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/\0+$/g, "").trim();
}

/**
 * Decode a `string` return value. Accepts the standard dynamic encoding
 * (offset, length, data) and the pre-standard `bytes32` style (MKR, SAI).
 * Returns null for empty or malformed data.
 */
export function decodeStringReturn(hex: string | null | undefined): string | null {
  if (!hex || hex === "0x") return null;
  const bytes = hexToBytes(hex);
  if (bytes.length === 32) {
    const s = utf8(bytes);
    return s.length > 0 ? s : null;
  }
  if (bytes.length < 64) return null;
  const offset = Number(BigInt("0x" + hex.slice(2, 66)));
  if (offset + 32 > bytes.length) return null;
  const len = Number(BigInt("0x" + hex.slice(2 + offset * 2, 2 + offset * 2 + 64)));
  const start = offset + 32;
  if (len < 0 || start + len > bytes.length) return null;
  const s = utf8(bytes.subarray(start, start + len));
  return s.length > 0 ? s : null;
}

/** Decode a `uint8` return value; null when absent, malformed, or > 255. */
export function decodeUint8Return(hex: string | null | undefined): number | null {
  if (!hex || hex === "0x" || hex.length < 66) return null;
  const n = BigInt("0x" + hex.slice(2, 66));
  if (n < 0n || n > 255n) return null;
  return Number(n);
}

// ---------------------------------------------------------------------------
// Cache

function key(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`;
}

function expired(row: TokenRow): boolean {
  return !row.ok && Date.now() - Date.parse(row.fetchedAtIso) > NEGATIVE_TTL_MS;
}

export class TokenCache {
  private mem = new Map<string, TokenRow>();
  /** in-flight lookups, so two fields for the same token share one request */
  private pending = new Map<string, Promise<TokenRow>>();
  /** tokens fetched from the chain since the last `drainLookups()` */
  private lookups = 0;

  constructor(
    private db: Db,
    private rpc: Rpc,
    private chainId: number,
  ) {
    for (const row of allTokens(db, chainId)) this.mem.set(key(row.chainId, row.address), row);
  }

  get size(): number {
    return this.mem.size;
  }

  /** Number of on-chain lookups since the previous call; resets the counter. */
  drainLookups(): number {
    const n = this.lookups;
    this.lookups = 0;
    return n;
  }

  private store(row: TokenIn): TokenRow {
    const full: TokenRow = { ...row, address: row.address.toLowerCase(), fetchedAtIso: new Date().toISOString() };
    this.mem.set(key(full.chainId, full.address), full);
    upsertTokens(this.db, [full]);
    return full;
  }

  /**
   * Cached row, or a fresh lookup. One lookup fetches all three getters, so
   * the row answers both token amounts (needs decimals) and collection names
   * (needs a name) without a second probe.
   */
  async get(address: string): Promise<TokenRow | null> {
    const k = key(this.chainId, address);
    const hit = this.mem.get(k);
    if (hit && !expired(hit)) return hit.ok ? hit : null;
    let p = this.pending.get(k);
    if (!p) {
      p = this.fetch(address).finally(() => this.pending.delete(k));
      this.pending.set(k, p);
    }
    const row = await p;
    return row.ok ? row : null;
  }

  private async fetch(address: string): Promise<TokenRow> {
    const addr = address.toLowerCase();
    this.lookups++;
    let name: string | null;
    let symbol: string | null;
    let decimals: number | null;
    try {
      const res = await this.rpc.batch(
        [SEL_NAME, SEL_SYMBOL, SEL_DECIMALS].map((data) => ({ method: "eth_call", params: [{ to: addr, data }, "latest"] })),
        { timeoutMs: CALL_TIMEOUT_MS },
      );
      name = decodeStringReturn(res[0]?.result as string | undefined);
      symbol = decodeStringReturn(res[1]?.result as string | undefined);
      decimals = decodeUint8Return(res[2]?.result as string | undefined);
    } catch {
      // transport failure: store nothing durable, answer null this time
      return { chainId: this.chainId, address: addr, kind: "none", name: null, symbol: null, decimals: null, ok: false, fetchedAtIso: new Date().toISOString() };
    }
    const base = { chainId: this.chainId, address: addr, name, symbol, decimals };
    if (symbol !== null && decimals !== null) return this.store({ ...base, kind: "erc20", name: name ?? symbol, ok: true });
    if (name !== null) return this.store({ ...base, kind: "erc721", ok: true }); // has a name, no decimals: a collection or similar
    return this.store({ ...base, kind: "none", ok: false });
  }
}

// ---------------------------------------------------------------------------
// Provider

export function createExternalDataProvider(opts: { db: Db; rpc: Rpc; chainId: number; tokens: TokenCache }): ExternalDataProvider {
  const { db, rpc, chainId, tokens } = opts;
  return {
    resolveChainInfo: async (id) => CHAIN_INFO[id] ?? null,

    resolveToken: async (id, tokenAddress): Promise<TokenResult | null> => {
      if (id !== chainId) return null;
      const row = await tokens.get(tokenAddress);
      if (!row || row.kind !== "erc20" || row.symbol === null || row.decimals === null) return null;
      return { name: row.name ?? row.symbol, symbol: row.symbol, decimals: row.decimals };
    },

    resolveNftCollectionName: async (id, collectionAddress) => {
      if (id !== chainId) return null;
      const row = await tokens.get(collectionAddress);
      return row?.name ? { name: row.name } : null;
    },

    resolveBlockTimestamp: async (id, blockHeight) => {
      if (id !== chainId) return null;
      const n = Number(blockHeight);
      if (!Number.isSafeInteger(n) || n < 0) return null;
      const stored = blockTimeIso(db, n);
      if (stored) return { timestamp: Math.floor(Date.parse(stored) / 1000) };
      try {
        const header = await rpc.blockHeader(n, { timeoutMs: CALL_TIMEOUT_MS });
        return header ? { timestamp: Number(header.timestamp) } : null;
      } catch {
        return null;
      }
    },
  };
}
