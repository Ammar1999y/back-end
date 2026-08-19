/**
 * Probe for the log serializer (C-05).
 *
 * Asserts the redaction rule still hides secrets, no longer eats ordinary
 * diagnostics, and records — rather than pretends to fix — the residual
 * free-text limitation.
 */
import { serializeForLog } from '@/utils';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  // eslint-disable-next-line unicorn/no-top-level-assignment-in-function -- module-scope tally: the check() helper is its only writer and the exit code at the end of the file is its only reader
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`
  );
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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
// eslint-disable-next-line unicorn/no-process-exit -- CLI probe: the exit code is how it reports pass/fail, the case the rule excepts
process.exit(failures === 0 ? 0 : 1);
