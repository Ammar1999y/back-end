/**
 * Opens the production rate-limit store once and prints what it found.
 *
 * Spawned N times against ONE `SQLITE_DIR` so the opens genuinely race. This
 * calls `getRateLimitStore()` — the production path, which calls `openDatabase`
 * with the real `MIGRATIONS` — rather than building its own `Database` and
 * repeating the PRAGMA and `user_version` sequence inline. That distinction is
 * the whole point: the historically reproduced failure was a loser of the race
 * throwing `table rate_limit already exists`, which lives inside `migrate()`'s
 * `BEGIN IMMEDIATE` strategy, and a test that never calls that function cannot
 * see a regression in it.
 *
 * One line of JSON on stdout, non-zero exit on any throw.
 */
import { getRateLimitStore } from '@/lib/rate-limit/store';
import { describeDatabase } from '@/lib/sqlite/database';

const store = getRateLimitStore();
// `consume` proves the schema is usable, not merely present: a partially applied
// migration leaves `user_version` set with a missing index.
const row = store.consume.get<{ count: number; window_start: number }>(
  `probe:${process.pid}`,
  0,
  Date.now() + 60_000,
  10
);

console.log(
  JSON.stringify({
    pid: process.pid,
    userVersion: Number(describeDatabase(store.db).userVersion),
    journalMode: describeDatabase(store.db).journalMode,
    busyTimeout: Number(describeDatabase(store.db).busyTimeout),
    consumed: row?.count ?? null,
  })
);
