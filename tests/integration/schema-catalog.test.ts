/**
 * The PostgreSQL catalog, compared with what `db/schema.ts` declares.
 *
 * Every enum in this schema is derived from a TypeScript constant — dashboard
 * pages, OTP channels and purposes, two-factor methods, role scopes, the file
 * lifecycle. Adding a member is therefore a source edit that typechecks, lints
 * and passes every suite whose database was built from the same source, and the
 * first thing to disagree is a deployed database: the insert fails with
 * `22P02 invalid input value for enum`, four layers down, as a 500.
 *
 * `bun run check:schema-drift` catches the missing migration at the gate. This
 * catches the migration that was generated but never applied here, and it does
 * it for EVERY enum rather than for the one somebody remembered — `provider_id`
 * had the only label assertion in the suite.
 *
 * Order is asserted too: enum label order is part of the type, it decides how
 * `order by` on such a column sorts, and PostgreSQL can only add labels at a
 * chosen position, never reorder them.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { TransactionRollbackError } from 'drizzle-orm/errors';
import { isPgEnum } from 'drizzle-orm/pg-core';

import { db, withTransaction } from '@/db';
import * as schema from '@/db/schema';

import { assertHarnessDatabase } from '../helpers/database';
import { seedUser } from '../helpers/session';

interface Declared {
  export: string;
  name: string;
  values: readonly string[];
}

function declaredEnums(): Declared[] {
  const declared: Declared[] = [];
  for (const [exportName, value] of Object.entries(schema))
    if (isPgEnum(value))
      declared.push({
        export: exportName,
        name: value.enumName,
        values: value.enumValues,
      });
  return declared.toSorted((a, b) =>
    a.name === b.name ? 0 : a.name < b.name ? -1 : 1
  );
}

// Read-only, but it holds the real client — and `tests/unit/harness-layout`
// makes that the rule rather than the intent: a file importing `@/db` must
// assert the harness owns the database it is pointed at.
beforeAll(async () => {
  await assertHarnessDatabase();
});

describe('the database enums match db/schema.ts', () => {
  test('every declared enum exists with the same labels in the same order', async () => {
    const declared = declaredEnums();
    // A guard on the guard: an empty walk would pass every assertion below.
    expect(declared.length).toBeGreaterThan(5);

    const rows = await db.execute<{ typname: string; labels: string[] }>(sql`
      select t.typname, array_agg(e.enumlabel order by e.enumsortorder) as labels
      from pg_type t
      join pg_enum e on e.enumtypid = t.oid
      join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public'
      group by t.typname
    `);
    const inDatabase = new Map(rows.map((row) => [row.typname, row.labels]));

    expect(
      declared.map((entry) => ({
        name: entry.name,
        values: [...entry.values],
      }))
    ).toEqual(
      declared.map((entry) => ({
        name: entry.name,
        values: inDatabase.get(entry.name) ?? [],
      }))
    );
  });

  test('the database carries no enum this schema does not declare', async () => {
    // The other direction: a label set removed from the source but left in the
    // database is a migration that was never generated, and the column keeps
    // accepting values no code path can produce.
    const rows = await db.execute<{ typname: string }>(sql`
      select distinct t.typname
      from pg_type t
      join pg_enum e on e.enumtypid = t.oid
      join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public'
    `);
    const declared = new Set(declaredEnums().map((entry) => entry.name));

    expect(
      rows.map((row) => row.typname).filter((name) => !declared.has(name))
    ).toEqual([]);
  });
});

/**
 * A migration that DROPS a column has to carry its state across first, and
 * nothing else here would notice if it did not: `check:schema-drift` compares
 * SHAPES, and every test database is built by replaying the whole chain onto an
 * empty one, where there is no state to carry.
 */
describe('the backup-code set-id migration', () => {
  /** The 0015 statements, read from the file the migrator itself runs. */
  async function migrationStatements(): Promise<string[]> {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sqlText = await readFile(
      path.join(
        here,
        '..',
        '..',
        'db',
        'drizzle',
        '0015_backup_code_set_id.sql'
      ),
      'utf8'
    );
    return sqlText
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(Boolean);
  }

  test('carries an acknowledgement that named the set the row still holds', async () => {
    const owners = await Promise.all([seedUser(), seedUser(), seedUser()]);
    const statements = await migrationStatements();
    const rows = [
      // Acknowledged, and the acknowledgement names the current set: a
      // backup-code factor this account can still sign in with.
      { userId: owners[0]?.userId, version: 2, acknowledged: 2, ready: true },
      // Acknowledged against a set since regenerated. It was not ready before
      // the migration and must not become ready because of it.
      { userId: owners[1]?.userId, version: 3, acknowledged: 1, ready: false },
      // The row a TOTP enrolment creates: no set has ever been generated.
      {
        userId: owners[2]?.userId,
        version: 0,
        acknowledged: null,
        ready: false,
      },
    ];

    // Everything below runs in a transaction that is rolled back, because it
    // rebuilds the pre-migration SHAPE of a table the rest of the tier uses.
    await withTransaction(async (tx) => {
      await tx.execute(
        sql`alter table two_factor_credentials
              drop column backup_codes_set_id,
              drop column backup_codes_acknowledged_set_id,
              add column backup_codes_version integer not null default 0,
              add column backup_codes_acknowledged_version integer`
      );
      for (const row of rows)
        await tx.execute(sql`
          insert into two_factor_credentials
            (id, user_id, secret, backup_codes, backup_codes_version,
             backup_codes_acknowledged_version, backup_codes_remaining)
          values (gen_random_uuid(), ${row.userId}, 'secret', 'codes',
                  ${row.version}, ${row.acknowledged}, 1)`);

      for (const statement of statements) await tx.execute(sql.raw(statement));

      const after = await tx.execute<{
        user_id: string;
        set_id: string | null;
        acknowledged_set_id: string | null;
      }>(sql`select user_id,
                    backup_codes_set_id as set_id,
                    backup_codes_acknowledged_set_id as acknowledged_set_id
               from two_factor_credentials`);
      const byUser = new Map(after.map((row) => [row.user_id, row]));

      expect(
        rows.map((row) => {
          const found = byUser.get(row.userId);
          return {
            hasSet: found?.set_id != null,
            ready:
              found?.acknowledged_set_id != null &&
              found.acknowledged_set_id === found.set_id,
          };
        })
      ).toEqual([
        { hasSet: true, ready: true },
        { hasSet: true, ready: false },
        { hasSet: false, ready: false },
      ]);

      tx.rollback();
    }).catch((error: unknown) => {
      if (!(error instanceof TransactionRollbackError)) throw error;
    });
  });
});

/**
 * The order the two ledger checks run in, which is the difference between a
 * refusal and a refusal that arrives too late.
 *
 * Every pending migration commits in ONE transaction (`drizzle-orm`'s pg
 * dialect), so a check that runs after the migrator has already let a `DROP
 * COLUMN` take the state its edited predecessor was meant to carry forward.
 */
describe('the migration gate', () => {
  const MIGRATE_SCRIPT = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'scripts',
    'migrate.ts'
  );

  async function journalEntries(): Promise<
    Array<{ when: number; tag: string }>
  > {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const raw = await readFile(
      path.join(here, '..', '..', 'db', 'drizzle', 'meta', '_journal.json'),
      'utf8'
    );
    return (
      JSON.parse(raw) as { entries: Array<{ when: number; tag: string }> }
    ).entries;
  }

  test('refuses an edited applied migration before it applies a pending one', async () => {
    await assertHarnessDatabase();
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set for this worker');

    const entries = await journalEntries();
    const pending = entries.at(-1);
    const edited = entries.at(-2);
    if (!pending || !edited)
      throw new Error('the journal needs at least two entries for this case');

    const hashOf = async (when: number) => {
      const [row] = await db.execute<{ hash: string }>(
        sql`select hash from drizzle.__drizzle_migrations where created_at = ${when}`
      );
      if (!row) throw new Error(`no ledger row for ${when}`);
      return row.hash;
    };
    const pendingHash = await hashOf(pending.when);
    const editedHash = await hashOf(edited.when);

    let out = '';
    let err = '';
    let code = 0;
    try {
      // The state the case needs: one entry not yet applied, and one applied
      // entry whose file no longer hashes to what the ledger recorded.
      await db.execute(
        sql`delete from drizzle.__drizzle_migrations where created_at = ${pending.when}`
      );
      await db.execute(
        sql`update drizzle.__drizzle_migrations set hash = 'edited-after-it-was-applied'
              where created_at = ${edited.when}`
      );

      const proc = Bun.spawn(['bun', '--no-env-file', MIGRATE_SCRIPT], {
        cwd: path.dirname(path.dirname(MIGRATE_SCRIPT)),
        env: { ...process.env, DATABASE_URL: url },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
    } finally {
      await db.execute(
        sql`update drizzle.__drizzle_migrations set hash = ${editedHash}
              where created_at = ${edited.when}`
      );
      await db.execute(
        sql`insert into drizzle.__drizzle_migrations (hash, created_at)
              select ${pendingHash}, ${pending.when}
              where not exists (
                select 1 from drizzle.__drizzle_migrations
                where created_at = ${pending.when})`
      );
    }

    expect([code, err.includes(`${edited.tag}.sql has changed`)]).toEqual([
      1,
      true,
    ]);
    // The whole point: the migrator never ran, so the pending transaction never
    // committed and the operator sees the refusal with the database intact.
    expect(out).not.toContain('drizzle migrations ... ok');
  });
});
