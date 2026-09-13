/**
 * Apply every pending migration to the database in `DATABASE_URL`, in three
 * phases, with one command: `bun run db:migrate`.
 *
 * **Phase 1 — `db/drizzle/`, the generated migrations.** This replaces
 * `drizzle-kit migrate`, which cannot run here at all: drizzle-kit 0.31.10 only
 * connects through `pg`, `postgres`, `@neondatabase/serverless` or
 * `@vercel/postgres`, and this project has none of them — the client is
 * `bun:sql`. Adding one of those four back purely for the CLI would reintroduce
 * a second PostgreSQL driver for a task the ORM already does. So the ORM's own
 * migrator runs it, over the same driver the application uses.
 *
 * It is the same ledger either way: `drizzle-orm`'s pg dialect writes
 * `drizzle.__drizzle_migrations` with the same hashes and `folderMillis` values
 * drizzle-kit does (verified in `node_modules/drizzle-orm/pg-core/dialect.js`),
 * so an environment previously migrated by the CLI continues from where it was
 * rather than replaying.
 *
 * `bun run db:generate` still uses drizzle-kit — `generate` reads `db/schema.ts`
 * and never connects, so it is unaffected.
 *
 * **Phase 2 — `db/migrations/`, the hand-written SQL.** Extensions and GIN
 * trigram indexes, which Drizzle Kit cannot express. Every file must be
 * idempotent (`IF NOT EXISTS`): there is no ledger for these, so re-running is
 * the supported way to bring an environment up to date. That is also why they
 * run after phase 1 rather than before — they index tables phase 1 creates.
 *
 * Each file is sent as ONE multi-statement query, which PostgreSQL runs in an
 * implicit transaction, so a file either applies whole or not at all. That also
 * means `CREATE INDEX CONCURRENTLY` cannot go in a shared file: it is rejected
 * inside a transaction block, so it needs a file of its own containing that
 * single statement.
 *
 * **Phase 3 — the referrer contract.** Every table that references `files` must
 * use the composite `(file_id, file_status)` key. A plain `file_id -> files(id)`
 * key is invisible to `unreferenced()` and blocks only the FINAL row delete,
 * which `finishDeleting` reaches after the object is already destroyed. A new
 * referrer can only arrive through a migration, so this is where it is caught:
 * the integration tier asserts the same rule, but a deployment that never ran
 * the suite would otherwise install the schema that loses bytes.
 *
 * **One advisory lock around all three.** Both migration phases read what is
 * pending before either transaction begins, so two processes starting together
 * both see the same set: the second waits on the DDL, replays it, fails, and
 * rolls back. Harmless with one maintenance shell, a crash loop from a
 * multi-replica entrypoint.
 *
 * Reads `process.env.DATABASE_URL` directly rather than importing
 * `@/lib/env.server`: migrating a database must not require a password pepper
 * keyring, a Turnstile secret or a session signing key to be configured. The
 * two modules phase 3 imports are leaves for the same reason — a registry
 * literal and a pure catalog check, neither of which opens a connection.
 */
import { SQL } from 'bun';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/bun-sql';
import { migrate } from 'drizzle-orm/bun-sql/migrator';

import { referrerContractViolations } from '../lib/media/referrer-contract';
import { registeredFileColumns } from '../lib/media/usage-sources';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = path.join(HERE, '..', 'db', 'drizzle');
const SQL_DIR = path.join(HERE, '..', 'db', 'migrations');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set');
  // eslint-disable-next-line unicorn/no-process-exit -- CLI entry point: the exit code IS this tool's result contract, which is the case the rule excepts
  process.exit(1);
}

/**
 * Explicit code-unit comparator, not the default and not `localeCompare`:
 * migration order must not depend on the host locale, where a locale collation
 * could order `0010_` before `0009_`. Order is the one thing this runner has to
 * get right.
 */
async function sqlFilesInOrder(): Promise<string[]> {
  const entries = await readdir(SQL_DIR);
  return entries
    .filter((f) => f.endsWith('.sql'))
    .toSorted((a, b) => (a === b ? 0 : a < b ? -1 : 1));
}

// One connection: these phases are strictly sequential and nothing else is using
// the pool, so a second one would only be another thing to close.
const client = new SQL(connectionString, { max: 1 });

/**
 * An arbitrary constant, and the only thing that makes two migrators serialize.
 * Any other holder of this exact number would deadlock with them, so it is
 * declared next to its only use rather than in a shared constants file where a
 * second caller could quietly adopt it.
 */
const MIGRATION_LOCK_KEY = 8_421_337_104_552_113n;

try {
  const [target] = await client`select current_database() as db`;
  console.log(`database: ${(target as { db: string }).db}\n`);

  // Blocking, not `try_advisory_lock`: a concurrent migrator is something to
  // WAIT for, and refusing would turn a rolling deploy into a failed release.
  process.stdout.write('migration lock ... ');
  await client`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
  console.log('acquired');

  process.stdout.write('drizzle migrations ... ');
  await migrate(drizzle({ client }), { migrationsFolder: DRIZZLE_DIR });
  console.log('ok');

  const files = await sqlFilesInOrder();
  for (const file of files) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- `file` comes from readdir of a fixed in-repo directory, not from input
    const statements = await readFile(path.join(SQL_DIR, file), 'utf8');
    process.stdout.write(`applying ${file} ... `);
    // `unsafe` because these files are multi-statement and carry no parameters;
    // they are repository content, not input.
    await client.unsafe(statements);
    console.log('ok');
  }

  process.stdout.write('referrer contract ... ');
  const violations = await referrerContractViolations(
    (statement) => client.unsafe(statement),
    registeredFileColumns()
  );
  if (violations.length > 0)
    throw new Error(
      'foreign keys into files break the referrer contract, so deleting one ' +
        'would destroy the object before PostgreSQL refuses the row: ' +
        violations.join('; ')
    );
  console.log('ok');

  console.log(`\nup to date (${files.length} hand-written file(s) applied).`);
} catch (error) {
  console.error('\nFAILED:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  // Before the close, and tolerant of never having been taken: the connection
  // dying releases it anyway, but an explicit release keeps a pooled backend
  // from carrying the lock into whatever reuses it.
  await client`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`.catch(
    () => []
  );
  await client.close();
}
