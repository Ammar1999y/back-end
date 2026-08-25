/**
 * `timestamptz` columns decode with the PROCESS timezone, and the suite cannot
 * see it.
 *
 * Two separate things are asserted here, and the second is the reason the first
 * needs a spawned child at all.
 *
 * **The defect.** Every one of the schema's `timestamptz` columns is
 * `mode: 'string'` with `withTimezone: true`. `bun:sql` hands drizzle a `Date`;
 * drizzle's decoder for that column shape takes the UTC wall-clock and appends
 * the process-LOCAL offset, so the string it returns names a different instant
 * from the one stored. Measured on this host (offset −180):
 *
 *     stored   2026-08-25T01:00:00.000Z
 *     returned "2026-08-25 01:00:00.000+03"   → parses back as 22:00:00Z
 *
 * Three hours early, silently, on every read of every timestamp. What that
 * disables is not cosmetic: `lib/auth/login-guard.ts` compares
 * `new Date(user.lockedUntil)` against now, so an account lock stamped 5 minutes
 * out reads as 3 hours in the PAST and the lockout never applies. The same shape
 * reaches the OTP block, the resend cooldown and the session-list cursor.
 *
 * **Why no ordinary test can see it.** `bun test` pins the runner to UTC —
 * measured: offset 0 inside `bun test` on a host whose plain `bun` children
 * report −180, and a `TZ=` prefix does not change it. At offset 0 the decoder
 * round-trips exactly, so every assertion in every other file is evaluated in the
 * one timezone where the bug does not exist. CI is UTC too. That is what makes
 * this a PROCESS-tier test: only a child with an explicit `TZ` in its environment
 * runs the production code the way production runs it.
 *
 * The non-UTC case is `test.failing` because the defect is live. It stays green
 * while the defect stands and turns RED the moment the columns are moved to
 * `mode: 'date'` (or the decoder is fixed) and this marker goes stale — which is
 * exactly when someone should be deleting the marker rather than discovering the
 * test was never re-enabled. `test.skip` would go quiet; a plain `test` would make
 * CI red forever and get deleted.
 */
import { describe, expect, test } from 'bun:test';
import path from 'node:path';

import { getTableColumns, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';

import * as schema from '@/db/schema';

const CHILD = path.join(
  import.meta.dir,
  '..',
  'fixtures',
  '_timezone-child.ts'
);

/** Non-UTC on purpose, and +03 is what `BUSINESS_TIMEZONE` defaults to. */
const NON_UTC_ZONE = 'Asia/Riyadh';

interface Report {
  tz: string | null;
  offsetMinutes: number;
  columnType: string;
  truth: string;
  decoded: string;
  reparsed: string;
  sameInstant: boolean;
  errorHours: number;
}

async function roundTripUnder(timeZone: string): Promise<Report> {
  const child = Bun.spawn(['bun', '--no-env-file', CHILD], {
    cwd: path.join(import.meta.dir, '..', '..'),
    env: { ...process.env, TZ: timeZone },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (code !== 0)
    throw new Error(`timezone child exited ${code}: ${err.slice(0, 400)}`);

  return JSON.parse(out.trim()) as Report;
}

describe('the blast radius', () => {
  test('every timestamptz column in the schema is mode:"string"', () => {
    // Enumerated rather than asserted about one column: the defect is a property
    // of the column TYPE, so the thing worth pinning is how many columns carry
    // it. If a migration moves some to `mode: 'date'` and not others, this is
    // what says so.
    const stringMode: string[] = [];
    const dateMode: string[] = [];

    // `is(value, PgTable)` is the discriminator, the same one
    // `tests/helpers/database.ts` uses. A `try/catch` around `getTableColumns`
    // does NOT work and was the first version of this: it returns `undefined`
    // for a non-table rather than throwing, so the guard caught nothing and
    // `Object.entries(undefined)` threw one line later.
    for (const value of Object.values(schema)) {
      if (!is(value, PgTable)) continue;
      const columns = getTableColumns(value as PgTable) as unknown as Record<
        string,
        { constructor: { name: string } }
      >;
      for (const [name, column] of Object.entries(columns)) {
        const kind = column.constructor.name;
        if (kind === 'PgTimestampString') stringMode.push(name);
        else if (kind === 'PgTimestamp') dateMode.push(name);
      }
    }

    // The count is not the assertion — the absence of a mixed state is. A schema
    // where both kinds coexist is the one where a reader cannot tell which
    // columns are affected.
    // 25 today. Asserted as a floor rather than an equality so adding a table
    // does not fail this, while removing the whole class would.
    expect(stringMode.length).toBeGreaterThanOrEqual(25);
    expect(
      dateMode,
      'these columns decode correctly while their siblings do not'
    ).toEqual([]);
  });
});

describe('the round trip through the production decoder', () => {
  test('is exact under UTC — which is the only zone the suite ever runs in', async () => {
    // The control. It proves the child and the decoder work, so a failure of
    // the non-UTC case below is about the timezone and not about the fixture.
    const report = await roundTripUnder('UTC');

    expect(report.columnType).toBe('PgTimestampString');
    expect(report.offsetMinutes).toBe(0);
    expect(report.sameInstant).toBe(true);
    expect(report.errorHours).toBe(0);
  }, 30_000);

  test.failing(
    'is exact under a non-UTC zone — LIVE DEFECT, see the header',
    async () => {
      const report = await roundTripUnder(NON_UTC_ZONE);

      // Currently: decoded is "2026-08-25 01:00:00.000+03", three hours early.
      expect(report.sameInstant).toBe(true);
      expect(report.errorHours).toBe(0);
    },
    30_000
  );

  test('the error is exactly the process offset, which is what makes it silent', async () => {
    // The shape of the defect, asserted positively so it is characterised
    // rather than merely known to be broken. This test passes TODAY and will
    // fail when the defect is fixed — at which point it should be deleted
    // together with the `test.failing` marker above. Written as one unit
    // deliberately: two markers that must be removed together are less likely
    // to be half-removed.
    const report = await roundTripUnder(NON_UTC_ZONE);

    expect(report.offsetMinutes).not.toBe(0);
    expect(report.sameInstant).toBe(false);
    // `getTimezoneOffset` is minutes WEST of UTC, so a +03 zone reports −180
    // and the decoded instant lands `offset` minutes early.
    expect(report.errorHours).toBe(report.offsetMinutes / 60);
  }, 30_000);
});

describe('why no other tier can see this', () => {
  test('the test runner itself is pinned to UTC', () => {
    // The finding that matters most for the suite, rather than for the product:
    // every assertion in every other file is evaluated in the one timezone where
    // the decoder is correct. Measured — a `TZ=` prefix on `bun test` does not
    // move it, and the host this runs on is not UTC.
    expect(new Date().getTimezoneOffset()).toBe(0);
  });
});
