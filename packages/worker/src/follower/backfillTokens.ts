/**
 * One-off: resolve token metadata for every token address that appears in a
 * stored display model (`tokenAddress` on a tokenAmount field) and is not in
 * the `tokens` cache yet. The follower does this per block from now on; run
 * this once after upgrading so the cache is warm for older tokens too.
 *
 *   npm run tokens:backfill
 *
 * Reads tx_index, writes only the tokens table, so it is safe to run next to
 * a live follower.
 */

import { openDb, defaultDbPath, tokenCounts } from "@ccd/db";
import { makeRpc, rpcFromEnv } from "./rpc.js";
import { TokenCache } from "./externalData.js";

const CHAIN_ID = 1;

async function main() {
  const dbPath = process.env.DB_PATH ?? defaultDbPath();
  const db = openDb(dbPath);
  const rpc = makeRpc(rpcFromEnv());
  const rows = db
    .prepare(
      `SELECT DISTINCT lower(j.value) AS address
         FROM tx_index t, json_tree(t.display_json) j
        WHERE t.display_json IS NOT NULL AND j.key = 'tokenAddress'`,
    )
    .all() as { address: string }[];
  const cache = new TokenCache(db, rpc, CHAIN_ID);
  const before = tokenCounts(db);
  process.stderr.write(`tokens: ${rows.length} distinct token addresses in tx_index, ${before.total} already cached (rpc=${rpc.label})\n`);

  let done = 0;
  const CONCURRENCY = 4;
  const queue = rows.map((r) => r.address);
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const address = queue.shift();
        if (!address) return;
        await cache.get(address);
        done++;
        if (done % 50 === 0) process.stderr.write(`tokens: ${done}/${rows.length}\n`);
      }
    }),
  );
  const after = tokenCounts(db);
  process.stderr.write(
    `tokens: looked up ${cache.drainLookups()}; cache now ${after.total} rows (${after.ok} resolved, ${after.negative} negative)\n`,
  );
  db.close();
}

main().catch((e) => {
  process.stderr.write(`tokens: ${(e as Error).message}\n`);
  process.exit(1);
});
