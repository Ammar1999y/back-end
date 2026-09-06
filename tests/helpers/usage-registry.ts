/**
 * The usage registry as a fixture.
 *
 * `USAGE_SOURCES` ships empty and every guard built on it FAILS CLOSED while it
 * is (`lib/media/usages.ts`): the media API governs library files only, and the
 * unfiled scope and its reaper match nothing. So a suite that exercises the
 * entity boundary, adoption or the reaper has to declare an owner table the way
 * a project would — in code, and backed by a table that really exists, because
 * the guards query it.
 *
 * The registry is a module-level array, so a source is pushed for the duration
 * of one block and removed again; leaving one behind would change what every
 * later test in the process means.
 */
import type { Tx } from '@/db';
import type { UsageSource } from '@/lib/media/usages';

import { sql } from 'drizzle-orm';

import { db } from '@/db';
import { USAGE_SOURCES } from '@/lib/media/usages';

/** The referrer shape every owner table in a project must use. */
const REFERRER_TABLE = '_media_test_refs';

export const PUBLIC_SOURCE: UsageSource = {
  table: REFERRER_TABLE,
  column: 'file_id',
  idColumn: 'id',
  resource: 'users',
  visibility: 'public',
  label: 'سجل اختبار',
};

/** The same table read as PRIVATE content: what a record holds is not published by it. */
export const PRIVATE_SOURCE: UsageSource = {
  ...PUBLIC_SOURCE,
  visibility: 'private',
};

export async function createReferrerTable(): Promise<void> {
  await dropReferrerTable();
  await db.execute(
    sql.raw(`
      create table ${REFERRER_TABLE} (
        id serial primary key,
        file_id uuid not null,
        file_status file_status not null default 'active' check (file_status = 'active'),
        foreign key (file_id, file_status) references files (id, status)
          on update no action on delete no action
      )
    `)
  );
}

export async function dropReferrerTable(): Promise<void> {
  await db.execute(sql.raw(`drop table if exists ${REFERRER_TABLE}`));
}

/** Registers `source` for the duration of `run`, and only that. */
export async function withSource<T>(
  source: UsageSource,
  run: () => Promise<T>
): Promise<T> {
  const registry = USAGE_SOURCES as UsageSource[];
  registry.push(source);
  try {
    return await run();
  } finally {
    const index = registry.indexOf(source);
    if (index !== -1) registry.splice(index, 1);
  }
}

/** In the caller's transaction when there is one: a referrer is written next to the row that owns it. */
export async function refer(
  fileId: string,
  executor: typeof db | Tx = db
): Promise<void> {
  await executor.execute(
    sql`insert into ${sql.identifier(REFERRER_TABLE)} (file_id) values (${fileId}::uuid)`
  );
}

export async function unrefer(fileId: string): Promise<void> {
  await db.execute(
    sql`delete from ${sql.identifier(REFERRER_TABLE)} where file_id = ${fileId}::uuid`
  );
}

export async function referrerCount(fileId: string): Promise<number> {
  const rows = await db.execute(
    sql`select 1 from ${sql.identifier(REFERRER_TABLE)} where file_id = ${fileId}::uuid`
  );
  return rows.length;
}
