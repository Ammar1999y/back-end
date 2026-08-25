/**
 * Creating and destroying the databases the suite runs against.
 *
 * **Only `run.ts` imports this.** Provisioning is deliberately not done from the
 * preload: a preload runs once per worker (and once per FILE under `--isolate`),
 * so putting `CREATE DATABASE` there means N processes racing to clone one
 * template — and PostgreSQL refuses a clone while any connection to the template
 * is open, so the race is not even theoretical. One sequential provisioner
 * upstream of `bun test`, and the workers only ever open the database that is
 * already waiting for them.
 *
 * Everything here is destructive by design. The databases it creates are cloned
 * from a template, hold nothing a developer typed, and are dropped when the run
 * ends; there is no state worth preserving and therefore no reason to be careful
 * with it. What it must never do is touch a database it did not make — which is
 * what `HARNESS_TABLE` and the name rules in `./names.ts` are for.
 */
import { SQL } from 'bun';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { MAX_POOL_CONNECTIONS } from '@/db/limits';

import {
  HARNESS_PREFIX,
  HARNESS_SUFFIX,
  HARNESS_TABLE,
  harnessDatabaseAgeMs,
  isHarnessDatabase,
  TEMPLATE_DATABASE,
  workerDatabaseName,
} from './names';

const REPO_ROOT = path.join(import.meta.dir, '..', '..');
const DRIZZLE_DIR = path.join(REPO_ROOT, 'db', 'drizzle');
const SQL_MIGRATIONS_DIR = path.join(REPO_ROOT, 'db', 'migrations');

/**
 * Connections the harness must leave for everything that is not a test worker:
 * the developer's own running `bun dev`, a `bun run db:migrate`, this
 * provisioner, and PostgreSQL's own `superuser_reserved_connections`.
 */
const CONNECTION_RESERVE = 25;

/** A leaked database older than this is reclaimed at the next run's start. */
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * Identifier quoting for the one place that needs it.
 *
 * `CREATE DATABASE` and `DROP DATABASE` take no parameters, so the name is
 * interpolated. Every name reaching here comes from `workerDatabaseName` or is
 * read back out of `pg_database` after `isHarnessDatabase` accepted it, but the
 * charset assertion stays: this is the one function in the suite where a bad
 * string becomes SQL, and "the caller is trusted" is how that stops being true.
 */
function quoteIdentifier(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name))
    throw new Error(`refusing to use "${name}" as a database identifier`);
  return `"${name}"`;
}

/**
 * The server and credentials the suite is allowed to use.
 *
 * `TEST_DATABASE_URL` is required and never defaulted. `bun test` auto-loads
 * `.env`, so the development `DATABASE_URL` — pointing at the developer's real
 * data — is present in every test process by default; a harness that *prefers*
 * `TEST_DATABASE_URL` and falls back to `DATABASE_URL` is one unset variable away
 * from truncating that database. Absent is a failure.
 */
export function adminUrl(): string {
  const configured = process.env.TEST_DATABASE_URL?.trim();
  if (!configured)
    throw new Error(
      'TEST_DATABASE_URL is not set. The test harness creates and drops ' +
        'databases and must never be able to reach the development one, so it ' +
        'has no fallback. Copy .env.test.example to .env.test and set it.'
    );

  // Admin DDL runs against the maintenance database: `CREATE DATABASE … TEMPLATE`
  // and `DROP DATABASE` cannot run from inside the database they name.
  const url = new URL(configured);
  url.pathname = '/postgres';
  return url.href;
}

/** The per-worker URL, derived from the same base the admin connection uses. */
export function workerUrl(runToken: string, workerId: number): string {
  const url = new URL(adminUrl());
  url.pathname = `/${workerDatabaseName(runToken, workerId)}`;
  return url.href;
}

/**
 * A hash over everything `bun run db:migrate` reads.
 *
 * The template is reused across runs, so something has to notice when the
 * migrations on disk have moved past it. Hashing the inputs is that something:
 * the journal alone is not enough, because editing a `.sql` file in place leaves
 * the journal identical.
 */
async function schemaFingerprint(): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');

  const journal = path.join(DRIZZLE_DIR, 'meta', '_journal.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fixed in-repo path
  hasher.update(await readFile(journal));

  for (const dir of [DRIZZLE_DIR, SQL_MIGRATIONS_DIR]) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- one of two fixed in-repo migration directories
    const found = await readdir(dir);
    const entries = found
      .filter((f) => f.endsWith('.sql'))
      .toSorted((a, b) => (a === b ? 0 : a < b ? -1 : 1));
    for (const entry of entries) {
      hasher.update(entry);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- `entry` comes from readdir of a fixed in-repo directory
      hasher.update(await readFile(path.join(dir, entry)));
    }
  }

  return hasher.digest('hex');
}

/**
 * `--parallel` ceiling, computed from the server rather than from the CPU count.
 *
 * Each worker constructs the application's pool, so N workers can demand
 * N × `MAX_POOL_CONNECTIONS` backends. Exceeding `max_connections` does not
 * surface as a connection error — it surfaces as Bun's 30-second
 * `connectionTimeout`, which reads as an unrelated hang in whichever test
 * happened to be running.
 */
export async function maxWorkers(client: SQL): Promise<number> {
  const [row] =
    await client`select setting from pg_settings where name = 'max_connections'`;
  const maxConnections = Number(
    (row as { setting: string } | undefined)?.setting ?? 0
  );
  if (!Number.isFinite(maxConnections) || maxConnections <= 0)
    throw new Error('could not read max_connections from pg_settings');

  const budget = Math.floor(
    (maxConnections - CONNECTION_RESERVE) / MAX_POOL_CONNECTIONS
  );
  if (budget < 1)
    throw new Error(
      `max_connections is ${maxConnections}, which leaves no room for a worker ` +
        `pool of ${MAX_POOL_CONNECTIONS} plus ${CONNECTION_RESERVE} reserved connections`
    );

  return budget;
}

async function databaseExists(client: SQL, name: string): Promise<boolean> {
  const rows = await client`select 1 from pg_database where datname = ${name}`;
  return rows.length > 0;
}

/**
 * `WITH (FORCE)` because a worker that crashed mid-query leaves its backend
 * behind, and a plain `DROP DATABASE` then fails with "is being accessed by other
 * users" — turning cleanup into the thing that needs cleanup.
 */
async function dropDatabase(client: SQL, name: string): Promise<void> {
  await client.unsafe(
    `drop database if exists ${quoteIdentifier(name)} with (force)`
  );
}

/** True when the database exists AND carries the harness's ownership marker. */
async function isOwnedByHarness(url: string): Promise<boolean> {
  const client = new SQL(url, { max: 1 });
  try {
    const rows =
      await client`select 1 from information_schema.tables where table_name = ${HARNESS_TABLE}`;
    return rows.length > 0;
  } catch {
    return false;
  } finally {
    await client.close();
  }
}

async function readFingerprint(url: string): Promise<string | null> {
  const client = new SQL(url, { max: 1 });
  try {
    const rows = await client.unsafe(
      `select fingerprint from ${HARNESS_TABLE}`
    );
    return (
      (rows[0] as { fingerprint?: string } | undefined)?.fingerprint ?? null
    );
  } catch {
    return null;
  } finally {
    await client.close();
  }
}

async function writeFingerprint(
  url: string,
  fingerprint: string
): Promise<void> {
  const client = new SQL(url, { max: 1 });
  try {
    await client.unsafe(
      `create table if not exists ${HARNESS_TABLE} (
         fingerprint text not null,
         created_at timestamptz not null default now()
       )`
    );
    await client.unsafe(`delete from ${HARNESS_TABLE}`);
    // Bound, not interpolated. The value is a sha256 hex digest, so nothing was
    // exploitable — but this was the one place in the harness where a VALUE became
    // SQL text, `unsafe` takes bound parameters, and `quoteIdentifier`'s own
    // argument in this file applies: "the caller is trusted" is how that stops
    // being true.
    await client.unsafe(
      `insert into ${HARNESS_TABLE} (fingerprint) values ($1)`,
      [fingerprint]
    );
  } finally {
    await client.close();
  }
}

/**
 * Runs the real `scripts/migrate.ts` against `url`.
 *
 * A subprocess rather than an import, and not for isolation: the script is a
 * top-level-await module that reads `process.env.DATABASE_URL` at load and calls
 * `process.exitCode` on failure. Spawning it is what makes the template's schema
 * the one production gets, applied by the code production uses, rather than a
 * second migration path that can drift.
 */
async function migrateInto(url: string): Promise<void> {
  const proc = Bun.spawn(
    ['bun', '--no-env-file', path.join(REPO_ROOT, 'scripts', 'migrate.ts')],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: url },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`db:migrate exited ${code}\n${out}\n${err}`);
}

/**
 * The migrated template, created if missing and re-created if the migrations
 * moved.
 *
 * Note the `close()` before returning: PostgreSQL refuses `CREATE DATABASE …
 * TEMPLATE t` while any connection to `t` is open, and the fingerprint read
 * above opens one. This is the easiest step in the whole harness to get wrong,
 * because `Bun.SQL` connects lazily — the blocking connection was opened by a
 * read three lines earlier, not by anything that looks like a connect.
 */
export async function ensureTemplate(client: SQL): Promise<void> {
  const fingerprint = await schemaFingerprint();
  const templateUrl = (() => {
    const url = new URL(adminUrl());
    url.pathname = `/${TEMPLATE_DATABASE}`;
    return url.href;
  })();

  if (await databaseExists(client, TEMPLATE_DATABASE)) {
    const owned = await isOwnedByHarness(templateUrl);
    const current = owned ? await readFingerprint(templateUrl) : null;
    if (owned && current === fingerprint) return;

    // Not owned, or stale. Either way it cannot serve as this run's template:
    // an unmarked database of that exact name is a mistake to fail loudly on
    // rather than to drop, because the name is reserved for the harness.
    if (!owned)
      throw new Error(
        `${TEMPLATE_DATABASE} exists but carries no ${HARNESS_TABLE} table, so ` +
          'it was not created by this harness. Inspect it and drop it by hand.'
      );

    await dropDatabase(client, TEMPLATE_DATABASE);
  }

  await client.unsafe(`create database ${quoteIdentifier(TEMPLATE_DATABASE)}`);
  await migrateInto(templateUrl);
  await writeFingerprint(templateUrl, fingerprint);
}

/**
 * One database per worker, cloned from the template.
 *
 * Concurrent clones of one template are fine — the restriction is on connections
 * to the template, not on readers of it — and doing them in parallel is what
 * keeps provisioning at roughly one clone's latency instead of N.
 */
export async function createWorkerDatabases(
  client: SQL,
  runToken: string,
  workers: number
): Promise<string[]> {
  const names = Array.from({ length: workers }, (_, index) =>
    workerDatabaseName(runToken, index + 1)
  );

  await Promise.all(
    names.map((name) =>
      client.unsafe(
        `create database ${quoteIdentifier(name)} template ${quoteIdentifier(TEMPLATE_DATABASE)}`
      )
    )
  );

  return names;
}

/** Best-effort teardown: a name that will not drop must not fail the run. */
export async function dropWorkerDatabases(
  client: SQL,
  names: readonly string[]
): Promise<string[]> {
  const failed: string[] = [];
  await Promise.all(
    names.map(async (name) => {
      try {
        await dropDatabase(client, name);
      } catch {
        failed.push(name);
      }
    })
  );
  return failed;
}

/**
 * Drops harness databases a crashed run left behind.
 *
 * Reclaim is by NAME, not by connecting to each candidate: the run token carries
 * its own creation time, so an abandoned database is identifiable without a
 * round trip and without a liveness check on a pid that may have been reused.
 * The template is exempt — reusing it is the point of it.
 */
export async function reclaimStale(
  client: SQL,
  nowMs: number
): Promise<string[]> {
  const rows =
    await client`select datname from pg_database where datname like ${`${HARNESS_PREFIX}%${HARNESS_SUFFIX}`}`;
  const reclaimed: string[] = [];

  for (const row of rows as { datname: string }[]) {
    const name = row.datname;
    if (name === TEMPLATE_DATABASE || !isHarnessDatabase(name)) continue;

    const age = harnessDatabaseAgeMs(name, nowMs);
    if (age === null || age < STALE_AFTER_MS) continue;

    try {
      await dropDatabase(client, name);
      reclaimed.push(name);
    } catch {
      // A live run may hold it despite the age; leaving it is the safe answer.
    }
  }

  return reclaimed;
}

/** `bun run test:db:reset`: drop every harness database, template included. */
export async function dropEverything(client: SQL): Promise<string[]> {
  const rows =
    await client`select datname from pg_database where datname like ${`${HARNESS_PREFIX}%${HARNESS_SUFFIX}`}`;
  const dropped: string[] = [];
  for (const row of rows as { datname: string }[]) {
    if (!isHarnessDatabase(row.datname)) continue;
    await dropDatabase(client, row.datname);
    dropped.push(row.datname);
  }
  return dropped;
}
