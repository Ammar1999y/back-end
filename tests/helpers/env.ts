// Loads .env into process.env for test runs (Bun does NOT auto-load .env in
// non-default modes the same way Next.js does, so we mirror what `next dev`
// sees). NODE_ENV is forced to 'development' so dev-only fallbacks fire:
//   - Captcha verifier uses the Cloudflare test secret (accepts any token).
//   - `lib/env.server.ts` does not require TURNSTILE_SECRET_KEY.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadDotEnv(path: string) {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(resolve(process.cwd(), '.env'));
loadDotEnv(resolve(process.cwd(), '.env.local'));

if (!process.env.NODE_ENV) process.env.NODE_ENV = 'development';

if (
  !process.env.PASSWORD_PEPPER_ACTIVE_ID &&
  !process.env.PASSWORD_PEPPER_KEYRING
) {
  process.env.PASSWORD_PEPPER_ACTIVE_ID = 'test_v1';
  process.env.PASSWORD_PEPPER_KEYRING =
    '{"test_v1":{"generation":1,"secret":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}}';
}

export const BASE_URL = process.env.TEST_BASE_URL ?? 'http://localhost:3000';
