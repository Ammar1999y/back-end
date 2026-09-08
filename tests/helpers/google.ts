import crypto from 'node:crypto';

import { app } from '@/app';
import * as z from 'zod';
import { PUBLIC_ORIGIN } from '@/lib/env';

import { scriptEgress } from './egress';
import { baseHeaders, mergeCookies } from './session';

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = {
  ...keys.publicKey.export({ format: 'jwk' }),
  kid: 'harness-google',
  alg: 'RS256',
  use: 'sig',
};
const exchanges = new Map<
  string,
  { token: string; challenge: string | null }
>();

function signGoogleToken(claims: Record<string, unknown>) {
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', kid: publicKey.kid })
  ).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const data = `${header}.${payload}`;
  return `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), keys.privateKey).toString('base64url')}`;
}

export async function startGoogle(
  claims: Record<string, unknown>,
  options: {
    cookie?: string;
    callbackURL?: string;
    token?: string;
  } = {}
) {
  const started = await app.handle(
    new Request(`${PUBLIC_ORIGIN}/api/auth/oauth/google/start`, {
      method: 'POST',
      headers: baseHeaders({
        'content-type': 'application/json',
        origin: PUBLIC_ORIGIN,
        ...(options.cookie && { cookie: options.cookie }),
      }),
      body: JSON.stringify({
        mode: 'sign_in',
        callbackURL: options.callbackURL,
        rememberMe: true,
      }),
    })
  );
  if (started.status !== 200)
    throw new Error(`Google start failed: ${started.status}`);
  const body = z
    .object({ data: z.object({ url: z.string() }) })
    .parse(await started.json());
  const url = new URL(body.data.url);
  const now = Math.floor(Date.now() / 1000);
  const token =
    options.token ??
    signGoogleToken({
      iss: 'https://accounts.google.com',
      aud: 'harness.apps.googleusercontent.com',
      exp: now + 600,
      iat: now,
      nonce: url.searchParams.get('nonce'),
      email_verified: true,
      ...claims,
    });
  scriptEgress('www.googleapis.com', () =>
    Response.json({ keys: [publicKey] })
  );
  const code = crypto.randomBytes(24).toString('base64url');
  exchanges.set(code, {
    token,
    challenge: url.searchParams.get('code_challenge'),
  });
  scriptEgress('oauth2.googleapis.com', async (request) => {
    const form = new URLSearchParams(await request.text());
    const requestedCode = form.get('code') ?? '';
    const exchange = exchanges.get(requestedCode);
    exchanges.delete(requestedCode);
    const verifier = form.get('code_verifier');
    if (
      !verifier ||
      !exchange ||
      crypto.createHash('sha256').update(verifier).digest('base64url') !==
        exchange.challenge
    )
      return Response.json({ error: 'invalid_grant' }, { status: 400 });
    return Response.json({
      access_token: 'unused-harness-access-token',
      token_type: 'Bearer',
      expires_in: 600,
      id_token: exchange.token,
    });
  });
  const cookie = mergeCookies(
    options.cookie ?? '',
    started.headers.getSetCookie()
  );
  const callback = (query: Record<string, string | null | undefined> = {}) => {
    const target = new URL('/api/auth/oauth/google/callback', PUBLIC_ORIGIN);
    target.searchParams.set('state', url.searchParams.get('state') ?? '');
    target.searchParams.set('code', code);
    for (const [key, value] of Object.entries(query)) {
      if (value === null) target.searchParams.delete(key);
      else if (value !== undefined) target.searchParams.set(key, value);
    }
    return app.handle(
      new Request(target, { headers: baseHeaders({ cookie }) })
    );
  };
  return { url, cookie, callback, token };
}
