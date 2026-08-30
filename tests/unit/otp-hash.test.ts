/**
 * The OTP MAC primitive (`lib/auth/otp-hash.ts`) and the keyring it reads
 * (`lib/auth/keyring.ts`).
 *
 * Covers the three things that would fail silently: a malformed stored value
 * must be REJECTED rather than throw (a throw is a 500, and an error-shaped
 * response is an oracle), a code hashed under a retained-but-not-active key must
 * still verify (that is what makes rotation possible), and the legacy Argon2id
 * envelope must still verify while in-flight codes expire.
 *
 * Runs in a SUBPROCESS per keyring configuration: the keyring memoises its parse
 * on first use, so two different `OTP_HMAC_KEYRING` values cannot be exercised
 * in one process. `--no-env-file` so the repository `.env` cannot make a case
 * pass by supplying a key the case meant to omit.
 *
 * Local: no database, no network.
 */
import { expect, test } from 'bun:test';

const RUNNER = 'tests/fixtures/_otp-hash-child.ts';

const KEY_A = Buffer.alloc(32, 11).toString('base64url');
const KEY_B = Buffer.alloc(32, 22).toString('base64url');

const PEPPER = Buffer.alloc(32, 7).toString('base64url');

/** `lib/auth/password.ts` is imported by the module under test, so its keyring must parse. */
const BASE_ENV = {
  PASSWORD_PEPPER_ACTIVE_ID: 'p1',
  PASSWORD_PEPPER_KEYRING: `{"p1":{"generation":1,"secret":"${PEPPER}"}}`,
  PATH: process.env.PATH ?? '',
};

async function run(
  env: Record<string, string>,
  argv: string[]
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(['bun', '--no-env-file', RUNNER, ...argv], {
    env: { ...BASE_ENV, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out.trim(), err: err.trim() };
}

const ONE_KEY = {
  OTP_HMAC_ACTIVE_ID: 'a',
  OTP_HMAC_KEYRING: `{"a":{"generation":1,"secret":"${KEY_A}"}}`,
};

/** `b` is active; `a` is retained, which is the state mid-rotation. */
const TWO_KEYS = {
  OTP_HMAC_ACTIVE_ID: 'b',
  OTP_HMAC_KEYRING: `{"a":{"generation":1,"secret":"${KEY_A}"},"b":{"generation":2,"secret":"${KEY_B}"}}`,
};

test('correct code verifies, wrong code does not', async () => {
  const { code, out, err } = await run(ONE_KEY, ['roundtrip']);
  expect(err).toBe('');
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ match: true, mismatch: false });
});

test('envelope records the active key id', async () => {
  const { out } = await run(ONE_KEY, ['envelope']);
  expect(JSON.parse(out).stored).toStartWith('o1:a:');
});

test('a code hashed under a retired-but-retained key still verifies', async () => {
  // The whole point of the keyring: hash under `a`, rotate the active key to
  // `b`, and the in-flight code must still verify.
  const hashed = await run(ONE_KEY, ['envelope']);
  const stored = JSON.parse(hashed.out).stored as string;

  const { out } = await run(TWO_KEYS, ['verify', stored]);
  expect(JSON.parse(out)).toEqual({ valid: true });
});

test('a code whose key was REMOVED throws rather than reporting a wrong code', async () => {
  // A removed generation is an operator error, and it must be loud. Reporting
  // "wrong code" instead would send every affected user round the resend loop
  // while the logs stayed clean.
  const hashed = await run(TWO_KEYS, ['envelope']);
  const stored = JSON.parse(hashed.out).stored as string;
  expect(stored).toStartWith('o1:b:');

  const { code, err } = await run(ONE_KEY, ['verify', stored]);
  expect(code).not.toBe(0);
  expect(err).toContain('no key is configured for stored key ID "b"');
});

test('a removed key makes the stored value UNEVALUABLE, which is what the verify boundary reads', async () => {
  // The same configuration error as the test above, asked as a question instead
  // of surfaced as a throw. `processOtpVerify` asks this first: letting
  // `verifyOtpCode` throw rolled the transaction back into a 500 on the two
  // ANONYMOUS verification endpoints, while an unknown identifier took the
  // generic 400 — so a mis-timed rotation distinguished a real live proof from a
  // nonexistent account. It answers "invalid or expired" now, which is the truth.
  const hashed = await run(TWO_KEYS, ['envelope']);
  const stored = JSON.parse(hashed.out).stored as string;

  const present = await run(TWO_KEYS, ['evaluable', stored]);
  expect(JSON.parse(present.out)).toEqual({ evaluable: true });

  const removed = await run(ONE_KEY, ['evaluable', stored]);
  expect(removed.code).toBe(0);
  expect(JSON.parse(removed.out)).toEqual({ evaluable: false });
});

test.each([
  ['empty', ''],
  ['no envelope', 'deadbeef'],
  ['wrong version', 'o2:a:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  ['too few segments', 'o1:a'],
])(
  'a malformed stored value is EVALUABLE (%s), so it stays a wrong code rather than a 500',
  async (_label, stored) => {
    // The boundary between the two answers: only a missing key generation is
    // unevaluable. A corrupted row must keep taking the ordinary
    // wrong-code path, which `verifyOtpCode` already gives it.
    const { code, out } = await run(TWO_KEYS, ['evaluable', stored]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ evaluable: true });
  }
);

test.each([
  ['empty', ''],
  ['no envelope', 'deadbeef'],
  ['wrong version', 'o2:a:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  ['too few segments', 'o1:a'],
  ['too many segments', 'o1:a:AAAA:extra'],
  ['empty key id', 'o1::AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  ['mac too short', 'o1:a:AAAA'],
  ['mac not base64url', 'o1:a:!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!'],
  [
    'key id out of charset',
    'o1:a b:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  ],
])('malformed stored value (%s) is rejected, not thrown', async (_, stored) => {
  const { code, out, err } = await run(ONE_KEY, ['verify', stored]);
  expect(err).toBe('');
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ valid: false });
});

test('a legacy p1 Argon2id envelope still verifies', async () => {
  // Codes issued by the previous build must survive the deploy that swapped the
  // primitive; they expire on their own within OTP_EXPIRY_MINUTES.
  const { code, out, err } = await run(ONE_KEY, ['legacy']);
  expect(err).toBe('');
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ match: true, mismatch: false });
});

test('a missing OTP keyring fails at load, naming the variable', async () => {
  const { code, err } = await run({ OTP_HMAC_ACTIVE_ID: 'a' }, ['roundtrip']);
  expect(code).not.toBe(0);
  expect(err).toContain('OTP_HMAC_KEYRING is required');
});

test('an active id absent from the keyring fails at load', async () => {
  const { code, err } = await run(
    {
      OTP_HMAC_ACTIVE_ID: 'missing',
      OTP_HMAC_KEYRING: `{"a":{"generation":1,"secret":"${KEY_A}"}}`,
    },
    ['roundtrip']
  );
  expect(code).not.toBe(0);
  expect(err).toContain(
    'OTP_HMAC_ACTIVE_ID must identify a key present in OTP_HMAC_KEYRING'
  );
});

test('two keys sharing one generation fail at load', async () => {
  // Generation is what answers "is this hash stale", so a shared one makes that
  // unanswerable. Shared with the password pepper via lib/auth/keyring.ts.
  const { code, err } = await run(
    {
      OTP_HMAC_ACTIVE_ID: 'a',
      OTP_HMAC_KEYRING: `{"a":{"generation":1,"secret":"${KEY_A}"},"b":{"generation":1,"secret":"${KEY_B}"}}`,
    },
    ['roundtrip']
  );
  expect(code).not.toBe(0);
  expect(err).toContain('cannot share generation 1');
});

test('a secret that is not 32 decoded bytes fails at load', async () => {
  const { code, err } = await run(
    {
      OTP_HMAC_ACTIVE_ID: 'a',
      OTP_HMAC_KEYRING: `{"a":{"generation":1,"secret":"${Buffer.alloc(16, 1).toString('base64url')}"}}`,
    },
    ['roundtrip']
  );
  expect(code).not.toBe(0);
  expect(err).toContain('exactly 32 bytes');
});
