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

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  // eslint-disable-next-line unicorn/no-top-level-assignment-in-function -- module-scope tally: the check() helper is its only writer and the exit code at the end of the file is its only reader
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`
  );
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

// Bookmarked epoch-millisecond filter values still resolve to a calendar day.
check(
  'toCalendarDate(epoch ms) in zone',
  toCalendarDate(Date.UTC(2026, 10, 1, 4, 30), 'America/New_York') ===
    '2026-11-01'
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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
// eslint-disable-next-line unicorn/no-process-exit -- CLI probe: the exit code is how it reports pass/fail, the case the rule excepts
process.exit(failures === 0 ? 0 : 1);
