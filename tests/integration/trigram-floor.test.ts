/**
 * `isTrigramIndexable` against the database that will actually run the query.
 *
 * The predicate approximates pg_trgm's `ISWORDCHR`, which is
 * `t_isalpha || t_isdigit` under the SERVER's ctype — so the class in
 * `lib/data-table/parsers.ts` is a statement about the deployment's C library,
 * not about Unicode. It is not restated here: it is MEASURED, by building a GIN
 * trigram index over a scratch table and reading how many rows the bitmap index
 * scan returns for each term. A pattern with no usable trigram makes GIN return
 * every row, which is the sequential scan the floor exists to prevent.
 *
 * ⚠️ The two directions are not worth the same, and the strict one is the
 * ADMISSION:
 *
 * - **Never admit what the index cannot serve.** A term the predicate lets
 *   through that scans the whole table is the vector the floor was built
 *   against, repeatable by any authorized user. Asserted for every case below.
 * - **Should not refuse what it can.** Costs that one search. Asserted for the
 *   terms a user of this application plausibly types; tolerated for the exotic
 *   families, where erring toward refusal is the cheaper mistake and is the
 *   choice the class makes deliberately.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SearchAnchor } from '@/lib/data-table/parsers';

import { sql } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { escapeLike } from '@/lib/data-table/filter-columns';
import { isTrigramIndexable } from '@/lib/data-table/parsers';

import { assertHarnessDatabase } from '../helpers/database';

const TABLE = 'trigram_floor_probe';
const ROWS = 20_000;

/** The pattern the production code builds for each operator shape. */
function patternFor(term: string, anchor: SearchAnchor): string {
  const escaped = escapeLike(term);
  if (anchor === 'prefix') return `${escaped}%`;
  if (anchor === 'suffix') return `%${escaped}`;
  return `%${escaped}%`;
}

/**
 * Whether PostgreSQL can answer this pattern FROM the index.
 *
 * `SET LOCAL enable_seqscan = off` takes the cost question off the table, so the
 * plan is the index either way and what remains is how much of it the pattern's
 * trigrams select: a pattern that yields none scans every entry, which is the
 * useless case, and anything less is a real lookup.
 *
 * Inside `withTransaction` because the setting is per CONNECTION and the pool
 * hands out an arbitrary one per statement — the transaction is what pins the
 * `SET` and the `EXPLAIN` to the same backend.
 */
async function indexUsable(pattern: string): Promise<boolean> {
  return withTransaction(async (tx) => {
    await tx.execute(sql`set local enable_seqscan = off`);
    const rows = await tx.execute<Record<string, string>>(
      sql`explain (analyze, costs off, timing off, summary off) select count(*) from ${sql.identifier(TABLE)} where v ilike ${pattern}`
    );
    const plan = rows.map((row) => String(Object.values(row)[0])).join('\n');
    const scanned = /Bitmap Index Scan.*?\(actual rows=([\d.]+)/s.exec(plan);
    if (!scanned)
      throw new Error(`no bitmap index scan in plan for ${pattern}:\n${plan}`);
    return Number(scanned[1]) < ROWS;
  });
}

/**
 * Terms a user of this application plausibly types: ASCII, Arabic and CJK
 * letters, Arabic-Indic digits, and the separator shapes around them. Both
 * directions are asserted — refusing one of these is a real loss.
 */
const EVERYDAY: ReadonlyArray<[string, SearchAnchor]> = [
  ['abc', 'contains'],
  ['zz1qq', 'contains'],
  ['a12', 'contains'],
  ['a-b', 'contains'],
  ['a b', 'contains'],
  ['ab c', 'contains'],
  ['ab-', 'contains'],
  ['-ab', 'contains'],
  ['a!b', 'contains'],
  ['a_b', 'contains'],
  ['a%b', 'contains'],
  ['ab😀', 'contains'],
  ['😀ab', 'contains'],
  ['ab', 'contains'],
  ['a1', 'contains'],
  ['a--', 'contains'],
  ['!!!', 'contains'],
  ['---', 'contains'],
  ['...', 'contains'],
  ['😀😀😀', 'contains'],
  ['فلم', 'contains'],
  ['فل', 'contains'],
  ['١٢٣', 'contains'],
  ['١٢', 'contains'],
  ['東京都', 'contains'],
  ['東京', 'contains'],
  ['a--', 'prefix'],
  ['!!!', 'prefix'],
  ['ab', 'prefix'],
  ['ab', 'suffix'],
  ['a', 'suffix'],
  ['!!!', 'suffix'],
];

/**
 * Characters nobody searches for on their own, and whose `alpha` answer is the C
 * library's business: combining marks, letter-numbers, number-others, a circled
 * letter, a decomposed accent, an astral mathematical letter. The class refuses
 * most of them on purpose, so only the admission direction is asserted — a
 * refusal here costs nothing anyone would notice.
 */
const EXOTIC: ReadonlyArray<[string, SearchAnchor]> = [
  ['ٍٍٍ', 'contains'],
  ['َََ', 'contains'],
  ['ְְְ', 'contains'],
  ['ⓐⓐⓐ', 'contains'],
  ['ⅣⅣⅣ', 'contains'],
  ['〇〇〇', 'contains'],
  ['½½½', 'contains'],
  ['①①①', 'contains'],
  ['é-e', 'contains'],
  ['\u{1D400}\u{1D400}\u{1D400}', 'contains'],
];

const EVERY_CASE = [...EVERYDAY, ...EXOTIC];

describe('the trigram floor matches the database it guards', () => {
  beforeAll(async () => {
    // This file holds the real client and creates a table of its own, so it
    // takes the ownership guard directly rather than through `resetTables`.
    await assertHarnessDatabase();
    await db.execute(sql`create extension if not exists pg_trgm`);
    await db.execute(sql`drop table if exists ${sql.identifier(TABLE)}`);
    await db.execute(
      sql`create table ${sql.identifier(TABLE)} (v text not null)`
    );
    await db.execute(
      sql`insert into ${sql.identifier(TABLE)} select 'zz' || g || 'qq' from generate_series(1, ${ROWS}) g`
    );
    await db.execute(
      sql`create index on ${sql.identifier(TABLE)} using gin (v gin_trgm_ops)`
    );
    await db.execute(sql`analyze ${sql.identifier(TABLE)}`);
  });

  afterAll(async () => {
    await db.execute(sql`drop table if exists ${sql.identifier(TABLE)}`);
  });

  test('the probe can tell the two apart, so no loop below passes vacuously', async () => {
    expect(await indexUsable(patternFor('zz1qq', 'contains'))).toBe(true);
    expect(await indexUsable(patternFor('!!!', 'contains'))).toBe(false);
  });

  test.each(EVERY_CASE)(
    'admits nothing the index cannot serve: %s (%s)',
    async (term, anchor) => {
      const usable = await indexUsable(patternFor(term, anchor));
      // `admitted && !usable` IS the scan: a term this guard lets through that
      // reads the whole table, which is what an authorized user repeats.
      expect([
        term,
        anchor,
        isTrigramIndexable(term, anchor) && !usable,
      ]).toEqual([term, anchor, false]);
    }
  );

  test.each(EVERYDAY)(
    'and refuses nothing it can: %s (%s)',
    async (term, anchor) => {
      expect([term, anchor, isTrigramIndexable(term, anchor)]).toEqual([
        term,
        anchor,
        await indexUsable(patternFor(term, anchor)),
      ]);
    }
  );
});
