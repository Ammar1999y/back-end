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
const NON_UTC_ZONE = 'Asia/Riyadh';

interface Report {
  tz: string | null;
  offsetMinutes: number;
  columnType: string;
  decodedIsDate: boolean;
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

describe('the schema-wide timestamp boundary', () => {
  test('every timestamptz column decodes in date mode', () => {
    // Schema-wide, not a sample: the defect was in the SHARED `timestamps`
    // helper and in twelve individual declarations, so one column added with
    // `mode: 'string'` reopens it for whatever that column governs.
    const timestampKinds: string[] = [];

    for (const value of Object.values(schema)) {
      if (!is(value, PgTable)) continue;
      const columns = Object.values(getTableColumns(value));
      for (const column of columns) {
        // Matched on substance, not on the exact rendering: drizzle's two
        // timestamp builders emit the precision differently — `timestamp (2)`
        // for date mode against `timestamp(2)` for string mode — so an equality
        // test on one spelling silently matches nothing once the mode changes,
        // which is the failure this whole file exists to catch.
        if (/^timestamp\s*\(\d+\) with time zone$/.test(column.getSQLType()))
          timestampKinds.push(column.constructor.name);
      }
    }

    expect(timestampKinds.length).toBeGreaterThanOrEqual(25);
    // `PgTimestampString` is the one that must never appear.
    expect(new Set(timestampKinds)).toEqual(new Set(['PgTimestamp']));
  });
});

describe('the production decoder round trip', () => {
  test.each(['UTC', NON_UTC_ZONE])(
    'is exact under %s',
    async (timeZone) => {
      const report = await roundTripUnder(timeZone);

      expect(report.tz).toBe(timeZone);
      expect(report.columnType).toBe('PgTimestamp');
      if (timeZone === NON_UTC_ZONE) expect(report.offsetMinutes).not.toBe(0);
      // The driver's own `Date`, not a re-rendered string: there is no
      // formatting step left in which an offset could be applied.
      expect(report.decodedIsDate).toBe(true);
      expect(report.sameInstant).toBe(true);
      expect(report.errorHours).toBe(0);
      expect(report.reparsed).toBe(report.truth);
    },
    30_000
  );
});
