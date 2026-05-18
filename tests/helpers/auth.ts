import type { EntityID } from '@/types';

import { api, extractSessionCookie } from './http';
import type { SeededUser } from './seed';

export interface SignedInUser extends SeededUser {
  cookie: string;
  sessionToken: string;
  ip: string;
}

/**
 * Sign in a seeded user against the real Better Auth endpoint and return
 * its session cookie. Each call uses a unique synthetic IP so the per-IP
 * sign-in rate limit (5/min) doesn't collide across tests sharing the
 * same user.
 */
export async function signIn(user: SeededUser, ip?: string): Promise<SignedInUser> {
  const usedIp = ip ?? `10.255.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
  const res = await api('/api/auth/sign-in/email', {
    method: 'POST',
    body: { email: user.email, password: user.password },
    ip: usedIp,
  });
  if (res.status !== 200) {
    throw new Error(
      `signIn failed for ${user.email}: ${res.status} ${JSON.stringify(res.body)}`
    );
  }
  const cookie = extractSessionCookie(res.cookies);
  if (!cookie) throw new Error(`signIn returned no session cookie: ${res.cookies.join(' | ')}`);
  const tokenMatch = cookie.match(/better-auth\.session_token=([^;]+)/);
  return {
    ...user,
    cookie,
    sessionToken: tokenMatch?.[1] ?? '',
    ip: usedIp,
  };
}

/** Send a request as an authenticated user. Reuses their ip/cookie. */
export function asUser(
  user: SignedInUser
): {
  cookie: string;
  ip: string;
  userId: EntityID;
} {
  return { cookie: user.cookie, ip: user.ip, userId: user.id };
}
