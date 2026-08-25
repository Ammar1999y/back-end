/**
 * Round-trips one instant through the REAL production column decoder, under
 * whatever timezone the parent gave this process.
 *
 * A child, because the property cannot be observed in-process: `bun test` pins
 * the runner to UTC no matter what the host is set to and no matter what `TZ`
 * says (measured — offset 0 inside `bun test`, the host's real offset in a plain
 * `bun` child). At offset 0 the decoder is correct, so the entire class is
 * invisible from a test file by construction rather than by oversight.
 *
 * No database: `mapFromDriverValue` is the exact function drizzle calls on the
 * `Date` that `bun:sql` hands back for a `timestamptz`, so calling it directly is
 * the same code path a `db.select()` takes, without a server round trip. The
 * driver's half — that `bun:sql` really does return a `Date` — is asserted
 * separately in `tests/integration/driver-contract.test.ts`.
 *
 * One line of JSON on stdout.
 */
import { getTableColumns } from 'drizzle-orm';

import { users } from '@/db/schema';

/** A fixed instant, so the output is a function of the timezone and nothing else. */
const TRUTH = new Date('2026-08-25T01:00:00.000Z');

const column = getTableColumns(users).createdAt as unknown as {
  constructor: { name: string };
  mapFromDriverValue: (value: Date) => unknown;
};

const decoded = column.mapFromDriverValue(TRUTH);
const reparsed = new Date(String(decoded));

console.log(
  JSON.stringify({
    tz: process.env.TZ ?? null,
    offsetMinutes: new Date().getTimezoneOffset(),
    columnType: column.constructor.name,
    truth: TRUTH.toISOString(),
    decoded: String(decoded),
    reparsed: reparsed.toISOString(),
    sameInstant: reparsed.getTime() === TRUTH.getTime(),
    errorHours: (reparsed.getTime() - TRUTH.getTime()) / 3_600_000,
  })
);
