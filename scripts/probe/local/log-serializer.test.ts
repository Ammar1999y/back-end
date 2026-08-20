/**
 * Probe for the log serializer (C-05).
 *
 * Asserts the redaction rule still hides secrets, no longer eats ordinary
 * diagnostics, and records — rather than pretends to fix — the residual
 * free-text limitation.
 */
import { serializeForLog } from '@/utils';
import { SQL } from 'bun';
import { expect, test } from 'bun:test';

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

const has = (s: string, needle: string) => s.includes(needle);

// ── still redacted ────────────────────────────────────────────────────
const secrets = serializeForLog({
  password: 'hunter2',
  passwordHash: '$argon2id$v=19$abc',
  sessionToken: 'st_live_123',
  otpCode: '424242',
  code: '424242',
  hash: '$argon2id$v=19$xyz',
  codeHash: '$argon2id$v=19$zzz',
  pwHash: '$argon2id$v=19$qqq',
  argonHash: '$argon2id$v=19$rrr',
  verificationCode: '999111',
  resetCode: '999111',
  apiKey: 'sk-abc',
  pepperSecret: 'aaaa',
});
for (const leak of [
  'hunter2',
  '$argon2id',
  'st_live_123',
  '424242',
  '999111',
  'sk-abc',
]) {
  check(
    `secret "${leak}" not present`,
    !has(secrets, leak),
    secrets.slice(0, 0)
  );
}

// ── no longer over-redacted ───────────────────────────────────────────
const diag = serializeForLog({
  statusCode: 502,
  errorCode: 'EAI_AGAIN',
  smtpCode: 'EAUTH',
  hashUpgraded: true,
  passwordChanged: true,
  passwordlessProofVerified: false,
  hashAlgorithm: 'argon2id',
});
check('statusCode kept', has(diag, '502'), diag);
check('errorCode kept', has(diag, 'EAI_AGAIN'), diag);
check('smtpCode kept', has(diag, 'EAUTH'), diag);
check('boolean hashUpgraded kept', has(diag, '"hashUpgraded":true'), diag);
check(
  'boolean passwordChanged kept',
  has(diag, '"passwordChanged":true'),
  diag
);
check(
  'boolean passwordlessProofVerified kept',
  has(diag, '"passwordlessProofVerified":false'),
  diag
);
// A STRING named hashAlgorithm is still ambiguous by the fragment rule? No —
// 'hash' is exact-match only now, and 'hashalgorithm' is not in the exact set.
check('hashAlgorithm kept', has(diag, 'argon2id'), diag);

// ── Error shape: driver code kept, OTP-shaped code redacted ───────────
const driverErr = serializeForLog(
  Object.assign(new Error('connection reset'), {
    code: 'ECONNRESET',
    statusCode: 500,
  })
);
check('driver code kept on Error', has(driverErr, 'ECONNRESET'), driverErr);

const sqlstateErr = serializeForLog(
  Object.assign(new Error('duplicate key'), { code: '23505' })
);
check('SQLSTATE kept on Error', has(sqlstateErr, '23505'), sqlstateErr);

const otpShapedErr = serializeForLog(
  Object.assign(new Error('boom'), { code: '123456' })
);
check(
  'OTP-shaped code redacted on Error',
  !has(otpShapedErr, '123456'),
  otpShapedErr
);

// ── `errno`, which is where bun:sql actually puts the SQLSTATE ─────────
// The block above pins `code`, and `code` is NOT the spelling this driver
// produces: `bun:sql` reports `code: 'ERR_POSTGRES_SERVER_ERROR'` for every
// server error and the five-character SQLSTATE in `errno`. So the `code` cases
// exercise a compatibility fallback while the field the serializer actually
// receives went uncovered — the same circularity `reports/test-strategy.md`
// makes a standing rule of: never assert against a hand-authored fixture where
// a real one is reachable (§5.1 records the concrete case, a manufactured
// SQLite error name).
//
// Built with Bun's OWN `SQL.PostgresError` rather than `Object.assign` on an
// Error: the constructor is typed, so this fixture cannot drift from the shape
// the driver really throws, and it needs no database to run in CI. What it does
// NOT prove is that Bun populates `errno` from the wire — that needs a live
// server and lives in scripts/probe/dev-live/.
const driverPgError = new SQL.PostgresError(
  'duplicate key value violates unique constraint "ux_users_email"',
  {
    code: 'ERR_POSTGRES_SERVER_ERROR',
    errno: '23505',
    constraint: 'ux_users_email',
  }
);
const pgErr = serializeForLog(driverPgError);
check(
  'SQLSTATE in errno kept on a real PostgresError',
  has(pgErr, '23505'),
  pgErr
);
check('constraint name kept alongside it', has(pgErr, 'ux_users_email'), pgErr);

// `errno` joined the shape-checked set, so it must be gated exactly like `code`:
// a six-digit OTP smuggled in under that key is still redacted.
const otpShapedErrno = serializeForLog(
  Object.assign(new Error('boom'), { errno: '123456' })
);
check(
  'OTP-shaped errno redacted on Error',
  !has(otpShapedErrno, '123456'),
  otpShapedErrno
);

// Node spells the same key as a negative integer; the numeric branch keeps it.
const nodeErrno = serializeForLog(
  Object.assign(new Error('ENOENT'), { code: 'ENOENT', errno: -4058 })
);
check('numeric Node errno kept', has(nodeErrno, '-4058'), nodeErrno);

// A parameter-bearing query error is reduced to allowlisted fields only, and
// `errno` had to be added to that allowlist too — otherwise a wrapped driver
// error logged a constraint with no code at all.
const wrappedDriverError = serializeForLog(
  new Error(
    'Failed query: insert into users (email) values ($1)\nparams: victim@example.com',
    {
      cause: driverPgError,
    }
  )
);
check(
  'SQLSTATE survives the query-error reduction',
  has(wrappedDriverError, '23505'),
  wrappedDriverError
);
check(
  'bound parameter still withheld from the wrapped driver error',
  !has(wrappedDriverError, 'victim@example.com'),
  wrappedDriverError
);

// ── Drizzle parameter-bearing error still withheld ────────────────────
const queryErr = serializeForLog(
  Object.assign(
    new Error(
      'Failed query: select * from sessions where token = $1\nparams: st_live_SENTINEL'
    ),
    { code: '42P01' }
  )
);
check(
  'query error params withheld',
  !has(queryErr, 'st_live_SENTINEL') && has(queryErr, 'withheld'),
  queryErr
);

// ── prototype-pollution key ───────────────────────────────────────────
const proto: Record<string, unknown> = {};
Object.defineProperty(proto, '__proto__', {
  value: 'polluted',
  enumerable: true,
  configurable: true,
});
const protoOut = serializeForLog(proto);
check(
  '__proto__ recorded as a field, prototype untouched',
  has(protoOut, 'polluted') &&
    ({} as Record<string, unknown>).polluted === undefined,
  protoOut
);

// ── control chars / log forging ───────────────────────────────────────
const forged = serializeForLog({ msg: 'a\nFAKE: injected\r\nb' });
check('newlines stripped', !forged.includes('\n') && !forged.includes('\r'));

// ── KNOWN RESIDUAL: free text is not reachable by a key-based rule ────
const freeText = serializeForLog(new Error('provider payload SENTINEL_TOKEN'));
console.log(
  `NOTE  free-text residual (by design, documented): message retained = ${has(
    freeText,
    'SENTINEL_TOKEN'
  )}`
);
