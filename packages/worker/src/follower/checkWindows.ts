#!/usr/bin/env tsx
/**
 * Consistency check for the rolling-window running totals: recomputes every
 * window from `block_groups` + `blocks` and compares it with `window_groups`
 * / `window_meta`. Prints the first differences and exits 1 if there are any.
 *
 * Read-only apart from a TEMP table, so it is safe next to a running follower
 * (a block landing mid-check can show up as a transient difference; rerun).
 *
 * Env:   DB_PATH   SQLite file (default <repo>/out/coverage.sqlite)
 * Usage: npm run windows:check
 */

import { openDb, defaultDbPath, checkWindows, windowMeta, WINDOW_KEYS } from "@ccd/db";

const dbPath = process.env.DB_PATH ?? defaultDbPath();
const db = openDb(dbPath);
const t0 = Date.now();
const diffs = checkWindows(db, { maxDiffs: 10 });
for (const k of WINDOW_KEYS) {
  const m = windowMeta(db, k);
  const rows = (db.prepare("SELECT COUNT(*) AS n FROM window_groups WHERE window = ?").get(k) as { n: number }).n;
  console.log(`${k}: blocks ${m.fromBlock ?? "-"}..${m.toBlock ?? "-"} (${m.blockCount}), ${m.txTotal} txs, ${rows} group rows, ends ${m.toTime ?? "-"}`);
}
if (diffs.length === 0) {
  console.log(`windows consistent (${Date.now() - t0} ms)`);
  db.close();
} else {
  console.error(`windows INCONSISTENT (${diffs.length} shown):`);
  for (const d of diffs) console.error(`  ${d}`);
  db.close();
  process.exit(1);
}
