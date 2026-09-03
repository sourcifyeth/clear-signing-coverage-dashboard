/**
 * Selector -> function signature lookup against Sourcify's 4-byte database
 * (api.4byte.sourcify.dev), cached in the `signatures` table so each selector
 * is fetched once. Unknown selectors are stored with a NULL name and retried
 * after a day.
 *
 * The follower calls `ensureSignatures` once per block with every selector it
 * saw. Failures are logged and skipped: the selectors stay unknown and are
 * retried with the next block.
 */

import { knownSelectors, upsertSignatures, type Db, type SignatureIn } from "@ccd/db";

const LOOKUP_URL = "https://api.4byte.sourcify.dev/signature-database/v1/lookup";
const BATCH = 50;
const TIMEOUT_MS = 8000;

interface LookupEntry {
  name: string;
  filtered: boolean;
  hasVerifiedContract: boolean;
}
interface LookupResponse {
  ok: boolean;
  result?: { function?: Record<string, LookupEntry[] | null> };
}

/** Pick one name per selector: a verified one first, else the first candidate. */
function pickName(entries: LookupEntry[] | null | undefined): { name: string | null; verified: boolean } {
  if (!entries || entries.length === 0) return { name: null, verified: false };
  const verified = entries.find((e) => e.hasVerifiedContract);
  if (verified) return { name: verified.name, verified: true };
  return { name: entries[0].name, verified: false };
}

export async function lookupSignatures(selectors: string[]): Promise<SignatureIn[]> {
  const out: SignatureIn[] = [];
  for (let i = 0; i < selectors.length; i += BATCH) {
    const chunk = selectors.slice(i, i + BATCH);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${LOOKUP_URL}?function=${chunk.join(",")}&filter=true`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`4byte lookup HTTP ${res.status}`);
      const body = (await res.json()) as LookupResponse;
      if (!body.ok) throw new Error("4byte lookup returned ok=false");
      const fn = body.result?.function ?? {};
      for (const sel of chunk) out.push({ selector: sel, ...pickName(fn[sel]) });
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}

/**
 * In-memory front for the `signatures` table. `ensure` looks up only the
 * selectors that are not yet known and stores the results.
 */
export class SignatureCache {
  private known: Set<string>;

  constructor(private db: Db) {
    this.known = knownSelectors(db);
  }

  get size(): number {
    return this.known.size;
  }

  /** Returns the number of selectors newly looked up. Throws on network errors. */
  async ensure(selectors: Iterable<string>): Promise<number> {
    const missing: string[] = [];
    for (const s of selectors) {
      const sel = s.toLowerCase();
      if (sel === "0x" || sel.length !== 10 || this.known.has(sel)) continue;
      this.known.add(sel); // optimistic: removed again below if the lookup fails
      missing.push(sel);
    }
    if (missing.length === 0) return 0;
    try {
      const rows = await lookupSignatures(missing);
      upsertSignatures(this.db, rows);
      return rows.length;
    } catch (e) {
      for (const sel of missing) this.known.delete(sel);
      throw e;
    }
  }
}
