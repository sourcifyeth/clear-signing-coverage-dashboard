/**
 * Explorer-style paths for the two modals:
 *   /tx/<hash>       opens the transaction modal
 *   /block/<number>  opens the block modal
 * Anything else is the plain dashboard. nginx and the Vite dev server serve
 * index.html for every path, so these work on a direct load and on reload.
 */
export interface Route {
  tx: string | null;
  block: number | null;
}

const TX_RE = /^\/tx\/(0x[0-9a-fA-F]{64})\/?$/;
const BLOCK_RE = /^\/block\/(\d{1,12})\/?$/;

export function parsePath(pathname: string): Route {
  const t = TX_RE.exec(pathname);
  if (t) return { tx: t[1].toLowerCase(), block: null };
  const b = BLOCK_RE.exec(pathname);
  if (b) return { tx: null, block: Number(b[1]) };
  return { tx: null, block: null };
}

export function pathFor(r: Route): string {
  if (r.tx) return `/tx/${r.tx}`;
  if (r.block !== null) return `/block/${r.block}`;
  return "/";
}

/**
 * Parse free text from the lookup box: a transaction hash or a block number,
 * on its own or inside an explorer URL (…/tx/0x…, …/block/123).
 */
export function parseLookup(text: string): Route | null {
  const s = text.trim();
  const h = /0x[0-9a-fA-F]{64}/.exec(s);
  if (h) return { tx: h[0].toLowerCase(), block: null };
  const inUrl = /\/block\/(\d{1,12})\b/.exec(s);
  if (inUrl) return { tx: null, block: Number(inUrl[1]) };
  const n = s.replace(/[,_\s#]/g, "");
  if (/^\d{1,12}$/.test(n)) return { tx: null, block: Number(n) };
  return null;
}
