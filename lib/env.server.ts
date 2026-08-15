/* eslint-disable unicorn/no-top-level-side-effects -- the load-time crash IS this module's contract */
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
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
] as const;

// Vars that are only required outside development. The Turnstile module falls
// back to a Cloudflare-published TEST_SECRET_KEY in dev; keeping that path
// usable lets local contributors run without provisioning every credential.
const REQUIRED_IN_PRODUCTION = ['TURNSTILE_SECRET_KEY'] as const;

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
 * Better Auth does reject a missing/default secret itself, but during
 * `next build` that rejection prints while the build still exits 0 — so a
 * deployment can be produced without one. This is what makes it fatal.
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
validatePasswordPepperConfiguration();

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
export const UPSTASH_REDIS_REST_URL = requireEnv('UPSTASH_REDIS_REST_URL');
export const UPSTASH_REDIS_REST_TOKEN = requireEnv('UPSTASH_REDIS_REST_TOKEN');
