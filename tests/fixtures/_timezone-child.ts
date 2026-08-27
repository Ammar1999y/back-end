/** Round-trip one instant through the production column decoder. */
import { getTableColumns } from 'drizzle-orm';

import { users } from '@/db/schema';

const TRUTH = new Date('2026-08-25T01:00:00.000Z');
const column = getTableColumns(users).createdAt;
const decoded: unknown = column.mapFromDriverValue(TRUTH);
const reparsed = decoded instanceof Date ? decoded : new Date(String(decoded));

console.log(
  JSON.stringify({
    tz: process.env.TZ ?? null,
    offsetMinutes: new Date().getTimezoneOffset(),
    columnType: column.constructor.name,
    decodedIsDate: decoded instanceof Date,
    truth: TRUTH.toISOString(),
    decoded: decoded instanceof Date ? decoded.toISOString() : String(decoded),
    reparsed: reparsed.toISOString(),
    sameInstant: reparsed.getTime() === TRUTH.getTime(),
    errorHours: (reparsed.getTime() - TRUTH.getTime()) / 3_600_000,
  })
);
