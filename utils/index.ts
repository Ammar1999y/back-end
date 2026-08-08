/* eslint-disable unicorn/prefer-math-trunc */
import type { NeonDbError } from '@neondatabase/serverless';

import { MAX_ID } from '@/constants';
import { EntityID } from '@/types';
import { v7 as uuidv7 } from 'uuid';

export function normalizeArabicDigits(input: string): string {
  const ARNums = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
  return input.replaceAll(/[٠-٩]/g, (n) => String(ARNums.indexOf(n)));
}

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
 * Key fragments whose values never belong in a log line.
 *
 * ⚠️ A NET, not a guarantee. It cannot see a secret inside free text (a driver
 * error's message carries its bound parameters; a provider's carries the
 * payload it rejected) and it cannot know a key nobody listed. Those need a
 * boundary at the source — see `serializeQueryError` and `sendOtp`. The rule is
 * still: never hand a secret to a logger.
 *
 * `code` is listed because here a "code" is an OTP; safe diagnostic fields are
 * named otherwise (`smtpClass`, `status`).
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
  'code',
  'hash',
];

/** Extra diagnostic fields worth keeping off Error-like objects (PG codes). */
const ERROR_DETAIL_KEYS = ['code', 'constraint', 'status', 'statusCode'];

function isSensitiveLogKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
  return SENSITIVE_LOG_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment)
  );
}

// Cc = control chars (CR/LF/TAB…), Zl/Zp = Unicode line/paragraph separators.
const LOG_CONTROL_CHARS = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;

/** Strip CR/LF and Unicode line separators so a log line can't be forged. */
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
  code: /^[0-9A-Z]{5}$/,
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

  const out: Record<string, unknown> = {
    name: clampLogString(error.name || 'Error'),
    message: clampLogString(error.message || ''),
  };
  const anyErr = error as unknown as Record<string, unknown>;
  for (const key of ERROR_DETAIL_KEYS) {
    const value = anyErr[key];
    if (typeof value === 'string' || typeof value === 'number')
      out[key] = typeof value === 'string' ? clampLogString(value) : value;
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
    out[key] = isSensitiveLogKey(key)
      ? LOG_REDACTED
      : serializeLogValue(
          (obj as Record<string, unknown>)[key],
          depth + 1,
          seen,
          budget
        );
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

export const returnNumber = (value: string | undefined | number | null) => {
  const num = Number(value);
  return Number.isNaN(num) ? 0 : num;
};
export const returnNumberOrNull = (
  value: string | undefined | number | null
) => {
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
};

export const positiveInt = (val: unknown, maxValue = MAX_ID) => {
  const num = Number(val);
  if (!Number.isFinite(num) || num <= 0 || num > maxValue) return 0;
  return num | 0;
};

/**
 * Drizzle wraps the driver error, so the PostgreSQL fields sit either on the
 * thrown value or one `cause` level down. Read structurally, not with
 * `instanceof`: the import stays type-only so this module — which
 * `lib/data-table/parsers.ts` reaches from the browser — pulls in no db layer.
 */
type PgErrorFields = Pick<NeonDbError, 'code' | 'constraint'>;
type ThrownDbError = Partial<PgErrorFields> & {
  cause?: Partial<PgErrorFields>;
};

const asDbError = (e: unknown) => e as ThrownDbError | null | undefined;

export function isUniqueViolation(e: unknown): boolean {
  const err = asDbError(e);
  // TODO: test this
  return (
    err?.code === '23505' || err?.cause?.code === '23505' /* ||
    /duplicate|unique/i.test(anyErr?.message ?? '') ||
    /duplicate|unique/i.test(anyErr?.cause?.message ?? '') */
  );
}

// PostgreSQL FK violation code: 23503
export function isForeignKeyViolation(e: unknown): boolean {
  const err = asDbError(e);
  return err?.code === '23503' || err?.cause?.code === '23503';
}

export function getConstraintName(e: unknown): string {
  const err = asDbError(e);
  return err?.constraint ?? err?.cause?.constraint ?? '';
}

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
  return UUID_V7_REGEX.test(trimmed) ? trimmed : '';
};

/**
 * Generates a UUID v7 (time-ordered UUID)
 * @returns A new UUID v7 string
 */
export const generateUUIDv7 = (): EntityID => {
  return uuidv7();
};

/**
 * Extracts EntityID from the end of a URL path
 * Supports UUID v7 format and numeric IDs
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
