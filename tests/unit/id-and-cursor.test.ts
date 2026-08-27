/**
 * The id primitives every session-scoped route is built on: `validID`, which
 * gates every id that reaches SQL, and the keyset cursor pair that pages the
 * session list.
 *
 * Neither had a single assertion anywhere under `tests/` before this file, and
 * both carry a claim made elsewhere that nothing checked:
 *
 * - `reports/should-ignore.md` #50 and #51 both accept a real risk on the
 *   grounds that "`validID` always matches session ID format". That premise is
 *   asserted here instead of assumed.
 * - `pagination.ts` line 46 says "the round trip is asserted in the tests". It
 *   was not asserted anywhere. This file is what makes that sentence true.
 *
 * Inputs may vary in case, but every accepted id leaves this boundary in one
 * canonical lowercase spelling before JavaScript identity guards see it.
 */
import { describe, expect, test } from 'bun:test';

import {
  formatCursor,
  parseCursor,
  parseLimit,
  SESSIONS_PAGE_SIZE,
} from '@/app/api/dash/users/[id]/sessions/pagination';
import { validID } from '@/utils';
import { generateUuidV7 } from '@/lib/id';

import { HTTP_STATUS } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';

/**
 * Fixtures come from the generator the application actually uses and from the
 * platform, never hand-typed: a hand-written "v7" that is subtly malformed makes
 * every rejection assertion pass for the wrong reason.
 */
const ID = generateUuidV7();
/** WebCrypto's `randomUUID` is v4 by specification; asserted below, not assumed. */
const V4 = crypto.randomUUID();

const VERSION_INDEX = 14;
const VARIANT_INDEX = 19;
const HEX_NIBBLES = [...'0123456789abcdef'];

/** Spelled by code point so the source stays readable ASCII. */
const NUL = String.fromCodePoint(0);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x20_0b);
const NBSP = String.fromCodePoint(0xa0);
const LINE_SEPARATOR = String.fromCodePoint(0x20_28);

const withNibble = (id: string, index: number, nibble: string) =>
  id.slice(0, index) + nibble + id.slice(index + 1);

/** Runs `fn`, and returns the `CustomError` it must have thrown. */
function rejection(fn: () => unknown): CustomError {
  let returned: unknown;
  try {
    returned = fn();
  } catch (error) {
    if (error instanceof CustomError) return error;
    throw error;
  }
  throw new Error(
    `expected a CustomError, but the call returned ${JSON.stringify(returned)}`
  );
}

describe('validID — the gate every id passes before it reaches SQL', () => {
  test('an id the application itself mints is accepted, verbatim', () => {
    for (let i = 0; i < 64; i++) {
      const minted = generateUuidV7();
      expect(validID(minted)).toBe(minted);
    }
  });

  test('a real v4 UUID is rejected', () => {
    // Self-describing fixture: if the platform ever returns something other than
    // a v4 here, this fails rather than silently testing nothing.
    expect(V4[VERSION_INDEX]).toBe('4');
    expect(validID(V4)).toBe('');
  });

  test.each(HEX_NIBBLES.filter((n) => n !== '7'))(
    'version nibble "%s" is rejected — only v7 is an id here',
    (nibble) => {
      expect(validID(withNibble(ID, VERSION_INDEX, nibble))).toBe('');
    }
  );

  test.each(HEX_NIBBLES)('variant nibble "%s"', (nibble) => {
    // RFC 9562 variant bits: only 8/9/a/b are a valid UUID, and an id whose
    // variant is anything else is a string that merely looks like one.
    const candidate = withNibble(ID, VARIANT_INDEX, nibble);
    expect(validID(candidate)).toBe('89ab'.includes(nibble) ? candidate : '');
  });

  test.each([
    ['all "x"', 'x'.repeat(36)],
    ['36 hex characters with no hyphens', ID.replaceAll('-', '') + '0000'],
    ['the right shape with one non-hex digit', ID.slice(0, -1) + 'g'],
    [
      'a hyphen moved one place',
      ID.slice(0, 8) + ID.slice(9, 14) + '-' + ID.slice(14),
    ],
    ['a NUL-terminated id', ID.slice(0, -1) + NUL],
    ['padded SQL', "' OR 1=1 --" + ' '.repeat(25)],
  ])('a non-UUID of exactly 36 characters is rejected: %s', (_label, value) => {
    // The length is what makes these interesting: a caller that checked only
    // "36 characters, looks like an id" would pass every one of them through.
    expect(value).toHaveLength(ID.length);
    expect(validID(value)).toBe('');
  });

  test('surrounding whitespace is TRIMMED and ACCEPTED, not rejected', () => {
    // Corrects the brief and `reports/test-strategy.md`, which both expect
    // rejection. `validID` calls `.trim()` BEFORE testing, so padding is
    // stripped and the id is accepted — and what comes back is the canonical,
    // unpadded id, so SQL never sees the padding. This is the safe direction for
    // non-canonical input (unlike case, below): many spellings in, one out.
    for (const padded of [
      `  ${ID}  `,
      `\t${ID}\n`,
      `${NBSP}${ID}${NBSP}`,
      `\r\n${ID}`,
      `${ID}${LINE_SEPARATOR}`,
    ])
      expect(validID(padded)).toBe(ID);
  });

  test('whitespace INSIDE the id is still rejected', () => {
    expect(validID(ID.slice(0, 18) + ' ' + ID.slice(19))).toBe('');
    expect(validID(ID.slice(0, 18) + '\t' + ID.slice(19))).toBe('');
  });

  test('uppercase hex is accepted and canonicalised to lowercase', () => {
    const oneUpper = ID.replace(/[a-f]/, (c) => c.toUpperCase());

    expect(oneUpper).not.toBe(ID);
    expect(validID(oneUpper)).toBe(ID);
    expect(validID(ID.toUpperCase())).toBe(ID);
  });

  test('an `a === b` self-guard sees an uppercase path id as the same id', () => {
    const sessionUserId = ID;
    const pathId = validID(ID.replace(/[a-f]/, (c) => c.toUpperCase()));

    expect(pathId).toBe(sessionUserId);
    expect(sessionUserId === pathId).toBe(true);
  });

  test.each([
    ['a number', 42],
    ['zero', 0],
    ['null', null],
    ['undefined', undefined],
    ['true', true],
    ['an object with a matching toString', { toString: () => ID }],
    ['a one-element array', [ID]],
    // `new Object(<string>)` is a String wrapper: `typeof` is 'object', so a
    // gate that only checked truthiness or `instanceof String` would take it.
    ['a String wrapper object', new Object(ID)],
    ['an empty string', ''],
  ])('%s is not an id', (_label, value) => {
    expect(validID(value)).toBe('');
  });

  test('nothing outside hex and hyphen can survive the gate', () => {
    // The property that matters at the SQL boundary, asserted over hostile input
    // rather than over the shape of the regex: whatever comes back is either
    // empty or carries no character that could terminate a literal, open a
    // comment, or end a statement.
    const hostile = [
      `${ID}' OR '1'='1`,
      `${ID};DROP TABLE users`,
      `${ID}--`,
      `${ID}/*`,
      `${ID}${NUL}`,
      `${ID}%00`,
      `${ZERO_WIDTH_SPACE}${ID}`,
      `${ID}\n${ID}`,
      '٠١٢٣٤٥٦٧-٨٩٠١-٧٢٣٤-٨٥٦٧-٨٩٠١٢٣٤٥٦٧٨٩',
      `${ID}${ID}`,
      ID.slice(0, 20),
    ];

    for (const value of hostile) {
      const out = validID(value);
      expect(out === '' || !/[^0-9a-fA-F-]/.test(out)).toBe(true);
    }
  });
});

describe('parseLimit', () => {
  /**
   * The cap is read out of the production rejection message rather than
   * restated. `SESSIONS_MAX_PAGE_SIZE` is not exported, and hand-copying `100`
   * would let the message and the enforced bound drift apart — the one thing
   * `pagination.ts` says must not happen ("the message promises a value between
   * 1 and the cap, and silently serving 100 rows for `limit=1000` makes that
   * message a lie the client cannot detect").
   */
  const cap = Number(
    (rejection(() => parseLimit('0')).message.match(/\d+/g) ?? []).at(-1)
  );

  test('the cap named in the message is the cap enforced', () => {
    expect(cap).toBeGreaterThan(1);
    expect(parseLimit(String(cap))).toBe(cap);
    expect(rejection(() => parseLimit(String(cap + 1))).status).toBe(
      HTTP_STATUS.UNPROCESSABLE
    );
  });

  test('an absent limit is the page size, not an error', () => {
    expect(parseLimit(null)).toBe(SESSIONS_PAGE_SIZE);
    // A default the endpoint could not serve would be a contradiction.
    expect(SESSIONS_PAGE_SIZE).toBeLessThanOrEqual(cap);
    expect(SESSIONS_PAGE_SIZE).toBeGreaterThanOrEqual(1);
  });

  test('the lower bound is 1, and 0 is not a page', () => {
    expect(parseLimit('1')).toBe(1);
    expect(rejection(() => parseLimit('0')).status).toBe(
      HTTP_STATUS.UNPROCESSABLE
    );
  });

  test('a non-canonical spelling of an IN-RANGE number is still rejected', () => {
    // The bypass this function exists for: every spelling here is a number
    // `Number()` reads as something inside the cap, so a `Number()`-first
    // implementation honoured it. Asserting the `Number()` value alongside the
    // rejection is what makes this a bypass test rather than a garbage test.
    for (const spelling of ['1e1', '0x10', '+5', ' 5 ', '05', '5.0', '5.']) {
      const asNumber = Number(spelling);
      expect(asNumber).toBeGreaterThanOrEqual(1);
      expect(asNumber).toBeLessThanOrEqual(cap);
      expect(rejection(() => parseLimit(spelling)).status).toBe(
        HTTP_STATUS.UNPROCESSABLE
      );
    }
  });

  test.each([
    ['empty', ''],
    ['whitespace only', ' '.repeat(3)],
    ['negative', '-1'],
    ['not a number', 'abc'],
    ['Infinity', 'Infinity'],
    ['NaN', 'NaN'],
    ['a binary literal', '0b1010'],
    ['Arabic-Indic digits', '١٠'],
    ['a full-width digit', '５'],
    ['an over-long run of digits', '9'.repeat(400)],
    ['a newline-suffixed number', '5\n'],
  ])('%s is rejected', (_label, raw) => {
    expect(rejection(() => parseLimit(raw)).status).toBe(
      HTTP_STATUS.UNPROCESSABLE
    );
  });
});

describe('the cursor round trip', () => {
  test('a cursor this module emitted parses back to the same pair', () => {
    const createdAt = new Date(Date.UTC(2026, 7, 25, 12, 34, 56, 789));
    expect(parseCursor(formatCursor(createdAt, ID))).toEqual({
      createdAt,
      id: ID,
    });
  });

  test('the string shape a PostgreSQL client can return round-trips', () => {
    expect(parseCursor(formatCursor('2026-08-25 12:34:56.78+00', ID))).toEqual({
      createdAt: new Date(Date.UTC(2026, 7, 25, 12, 34, 56, 780)),
      id: ID,
    });
  });

  test.each([
    ['the epoch', 0],
    ['one millisecond after the epoch', 1],
    ['a recent instant', Date.UTC(2026, 0, 31, 23, 59, 59, 999)],
    ['a leap day', Date.UTC(2028, 1, 29, 0, 0, 0, 0)],
    [
      'the far future the format allows',
      Date.UTC(9999, 11, 31, 23, 59, 59, 999),
    ],
  ])('%s survives the round trip to the millisecond', (_label, epochMs) => {
    const createdAt = new Date(epochMs);
    const parsed = parseCursor(formatCursor(createdAt, ID));

    expect(parsed?.createdAt.getTime()).toBe(createdAt.getTime());
    expect(parsed?.id).toBe(ID);
  });

  test('an absent cursor is null — a different answer from a bad one', () => {
    // Page one. Collapsing this into the malformed case is what made a corrupted
    // cursor silently restart at the top while the client believed it was
    // advancing.
    expect(parseCursor(null)).toBeNull();
  });
});

describe('a cursor this module did not emit is refused', () => {
  const TS = '2026-08-25T12:34:56.789Z';

  test.each([
    ['empty', ''],
    ['no separator', `${TS}${ID}`],
    ['separator first', `|${ID}`],
    ['separator last', `${TS}|`],
    ['separator only', '|'],
    ['an extra separator before the id', `${TS}|junk|${ID}`],
    ['over the length cap', `${TS}|${ID}`.padEnd(200, 'x')],
    ['no timezone', `2026-08-25T12:34:56.789|${ID}`],
    ['an explicit +00:00 offset', `2026-08-25T12:34:56.789+00:00|${ID}`],
    ['a non-UTC offset', `2026-08-25T12:34:56.789+03:00|${ID}`],
    ['microsecond precision', `2026-08-25T12:34:56.789123Z|${ID}`],
    ['no milliseconds', `2026-08-25T12:34:56Z|${ID}`],
    ['a lowercase z', `2026-08-25T12:34:56.789z|${ID}`],
    ['a space where the T belongs', `2026-08-25 12:34:56.789Z|${ID}`],
    ['epoch milliseconds', `1787690096789|${ID}`],
    ['a v4 id', `${TS}|${crypto.randomUUID()}`],
    ['a numeric id', `${TS}|1`],
    ['an id with a quote', `${TS}|${ID}'`],
    ['no id at all', `${TS}|${' '.repeat(36)}`],
  ])('%s → 422', (_label, raw) => {
    expect(rejection(() => parseCursor(raw)).status).toBe(
      HTTP_STATUS.UNPROCESSABLE
    );
  });

  test.each([
    ['31 September', `2026-09-31T00:00:00.000Z|${ID}`],
    ['30 February', `2026-02-30T00:00:00.000Z|${ID}`],
    ['29 February of a non-leap year', `2026-02-29T00:00:00.000Z|${ID}`],
    ['month 13', `2026-13-01T00:00:00.000Z|${ID}`],
    ['month 00', `2026-00-01T00:00:00.000Z|${ID}`],
    ['day 00', `2026-08-00T00:00:00.000Z|${ID}`],
    ['hour 24', `2026-08-25T24:00:00.000Z|${ID}`],
    ['minute 60', `2026-08-25T12:60:00.000Z|${ID}`],
    ['second 60', `2026-08-25T12:34:60.000Z|${ID}`],
  ])('an impossible date is refused, not normalised: %s → 422', (_l, raw) => {
    // `new Date('2026-02-30T00:00:00.000Z')` is 2 March and `T24:00:00` is the
    // next day, so a `Date`-first parser answers with a page the caller never
    // asked for instead of refusing.
    expect(rejection(() => parseCursor(raw)).status).toBe(
      HTTP_STATUS.UNPROCESSABLE
    );
  });

  test('29 February of a LEAP year is accepted', () => {
    // The negative cases above are worth nothing without this one: a check that
    // rejected every 29 February would pass all of them.
    expect(parseCursor(`2028-02-29T00:00:00.000Z|${ID}`)).toEqual({
      createdAt: new Date(Date.UTC(2028, 1, 29)),
      id: ID,
    });
  });

  test('the refusal echoes nothing back to the caller', () => {
    const marker = 'reflect-me-9f1b3c2e';
    const error = rejection(() => parseCursor(`${marker}|${ID}`));

    expect(error.message).not.toContain(marker);
    expect(error.message).not.toContain(ID);
    // And one refusal for every reason: a bad timestamp, a bad id and a bad pair
    // are indistinguishable, so the message is no oracle for which half was
    // wrong or whether the session exists.
    expect(rejection(() => parseCursor(`bad|${ID}`)).message).toBe(
      error.message
    );
    expect(rejection(() => parseCursor(`${marker}|nope`)).message).toBe(
      error.message
    );
  });
});

describe('pinned: the round-trip guarantee runs one way only', () => {
  test('formatCursor does not validate the id, so it can emit a 422', () => {
    // `pagination.ts` line 46 claims "a cursor this function did not produce
    // cannot be parsed" — true, and asserted above. The converse is not: nothing
    // checks the id, so a caller handing it a non-v7 value gets a cursor its own
    // parser refuses. Unreachable today (the id comes from a `uuid` column),
    // which is why this pins rather than fails.
    const emitted = formatCursor(new Date(0), 'a|b');

    expect(emitted).toContain('|a|b');
    expect(rejection(() => parseCursor(emitted)).status).toBe(
      HTTP_STATUS.UNPROCESSABLE
    );
  });

  test('a year outside four digits emits an ISO year it cannot read back', () => {
    // `toISOString()` renders year 10000 as `+010000-…`, which the fully
    // anchored `\d{4}` pattern refuses. Also unreachable for a session row.
    const emitted = formatCursor(new Date(Date.UTC(10_000, 0, 1)), ID);

    expect(emitted.startsWith('+010000-')).toBe(true);
    expect(rejection(() => parseCursor(emitted)).status).toBe(
      HTTP_STATUS.UNPROCESSABLE
    );
  });

  test('an UPPERCASE id passes the cursor parser and is canonicalised to lowercase', () => {
    // `parseCursor` gates the id through `validID`, which normalises to
    // lowercase. The cursor accepts uppercase hex from clients and canonicalises
    // it before returning.
    const upper = ID.toUpperCase();

    expect(parseCursor(`2026-08-25T12:34:56.789Z|${upper}`)).toEqual({
      createdAt: new Date(Date.UTC(2026, 7, 25, 12, 34, 56, 789)),
      id: ID,
    });
  });

  test('a real instant in year 0 is refused by the day check', () => {
    // `daysInMonth` computes `Date.UTC(year, month, 0)`, and `Date.UTC` maps
    // years 0-99 onto 1900-1999 — so for year 0 it asks about 1900, which was
    // not a leap year, and refuses a date that IS real and DOES round-trip.
    // Latent: no session predates 1970. Pinned because the mapping would
    // misjudge any two-digit year, not because this one matters.
    const raw = '0000-02-29T00:00:00.000Z';

    expect(new Date(raw).toISOString()).toBe(raw);
    expect(rejection(() => parseCursor(`${raw}|${ID}`)).status).toBe(
      HTTP_STATUS.UNPROCESSABLE
    );
    // The neighbouring years the mapping happens to get right, for contrast.
    expect(parseCursor(`0004-02-29T00:00:00.000Z|${ID}`)).not.toBeNull();
    expect(parseCursor(`0099-12-31T00:00:00.000Z|${ID}`)).not.toBeNull();
  });

  test('a timestamp with no offset is read in the SERVER zone', () => {
    // Not live today — PostgreSQL renders `timestamptz` with an explicit offset,
    // asserted above — but one `DateStyle` or driver change away. If a zone-less
    // string ever reaches the emitter, every cursor shifts by the host's UTC
    // offset and the next page starts at the wrong instant. Written against the
    // host's own offset so it holds on a UTC CI machine and a +03 laptop alike.
    const local = '2026-08-25T12:34:56.789';
    const hostIsUtc = new Date(local).getTimezoneOffset() === 0;

    expect(formatCursor(local, ID) === formatCursor(`${local}Z`, ID)).toBe(
      hostIsUtc
    );
  });
});

describe('formatCursor on an unparseable timestamp', () => {
  test.each([
    ['a non-date string', 'not-a-date'],
    ['an empty string', ''],
    ['an Invalid Date', new Date(NaN)],
    ['null', null as unknown as string],
    ['undefined', undefined as unknown as string],
  ])('%s throws a plain Error, not a CustomError', (_label, input) => {
    // Which means it carries no status, so `handleApiError` answers 500 — an
    // unhandled server fault rather than a 4xx. Correct for what it is (the
    // value came from our own row, not from the caller), and worth pinning
    // because a `CustomError` here would quietly turn a corrupt row into a
    // client error.
    let thrown: unknown;
    try {
      formatCursor(input, ID);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(CustomError);
    expect((thrown as { status?: number }).status).toBeUndefined();
  });
});
