/**
 * The preload the database-backed tiers add on the command line.
 *
 * `run.ts` has already created this worker's database; this file's whole job is
 * to point the application at it before the application loads, and to refuse to
 * continue if what it pointed at is not what it thinks.
 *
 * **Why the guards are asserts and not fallbacks.** `bun test` auto-loads `.env`,
 * so the development `DATABASE_URL` — the developer's real data — is present in
 * every test process by default. A harness that *prefers* `TEST_DATABASE_URL` and
 * falls back to whatever is there is one unset variable away from `TRUNCATE`ing
 * that database, and the failure is silent: the tests pass. Every check below
 * hard-exits.
 */
import { SQL } from 'bun';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { HARNESS_SUFFIX, HARNESS_TABLE } from './names';
import { workerUrl } from './provision';

const REPO_ROOT = path.join(import.meta.dir, '..', '..');

/** The database component of a PostgreSQL URL, or null when it names none. */
function databaseNameOf(url: string): string | null {
  return new URL(url).pathname.slice(1) || null;
}

/**
 * `1` when `--parallel` is on and undefined when it is not, so both shapes have
 * to be handled — a `Number(undefined)` here is `NaN` and would name a database
 * called `…_wNaN`, which does not exist and whose absence surfaces 30 seconds
 * later as a connection timeout.
 */
function workerId(): number {
  const raw = process.env.BUN_TEST_WORKER_ID ?? process.env.JEST_WORKER_ID;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * The database name `.env` names, read from the FILE rather than from
 * `process.env`.
 *
 * Read from the file, and NOT because the environment variable is unavailable —
 * an earlier version of this comment claimed exactly that and it was false. It
 * said the tiers run with `--env-file=.env.test`, so `process.env.DATABASE_URL`
 * no longer held the development value; `run.ts` actually spawns `bun test` with
 * `--no-env-file` and hands it `{...process.env}` from a parent that `bun run`
 * populated from `.env`, so the development value IS present in the child and the
 * cheaper comparison is available.
 *
 * The file read is kept for a different reason: it is the only form that is
 * correct when the parent's environment did not come from `.env` at all — CI,
 * where no `.env` exists, and a direct `bun tests/helpers/run.ts` — because there
 * the env-var form would compare against the value this preload is itself about
 * to write, and pass vacuously.
 */
function developmentDatabaseName(): string | null {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fixed path relative to this module
    const raw = readFileSync(path.join(REPO_ROOT, '.env'), 'utf8');
    const line = raw
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('DATABASE_URL='));
    if (!line) return null;
    const value = line
      .slice('DATABASE_URL='.length)
      .trim()
      .replaceAll(/^["']|["']$/g, '');
    return databaseNameOf(value);
  } catch {
    // No `.env`, or an unparseable one. Guard 2 (asked of the server) is the
    // load-bearing one; this is the cheap cross-check, and its absence must not
    // be the thing that stops the suite.
    return null;
  }
}

const runToken = process.env.HARNESS_RUN_TOKEN;
if (!runToken)
  throw new Error(
    'HARNESS_RUN_TOKEN is not set. This preload is only valid under ' +
      '`bun tests/helpers/run.ts <tier>`, which provisions the database it names.'
  );

// Guard 1 lives in `adminUrl()`, which `workerUrl` calls: TEST_DATABASE_URL
// absent is a throw, never a fallback to DATABASE_URL.
const resolved = workerUrl(runToken, workerId());

// Guard 3. Cheap, and it is the one that catches a name-derivation bug before a
// connection is even opened.
const resolvedName = databaseNameOf(resolved);
const devName = developmentDatabaseName();
if (devName && devName === resolvedName)
  throw new Error(
    `the resolved test database (${resolvedName}) is the database .env names. ` +
      'Refusing to run: this suite truncates tables.'
  );

process.env.DATABASE_URL = resolved;

/**
 * Guard 2, and the reason it is asked of the SERVER: the URL is the thing that
 * would be wrong. Parsing a database name out of the string proves the string
 * says `_test`, not that the connection landed on a `_test` database — a
 * `PGDATABASE`, a connection-service file or a pooler rewriting the target all
 * break that equivalence.
 *
 * The ownership marker is checked in the same round trip. A database that ends
 * `_test` but carries no `_harness_schema` table was not created by this harness,
 * and the harness must not write to it.
 */
const client = new SQL(resolved, { max: 1 });
try {
  const [row] = await client`
    select current_database() as db,
           (select count(*) from information_schema.tables
             where table_name = ${HARNESS_TABLE}) as owned`;
  const answer = row as { db: string; owned: number | string };
  const actual = answer.db;

  if (!actual.endsWith(HARNESS_SUFFIX))
    throw new Error(
      `connected to "${actual}", which does not end in "${HARNESS_SUFFIX}". ` +
        'Refusing to run a destructive suite against it.'
    );

  if (Number(answer.owned) === 0)
    throw new Error(
      `"${actual}" carries no ${HARNESS_TABLE} table, so it was not created by ` +
        'this harness. Refusing to touch it.'
    );
} finally {
  // Closed immediately: this pool exists for one query, and leaving it open
  // would sit inside the application's own connection budget for the whole run.
  await client.close();
}
