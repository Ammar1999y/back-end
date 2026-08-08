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

function assertEnv(): void {
  const missing: string[] = [];

  for (const key of REQUIRED_SERVER_ENV)
    if (!process.env[key]) missing.push(key);

  if (process.env.NODE_ENV === 'production')
    for (const key of REQUIRED_IN_PRODUCTION)
      if (!process.env[key]) missing.push(key);

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
