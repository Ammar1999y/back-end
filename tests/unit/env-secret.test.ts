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
/* eslint-disable security/detect-non-literal-fs-filename, security/detect-non-literal-regexp --
   the path and the pattern are module-scope constants in this file, never input */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const RUNNER = 'tests/fixtures/_env-secret-child.ts';
const ENV_SERVER = 'lib/env.server.ts';

/**
 * Pulls a `const NAME = [...] as const;` string array out of a module's source.
 *
 * The house pattern (`sqlite-semantics.test.ts` extracts production SQL the same
 * way) and the reason is this file's own history: the `REQUIRED` map below used
 * to be a hand-written mirror of `lib/env.server.ts`'s required-variable list,
 * and it had already drifted — a variable added there is one this suite would
 * keep passing without, because every case here would then fail for the missing
 * variable rather than for the secret under test, which is the same colour of
 * red.
 *
 * A failed extraction is a hard failure, not a skip.
 */
function extractStringArray(file: string, name: string): string[] {
  const source = readFileSync(file, 'utf8');
  const match = source.match(
    new RegExp(String.raw`const ${name} = \[([^\]]*)\]`)
  );
  if (!match?.[1])
    throw new Error(
      `could not extract ${name} from ${file}. If it was renamed, update this ` +
        'test rather than inlining a copy of the list.'
    );
  return match[1]
    .matchAll(/'([^']+)'/g)
    .map((m) => m[1] as string)
    .toArray();
}

const REQUIRED_ALWAYS = extractStringArray(ENV_SERVER, 'REQUIRED_SERVER_ENV');
const REQUIRED_IN_PRODUCTION = extractStringArray(
  ENV_SERVER,
  'REQUIRED_IN_PRODUCTION'
);

/** 40 chars, no whitespace, not the library default. */
const VALID = 'Kq7vT2mXp9wLd4bR8nZc1yHj5sGf3aEu6tVi0oPk';
const LIBRARY_DEFAULT = 'better-auth-secret-12345678901234567890';

// A real unpadded base64url encoding of 32 bytes — the pepper module validates
// the decoded length, so a string of the right length is not enough.
const PEPPER_SECRET = Buffer.alloc(32, 7).toString('base64url');

/**
 * A satisfying value per variable name, so the environment handed to the child
 * can be BUILT from the extracted lists instead of mirroring them.
 *
 * The keyrings share one 32-byte base64url secret — `lib/auth/keyring.ts` parses
 * both and validates the decoded length, so a string of the right character count
 * is not enough.
 */
const SATISFYING_VALUE: Record<string, string> = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  PASSWORD_PEPPER_ACTIVE_ID: '1',
  PASSWORD_PEPPER_KEYRING: `{"1":{"generation":1,"secret":"${PEPPER_SECRET}"}}`,
  OTP_HMAC_ACTIVE_ID: '1',
  OTP_HMAC_KEYRING: `{"1":{"generation":1,"secret":"${PEPPER_SECRET}"}}`,
  TURNSTILE_SECRET_KEY: 'turnstile',
};

/**
 * Not in either extracted list, and deliberately: `SQLITE_DIR` has no production
 * default (an unmounted volume must not boot silently) and the maintenance token
 * is enforced at the route rather than at load. Both still have to be present for
 * the module to evaluate under `NODE_ENV=production`. Absolute path, because
 * production rejects a relative one; nothing here opens the file.
 */
const ALSO_NEEDED_IN_PRODUCTION = {
  SQLITE_DIR: '/tmp/env-secret-probe',
  SQLITE_MAINTENANCE_TOKEN: 'probe-token',
};

/**
 * Every required variable satisfied EXCEPT the secret under test.
 *
 * Derived from the source, so a variable added to `REQUIRED_SERVER_ENV` without a
 * value here fails the guard test below by name rather than turning every case in
 * this file into a false negative.
 */
const REQUIRED: Record<string, string> = {
  ...Object.fromEntries(
    [...REQUIRED_ALWAYS, ...REQUIRED_IN_PRODUCTION].map((key) => [
      key,
      SATISFYING_VALUE[key] ?? '',
    ])
  ),
  ...ALSO_NEEDED_IN_PRODUCTION,
  NODE_ENV: 'production',
};

test('the extracted required-env lists are all covered by a value here', () => {
  // The guard that makes the derivation load-bearing. Without it a new required
  // variable would silently get an empty string, every case below would fail on
  // "Missing required server env var: NEW_ONE", and the suite would still look
  // like it was testing BETTER_AUTH_SECRET.
  const uncovered = [...REQUIRED_ALWAYS, ...REQUIRED_IN_PRODUCTION].filter(
    (key) => !SATISFYING_VALUE[key]
  );
  expect(uncovered).toEqual([]);
  // And the lists really were read, rather than defaulted to empty.
  expect(REQUIRED_ALWAYS.length).toBeGreaterThan(0);
  expect(REQUIRED_IN_PRODUCTION.length).toBeGreaterThan(0);
});

test('a valid environment plus a valid secret loads, so the base is honest', async () => {
  // The positive control for every negative case below: if this fails, the
  // rejections prove nothing about the secret.
  const r = await run({ BETTER_AUTH_SECRET: VALID });
  expect(r.message).toBe('LOADED');
}, 30_000);

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
