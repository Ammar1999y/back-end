import { expect, test } from 'bun:test';

import { auth } from '@/lib/auth';
import { BETTER_AUTH_ALLOWED_PATH_SET } from '@/lib/auth/allowed-paths';
import { GOOGLE_ENABLED } from '@/lib/auth/oauth-config';
import { PUBLIC_ORIGIN } from '@/lib/env';

test('OAuth is disabled by default, including direct Better Auth entrypoints', async () => {
  expect(GOOGLE_ENABLED).toBe(false);
  const capabilities = await auth.handler(
    new Request(`${PUBLIC_ORIGIN}/api/auth/capabilities`)
  );
  expect(await capabilities.json()).toEqual({
    success: true,
    data: { oauthProviders: [] },
  });
  for (const path of [
    '/oauth/google/start',
    '/oauth/google/callback',
    '/oauth/result',
    '/sign-in/social',
    '/callback/google',
    '/link-social',
  ]) {
    expect(BETTER_AUTH_ALLOWED_PATH_SET.has(path)).toBe(false);
    const response = await auth.handler(
      new Request(`${PUBLIC_ORIGIN}/api/auth${path}`, {
        method: path.endsWith('/start') ? 'POST' : 'GET',
      })
    );
    expect(response.status).toBe(404);
  }
});

test.each([
  {
    ENABLED_OAUTH_PROVIDERS: 'google',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
  },
  {
    ENABLED_OAUTH_PROVIDERS: 'google',
    GOOGLE_CLIENT_ID: 'invalid',
    GOOGLE_CLIENT_SECRET: 'not-a-real-secret',
  },
  {
    ENABLED_OAUTH_PROVIDERS: 'google',
    GOOGLE_CLIENT_ID: 'harness.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'short',
  },
  {
    ENABLED_OAUTH_PROVIDERS: 'github',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
  },
])(
  'bad provider configuration fails without reflecting credentials',
  async (config) => {
    const child = Bun.spawn(
      [
        'bun',
        '--no-env-file',
        '-e',
        "await import('./lib/auth/oauth-config.ts')",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...config },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const error = await new Response(child.stderr).text();
    expect(await child.exited).not.toBe(0);
    expect(error).toContain(
      'ENABLED_OAUTH_PROVIDERS' in config &&
        config.ENABLED_OAUTH_PROVIDERS === 'github'
        ? 'unknown provider'
        : 'Google OAuth requires valid'
    );
    expect(error).not.toContain('not-a-real-secret');
  }
);
