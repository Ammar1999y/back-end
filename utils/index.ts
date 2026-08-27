import type { SQL } from 'bun';

import { MAX_ID } from '@/constants';

const ARABIC_INDIC_DIGITS = /[٠-٩۰-۹]/g;

const ARABIC_INDIC_BASE = 0x06_60;
const EXTENDED_ARABIC_INDIC_BASE = 0x06_f0;

export function normalizeArabicDigits(input: string): string {
  return input.replaceAll(ARABIC_INDIC_DIGITS, (digit) => {
    const code = digit.codePointAt(0) ?? 0;
    const base =
      code >= EXTENDED_ARABIC_INDIC_BASE
        ? EXTENDED_ARABIC_INDIC_BASE
        : ARABIC_INDIC_BASE;
    return String(code - base);
  });
}

/** @knipignore */
export const humanReadableNumber = (
  value: number | string,
  numberOfDigits = 2
) =>
  returnNumber(value).toLocaleString('en', {
    maximumFractionDigits: numberOfDigits,
  });

// ---- Log serialization ----------------------------------------------
// Diagnostic call sites pass structured objects (`{ msg, attempt, error }`).
// `String(obj)` would collapse those to "[object Object]" and destroy the
// context incident response needs, so they are serialized field by field with
// hard bounds and recursive redaction instead.

const LOG_MAX_DEPTH = 4;
const LOG_MAX_ITEMS = 20;
const LOG_MAX_KEYS = 30;
const LOG_MAX_STRING = 256;
const LOG_REDACTED = '[redacted]';

/**
 * Key fragments whose values never belong in a log line, matched ANYWHERE in
 * the key.
 *
 * ⚠️ A NET, not a guarantee. It cannot see a secret inside free text (a driver
 * error's message carries its bound parameters; a provider's carries the
 * payload it rejected) and it cannot know a key nobody listed. Those need a
 * boundary at the source — see `serializeQueryError` and `sendOtp`. The rule is
 * still: never hand a secret to a logger.
 */
const SENSITIVE_LOG_FRAGMENTS = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'cookie',
  'authorization',
  'bearer',
  'credential',
  'pepper',
  'apikey',
  'privatekey',
  'signature',
  'jwt',
  'salt',
  'passphrase',
  'otp',
];

/**
 * `hash` and `code` are secrets in one position and diagnostics in another, so
 * they are matched positionally rather than as substrings: `hash` at the end is
 * the digest (`passwordHash`), at the start it describes one (`hashUpgraded`);
 * `code` at the end is a status (`statusCode`), alone it is the OTP. As plain
 * substrings they redacted every one of those.
 */
const SENSITIVE_LOG_SUFFIXES = ['hash'];
const SENSITIVE_LOG_KEYS: ReadonlySet<string> = new Set([
  'code',
  'plaintextcode',
  'verificationcode',
  'resetcode',
]);

/**
 * Extra diagnostic fields worth keeping off Error-like objects (PG codes).
 *
 * `errno` is in this list because `bun:sql` puts the SQLSTATE there and its
 * `code` on a `PostgresError` is the constant `'ERR_POSTGRES_SERVER_ERROR'` for
 * every constraint violation — so without `errno` a driver error logs a name for
 * a class of failures instead of the one code that identifies which failure it
 * was. On Node errors the same key is a negative integer (`-4058`), which the
 * numeric branch below keeps as-is.
 */
const ERROR_DETAIL_KEYS = [
  'code',
  'errno',
  'constraint',
  'status',
  'statusCode',
];

/**
 * SQLSTATE (`23505`) or a Node/Nodemailer class (`ECONNRESET`). An Error's
 * `code` is kept only when it matches this — six plain digits, an OTP, does not.
 */
const DRIVER_ERROR_CODE = /^(?:[0-9A-Z]{5}|[A-Z][A-Z0-9_]{1,31})$/;

/** The keys in `ERROR_DETAIL_KEYS` that must look like driver metadata. */
const SHAPE_CHECKED_ERROR_KEYS = new Set(['code', 'errno']);

function isSensitiveLogKey(key: string, value: unknown): boolean {
  // A boolean cannot carry a credential, so a flag ABOUT one is safe by
  // construction — same rule as `lib/audit.ts`.
  if (typeof value === 'boolean') return false;
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
  if (SENSITIVE_LOG_KEYS.has(normalized)) return true;
  if (SENSITIVE_LOG_SUFFIXES.some((suffix) => normalized.endsWith(suffix)))
    return true;
  return SENSITIVE_LOG_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment)
  );
}

const LOG_CONTROL_CHARS = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;

function stripLogControlChars(value: string): string {
  return value.replaceAll(LOG_CONTROL_CHARS, ' ');
}

function clampLogString(value: string): string {
  const clean = stripLogControlChars(value);
  return clean.length > LOG_MAX_STRING
    ? clean.slice(0, LOG_MAX_STRING - 1) + '\u{2026}'
    : clean;
}

/**
 * A database driver error whose message was built from the statement and its
 * BOUND PARAMETERS.
 *
 * Drizzle throws `Failed query: <sql>\nparams: <values>`, and those values are
 * routinely the application's secrets — session tokens, password hashes,
 * contact details. Because they live inside `message`, key-based redaction
 * cannot reach them: every `console.error(sanitizeForLog(error))` in the app,
 * including the generic one in `handleApiError`, would print them.
 *
 * The message is mechanically reconstructible from the code, so nothing of
 * diagnostic value is lost by dropping it; the driver `code`/`constraint` and
 * the `cause` chain are kept.
 */
/**
 * Drizzle's fixed message prefix. Checked as a second signal because a wrapper
 * or a structured clone can copy `message` while dropping `query`/`params`,
 * which would slip the parameter-bearing text past a shape-only test. This is
 * a literal from our own dependency, not a guess about adversary formatting.
 */
const QUERY_ERROR_MARKERS = ['Failed query:', 'params:'] as const;

function isParameterBearingQueryError(error: object): boolean {
  if ('query' in error && 'params' in error) return true;
  const message = (error as { message?: unknown }).message;
  // Both markers, ANYWHERE in the text. A prefix test missed the common
  // contextual wrapper `new Error(\`context: ${dbError.message}\`)`, and even
  // leading whitespace defeated it. Requiring the pair keeps it from firing on
  // unrelated messages that merely mention a query.
  return (
    typeof message === 'string' &&
    QUERY_ERROR_MARKERS.every((marker) => message.includes(marker))
  );
}

/**
 * Per-field shape checks on the metadata kept from a query error.
 *
 * SQLSTATE is exactly five uppercase alphanumerics, which is narrow enough to
 * be a real constraint. `constraint` is bounded to a lowercase identifier,
 * matching this schema's `ux_`/`idx_`/`chk_` naming.
 *
 * Being precise about the limit: this bounds what a FABRICATED query-shaped
 * error could smuggle through — it does not eliminate it, because a token can
 * be shaped like an identifier. Only an allowlist of this schema's actual
 * constraint names would, and that would couple the logger to the schema. Real
 * driver metadata is safe; the residual risk is an attacker who can already
 * throw arbitrary objects into a log call, which is a larger problem than this.
 */
const QUERY_ERROR_SAFE_FIELDS = {
  // Two spellings of the same field, both gated by the SQLSTATE shape. `errno`
  // is where `bun:sql` puts it; `code` is where every other PostgreSQL client
  // does, and Bun's own `code` (`ERR_POSTGRES_SERVER_ERROR`) fails this pattern
  // and is dropped — which is the intended outcome, since it names a class of
  // errors rather than one. Without `errno` here a query error reduced by this
  // function carried no code at all.
  code: /^[0-9A-Z]{5}$/,
  errno: /^[0-9A-Z]{5}$/,
  constraint: /^[a-z][a-z0-9_]{0,62}$/,
} as const;

function pickQuerySafeKeys(value: object): Record<string, unknown> {
  // Own properties only, into a prototype-free record — the same rule the
  // generic serializer uses. The written keys are fixed here, but an inherited
  // `code`/`constraint` off a caller-supplied prototype would otherwise be
  // reported as driver metadata it isn't.
  const out: Record<string, unknown> = Object.create(null);
  const record = value as Record<string, unknown>;
  for (const [key, pattern] of Object.entries(QUERY_ERROR_SAFE_FIELDS)) {
    if (!Object.hasOwn(record, key)) continue;
    const entry = record[key];
    if (typeof entry === 'string' && pattern.test(entry)) out[key] = entry;
  }
  return out;
}

/**
 * Reduce a parameter-bearing query error to metadata only.
 *
 * Suppressing the wrapper's message is not enough. The driver `cause`
 * underneath it also echoes offending values — PostgreSQL `22P02` reports
 * `invalid input syntax for type uuid: "<the value>"` — so the whole chain has
 * to be reduced to hard-allowlisted fields rather than recursed into with the
 * ordinary rules. Nothing is lost: the wrapper's message is reconstructible
 * from the code, and SQLSTATE plus the constraint name is what actually
 * identifies the failure.
 *
 * The name is a fixed label, not the error's own: real `DrizzleQueryError`
 * instances report `name === 'Error'`, so copying it says nothing, and copying
 * an arbitrary name is one more untrusted string.
 */
function serializeQueryError(error: object): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: 'QueryError',
    message: '[withheld: query errors echo bound parameters]',
    ...pickQuerySafeKeys(error),
  };

  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === 'object')
    out.cause = { name: 'DriverError', ...pickQuerySafeKeys(cause) };

  return out;
}

function serializeErrorLike(
  error: Error,
  depth: number,
  seen: WeakSet<object>,
  budget: { nodes: number }
): Record<string, unknown> {
  if (isParameterBearingQueryError(error)) return serializeQueryError(error);

  // `message` is kept, and a key-based rule cannot see inside it: anything that
  // builds a message from a secret must be contained where it is thrown (see
  // `serializeQueryError`, `sendOtp`). This is not a no-secrets guarantee.
  const out: Record<string, unknown> = {
    name: clampLogString(error.name || 'Error'),
    message: clampLogString(error.message || ''),
  };
  const anyErr = error as unknown as Record<string, unknown>;
  for (const key of ERROR_DETAIL_KEYS) {
    const value = anyErr[key];
    if (typeof value === 'number') {
      out[key] = value;
      continue;
    }
    if (typeof value !== 'string') continue;
    // A plain object's `code` is redacted outright; an Error's is kept because
    // that is where driver metadata lives. The shape test reconciles the two.
    out[key] =
      SHAPE_CHECKED_ERROR_KEYS.has(key) && !DRIVER_ERROR_CODE.test(value)
        ? LOG_REDACTED
        : clampLogString(value);
  }
  if (error.cause != null && depth < LOG_MAX_DEPTH)
    out.cause = serializeLogValue(error.cause, depth + 1, seen, budget);
  return out;
}

/**
 * Total values one call may visit.
 *
 * Depth, item, key and string caps each bound one dimension, but their PRODUCT
 * is large (4 deep x 30 keys per level), so a wide-and-deep payload could still
 * cost far more than any log line is worth. This is the flat ceiling across the
 * whole walk.
 */
const LOG_MAX_NODES = 2000;

function serializeLogValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  // Required, not defaulted: every entry point creates the budget so one
  // traversal cannot silently start a fresh allowance mid-walk.
  budget: { nodes: number }
): unknown {
  if (budget.nodes <= 0) return '[budget limit]';
  budget.nodes -= 1;
  if (value === null) return null;

  switch (typeof value) {
    case 'undefined': {
      return undefined;
    }
    case 'boolean': {
      return value;
    }
    case 'number': {
      return Number.isFinite(value) ? value : String(value);
    }
    case 'bigint': {
      return `${value}n`;
    }
    case 'string': {
      return clampLogString(value);
    }
    case 'function':
    case 'symbol': {
      return `[${typeof value}]`;
    }
  }

  const obj = value as object;
  if (seen.has(obj)) return '[circular]';

  if (obj instanceof Date)
    return Number.isNaN(obj.getTime()) ? '[invalid date]' : obj.toISOString();
  if (obj instanceof Error) {
    seen.add(obj);
    return serializeErrorLike(obj, depth, seen, budget);
  }
  if (depth >= LOG_MAX_DEPTH) return '[depth limit]';

  seen.add(obj);

  if (Array.isArray(obj)) {
    const items = obj
      .slice(0, LOG_MAX_ITEMS)
      .map((item) => serializeLogValue(item, depth + 1, seen, budget));
    if (obj.length > LOG_MAX_ITEMS)
      items.push(`[+${obj.length - LOG_MAX_ITEMS} more]`);
    return items;
  }

  if (obj instanceof Map || obj instanceof Set)
    return `[${obj.constructor.name}(${obj.size})]`;

  // A non-Error object can still be a driver error shape (some drivers throw
  // plain objects). Apply the same rule rather than trusting `instanceof`,
  // and keep the same allowlisted metadata an Error-shaped one keeps.
  if (isParameterBearingQueryError(obj)) return serializeQueryError(obj);

  // Prototype-free record: `out[key] = …` with a key of `__proto__` on a plain
  // object hits the setter and mutates this record's prototype instead of
  // recording a field — the field silently disappears from the log line.
  const out: Record<string, unknown> = Object.create(null);
  let keyCount = 0;
  // Lazy iteration over own keys. `Object.entries(obj)` built an array of every
  // enumerable key AND read every value — running any getters — before the
  // 30-key output cap could apply, so the cap bounded the output but not the
  // work. `for...in` stops at the cap; `hasOwn` keeps inherited keys out.
  for (const key in obj) {
    if (!Object.hasOwn(obj, key)) continue;
    if (keyCount >= LOG_MAX_KEYS) {
      out._truncated = true;
      break;
    }
    keyCount += 1;
    const entry = (obj as Record<string, unknown>)[key];
    out[key] = isSensitiveLogKey(key, entry)
      ? LOG_REDACTED
      : serializeLogValue(entry, depth + 1, seen, budget);
  }
  return out;
}

/**
 * Bounded, redacting serializer for log payloads. Always returns a
 * single-line string: depth/collection/length limited, sensitive keys
 * replaced, nested `Error`s reduced to safe name/message/code fields.
 * Exported so the behavior can be asserted directly in tests.
 */
export function serializeForLog(input: unknown, maxLength = 1024): string {
  let out: string;
  try {
    const value = serializeLogValue(input, 0, new WeakSet(), {
      nodes: LOG_MAX_NODES,
    });
    out =
      typeof value === 'string'
        ? value
        : (JSON.stringify(value) ?? String(value));
  } catch {
    out = '[unserializable log payload]';
  }
  out = stripLogControlChars(out);
  if (out.length <= maxLength) return out;
  // The ellipsis must fit INSIDE the cap. `slice(0, maxLength - 3) + '...'`
  // returned 3 characters for `maxLength = 1`, breaking the one guarantee this
  // function's signature makes.
  return maxLength <= 3
    ? out.slice(0, Math.max(0, maxLength))
    : out.slice(0, maxLength - 3) + '...';
}

/**
 * The class of a thrown value, for a log line.
 *
 * Takes `unknown` and narrows, rather than asserting a shape: `throw` accepts
 * any value, so `(error as { name?: string }).name` is an assumption the
 * language does not back. Seven copies of that assertion preceded this one.
 */
export function errorClassOf(error: unknown): string {
  return error instanceof Error ? error.name : 'Unknown';
}

export function sanitizeForLog(input: unknown, maxLength = 1024) {
  // Development still gets an expandable structure rather than a JSON string —
  // but a REDACTED one. Returning the raw value meant local, preview, and
  // accidentally development-configured deployments printed whatever the value
  // contained, including bound query parameters (session tokens, password
  // hashes). Redaction is not a production-only concern.
  if (process.env.NODE_ENV === 'development') {
    // Same failure guard as the production path. Walking an unknown value can
    // itself throw (a hostile getter, a Proxy trap), and a logging call must
    // never be the thing that takes the request down.
    try {
      return serializeLogValue(input, 0, new WeakSet(), {
        nodes: LOG_MAX_NODES,
      });
    } catch {
      return '[unserializable log payload]';
    }
  }
  return serializeForLog(input, maxLength);
}

const returnNumber = (value: string | undefined | number | null) => {
  const num = Number(value);
  return Number.isNaN(num) ? 0 : num;
};

/**
 * Canonical decimal integers only — the same shape
 * `app/api/dash/users/[id]/sessions/pagination.ts` enforces, and for the reason
 * stated there: bare `Number()` accepts a whole family of spellings a query
 * string has no business carrying. Measured against `maxValue = 100`:
 * `"1e2"` -> 100, `"0x10"` -> 16, `"+1"` -> 1, `" 5 "` -> 5, `"05"` -> 5,
 * `"10.9"` -> 10. Two spelling policies for one concept in one API — and the
 * over-cap rejection was bypassable by spelling the number differently.
 *
 * **Over the maximum returns `OUT_OF_RANGE`, not `0`.** Both used to be `0`, and
 * the caller cannot tell them apart: `lib/data-table/parsers.ts` writes
 * `positiveInt(params.perPage, maxPerPage) || 10`, so `?perPage=101` served TEN
 * rows rather than 100 or a 422, and `?page=10001` silently returned page one.
 *
 * `Math.trunc`, not `| 0`: the bitwise form is a 32-bit signed truncation, so a
 * `maxValue` above 2³¹−1 returned a NEGATIVE result for an in-range input. No
 * current caller passes one; the trap is removed rather than documented.
 */
const CANONICAL_INTEGER = /^(?:0|[1-9]\d*)$/;

/** Distinguishes "over the cap" from "not a number at all". */
export const OUT_OF_RANGE = -1;

export const positiveInt = (val: unknown, maxValue = MAX_ID) => {
  const raw =
    typeof val === 'number' ? String(val) : typeof val === 'string' ? val : '';
  if (!CANONICAL_INTEGER.test(raw)) return 0;
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return 0;
  if (num > maxValue) return OUT_OF_RANGE;
  return Math.trunc(num);
};

/**
 * Drizzle wraps the driver error in a `DrizzleQueryError`, so the PostgreSQL
 * fields sit either on the thrown value or one `cause` level down. Read
 * structurally, not with `instanceof`: no db layer is imported here, because
 * `lib/data-table/parsers.ts` reaches this module from the browser.
 *
 * **`errno` carries the SQLSTATE, not `code`.** That is a `bun:sql` fact and it
 * is the whole reason this block is not a one-liner. `Bun.SQL`'s `PostgresError`
 * puts its own identifier in `code` — `'ERR_POSTGRES_SERVER_ERROR'` for every
 * constraint violation — and the five-character SQLSTATE in `errno`, as a
 * STRING. Measured on Bun 1.4.0 against PostgreSQL 18.6 across unique, not-null,
 * check, FK, undefined-table, syntax, cast, divide-by-zero, lock-not-available
 * and `RAISE … USING errcode` errors: `errno` was the SQLSTATE in all of them,
 * letters intact (`42P01`, `23P01`), never a number.
 *
 * The previous driver put it in `code`, so reading `code` here now matches
 * nothing — every unique violation would fall through to a generic 500 instead
 * of the 409 the handlers raise. Both keys are therefore read: `errno` is what
 * this driver sets, and `code` keeps a SQLSTATE recognised if it ever arrives
 * under the name every other PostgreSQL client uses.
 *
 * The field names are `Pick`ed from Bun's own `PostgresError` rather than
 * hand-written, so a rename or a type change there is a build failure instead of
 * a matcher that silently stops matching — which is this exact defect. Worth the
 * link because Bun's own spelling is not consistent across its drivers:
 * `MySQLError` carries `errno: number` AND `sqlState: string`, while
 * `PostgresError` puts the SQL state in `errno: string`. `import type` erases at
 * compile time, so this module stays free of any db import — which is what lets
 * `lib/data-table/parsers.ts` reach it from the browser.
 */
type PgErrorFields = Pick<SQL.PostgresError, 'code' | 'errno' | 'constraint'>;
function dbErrorField<K extends keyof PgErrorFields>(
  error: unknown,
  key: K
): unknown {
  if (!error || typeof error !== 'object') return undefined;
  return key in error ? Reflect.get(error, key) : undefined;
}

function hasSqlState(e: unknown, sqlState: string): boolean {
  const cause =
    e && typeof e === 'object' && 'cause' in e ? e.cause : undefined;
  return (
    dbErrorField(e, 'errno') === sqlState ||
    dbErrorField(e, 'code') === sqlState ||
    dbErrorField(cause, 'errno') === sqlState ||
    dbErrorField(cause, 'code') === sqlState
  );
}

/** PostgreSQL `unique_violation`. */
export function isUniqueViolation(e: unknown): boolean {
  return hasSqlState(e, '23505');
}

/** PostgreSQL `foreign_key_violation`. */
export function isForeignKeyViolation(e: unknown): boolean {
  return hasSqlState(e, '23503');
}

/**
 * PostgreSQL `character_not_in_repertoire` — a NUL byte reaching a text
 * parameter.
 *
 * Mapped so the class cannot resurface as a 500 from a path that forgets to
 * filter. The read path is filtered at its entry points now
 * (`lib/data-table/parsers.ts`, `db/queries/data-table.ts`), but this is the
 * boundary that makes a MISSED site a 422 instead of an unhandled fault whose
 * log line embeds the SQL and its parameters.
 */
export function isInvalidTextEncoding(e: unknown): boolean {
  return hasSqlState(e, '22021');
}

export function getConstraintName(e: unknown): string {
  const direct = dbErrorField(e, 'constraint');
  if (typeof direct === 'string') return direct;
  const cause =
    e && typeof e === 'object' && 'cause' in e ? e.cause : undefined;
  const nested = dbErrorField(cause, 'constraint');
  return typeof nested === 'string' ? nested : '';
}

/** @knipignore */
export const formatDate = (date: string) =>
  new Date(date).toLocaleDateString('ar-EG', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

// UUID v7 validation regex
// Format: xxxxxxxx-xxxx-7xxx-xxxx-xxxxxxxxxxxx
const UUID_V7_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates if the given value is a valid UUID v7
 * @param val - Value to validate
 * @returns The valid UUID v7 string, or empty string if invalid
 */
export const validID = (val: unknown): string => {
  if (typeof val !== 'string') return '';
  const trimmed = val.trim();
  return UUID_V7_REGEX.test(trimmed) ? trimmed.toLowerCase() : '';
};

/**
 * Extracts EntityID from the end of a URL path
 * Supports UUID v7 format and numeric IDs
 * @knipignore
 * @param url - The URL to extract ID from
 * @returns The extracted ID string, or null if not found
 */
export const extractIdFromUrl = (url: string): string | null => {
  // Match UUID v7 (36 chars with hyphens) or numeric ID at the end
  const match = url.match(/\/([0-9a-f-]{36}|\d+)$/i);
  return match?.[1] ?? null;
};

// export const validID = positiveInt;
// export const extractIdFromUrl = (url: string): number | null => {
//   const idMatch = url.match(/\/(\d+)$/);
//   const id = idMatch ? Number(idMatch[1]) : null;
//   return id;
// };
