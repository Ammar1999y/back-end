/**
 * Apply the hand-written SQL migrations in `db/migrations/` — the things
 * Drizzle Kit cannot express (extensions, GIN trigram indexes), which no script
 * reached before, so they had never been created in any environment.
 *
 * Every file must be idempotent (`IF NOT EXISTS`): there is no ledger, so
 * re-running is the supported way to bring an environment up to date.
 *
 * Each file is sent as ONE multi-statement query, which PostgreSQL runs in an
 * implicit transaction — so a file either applies whole or not at all. That
 * also means `CREATE INDEX CONCURRENTLY` cannot go in a shared file: it is
 * rejected inside a transaction block, so it needs a file of its own
 * containing that single statement.
 *
 * Usage: bun run db:migrate:sql
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from '@neondatabase/serverless';

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'db',
  'migrations'
);

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set');
  // eslint-disable-next-line unicorn/no-process-exit -- CLI entry point: the exit code IS this tool's result contract, which is the case the rule excepts
  process.exit(1);
}

// Explicit code-unit comparator, not the default and not `localeCompare`:
// migration order must not depend on the host locale, where a locale collation
// could order `0010_` before `0009_`. Order is the one thing this runner has to
// get right.
const entries = await readdir(MIGRATIONS_DIR);
const files = entries
  .filter((f) => f.endsWith('.sql'))
  .toSorted((a, b) => (a === b ? 0 : a < b ? -1 : 1));

if (files.length === 0) {
  console.log('No SQL migrations found.');
  // eslint-disable-next-line unicorn/no-process-exit -- CLI entry point: the exit code IS this tool's result contract, which is the case the rule excepts
  process.exit(0);
}

const pool = new Pool({ connectionString });

try {
  for (const file of files) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- `file` comes from readdir of a fixed in-repo directory, not from input
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    process.stdout.write(`applying ${file} ... `);
    await pool.query(sql);
    console.log('ok');
  }
  console.log(`\n${files.length} file(s) applied.`);
} catch (error) {
  console.error('\nFAILED:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
