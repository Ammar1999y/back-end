/**
 * What an integration test uses to get a clean database.
 *
 * `TRUNCATE`, not a fresh database per file: measured on this machine, cloning a
 * migrated template is 0.5–1.3 s to create plus ~1.5 s to drop, while truncating
 * all nine tables is ~200 ms and provisions nothing. Across thirty integration
 * files that is the difference between a minute of pure provisioning and six
 * seconds of it.
 */
import { getTableName, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';

import { db } from '@/db';
import * as schema from '@/db/schema';

import { isHarnessDatabase } from './names';

/**
 * Every table Drizzle knows about, read out of the schema module rather than
 * listed here.
 *
 * A hand-written list is a list that silently stops covering a new table: the
 * suite keeps passing while rows from the previous file survive into the next
 * one, which surfaces as an unrelated uniqueness violation somewhere else.
 */
export function schemaTableNames(): string[] {
  const names: string[] = [];
  // A `filter` with a type predicate does not type-check here: the schema's
  // exported union includes enums and relations, and `PgTable<TableConfig>` is
  // not assignable to the narrow per-table types the union carries. `is()` is
  // still the discriminator; the loop just keeps the narrowing local.
  for (const value of Object.values(schema))
    if (is(value, PgTable)) names.push(getTableName(value as PgTable));
  return names.toSorted((a, b) => (a === b ? 0 : a < b ? -1 : 1));
}

/** Memoised: one round trip per process, not one per `resetTables` call. */
const ownership: { checked: string | null } = { checked: null };

/**
 * Refuses to touch a database this harness did not create.
 *
 * **This is the load-bearing safety guard, and it lives here rather than in an
 * environment variable because this is where the destruction happens.** The
 * preload used to point `DATABASE_URL` at a dead port whenever
 * `HARNESS_RUN_TOKEN` was absent, which protected a bare `bun test` by accident
 * and broke every other `bun test` in the repository on purpose — `bun run
 * probe:db` went from passing to 17 connection failures, and the error named a
 * refused port rather than the preload.
 *
 * Asked of the SERVER, like the preload's guard 2, because the URL is the thing
 * that would be wrong. Every helper that WRITES calls this, so the protection
 * holds no matter how `bun test` was invoked — a hand-run of one integration
 * file, or a bare `bun test` that walks all three tiers, now fails with a
 * sentence naming the cause instead of truncating `app`.
 */
export async function assertHarnessDatabase(): Promise<string> {
  if (ownership.checked) return ownership.checked;

  const name = await currentDatabase();
  if (!isHarnessDatabase(name))
    throw new Error(
      `refusing to write to "${name}": it is not a database this harness ` +
        'created. Run the database tiers through `bun run test:integration` / ' +
        '`bun run test:process`, which provision one and point DATABASE_URL at it.'
    );

  ownership.checked = name;
  return name;
}

/**
 * One statement, `RESTART IDENTITY CASCADE`, in a `beforeAll` — and in
 * `beforeEach` for a file that needs a clean slate between tests.
 *
 * `CASCADE` because the tables are a foreign-key graph and PostgreSQL refuses to
 * truncate half of one. `RESTART IDENTITY` matters even though every primary key
 * here is a UUID: `audit_logs` and the verification tables carry sequences that a
 * later assertion on ordering would otherwise inherit from the previous file.
 *
 * `_harness_schema` and `drizzle.__drizzle_migrations` are absent by construction
 * — neither is in the Drizzle schema — which is what keeps the ownership marker
 * and the migration ledger intact across a truncate.
 */
export async function resetTables(): Promise<void> {
  await assertHarnessDatabase();
  const names = schemaTableNames();
  const list = names.map((name) => `"${name}"`).join(', ');
  await db.execute(sql.raw(`truncate table ${list} restart identity cascade`));
}

/** The database this worker is actually connected to, asked of the server. */
export async function currentDatabase(): Promise<string> {
  const rows = await db.execute<{ db: string }>(
    sql`select current_database() as db`
  );
  const row = rows[0];
  if (!row) throw new Error('current_database() returned no row');
  return row.db;
}
