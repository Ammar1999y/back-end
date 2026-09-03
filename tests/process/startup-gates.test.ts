/**
 * `server.ts`'s fail-closed admission checks, and the shutdown coordinator they
 * guard — neither of which had a single assertion anywhere.
 *
 * These are the process's ONLY fail-closed admission gates, and they exist
 * because of a recorded incident the file documents itself: `NODE_ENV=prodution`
 * silently disabled the Better Auth secret floor, the Turnstile requirement, the
 * absolute-`SQLITE_DIR` rule and HSTS at once while the server still booted and
 * served traffic. Weakening any of them — deleting `VALID_NODE_ENV`, turning
 * `requireNodeEnv` from `fail` into a warning — left every other gate green:
 * lint, `format:check`, `build`, all three test tiers, `find-unused-files`,
 * knip, `dedupe`, and `smoke`, which always passes a valid `NODE_ENV`. A
 * fail-closed guard that is never exercised regresses to fail-open silently.
 *
 * Spawned, not imported: the checks run at module scope before `./app` is
 * dynamically imported, so the only way to observe them is a real process and a
 * real exit code.
 *
 * Every case below runs with `--no-env-file` and an environment built from
 * scratch, so a developer's `.env` cannot satisfy a variable the case is
 * deliberately withholding.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.join(import.meta.dir, '..', '..');
const SERVER = 'server.ts';

/** Ports well above the smoke test's 3999 and out of the ephemeral range. */
const BOOT_PORT = 39_411;

const created: string[] = [];

function tempSqliteDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'startup-gates-'));
  created.push(dir);
  return dir;
}

afterAll(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
    } catch {
      // Windows can hold a just-closed SQLite handle; a leftover temp directory
      // must not fail the assertion.
    }
  }
});

/**
 * A minimally valid environment: enough for `server.ts` to reach `app.listen`.
 *
 * `DATABASE_URL` points at an unreachable host on purpose — `bun:sql` connects
 * lazily, so a boot needs no database, and depending on one would make these
 * cases fail for a reason that has nothing to do with the gate under test.
 */
function baseEnv(sqliteDir: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    ...(process.env.SystemRoot && { SystemRoot: process.env.SystemRoot }),
    ...(process.env.ComSpec && { ComSpec: process.env.ComSpec }),
    ...(process.env.TEMP && { TEMP: process.env.TEMP }),
    ...(process.env.TMP && { TMP: process.env.TMP }),
    NODE_ENV: 'development',
    PORT: String(BOOT_PORT),
    PUBLIC_URL: `http://localhost:${BOOT_PORT}`,
    DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
    SQLITE_DIR: sqliteDir,
    NEXT_PUBLIC_ENABLED_OTP_CHANNELS: 'email',
    SMTP_USER: 'startup-gates@example.invalid',
    SMTP_PASS: 'throwaway',
    // Real 32-byte base64url values: the keyring validates the DECODED length,
    // so a 43-character run of an arbitrary character is not automatically
    // valid — its final character has to leave the trailing bits clear.
    PASSWORD_PEPPER_ACTIVE_ID: 'g',
    PASSWORD_PEPPER_KEYRING: JSON.stringify({
      g: {
        generation: 1,
        secret: Buffer.alloc(32, 0x11).toString('base64url'),
      },
    }),
    OTP_HMAC_ACTIVE_ID: 'g',
    OTP_HMAC_KEYRING: JSON.stringify({
      g: {
        generation: 1,
        secret: Buffer.alloc(32, 0x22).toString('base64url'),
      },
    }),
  };
}

/** The extra variables `lib/env.server.ts` requires outside development. */
function productionEnv(sqliteDir: string): Record<string, string> {
  return {
    ...baseEnv(sqliteDir),
    NODE_ENV: 'production',
    // Localhost is exempt from the https rule in `lib/env.ts`, which is what
    // lets a production-posture boot run on a CI runner at all.
    PUBLIC_URL: `http://localhost:${BOOT_PORT}`,
    BETTER_AUTH_SECRET: 'startup-gates-placeholder-secret-000000',
    TURNSTILE_SECRET_KEY: 'throwaway',
    R2_ACCOUNT_ID: 'throwaway',
    R2_ACCESS_KEY_ID: 'throwaway',
    R2_SECRET_ACCESS_KEY: 'throwaway',
    R2_PUBLIC_BUCKET: 'throwaway',
    R2_PRIVATE_BUCKET: 'throwaway',
  };
}

interface Outcome {
  exitCode: number | null;
  output: string;
}

/** Spawns `bun server.ts`, kills it if it ever listens, and returns its output. */
async function bootWith(
  env: Record<string, string>,
  options: { expectListen?: boolean } = {}
): Promise<Outcome> {
  const child = Bun.spawn(['bun', '--no-env-file', SERVER], {
    cwd: REPO_ROOT,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const collected = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  // A rejected boot exits on its own. A boot that is EXPECTED to reject but
  // does not would otherwise hang the suite on a listening server, so the wait
  // is bounded and the process is killed either way.
  const timedOut = Symbol('boot-timeout');
  const raced = await Promise.race([
    child.exited,
    Bun.sleep(options.expectListen ? 20_000 : 30_000).then(() => timedOut),
  ]);
  if (raced === timedOut) child.kill();

  const [stdout, stderr] = await collected;
  const exitCode = await child.exited;
  return { exitCode, output: `${stdout}\n${stderr}` };
}

function rejectionReason(output: string): string | null {
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { msg?: unknown }).msg === 'startup rejected'
      )
        return String((parsed as { reason?: unknown }).reason);
    } catch {
      // Not a JSON log line.
    }
  }
  return null;
}

describe('the runtime gates refuse a bad configuration', () => {
  test.each([
    ['NODE_ENV absent', { NODE_ENV: undefined }, /NODE_ENV is not set/],
    ['NODE_ENV empty', { NODE_ENV: '' }, /NODE_ENV is not set/],
    // The exact incident: one transposed letter turned four production security
    // controls off while the server booted and served traffic.
    [
      'NODE_ENV misspelled',
      { NODE_ENV: 'prodution' },
      /NODE_ENV must be exactly one of/,
    ],
    ['NODE_ENV out of set', { NODE_ENV: 'staging' }, /NODE_ENV must be/],
    // `Number(process.env.PORT)` accepted every one of these, and Bun then bound
    // an ephemeral or clamped port while the startup log reported the requested
    // value.
    ['PORT zero', { PORT: '0' }, /PORT must be between 1 and 65535/],
    ['PORT over range', { PORT: '70000' }, /PORT must be between 1 and 65535/],
    [
      'PORT trailing text',
      { PORT: '3000abc' },
      /PORT must be a decimal integer/,
    ],
    ['PORT fractional', { PORT: '3000.5' }, /PORT must be a decimal integer/],
  ])(
    '%s exits non-zero with a reason',
    async (_label, overrides, expected) => {
      const env = { ...baseEnv(tempSqliteDir()), ...overrides } as Record<
        string,
        string
      >;
      for (const [key, value] of Object.entries(overrides))
        if (value === undefined) delete env[key];

      const outcome = await bootWith(env);

      expect(outcome.exitCode).not.toBe(0);
      expect(rejectionReason(outcome.output)).toMatch(expected);
    },
    60_000
  );

  // The empty-PORT case, the Bun floor and the SQLite floor are asserted in
  // `tests/unit/startup-gates-logic.test.ts` instead, against
  // `utils/startup.ts`. Not a downgrade in either case, and the reasons differ:
  //
  // - A child cannot vary the running Bun or the SQLite compiled into it, so
  //   those two gates had NO assertion here — only a boot that happened to pass
  //   them. A pure-function case can drive both sides of each floor.
  // - The empty-PORT case ran a child that really bound the 3000 default, so it
  //   failed with `EADDRINUSE` on any machine running `bun run dev`, for a
  //   reason unrelated to the gate — and it cost a fixed 20 s wait every run,
  //   because the child it expected to keep listening never exits.
  //
  // What stays here is what only a real process can show: that a refusal
  // actually ends the process non-zero before anything serves.
});

describe('the production environment gate refuses a missing variable', () => {
  test('an unset R2 bucket fails the boot rather than the first upload', async () => {
    // `REQUIRED_IN_PRODUCTION` is enforced at module load, and this whole branch
    // — plus `betterAuthSecretError` — was unreachable from any whole-process
    // check, because the only one there is boots in development.
    const env = productionEnv(tempSqliteDir());
    delete env.R2_PUBLIC_BUCKET;

    const outcome = await bootWith(env);

    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.output).toInclude('R2_PUBLIC_BUCKET');
  }, 60_000);

  test('the Better Auth default secret fails the boot', async () => {
    const outcome = await bootWith({
      ...productionEnv(tempSqliteDir()),
      BETTER_AUTH_SECRET: 'better-auth-secret-12345678901234567890',
    });

    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.output).toInclude('BETTER_AUTH_SECRET');
  }, 60_000);

  test('an enabled OTP channel with no provider credentials fails the boot', async () => {
    // Otherwise the deploy starts, passes storage readiness, and then ACCEPTS
    // and PERSISTS every send request before delivery fails — with recovery and
    // passwordless login both unusable.
    const env = productionEnv(tempSqliteDir());
    delete env.SMTP_PASS;

    const outcome = await bootWith(env);

    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.output).toInclude('SMTP_PASS');
  }, 60_000);

  test('the OTP test outbox fails a production boot', async () => {
    // `OTP_DELIVERY=outbox` makes every send succeed and deliver nothing. It
    // exists for the matrix tier, and a production process must refuse it for
    // the same reason it refuses an enabled channel with no credentials.
    const outcome = await bootWith({
      ...productionEnv(tempSqliteDir()),
      OTP_DELIVERY: 'outbox',
    });

    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.output).toInclude('OTP_DELIVERY');
  }, 60_000);

  test('a relative SQLITE_DIR fails the boot', async () => {
    const outcome = await bootWith({
      ...productionEnv(tempSqliteDir()),
      SQLITE_DIR: './data',
    });

    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.output).toInclude('SQLITE_DIR');
  }, 60_000);
});

describe('the OTP channel list is parsed strictly, in every environment', () => {
  // `parseEnvChannels` throws at module load — NOT behind a production guard,
  // and that is the point: an unknown entry used to be filtered out and the
  // resulting empty set read as "OTP intentionally disabled", so
  // `NEXT_PUBLIC_ENABLED_OTP_CHANNELS=emial` logged a notice and answered 404
  // from every OTP surface in a deployment that passed every other boot check.
  //
  // The cost of that strictness is that a trailing comma now fails a DEVELOPMENT
  // boot and a test run too. These cases pin that as intended rather than as an
  // accident nobody meant to ship.
  test.each([
    ['a misspelled channel', 'emial', /unknown channel "emial"/],
    ['a duplicate entry', 'email,email', /lists "email" more than once/],
    ['a trailing comma', 'email,', /contains an empty entry/],
    ['a blank entry', 'email,,sms', /contains an empty entry/],
    ['whitespace only', 'email, ,sms', /contains an empty entry/],
  ])(
    '%s fails the boot',
    async (_label, channels, expected) => {
      const outcome = await bootWith({
        ...baseEnv(tempSqliteDir()),
        NEXT_PUBLIC_ENABLED_OTP_CHANNELS: channels,
      });

      expect(outcome.exitCode).not.toBe(0);
      expect(outcome.output).toMatch(expected);
    },
    60_000
  );

  // The passing case is not repeated here: every other boot in this file — the
  // production-posture one and the SIGTERM one — runs with `baseEnv`'s
  // `NEXT_PUBLIC_ENABLED_OTP_CHANNELS: 'email'` and listens, so a parse that
  // refused a supported list would fail those instead. A case that boots
  // successfully costs this file the full spawn timeout, because a listening
  // child never exits.
});

describe('the two-factor configuration is parsed strictly, in every environment', () => {
  // Same posture as the OTP channel list above and for the same reason: an
  // unknown entry filtered to an empty set reads as "the feature is
  // intentionally off", which deploys a broken second factor that passes every
  // other boot check.
  test.each([
    ['a misspelled method', 'totp,bakcup_code', /unknown method "bakcup_code"/],
    ['a duplicate entry', 'totp,totp', /lists "totp" more than once/],
    ['a trailing comma', 'totp,', /contains an empty entry/],
  ])(
    '%s fails the boot',
    async (_label, methods, expected) => {
      const outcome = await bootWith({
        ...baseEnv(tempSqliteDir()),
        NEXT_PUBLIC_ENABLED_2FA_METHODS: methods,
      });

      expect(outcome.exitCode).not.toBe(0);
      expect(outcome.output).toMatch(expected);
    },
    60_000
  );

  test('enabling the OTP method with no channel fails the boot', async () => {
    // The method would be advertised in settings, enabled by users, and then
    // fail to deliver at their next sign-in — with no session left to fix it
    // from. Refusing the deploy is the only place this can still be corrected.
    const outcome = await bootWith({
      ...baseEnv(tempSqliteDir()),
      NEXT_PUBLIC_ENABLED_2FA_METHODS: 'otp',
      NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS: '',
    });

    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.output).toMatch(/NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS/);
  }, 60_000);

  test('a second factor that reuses the recovery contact WARNS and boots', async () => {
    // ⚠️ This used to fail the boot, and the refusal was the wrong control in
    // the wrong place. Disjointness is a property of the authentication CHAIN:
    // password recovery proves a second factor from a set that excludes the
    // contact its own code arrived on, and refuses outright when nothing
    // survives. Enforcing it again at configuration time only made a supported
    // deployment unstartable — the chain, not the environment, is what has to
    // hold the guarantee.
    //
    // The warning is still required: it names the population that will be sent
    // to the administrative reset.
    const dir = tempSqliteDir();
    const child = Bun.spawn(['bun', '--no-env-file', SERVER], {
      cwd: REPO_ROOT,
      env: {
        ...baseEnv(dir),
        PORT: String(BOOT_PORT + 7),
        NEXT_PUBLIC_ENABLED_OTP_CHANNELS: 'email',
        NEXT_PUBLIC_ENABLED_2FA_METHODS: 'otp',
        NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS: 'email',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      const deadline = Date.now() + 30_000;
      let listening = false;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) break;
        try {
          await fetch(`http://127.0.0.1:${BOOT_PORT + 7}/api/health/storage`);
          listening = true;
          break;
        } catch {
          await Bun.sleep(200);
        }
      }
      expect(listening).toBe(true);
    } finally {
      child.kill();
      await child.exited;
    }
    const output = await new Response(child.stderr).text();
    expect(output).toMatch(/twoFactor\.otpOverlapsRecovery/);
  }, 60_000);

  test('the same overlap is ALLOWED when another method exists', async () => {
    // The narrowness partner. `totp` is a real second factor that recovery
    // cannot reach, so the overlap no longer collapses anything and refusing it
    // would block a reasonable deployment.
    const dir = tempSqliteDir();
    const child = Bun.spawn(['bun', '--no-env-file', SERVER], {
      cwd: REPO_ROOT,
      env: {
        ...baseEnv(dir),
        PORT: String(BOOT_PORT + 3),
        NEXT_PUBLIC_ENABLED_OTP_CHANNELS: 'email',
        NEXT_PUBLIC_ENABLED_2FA_METHODS: 'totp,otp',
        NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS: 'email',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      // A boot that reaches the listening state has passed every module-load
      // gate. It is killed rather than probed: this asserts the configuration
      // is accepted, not what it then serves.
      const deadline = Date.now() + 30_000;
      let listening = false;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) break;
        try {
          await fetch(`http://127.0.0.1:${BOOT_PORT + 3}/api/health/storage`);
          listening = true;
          break;
        } catch {
          await Bun.sleep(250);
        }
      }
      expect(listening).toBe(true);
    } finally {
      child.kill();
      await child.exited;
    }
  }, 60_000);
});

describe('a production-posture boot serves the production header set', () => {
  test('HSTS is present, and every other security header keeps its value', async () => {
    // The positive HSTS case had no home: `tests/integration/security-headers.test.ts`
    // states it "belongs to the process tier, since `isProduction` is read at
    // module load", and carried only ABSENCE assertions; every spawning process
    // test passed `NODE_ENV: 'development'`, and so does CI's only whole-process
    // gate. A regression that drops HSTS or breaks a production-only module-load
    // path passed every gate and would be found by the first production request.
    const dir = tempSqliteDir();
    const child = Bun.spawn(['bun', '--no-env-file', SERVER], {
      cwd: REPO_ROOT,
      env: { ...productionEnv(dir), PORT: String(BOOT_PORT + 1) },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    try {
      const base = `http://127.0.0.1:${BOOT_PORT + 1}`;
      const deadline = Date.now() + 30_000;
      let response: Response | null = null;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) break;
        try {
          response = await fetch(`${base}/api/health/storage`);
          break;
        } catch {
          await Bun.sleep(250);
        }
      }
      if (!response)
        throw new Error(
          `production boot never answered (exit ${String(child.exitCode)})`
        );

      // Read from the child's own module load, not from this process's: the
      // header set is frozen at import time from `NODE_ENV`, and this test
      // process runs as `development`.
      expect(response.headers.get('strict-transport-security')).toBe(
        'max-age=63072000; includeSubDomains; preload'
      );
      expect(response.headers.get('content-security-policy')).toBe(
        "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
      );
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('referrer-policy')).toBe('strict-origin');

      // And the development-only route is genuinely unrouted here — 404 on every
      // method, with no `Allow` to confirm it exists.
      const dev = await fetch(`${base}/api/dev/sign-up`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(dev.status).toBe(404);
      expect(dev.headers.get('allow')).toBeNull();
    } finally {
      child.kill();
      await child.exited;
    }
  }, 90_000);
});

describe('the shutdown coordinator', () => {
  // SIGTERM is not deliverable on Windows — `subprocess.kill('SIGTERM')` there
  // terminates without running handlers — so the coordinator's own path can only
  // be observed on POSIX. It runs in CI, which is where this tier's
  // platform-specific cases are meant to run.
  const posixOnly = process.platform === 'win32' ? test.skip : test;

  posixOnly(
    'a clean SIGTERM stops the schedule, closes the stores, and exits 0',
    async () => {
      const dir = tempSqliteDir();
      const child = Bun.spawn(['bun', '--no-env-file', SERVER], {
        cwd: REPO_ROOT,
        env: { ...baseEnv(dir), PORT: String(BOOT_PORT + 2) },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const collected = Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      const base = `http://127.0.0.1:${BOOT_PORT + 2}`;
      const deadline = Date.now() + 30_000;
      let listening = false;
      while (Date.now() < deadline && child.exitCode === null) {
        try {
          await fetch(`${base}/api/health/storage`);
          listening = true;
          break;
        } catch {
          await Bun.sleep(250);
        }
      }
      expect(listening).toBe(true);

      child.kill('SIGTERM');
      const exitCode = await child.exited;
      const [stdout, stderr] = await collected;
      const output = `${stdout}\n${stderr}`;

      expect(exitCode).toBe(0);
      // ORDER, not just presence: the schedule has to stop before the stores it
      // writes to close, and `closeStores` runs only on positive proof that
      // nothing is still in flight.
      expect(
        output.indexOf('"msg":"maintenance schedule started"')
      ).toBeLessThan(output.indexOf('"msg":"server stopping"'));
      expect(output).toInclude('"msg":"server stopped"');
      expect(output).not.toInclude('stores left open for forced exit');
      expect(output).not.toInclude('"msg":"forced shutdown"');
      expect(output).not.toInclude('store close failed');
    },
    120_000
  );
});
