import { BUSINESS_TIMEZONE } from './config';

export function safeDate(
  input: string | Date | number | null | undefined
): Date | null {
  try {
    if (!input) return null;
    const d = new Date(input);
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
    return d;
  } catch {
    return null;
  }
}

// ---- Calendar dates in the business timezone -------------------------
// Date filters are expressed as calendar days ("2026-08-02"), not instants.
// Turning a calendar day into a UTC range has to happen in one declared zone
// (BUSINESS_TIMEZONE); doing it with `setHours` uses the *host* zone, so the
// same filter selected a different day depending on where the code ran.

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function getZoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = zoneFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    zoneFormatters.set(timeZone, formatter);
  }
  return formatter;
}

interface ZoneParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

// `NaN` rather than 0 for an absent field: it propagates as the invalid date
// every caller already rejects, instead of a plausible year 0 / January / day 0.
function zoneParts(instant: Date, timeZone: string): ZoneParts {
  const parts = getZoneFormatter(timeZone).formatToParts(instant);
  const found = new Map<string, number>();
  for (const part of parts)
    if (part.type !== 'literal') found.set(part.type, Number(part.value));
  const read = (type: string) => found.get(type) ?? NaN;
  const hour = read('hour');
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // Some ICU versions render midnight as hour "24".
    hour: hour === 24 ? 0 : hour,
    minute: read('minute'),
    second: read('second'),
  };
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = zoneParts(instant, timeZone);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second
  );
  const whole = Math.floor(instant.getTime() / 1000) * 1000;
  return asUtc - whole;
}

/** The `YYYY-MM-DD` calendar day an instant falls on in `timeZone`. */
export function calendarDayInZone(
  instant: Date,
  timeZone: string = BUSINESS_TIMEZONE
): string {
  const p = zoneParts(instant, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * First instant of a calendar day in `timeZone`, as a UTC `Date`.
 * The second pass covers days whose UTC-guessed instant lands on the other
 * side of a DST transition from the day's real start.
 */
/**
 * Turn a UTC-naive wall-clock reading into the real instant it occurs at in
 * `timeZone`. The second pass covers a guess that lands on the other side of a
 * DST transition from the reading itself.
 */
function resolveZonedWallClock(utcNaive: number, timeZone: string): Date {
  const firstOffset = zoneOffsetMs(new Date(utcNaive), timeZone);
  let candidate = utcNaive - firstOffset;
  const secondOffset = zoneOffsetMs(new Date(candidate), timeZone);
  if (secondOffset !== firstOffset) candidate = utcNaive - secondOffset;
  return new Date(candidate);
}

/**
 * Some zones skip midnight entirely — `America/Santiago` jumps 00:00 to 01:00
 * on its spring-forward date — so a day's first existing instant can be later
 * than 00:00 and resolving midnight yields a reading that isn't in the day at
 * all. Probing forward an hour at a time finds the real start; transitions are
 * never larger than this.
 */
const MIDNIGHT_JUMP_PROBE_HOURS = 3;

interface CalendarDateParts {
  year: number;
  month: number;
  day: number;
}

/** Split a `YYYY-MM-DD` string into numeric components, or null if malformed. */
function splitCalendarDate(calendarDate: string): CalendarDateParts | null {
  if (!CALENDAR_DATE_PATTERN.test(calendarDate)) return null;
  const [year, month, day] = calendarDate.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined)
    return null;
  return { year, month, day };
}

/** First instant belonging to `calendarDate` in `timeZone`, or null. */
function firstInstantOfDay(
  year: number,
  month: number,
  day: number,
  calendarDate: string,
  timeZone: string
): Date | null {
  for (let hour = 0; hour <= MIDNIGHT_JUMP_PROBE_HOURS; hour++) {
    const candidate = resolveZonedWallClock(
      Date.UTC(year, month - 1, day, hour),
      timeZone
    );
    // The round trip is what makes the date real: `Date.UTC` silently rolls
    // out-of-range components over ("2026-13-99" becomes April 2027).
    if (calendarDayInZone(candidate, timeZone) === calendarDate)
      return candidate;
  }
  return null;
}

export function zonedDayStart(
  calendarDate: string,
  timeZone: string = BUSINESS_TIMEZONE
): Date | null {
  const parts = splitCalendarDate(calendarDate);
  if (!parts) return null;
  const { year, month, day } = parts;
  if (Number.isNaN(Date.UTC(year, month - 1, day))) return null;

  return firstInstantOfDay(year, month, day, calendarDate, timeZone);
}

/**
 * Exclusive upper bound of a calendar day — the start of the following day.
 * Half-open ranges (`>= start`, `< next`) avoid end-of-day precision games
 * (23:59:59.999 vs a column stored at centisecond precision).
 */
export function zonedNextDayStart(
  calendarDate: string,
  timeZone: string = BUSINESS_TIMEZONE
): Date | null {
  // Validates the input day, including the real-date round trip.
  if (!zonedDayStart(calendarDate, timeZone)) return null;

  const parts = splitCalendarDate(calendarDate);
  if (!parts) return null;
  const { year, month, day } = parts;
  // The next day's identity is derived from `Date`, not from re-parsing a
  // YYYY-MM-DD string through `CALENDAR_DATE_PATTERN`: the day after
  // 9999-12-31 is year 10000, whose five digits the four-digit pattern
  // rejects, which made the last representable day fail with a 422.
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return firstInstantOfDay(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    calendarDayInZone(next, 'UTC'),
    timeZone
  );
}

/**
 * Normalize a client-supplied date filter value to a calendar day.
 *
 * `YYYY-MM-DD` is the whole contract, so this takes no timezone: the zone only
 * matters once a calendar day is turned into instants, which is
 * `zonedDayStart`/`zonedNextDayStart`.
 *
 * There USED to be an epoch-milliseconds branch here "so previously bookmarked
 * URLs keep working". It could not: the only non-test caller is `dayBounds`, and
 * `parsers.ts` stringifies every filter value (`safeString`) before it gets
 * there, so the branch required `typeof raw === 'number'` and never saw one.
 * Measured end to end, a `createdAt` filter carrying either a numeric or a
 * string epoch value answered 422. Deleted rather than wired through: the
 * contract clients can actually express is unchanged, and this repository has no
 * bookmarked URL to keep working.
 */
export function toCalendarDate(raw: unknown): string | null {
  if (typeof raw === 'string' && CALENDAR_DATE_PATTERN.test(raw)) return raw;
  return null;
}
