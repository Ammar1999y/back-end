import { validID } from '@/utils';

import { HTTP_STATUS } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';
import { safeDate } from '@/utils/time';

/**
 * Page size for the cursor-paginated session list. The previous fixed cap of
 * 50 newest sessions with no cursor meant an OLDER compromised session could
 * not be discovered at all — and selective revocation needs its id.
 */
export const SESSIONS_PAGE_SIZE = 50;
const SESSIONS_MAX_PAGE_SIZE = 100;
const CURSOR_MAX_LENGTH = 128;

/**
 * ONE canonical cursor format: `<ISO-8601 UTC with milliseconds>|<uuid>`.
 *
 * Accepting "anything `Date` can read" was the mistake behind every cursor
 * defect. `new Date()` normalises rather than rejects, so each permissive form
 * silently pointed at a different page than the one requested:
 *
 * - no timezone      → read in the SERVER's zone, so the same cursor meant
 *                      different instants on different hosts
 * - `T24:00:00Z`     → rolled forward to 00:00 the next day
 * - six fraction digits → truncated to JavaScript's millisecond precision
 *
 * None of those are emitted by `formatCursor`, so none of them can come from a
 * client that is paginating correctly. Everything else is a 422. The pattern is
 * fully anchored with fixed-width groups; the range checks below cover what a
 * regex cannot express.
 */
const CURSOR_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

/** Days in a 1-based month; `day 0` of the next month is the last of this one. */
const daysInMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * The canonical string every cursor in a response is built from.
 *
 * Single source of truth deliberately: while the emitter interpolated the raw
 * Postgres timestamp and the parser accepted a family of formats, the two could
 * disagree without anything failing loudly. Now a cursor this function did not
 * produce cannot be parsed, and the round trip is asserted in the tests.
 */
export function formatCursor(createdAt: string | Date, id: string): string {
  const date = safeDate(createdAt);
  if (!date) throw new Error('formatCursor received an unparseable timestamp');
  return `${date.toISOString()}|${id}`;
}

/**
 * Components validated directly rather than through `Date`, which would accept
 * an impossible date (`2026-02-30` → 2 March) and an out-of-range hour
 * (`24:00:00` → next day) by normalising them.
 */
function parseCursorTimestamp(raw: string): Date | null {
  const match = CURSOR_TIMESTAMP.exec(raw);
  if (!match) return null;

  const [, y, mo, d, h, mi, sec] = match;
  const year = Number(y);
  const month = Number(mo);

  if (month < 1 || month > 12) return null;

  const day = Number(d);
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (Number(h) > 23 || Number(mi) > 59 || Number(sec) > 59) return null;

  const parsed = safeDate(raw);
  // Belt and braces: a value that satisfied every check above must also survive
  // the round trip, or the two representations have drifted apart.
  return parsed && parsed.toISOString() === raw ? parsed : null;
}

export function parseCursor(
  raw: string | null
): { createdAt: Date; id: string } | null {
  // Absent and malformed are DIFFERENT answers. Returning `null` for both meant
  // a corrupted cursor silently restarted at page one: the client believed it
  // was advancing while re-reading the same rows, which for a revocation list
  // can hide the session it is hunting for.
  if (raw === null) return null;
  if (!raw || raw.length > CURSOR_MAX_LENGTH) invalidCursor();
  const separator = raw.lastIndexOf('|');
  if (separator <= 0) invalidCursor();
  const id = validID(raw.slice(separator + 1));
  const createdAt = parseCursorTimestamp(raw.slice(0, separator));
  if (!id || !createdAt) invalidCursor();
  return { createdAt, id };
}

function invalidCursor(): never {
  throw new CustomError(
    'مؤشر الصفحة غير صالح، اعد تحميل القائمة',
    HTTP_STATUS.UNPROCESSABLE
  );
}

/**
 * Canonical decimal integers only.
 *
 * `Number()` accepts a whole family of spellings a query string has no business
 * carrying — `1e2`, `0x10`, `+1`, `' 5 '` and `'05'` all became numbers, so the
 * endpoint honoured page sizes the caller could not have meant to write, and the
 * over-cap rejection could be bypassed by spelling the number differently. The
 * pattern is checked before any numeric conversion.
 */
const CANONICAL_INTEGER = /^(?:0|[1-9]\d*)$/;

export function parseLimit(raw: string | null): number {
  if (raw === null) return SESSIONS_PAGE_SIZE;

  // Over the maximum is rejected, not clamped: the message promises a value
  // between 1 and the cap, and silently serving 100 rows for `limit=1000` makes
  // that message a lie the client cannot detect.
  if (!CANONICAL_INTEGER.test(raw)) invalidLimit();
  const requested = Number(raw);
  if (requested < 1 || requested > SESSIONS_MAX_PAGE_SIZE) invalidLimit();
  return requested;
}

function invalidLimit(): never {
  throw new CustomError(
    `حجم الصفحة يجب أن يكون رقماً بين 1 و ${SESSIONS_MAX_PAGE_SIZE}`,
    HTTP_STATUS.UNPROCESSABLE
  );
}
