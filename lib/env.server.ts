/* eslint-disable unicorn/no-top-level-side-effects -- the load-time crash IS this module's contract */
import path from 'node:path';

import { validateOtpKeyConfiguration } from '@/lib/auth/otp-key';
import { validatePasswordPepperConfiguration } from '@/lib/auth/password-pepper';

/**
 * Hard-fail at module-load time when a required server env var is missing.
 *
 * Imported by every server-only module that depends on these values (auth,
 * DB, rate-limit, captcha, OTP) so a misconfigured production deploy crashes
 * during startup instead of intermittently failing on the first request that
 * hits an unset variable.
 */
const REQUIRED_SERVER_ENV = [
  'DATABASE_URL',
  'PASSWORD_PEPPER_ACTIVE_ID',
  'PASSWORD_PEPPER_KEYRING',
  // The OTP MAC key. Required unconditionally, like the pepper: without it every
  // OTP send throws at hash time, so a "start now, configure later" deployment
  // is a silently broken one.
  'OTP_HMAC_ACTIVE_ID',
  'OTP_HMAC_KEYRING',
] as const;

// Vars that are only required outside development. The Turnstile module falls
// back to a Cloudflare-published TEST_SECRET_KEY in dev; keeping that path
// usable lets local contributors run without provisioning every credential.

const REQUIRED_IN_PRODUCTION = [
  'TURNSTILE_SECRET_KEY',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  // The buckets too. Excluding them was justified on the claim that each is
  // "read at its point of use and raises an error naming itself" — which was
  // FALSE: `getBucketName` returned them unchecked, so an unset value reached
  // the AWS SDK as `Bucket: undefined`. It raises now, but a boot check is the
  // right boundary for a value that is pure deployment configuration: failing on
  // the first upload is failing in front of a user.
  'R2_PUBLIC_BUCKET',
  'R2_PRIVATE_BUCKET',
] as const;

/** The value Better Auth falls back to when no secret is configured. */
const BETTER_AUTH_DEFAULT_SECRET = 'better-auth-secret-12345678901234567890';

/**
 * Better Auth only WARNS below 32 characters and continues, so a one-character
 * secret would sign real sessions. This is a floor, not a strength test — no
 * regex can prove randomness, and trying would only reject valid keys.
 */
const BETTER_AUTH_SECRET_MIN_LENGTH = 32;

/**
 * This project's signing-secret contract: `BETTER_AUTH_SECRET`, and only that.
 *
 * Scope, precisely: the caller runs this ONLY when `NODE_ENV === 'production'`,
 * so every rule below — including the `BETTER_AUTH_SECRETS` rejection — applies
 * in production and is not evaluated in development.
 *
 * Better Auth also accepts a `BETTER_AUTH_SECRETS` keyring and an `AUTH_SECRET`
 * fallback. Neither is supported here — a dependency offering an input is not a
 * reason for this project to. Rotation would need its own deliberate design and
 * its own tests, so until then one name means one place to look.
 *
 * `BETTER_AUTH_SECRETS` is rejected rather than ignored: Better Auth gives the
 * keyring PRECEDENCE over the singular secret, so a stray value there would
 * silently take over signing from the variable this project validates.
 *
 * Better Auth does reject a missing/default secret itself, but only where it
 * is constructed — a build step that evaluates the module graph prints the
 * rejection and still exits 0, so a deployment can be produced without one.
 * This is what makes it fatal here instead.
 *
 * No environment value, or any slice of one, appears in these messages: build
 * logs are widely readable and a mistakenly pasted secret must not leak a
 * prefix. `betterAuth({secret})` is out of scope — `lib/auth.ts` passes none,
 * and if that changes this check has to move.
 */
function betterAuthSecretError(): string | null {
  if (process.env.BETTER_AUTH_SECRETS !== undefined)
    return 'BETTER_AUTH_SECRETS is not supported by this project (it would take precedence over BETTER_AUTH_SECRET). Unset it and use BETTER_AUTH_SECRET.';

  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret?.trim())
    return 'Missing required server env var: BETTER_AUTH_SECRET';

  // Rejected, not trimmed. Better Auth signs with the value verbatim, so padding
  // silently becomes part of the key — and comparing the untrimmed value against
  // the known default let a padded copy of it through.
  // eslint-disable-next-line security/detect-possible-timing-attacks -- compares the value against its own trimmed form at startup; no second party and no request path, so there is nothing to observe
  if (secret !== secret.trim())
    return 'BETTER_AUTH_SECRET has leading or trailing whitespace; remove it (the value is used verbatim as the signing key)';

  // eslint-disable-next-line security/detect-possible-timing-attacks -- not a credential comparison: both sides are public (the value is a published library placeholder), it runs once at startup, and it is never reached by a request, so there is no observable oracle
  if (secret === BETTER_AUTH_DEFAULT_SECRET)
    return 'BETTER_AUTH_SECRET is set to the Better Auth default value and must be replaced';

  if (secret.length < BETTER_AUTH_SECRET_MIN_LENGTH)
    return `BETTER_AUTH_SECRET must be at least ${BETTER_AUTH_SECRET_MIN_LENGTH} characters; generate one with "openssl rand -base64 32"`;

  return null;
}

function assertEnv(): void {
  const missing: string[] = [];

  for (const key of REQUIRED_SERVER_ENV)
    if (!process.env[key]) missing.push(key);

  if (process.env.NODE_ENV === 'production') {
    for (const key of REQUIRED_IN_PRODUCTION)
      if (!process.env[key]) missing.push(key);

    const secretError = betterAuthSecretError();
    if (secretError) throw new Error(secretError);
  }

  if (missing.length > 0)
    throw new Error(
      `Missing required server env var${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`
    );
}

assertEnv();
// Presence is not validity: `assertEnv` only proves the variables are set, and a
// keyring is a JSON document with rules. Both parses are forced here so a bad
// keyring crashes the boot rather than the first login or the first OTP send.
validatePasswordPepperConfiguration();
validateOtpKeyConfiguration();

/**
 * Re-reads a variable `assertEnv` has already proven present. The throw is
 * unreachable once this module has evaluated; it is what makes the `string`
 * return type honest, so consumers need no non-null assertion.
 */
function requireEnv(key: (typeof REQUIRED_SERVER_ENV)[number]): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required server env var: ${key}`);
  return value;
}

export const DATABASE_URL = requireEnv('DATABASE_URL');
/**
 * Directory holding the local SQLite databases.
 *
 * MUST be a Coolify persistent volume on real local disk. A container's writable
 * layer is not deployment persistence, and SQLite's WAL requires the `-shm` file,
 * which needs real mmap on a local filesystem. Never NFS or CIFS — file locking
 * there is unreliable and the failure mode is silent corruption, not an error.
 *
 * Required and absolute in production, with no fallback. A default would let a
 * missing variable or an unmounted volume boot successfully and write to the
 * container layer, where every redeploy silently resets the auth, API and daily
 * OTP counters — and the OTP one is a money cap. Failing to boot is the correct
 * response to that misconfiguration.
 *
 * NOTE the limit of this check: it proves the path is configured and absolute, not
 * that a volume is mounted there. SQLite will happily create the same path inside
 * the container. Only surviving a real redeploy proves persistence — see the
 * verification step in reports/coolify-deployment.md.
 */
function resolveSqliteDir(): string {
  const configured = process.env.SQLITE_DIR?.trim();

  if (!configured) {
    if (process.env.NODE_ENV === 'production')
      throw new Error(
        'Missing required server env var: SQLITE_DIR. It must be an absolute path ' +
          'to a persistent volume; see reports/coolify-deployment.md.'
      );
    return './data';
  }

  if (process.env.NODE_ENV === 'production' && !path.isAbsolute(configured))
    throw new Error(
      `SQLITE_DIR must be an absolute path in production, got: ${configured}`
    );

  return configured;
}

/**
 * Exported because `lib/sqlite/writer-lock.ts` asserts single-writer ownership of
 * this DIRECTORY, not of one database file inside it.
 */
export const SQLITE_DIR = resolveSqliteDir();

/** Rate-limit state: process-crash-safe, must survive deploys (the OTP cap). */
export const RATE_LIMIT_DB_PATH = path.join(SQLITE_DIR, 'rate-limit.db');

/** Response cache: disposable. Safe to delete, and safe to place on tmpfs. */
export const CACHE_DB_PATH = path.join(SQLITE_DIR, 'cache.db');

/**
 * A floor, on the same reasoning as `BETTER_AUTH_SECRET_MIN_LENGTH` and for a
 * sharper reason: `maintenanceTokenMatches` short-circuits on length before the
 * constant-time compare (it must — `timingSafeEqual` throws on a length
 * mismatch), so the token's exact LENGTH is recoverable before any content
 * guessing begins. A short token is therefore not merely weak, it is weak in a
 * measurable way. `SQLITE_MAINTENANCE_TOKEN=x` used to be accepted at boot.
 *
 * Validated here rather than added to `REQUIRED_IN_PRODUCTION` — the reason
 * above still holds, the variable stays optional, and an EMPTY value keeps
 * meaning "fail closed, and let the health check report it". Only a value that
 * is set and too short is rejected.
 */
const MAINTENANCE_TOKEN_MIN_LENGTH = 32;

function resolveMaintenanceToken(): string {
  const configured = process.env.SQLITE_MAINTENANCE_TOKEN ?? '';
  if (configured && configured.length < MAINTENANCE_TOKEN_MIN_LENGTH)
    throw new Error(
      `SQLITE_MAINTENANCE_TOKEN must be at least ${MAINTENANCE_TOKEN_MIN_LENGTH} characters ` +
        'when set; generate one with "openssl rand -base64 32". Leave it unset to disable ' +
        'the maintenance surface entirely.'
    );
  return configured;
}

/**
 * Shared secret for the deep storage check.
 *
 * Deliberately NOT in `REQUIRED_IN_PRODUCTION`. That list is enforced at module
 * load and `bun run build` evaluates the route graph, so requiring it there
 * would force the real secret into the build environment for a value only ever
 * used at runtime.
 *
 * Unset makes `?deep=1` answer 401, never "no auth required". Readiness
 * deliberately does NOT report whether it is set: unset is a supported
 * configuration, so failing readiness on it would pull a healthy container.
 */
export const SQLITE_MAINTENANCE_TOKEN = resolveMaintenanceToken();
