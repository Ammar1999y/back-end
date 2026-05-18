import 'server-only';

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
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
] as const;

// Vars that are only required outside development. The Turnstile module falls
// back to a Cloudflare-published TEST_SECRET_KEY in dev; keeping that path
// usable lets local contributors run without provisioning every credential.
const REQUIRED_IN_PRODUCTION = ['TURNSTILE_SECRET_KEY'] as const;

function assertEnv(): void {
  const missing: string[] = [];

  for (const key of REQUIRED_SERVER_ENV) {
    if (!process.env[key]) missing.push(key);
  }

  if (process.env.NODE_ENV === 'production') {
    for (const key of REQUIRED_IN_PRODUCTION) {
      if (!process.env[key]) missing.push(key);
    }
  }

  if (missing.length) {
    throw new Error(
      `Missing required server env var${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`
    );
  }
}

assertEnv();

export {};
