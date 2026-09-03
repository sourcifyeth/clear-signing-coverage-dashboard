/**
 * Token metadata cache (`tokens` table). The follower's ExternalDataProvider
 * reads through an in-memory map first; these helpers are the SQLite side.
 */

import type { Db } from "./index.js";

export type TokenKind = "erc20" | "erc721" | "none";

export interface TokenRow {
  chainId: number;
  /** lowercase 0x address */
  address: string;
  kind: TokenKind;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  /** false = negative entry: the address answered no token getters */
  ok: boolean;
  fetchedAtIso: string;
}

export type TokenIn = Omit<TokenRow, "fetchedAtIso">;

interface Raw {
  chain_id: number;
  address: string;
  kind: TokenKind;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  ok: number;
  fetched_at: string;
}

function toRow(r: Raw): TokenRow {
  return {
    chainId: r.chain_id,
    address: r.address,
    kind: r.kind,
    name: r.name,
    symbol: r.symbol,
    decimals: r.decimals,
    ok: r.ok === 1,
    fetchedAtIso: r.fetched_at,
  };
}

const COLS = "chain_id, address, kind, name, symbol, decimals, ok, fetched_at";

export function getToken(db: Db, chainId: number, address: string): TokenRow | null {
  const r = db.prepare(`SELECT ${COLS} FROM tokens WHERE chain_id = ? AND address = ?`).get(chainId, address.toLowerCase()) as
    | Raw
    | undefined;
  return r ? toRow(r) : null;
}

/** Every cached row (positive and negative) for one chain. */
export function allTokens(db: Db, chainId: number): TokenRow[] {
  return (db.prepare(`SELECT ${COLS} FROM tokens WHERE chain_id = ?`).all(chainId) as Raw[]).map(toRow);
}

export function upsertTokens(db: Db, rows: TokenIn[]): void {
  if (rows.length === 0) return;
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO tokens (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chain_id, address) DO UPDATE SET
       kind = excluded.kind, name = excluded.name, symbol = excluded.symbol,
       decimals = excluded.decimals, ok = excluded.ok, fetched_at = excluded.fetched_at`,
  );
  db.transaction((rs: TokenIn[]) => {
    for (const r of rs) stmt.run(r.chainId, r.address.toLowerCase(), r.kind, r.name, r.symbol, r.decimals, r.ok ? 1 : 0, now);
  })(rows);
}

export function tokenCounts(db: Db): { total: number; ok: number; negative: number } {
  const r = db
    .prepare(`SELECT COUNT(*) AS total, SUM(ok) AS ok FROM tokens`)
    .get() as { total: number; ok: number | null };
  const ok = r.ok ?? 0;
  return { total: r.total, ok, negative: r.total - ok };
}

/** Stored block time (ISO) for a block the follower has processed, else null. */
export function blockTimeIso(db: Db, number: number): string | null {
  const r = db.prepare("SELECT block_time FROM blocks WHERE number = ?").get(number) as { block_time: string } | undefined;
  return r?.block_time ?? null;
}
