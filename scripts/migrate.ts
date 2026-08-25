/**
 * Apply every pending migration to the database in `DATABASE_URL`, in two
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
 * Reads `process.env.DATABASE_URL` directly rather than importing
 * `@/lib/env.server`: migrating a database must not require a password pepper
 * keyring, a Turnstile secret or a session signing key to be configured.
 */
import { SQL } from 'bun';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/bun-sql';
import { migrate } from 'drizzle-orm/bun-sql/migrator';

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

try {
  const [target] = await client`select current_database() as db`;
  console.log(`database: ${(target as { db: string }).db}\n`);

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

  console.log(`\nup to date (${files.length} hand-written file(s) applied).`);
} catch (error) {
  console.error('\nFAILED:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.close();
}
