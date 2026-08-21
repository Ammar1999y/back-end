/**
 * Production guard for `BETTER_AUTH_SECRET` (`lib/env.server.ts`).
 *
 * Each case runs in a SUBPROCESS with `--no-env-file`, so the repository `.env`
 * cannot make a "missing value" case pass by accident — that would have made
 * every negative assertion here vacuous. The subprocess also isolates the
 * module-load-time throw, which is the guard's actual contract.
 *
 * Local: no database, no network.
 */
import { expect, test } from 'bun:test';

const RUNNER = 'scripts/probe/local/_env-secret-child.ts';

/** 40 chars, no whitespace, not the library default. */
const VALID = 'Kq7vT2mXp9wLd4bR8nZc1yHj5sGf3aEu6tVi0oPk';
const LIBRARY_DEFAULT = 'better-auth-secret-12345678901234567890';

// A real unpadded base64url encoding of 32 bytes — the pepper module validates
// the decoded length, so a string of the right length is not enough.
const PEPPER_SECRET = Buffer.alloc(32, 7).toString('base64url');

const REQUIRED = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  PASSWORD_PEPPER_ACTIVE_ID: '1',
  PASSWORD_PEPPER_KEYRING: `{"1":{"generation":1,"secret":"${PEPPER_SECRET}"}}`,
  // The OTP MAC keyring, validated at load beside the pepper. Same 32-byte
  // base64url rule — `lib/auth/keyring.ts` parses both.
  OTP_HMAC_ACTIVE_ID: '1',
  OTP_HMAC_KEYRING: `{"1":{"generation":1,"secret":"${PEPPER_SECRET}"}}`,
  TURNSTILE_SECRET_KEY: 'turnstile',
  // Production-required since the move off Upstash: SQLITE_DIR has no default in
  // production (an unmounted volume must not boot silently) and the maintenance
  // token gates the sweep endpoint. Absolute path, because production rejects a
  // relative one; nothing here opens the file.
  SQLITE_DIR: '/tmp/env-secret-probe',
  SQLITE_MAINTENANCE_TOKEN: 'probe-token',
  NODE_ENV: 'production',
};

async function run(
  secretEnv: Record<string, string>
): Promise<{ ok: boolean; message: string }> {
  const proc = Bun.spawn(['bun', '--no-env-file', RUNNER], {
    env: { ...REQUIRED, ...secretEnv, PATH: process.env.PATH ?? '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const trimmed = out.trim();
  return { ok: trimmed === 'LOADED', message: trimmed };
}

test('a valid secret is accepted', async () => {
  const r = await run({ BETTER_AUTH_SECRET: VALID });
  expect(r.ok).toBe(true);
}, 30_000);

test('a missing secret is rejected', async () => {
  const r = await run({});
  expect(r.ok).toBe(false);
  expect(r.message).toContain('BETTER_AUTH_SECRET');
}, 30_000);

test('a whitespace-only secret is rejected', async () => {
  const r = await run({ BETTER_AUTH_SECRET: ' '.repeat(3) });
  expect(r.ok).toBe(false);
}, 30_000);

test('surrounding whitespace is rejected, not trimmed', async () => {
  const r = await run({ BETTER_AUTH_SECRET: ` ${VALID} ` });
  expect(r.ok).toBe(false);
  expect(r.message).toContain('whitespace');
}, 30_000);

test('the exact library default is rejected', async () => {
  const r = await run({ BETTER_AUTH_SECRET: LIBRARY_DEFAULT });
  expect(r.ok).toBe(false);
  expect(r.message).toContain('default');
}, 30_000);

test('the library default with padding is rejected', async () => {
  const r = await run({ BETTER_AUTH_SECRET: `  ${LIBRARY_DEFAULT}  ` });
  expect(r.ok).toBe(false);
}, 30_000);

test('a too-short secret is rejected', async () => {
  const r = await run({ BETTER_AUTH_SECRET: 'x'.repeat(31) });
  expect(r.ok).toBe(false);
  expect(r.message).toContain('32');
}, 30_000);

test('a 1-character secret is rejected', async () => {
  const r = await run({ BETTER_AUTH_SECRET: 'x' });
  expect(r.ok).toBe(false);
}, 30_000);

test('AUTH_SECRET alone does not satisfy the contract', async () => {
  const r = await run({ AUTH_SECRET: VALID });
  expect(r.ok).toBe(false);
  expect(r.message).toContain('BETTER_AUTH_SECRET');
}, 30_000);

test('BETTER_AUTH_SECRETS is rejected even alongside a valid secret', async () => {
  const r = await run({
    BETTER_AUTH_SECRET: VALID,
    BETTER_AUTH_SECRETS: `1:${VALID}`,
  });
  expect(r.ok).toBe(false);
  expect(r.message).toContain('BETTER_AUTH_SECRETS');
}, 30_000);

test('no rejection message contains the secret value', async () => {
  // Explicitly typed: inferring a union across these entries gives the ones
  // without `BETTER_AUTH_SECRETS` an optional property of type `undefined`,
  // which is not assignable to `run`'s `Record<string, string>`.
  const cases: Array<Record<string, string>> = [
    { BETTER_AUTH_SECRET: ` ${VALID} ` },
    { BETTER_AUTH_SECRET: 'x'.repeat(31) },
    { BETTER_AUTH_SECRET: LIBRARY_DEFAULT },
    { BETTER_AUTH_SECRET: VALID, BETTER_AUTH_SECRETS: `1:${VALID}` },
  ];
  for (const env of cases) {
    const r = await run(env);
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain(VALID);
    // A prefix slice would be just as bad as the whole value.
    expect(r.message).not.toContain(VALID.slice(0, 8));
    expect(r.message).not.toContain(LIBRARY_DEFAULT);
  }
}, 60_000);
