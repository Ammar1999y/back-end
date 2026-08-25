/**
 * The database names the harness owns, and the rule that decides whether a name
 * belongs to it.
 *
 * Pure and dependency-free on purpose: the safety guards in `preload-database.ts`
 * assert against these functions before any connection exists, and
 * `provision.ts` drops databases by matching them. One definition, so a name the
 * provisioner creates can never be a name the guard refuses.
 *
 * **Every name ends in `_test`.** The guard that matters most is asked of the
 * SERVER — `select current_database()` — because the URL is the thing that would
 * be wrong. A suffix rule is what that answer can be checked against.
 */

/** Marks a database as harness-owned. A database without it is never touched. */
export const HARNESS_PREFIX = 'app_harness_';

/** Checked against `current_database()`, not against the URL. */
export const HARNESS_SUFFIX = '_test';

/**
 * The migrated source every worker database is cloned from. Reused across runs:
 * creating it costs ~1.6 s and cloning it ~0.5–1.3 s, so re-migrating per run
 * would pay the expensive half every time for no isolation gain.
 */
export const TEMPLATE_DATABASE = `${HARNESS_PREFIX}template${HARNESS_SUFFIX}`;

/**
 * Table the harness creates inside the template and every clone. Two jobs:
 *
 * - **Ownership marker.** A database matching the name pattern but missing this
 *   table is not one the harness made, so it is left alone rather than dropped.
 * - **Schema fingerprint.** Holds the hash of the migration inputs, so a stale
 *   template is re-created instead of silently serving an old schema.
 *
 * No migration creates it, which is what makes both signals unambiguous.
 */
export const HARNESS_TABLE = '_harness_schema';

/**
 * Separator between the timestamp and the random half of a run token.
 *
 * **`_`, and it must not be a base36 digit.** This was `x`, which IS one:
 * `Date.now().toString(36)` is eight base36 digits and 22.8% of hourly samples
 * over the next five years contain an `x`, so `split('x')` truncated the stamp
 * mid-number. Measured: `mt2zouxi` parsed as `mt2zou`, reporting a database
 * created one second ago as 56.6 YEARS old — past the two-hour staleness
 * threshold, so `reclaimStale` would `DROP DATABASE … WITH (FORCE)` a
 * concurrently running suite's databases and kill its backends. The victim fails
 * with connection errors in whatever test was running, which is exactly the
 * "looks like a flaky assertion rather than a name collision" failure the run
 * token exists to prevent.
 *
 * `_` is the only practical choice that also satisfies `quoteIdentifier`'s
 * `/^[a-z0-9_]+$/`.
 */
const RUN_TOKEN_SEPARATOR = '_';

/**
 * A run token: base36 milliseconds, then a random suffix.
 *
 * The timestamp is not decoration — `staleRunTokenAge` reads it back to drop
 * databases a crashed run abandoned, without connecting to them or asking the
 * server for a creation time it does not record. The random half is what keeps
 * two runs started in the same millisecond apart, which matters because several
 * agents run this suite concurrently.
 */
export function newRunToken(nowMs: number, random: string): string {
  return `${nowMs.toString(36)}${RUN_TOKEN_SEPARATOR}${random}`;
}

/**
 * One database per worker process, named from the run token rather than from the
 * worker index alone.
 *
 * Worker-index-only names (`app_test_w1`) collide across concurrent runs, and the
 * collision is silent: two runs both hold `w1` and truncate each other's tables
 * mid-test. The failure looks like a flaky assertion, not like a name clash.
 */
export function workerDatabaseName(runToken: string, workerId: number): string {
  return `${HARNESS_PREFIX}${runToken}_w${workerId}${HARNESS_SUFFIX}`;
}

/** Every harness database matches this; nothing else does. */
export function isHarnessDatabase(name: string): boolean {
  return name.startsWith(HARNESS_PREFIX) && name.endsWith(HARNESS_SUFFIX);
}

/**
 * Age in milliseconds of the run that created `name`, or `null` when the name
 * carries no readable token (the template, or something shaped like a harness
 * database but not named by `workerDatabaseName`).
 *
 * `null` means "do not reclaim", never "reclaim immediately": an unreadable name
 * is the case where guessing is how a database somebody is using gets dropped.
 */
export function harnessDatabaseAgeMs(
  name: string,
  nowMs: number
): number | null {
  if (!isHarnessDatabase(name)) return null;

  const token = name.slice(HARNESS_PREFIX.length, -HARNESS_SUFFIX.length);
  const stamp = token.split(RUN_TOKEN_SEPARATOR, 1)[0];
  if (!stamp || !/^[0-9a-z]+$/.test(stamp)) return null;

  const created = Number.parseInt(stamp, 36);
  if (!Number.isFinite(created) || created <= 0) return null;

  const age = nowMs - created;
  return age >= 0 ? age : null;
}
