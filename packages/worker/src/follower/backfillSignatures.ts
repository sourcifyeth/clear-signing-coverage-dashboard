/**
 * One-off: look up function names for every selector already in tx_index that
 * the `signatures` table does not know yet. The follower does this per block
 * from now on; run this once after upgrading so older rows get names too.
 *
 *   npm run signatures:backfill
 */

import { openDb, defaultDbPath } from "@ccd/db";
import { SignatureCache } from "./signatures.js";

async function main() {
  const dbPath = process.env.DB_PATH ?? defaultDbPath();
  const db = openDb(dbPath);
  const rows = db
    .prepare(`SELECT DISTINCT selector FROM tx_index WHERE selector != '0x' AND bucket != 'contract_creation'`)
    .all() as { selector: string }[];
  const sigs = new SignatureCache(db);
  const before = sigs.size;
  process.stderr.write(`signatures: ${rows.length} distinct selectors in tx_index, ${before} already cached\n`);
  const looked = await sigs.ensure(rows.map((r) => r.selector));
  const named = db.prepare(`SELECT COUNT(*) AS n FROM signatures WHERE name IS NOT NULL`).get() as { n: number };
  process.stderr.write(`signatures: looked up ${looked}; ${named.n} selectors now have a name\n`);
  db.close();
}

main().catch((e) => {
  process.stderr.write(`signatures: ${(e as Error).message}\n`);
  process.exit(1);
});
