/** The production timestamptz string codec must preserve instants in every TZ. */
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
  test('every timestamptz column uses the timezone-stable custom codec', () => {
    const timestampKinds: string[] = [];

    for (const value of Object.values(schema)) {
      if (!is(value, PgTable)) continue;
      const columns = Object.values(getTableColumns(value));
      for (const column of columns) {
        if (column.getSQLType() === 'timestamp(2) with time zone')
          timestampKinds.push(column.constructor.name);
      }
    }

    expect(timestampKinds.length).toBeGreaterThanOrEqual(25);
    expect(new Set(timestampKinds)).toEqual(new Set(['PgCustomColumn']));
  });
});

describe('the production decoder round trip', () => {
  test.each(['UTC', NON_UTC_ZONE])(
    'is exact under %s',
    async (timeZone) => {
      const report = await roundTripUnder(timeZone);

      expect(report.tz).toBe(timeZone);
      expect(report.columnType).toBe('PgCustomColumn');
      if (timeZone === NON_UTC_ZONE) expect(report.offsetMinutes).not.toBe(0);
      expect(report.decoded).toEndWith('+00');
      expect(report.sameInstant).toBe(true);
      expect(report.errorHours).toBe(0);
      expect(report.reparsed).toBe(report.truth);
    },
    30_000
  );
});
