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
 * The checker (`lib/media/referrer-contract.ts`) reads the constraints
 * themselves, and the second test proves it can see each of those shapes before
 * the first test is trusted to say the schema is clean. `scripts/migrate.ts`
 * runs the same function, so a project that never runs this tier still cannot
 * deploy a schema that loses bytes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';

import { db } from '@/db';
import { UPLOAD_PURPOSES } from '@/lib/media/policy';
import { referrerContractViolations } from '@/lib/media/referrer-contract';
import { registeredFileColumns, USAGE_SOURCES } from '@/lib/media/usages';

import { resetTables } from '../helpers/database';

const SCRATCH_TABLES = [
  '_usage_probe_good',
  '_usage_probe_plain',
  '_usage_probe_unchecked',
  '_usage_probe_nullable',
  '_usage_probe_permissive',
  '_usage_probe_matchfull',
  '_usage_probe_setnull',
  '_usage_probe_cascade',
] as const;

/**
 * The production checker, over this tier's connection.
 *
 * `scripts/migrate.ts` runs the same function over its own `bun:sql` client, so
 * the probes below prove the gate that actually refuses a deployment rather
 * than a second copy of its rules.
 */
const referrerViolations = (): Promise<string[]> =>
  referrerContractViolations(
    (statement) => db.execute(sql.raw(statement)),
    registeredFileColumns()
  );

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
        create table _usage_probe_setnull (
          id serial primary key,
          file_id uuid,
          file_status file_status check (file_status = 'active'),
          foreign key (file_id, file_status) references files (id, status)
            match full on update set null
        );
        create table _usage_probe_cascade (
          id serial primary key,
          file_id uuid not null,
          file_status file_status not null default 'active' check (file_status = 'active'),
          foreign key (file_id, file_status) references files (id, status)
            on delete cascade
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
    // The two shapes every other rule in the checker accepts. `set null` on
    // update passes the composite, nullability and check rules — an all-null
    // pair satisfies MATCH FULL and the check alike — and would let
    // `startDeleting` unlink a live referrer; `cascade` on delete removes the
    // referrer after `finishDeleting` has already destroyed the object.
    expect(
      violations.filter((v) => v.startsWith('_usage_probe_setnull'))
    ).toEqual([
      expect.stringContaining('_usage_probe_setnull.file_id: ON UPDATE'),
      '_usage_probe_setnull.file_id: not in USAGE_SOURCES',
    ]);
    expect(
      violations.filter((v) => v.startsWith('_usage_probe_cascade'))
    ).toEqual([
      expect.stringContaining('_usage_probe_cascade.file_id: ON DELETE'),
      '_usage_probe_cascade.file_id: not in USAGE_SOURCES',
    ]);
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
