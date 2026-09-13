import { describe, expect, test } from 'bun:test';

import { PgDialect } from 'drizzle-orm/pg-core';

import { users } from '@/db/schema';
import { filterColumns } from '@/lib/data-table/filter-columns';

import { BUSINESS_TIMEZONE } from '@/utils/config';
/**
 * DST / calendar-boundary probe for utils/time.ts (C-14).
 *
 * Asserts the half-open [start, nextDayStart) contract holds in zones the
 * shipped default (Asia/Riyadh, no DST) can never exercise:
 *  - 23-hour and 25-hour days (America/New_York)
 *  - a day whose midnight does not exist (America/Santiago spring forward)
 *  - 30-minute DST shift (Australia/Lord_Howe)
 *  - 45-minute standard offset (Asia/Kathmandu)
 */
import {
  calendarDayInZone,
  toCalendarDate,
  zonedDayStart,
  zonedNextDayStart,
} from '@/utils/time';

/**
 * One `bun test` case per assertion, keeping every original `check(...)` call
 * site unchanged.
 *
 * This file used to be a standalone CLI probe that kept its own tally and exited
 * with a status. It therefore did not match Bun's test glob and had NEVER run in
 * CI — three of the twelve files in this directory were in that state, so
 * `bun run test`'s "60 pass" covered six files, not nine. Renaming alone would
 * have been worse than leaving it out: an explicit exit inside a test file ends
 * the whole run, silently skipping every file after it.
 *
 * `ok` is evaluated by the caller before the case runs, which is exactly what the
 * CLI version did; `detail` goes into the test name so a failure reads the same
 * as the old `FAIL  <label>  <detail>` line.
 */
function check(label: string, ok: boolean, detail = ''): void {
  test(detail ? `${label} — ${detail}` : label, () => {
    expect(ok).toBe(true);
  });
}

interface Case {
  zone: string;
  day: string;
  expectHours: number;
  note: string;
}

const CASES: Case[] = [
  { zone: 'Asia/Riyadh', day: '2026-08-02', expectHours: 24, note: 'no DST' },
  {
    zone: 'America/New_York',
    day: '2026-03-08',
    expectHours: 23,
    note: 'spring forward',
  },
  {
    zone: 'America/New_York',
    day: '2026-11-01',
    expectHours: 25,
    note: 'fall back',
  },
  {
    zone: 'America/Santiago',
    day: '2026-09-06',
    expectHours: 23,
    note: 'midnight does not exist',
  },
  {
    zone: 'Australia/Lord_Howe',
    day: '2026-10-04',
    expectHours: 23.5,
    note: '30-minute DST',
  },
  {
    zone: 'Asia/Kathmandu',
    day: '2026-02-15',
    expectHours: 24,
    note: '+05:45 offset',
  },
  { zone: 'UTC', day: '2028-02-29', expectHours: 24, note: 'leap day' },
  {
    zone: 'Pacific/Chatham',
    day: '2026-04-05',
    expectHours: 25,
    note: '+12:45 / fall back',
  },
];

for (const c of CASES) {
  const start = zonedDayStart(c.day, c.zone);
  const next = zonedNextDayStart(c.day, c.zone);
  const label = `${c.zone} ${c.day} (${c.note})`;

  if (!start || !next) {
    check(label, false, 'null bound');
    continue;
  }

  const hours = (next.getTime() - start.getTime()) / 3_600_000;

  check(`${label} length=${hours}h`, hours === c.expectHours);

  // The start instant must belong to the day, and the instant one ms before it
  // must belong to the previous day: that is what "first instant" means.
  check(
    `${label} start in day`,
    calendarDayInZone(start, c.zone) === c.day,
    `got ${calendarDayInZone(start, c.zone)}`
  );
  check(
    `${label} start-1ms in previous day`,
    calendarDayInZone(new Date(start.getTime() - 1), c.zone) !== c.day
  );
  // The upper bound is exclusive: it must NOT belong to the day, but one ms
  // earlier must.
  check(`${label} next excluded`, calendarDayInZone(next, c.zone) !== c.day);
  check(
    `${label} next-1ms in day`,
    calendarDayInZone(new Date(next.getTime() - 1), c.zone) === c.day
  );
}

// Contiguity: yesterday's exclusive upper bound is today's inclusive lower
// bound, so no instant falls into two days or none.
for (const zone of [
  'America/New_York',
  'America/Santiago',
  'Australia/Lord_Howe',
  'Pacific/Chatham',
]) {
  // Walks 400 consecutive days and reports the first discontinuity. Extracted
  // into a function so the early exits are `return`s in a single loop rather
  // than `break`s inside the zone loop — the shape `no-break-in-nested-loop`
  // asks for, and it also lets the failing day be reported directly.
  const firstDiscontinuity = (): string | null => {
    const cursor = new Date(Date.UTC(2026, 0, 1));
    for (let i = 0; i < 400; i++) {
      const day = calendarDayInZone(cursor, zone);
      const next = zonedNextDayStart(day, zone);
      if (!next) return day;
      const nextDayStart = zonedDayStart(calendarDayInZone(next, zone), zone);
      if (!nextDayStart || nextDayStart.getTime() !== next.getTime())
        return day;
      cursor.setTime(next.getTime() + 3_600_000);
    }
    return null;
  };

  const discontinuity = firstDiscontinuity();
  check(
    `${zone} 400-day contiguity`,
    discontinuity === null,
    discontinuity === null ? '' : `first break at ${discontinuity}`
  );
}

// `YYYY-MM-DD` is the whole contract. The epoch-milliseconds branch this used to
// assert was unreachable through the API (`parsers.ts` stringifies every filter
// value before `dayBounds` sees it) and is gone.
check(
  'toCalendarDate rejects epoch milliseconds',
  toCalendarDate(Date.UTC(2026, 10, 1, 4, 30)) === null
);
check('toCalendarDate rejects 0', toCalendarDate(0) === null);
check('toCalendarDate rejects garbage', toCalendarDate('not-a-date') === null);
check(
  'toCalendarDate passes through YYYY-MM-DD',
  toCalendarDate('2026-08-02') === '2026-08-02'
);

// Out-of-range components must not roll over into a different real date.
check('rejects 2026-02-30', zonedDayStart('2026-02-30', 'UTC') === null);
check('rejects 2026-13-01', zonedDayStart('2026-13-01', 'UTC') === null);
check('accepts 9999-12-31', zonedNextDayStart('9999-12-31', 'UTC') !== null);

/**
 * Every date OPERATOR, through the default-timezone path production uses.
 *
 * The cases above all pass an explicit zone, so nothing in this file exercised
 * `BUSINESS_TIMEZONE` — `dayBounds` in `lib/data-table/filter-columns.ts` calls
 * `zonedDayStart(day)` / `zonedNextDayStart(day)` with no zone argument, and a
 * hard-coded `'UTC'` in either default would have shifted every date filter on
 * every dashboard list by the business offset with the whole suite still green.
 *
 * The bounds are checked by round trip through `Intl` rather than against a
 * recomputed instant: this file must not reimplement `utils/time.ts` to check
 * it. `formatInBusinessZone` is the independent half — the same
 * `Intl.DateTimeFormat` the application's helpers build on, but reached
 * directly, so a default that stops resolving the business zone fails here
 * whatever the configured zone happens to be.
 */
const businessDayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const formatInBusinessZone = (instant: Date): string =>
  businessDayFormatter.format(instant);

const dialect = new PgDialect();

/** The bound instants one date filter puts on the wire, in order. */
function dateFilterBounds(operator: string, value: string | string[]): Date[] {
  const condition = filterColumns({
    table: users,
    filters: [
      {
        filterId: 'f1',
        id: 'createdAt',
        value,
        operator,
        variant: 'date',
      },
    ] as never,
    joinOperator: 'and',
    specs: { createdAt: { type: 'date' } },
  });
  if (!condition) throw new Error('filterColumns produced no condition');
  return dialect
    .sqlToQuery(condition)
    .params.map((param) => new Date(param as string));
}

const DAY = '2026-08-02';
const NEXT_DAY = '2026-08-03';
const MS = 1;

describe('date filters resolve through the BUSINESS_TIMEZONE default', () => {
  test('the day start is the first instant of that calendar day', () => {
    const [start] = dateFilterBounds('gte', DAY);
    if (!start) throw new Error('no bound emitted');
    expect(formatInBusinessZone(start)).toBe(DAY);
    // The discriminating half: under a UTC default this instant is three hours
    // into the business day, so the millisecond before it is still inside it.
    expect(formatInBusinessZone(new Date(start.getTime() - MS))).not.toBe(DAY);
  });

  test('the exclusive upper bound is the first instant of the NEXT day', () => {
    const [next] = dateFilterBounds('gt', DAY);
    if (!next) throw new Error('no bound emitted');
    expect(formatInBusinessZone(next)).toBe(NEXT_DAY);
    expect(formatInBusinessZone(new Date(next.getTime() - MS))).toBe(DAY);
  });

  test('the default path agrees with passing the business zone explicitly', () => {
    const [start] = dateFilterBounds('gte', DAY);
    expect(start?.getTime()).toBe(
      zonedDayStart(DAY, BUSINESS_TIMEZONE)?.getTime()
    );
  });

  /**
   * The labels are calendar-relative, which is the part a reader has to be able
   * to check: "before X" excludes the whole of X's day, "on or before X"
   * includes all of it, "after X" starts at the next day.
   */
  test.each([
    ['eq', DAY, ['start', 'next']],
    ['ne', DAY, ['start', 'next']],
    ['lt', DAY, ['start']],
    ['lte', DAY, ['next']],
    ['gt', DAY, ['next']],
    ['gte', DAY, ['start']],
  ] as const)('%s binds %p', (operator, value, expected) => {
    const start = zonedDayStart(DAY, BUSINESS_TIMEZONE);
    const next = zonedNextDayStart(DAY, BUSINESS_TIMEZONE);
    if (!start || !next) throw new Error('the business zone resolved no day');
    expect(dateFilterBounds(operator, value).map((d) => d.getTime())).toEqual(
      expected.map((which) =>
        which === 'start' ? start.getTime() : next.getTime()
      )
    );
  });

  test('isBetween spans the first day start to the last day end', () => {
    const start = zonedDayStart(DAY, BUSINESS_TIMEZONE);
    const next = zonedNextDayStart('2026-08-04', BUSINESS_TIMEZONE);
    if (!start || !next) throw new Error('the business zone resolved no day');
    expect(
      dateFilterBounds('isBetween', [DAY, '2026-08-04']).map((d) => d.getTime())
    ).toEqual([start.getTime(), next.getTime()]);
  });

  test('the valueless operators bind no instant at all', () => {
    expect(dateFilterBounds('isEmpty', '')).toEqual([]);
    expect(dateFilterBounds('isNotEmpty', '')).toEqual([]);
  });
});
