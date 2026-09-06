/**
 * The usage registry (`lib/media/usages.ts`) against the schema it describes.
 *
 * Every owner table a project adds MUST reference `files` with the composite
 * `(file_id, file_status) → files (id, status)` foreign key, a status column a
 * NULL cannot slip through (`NOT NULL`, or a `MATCH FULL` key for an optional
 * attachment) and a `file_status = 'active'` check, and MUST be registered —
 * the registry is what
 * answers "used by", what blocks `unpublish`, what defines "unfiled", and what
 * the sweep's reaper trusts. A table name alone proved too little: it could not
 * see a second file column on a registered table, a plain `file_id → files.id`
 * key with no status guard, or a purpose whose visibility no source matched.
 * The checker here reads the constraints themselves, and the second test proves
 * it can see each of those shapes before the first test is trusted to say the
 * schema is clean.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';

import { db } from '@/db';
import { UPLOAD_PURPOSES } from '@/lib/media/policy';
import { USAGE_SOURCES } from '@/lib/media/usages';

import { resetTables } from '../helpers/database';

interface ForeignKey {
  table: string;
  columns: string[];
  definition: string;
  /** `f` = MATCH FULL, `s` = MATCH SIMPLE (the default), `p` = MATCH PARTIAL. */
  matchType: string;
}

const SCRATCH_TABLES = [
  '_usage_probe_good',
  '_usage_probe_plain',
  '_usage_probe_unchecked',
  '_usage_probe_nullable',
  '_usage_probe_permissive',
  '_usage_probe_matchfull',
] as const;

/**
 * The driver's boolean shape is not guaranteed for a raw statement, so a
 * catalog flag is read through this rather than asserted to be a JS boolean.
 */
const TRUE_FORMS = new Set<unknown>([true, 't', 'true']);
const isTrue = (value: unknown): boolean => TRUE_FORMS.has(value);

/** Every foreign key whose target is `files`, with its columns in key order. */
async function foreignKeysIntoFiles(): Promise<ForeignKey[]> {
  const rows = await db.execute(sql`
    select cl.relname as table_name,
           array_agg(a.attname order by k.ord) as columns,
           c.confmatchtype::text as match_type,
           pg_get_constraintdef(c.oid) as definition
    from pg_constraint c
    join pg_class cl on cl.oid = c.conrelid
    join pg_class ref on ref.oid = c.confrelid
    join unnest(c.conkey) with ordinality as k(attnum, ord) on true
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
    where c.contype = 'f' and ref.relname = 'files'
    group by cl.relname, c.oid
    order by cl.relname
  `);
  return rows.map((row) => ({
    table: String(row['table_name']),
    columns: Array.isArray(row['columns']) ? row['columns'].map(String) : [],
    definition: String(row['definition']),
    matchType: String(row['match_type']),
  }));
}

/** Is this column declared `NOT NULL`? Read from the catalog, not from printed SQL. */
async function isNotNull(table: string, column: string): Promise<boolean> {
  const rows = await db.execute(sql`
    select a.attnotnull
    from pg_attribute a
    join pg_class cl on cl.oid = a.attrelid
    where cl.relname = ${table} and a.attname = ${column}
      and a.attnum > 0 and not a.attisdropped
  `);
  return isTrue(rows[0]?.['attnotnull']);
}

/** The check constraints of one table, as PostgreSQL prints them. */
async function checksOf(table: string): Promise<string[]> {
  const rows = await db.execute<{ definition: string }>(sql`
    select pg_get_constraintdef(c.oid) as definition
    from pg_constraint c
    join pg_class cl on cl.oid = c.conrelid
    where c.contype = 'c' and cl.relname = ${table}
  `);
  return rows.map((row) => row.definition);
}

/**
 * The `CHECK` that pins a status column to `'active'`, as PostgreSQL prints it,
 * whitespace and the optional outer parentheses removed.
 *
 * A substring test was not enough: `check.includes(statusColumn)` also matches
 * a check on an unrelated column whose text merely contains the name, which
 * accepts a table whose status column is pinned to nothing.
 */
const pinsToActive = (definition: string, statusColumn: string): boolean => {
  const normalised = definition.replaceAll(/\s+/g, '').toLowerCase();
  const column = statusColumn.toLowerCase();
  return (
    normalised === `check((${column}='active'::file_status))` ||
    normalised === `check(${column}='active'::file_status)`
  );
};

/**
 * What is wrong with each foreign key into `files`, if anything: not the
 * composite shape, a status column that can be NULL under a `MATCH SIMPLE` key,
 * no `'active'` check on that column, or no registry entry for exactly that
 * table and column.
 *
 * The nullability rule IS the delete protection. `MATCH SIMPLE` skips a row
 * with any NULL key component and a `CHECK` is satisfied by NULL, so a nullable
 * status column carrying the `'active'` check leaves a referrer the database
 * will not defend: the file is deleted and the reference dangles (reproduced).
 * An optional attachment stays expressible — `cover_image_id` may be null —
 * either with a `NOT NULL` status column beside a nullable id, or with a
 * `MATCH FULL` key, where all-null is an absent attachment and a half-null one
 * is refused by the constraint itself.
 */
async function referrerViolations(): Promise<string[]> {
  const violations: string[] = [];
  const keys = await foreignKeysIntoFiles();
  for (const key of keys) {
    const shape =
      /^FOREIGN KEY \((\w+), (\w+)\) REFERENCES files\(id, status\)/.exec(
        key.definition
      );
    if (!shape) {
      violations.push(
        `${key.table}: ${key.definition} is not the composite (file_id, file_status) → files (id, status) key`
      );
      continue;
    }
    const [, fileColumn = '', statusColumn = ''] = shape;
    if (key.matchType !== 'f' && !(await isNotNull(key.table, statusColumn)))
      violations.push(
        `${key.table}.${statusColumn}: nullable under a MATCH SIMPLE key, so a null status skips the foreign key`
      );
    const checks = await checksOf(key.table);
    if (!checks.some((check) => pinsToActive(check, statusColumn)))
      violations.push(
        `${key.table}.${statusColumn}: no check fixing it to 'active'`
      );
    if (
      !USAGE_SOURCES.some(
        (source) => source.table === key.table && source.column === fileColumn
      )
    )
      violations.push(`${key.table}.${fileColumn}: not in USAGE_SOURCES`);
  }
  return violations;
}

beforeAll(async () => {
  await resetTables();
  for (const table of SCRATCH_TABLES)
    await db.execute(sql.raw(`drop table if exists ${table}`));
});

afterAll(async () => {
  for (const table of SCRATCH_TABLES)
    await db.execute(sql.raw(`drop table if exists ${table}`));
});

describe('the referrer contract', () => {
  test('every foreign key into files has the composite shape, the active check, and a registry entry', async () => {
    expect(await referrerViolations()).toEqual([]);
  });

  test('the checker sees an unregistered referrer, a plain key, a missing check, a nullable status and a check that pins nothing', async () => {
    await db.execute(
      sql.raw(`
        create table _usage_probe_good (
          id serial primary key,
          file_id uuid not null,
          file_status file_status not null default 'active' check (file_status = 'active'),
          foreign key (file_id, file_status) references files (id, status)
        );
        create table _usage_probe_plain (
          id serial primary key,
          file_id uuid not null references files (id)
        );
        create table _usage_probe_unchecked (
          id serial primary key,
          file_id uuid not null,
          file_status file_status not null default 'active',
          foreign key (file_id, file_status) references files (id, status)
        );
        create table _usage_probe_nullable (
          id serial primary key,
          file_id uuid not null,
          file_status file_status check (file_status = 'active'),
          foreign key (file_id, file_status) references files (id, status)
        );
        create table _usage_probe_permissive (
          id serial primary key,
          file_id uuid not null,
          file_status file_status not null default 'active',
          file_status_note text not null default 'x' check (file_status_note <> 'active'),
          foreign key (file_id, file_status) references files (id, status)
        );
        create table _usage_probe_matchfull (
          id serial primary key,
          file_id uuid,
          file_status file_status check (file_status = 'active'),
          foreign key (file_id, file_status) references files (id, status) match full
        );
      `)
    );

    const violations = await referrerViolations();

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          '_usage_probe_good.file_id: not in USAGE_SOURCES'
        ),
        expect.stringContaining('_usage_probe_plain: '),
        expect.stringContaining(
          "_usage_probe_unchecked.file_status: no check fixing it to 'active'"
        ),
        expect.stringContaining(
          '_usage_probe_nullable.file_status: nullable under a MATCH SIMPLE key'
        ),
        expect.stringContaining(
          "_usage_probe_permissive.file_status: no check fixing it to 'active'"
        ),
      ])
    );
    // The plain key is one violation, not three: its shape is wrong, and the
    // other two checks presuppose the shape.
    expect(
      violations.filter((v) => v.startsWith('_usage_probe_plain'))
    ).toHaveLength(1);
    // MATCH FULL is the other way to make an OPTIONAL attachment safe, so the
    // only thing wrong with that table is that nobody registered it.
    expect(
      violations.filter((v) => v.startsWith('_usage_probe_matchfull'))
    ).toEqual(['_usage_probe_matchfull.file_id: not in USAGE_SOURCES']);
  });
});

describe('purposes and usage sources', () => {
  test('every purpose has a source with the same resource and visibility, and every source a purpose', () => {
    const purposes = Object.entries(UPLOAD_PURPOSES).flatMap(
      ([resource, named]) =>
        Object.entries(named ?? {}).map(([name, purpose]) => ({
          resource,
          name,
          visibility: purpose.visibility,
        }))
    );

    for (const purpose of purposes)
      expect(
        USAGE_SOURCES.some(
          (source) =>
            source.resource === purpose.resource &&
            source.visibility === purpose.visibility
        ),
        `purpose ${purpose.resource}/${purpose.name} (${purpose.visibility}) has no usage source`
      ).toBe(true);

    for (const source of USAGE_SOURCES)
      expect(
        purposes.some(
          (purpose) =>
            purpose.resource === source.resource &&
            purpose.visibility === source.visibility
        ),
        `usage source ${source.table}.${source.column} (${source.visibility}) has no purpose`
      ).toBe(true);
  });
});
