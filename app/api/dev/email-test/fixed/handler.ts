// TODO: remove this endpoint in production — dev-only test for F-9
// Requests `returnHeaders: true` from Better Auth so the refreshed Set-Cookie
// values are addressable, then forwards them on the outgoing response.
// Adapter-agnostic: the cookies travel on `HandlerOutput.cookies`, so no
// framework cookie API is touched.
import type { Handler } from '@/lib/http/contract';

import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { users } from '@/db/schema';
import { validID } from '@/utils';
import { auth } from '@/lib/auth';
import { parseSetCookieHeaders } from '@/lib/http/contract';

import {
  HTTP_STATUS,
  MSG_LOGIN_REQUIRED,
  MSG_PAGE_NOT_FOUND,
} from '@/utils/api-messages';
import { apiError, apiSuccess } from '@/utils/api-response';

export const GET: Handler = async (ctx) => {
  // 404, not the 403 the Next version returned. Deliberate, and recorded in §4
  // of docs/framework-migration.md rather than left as an accident of the
  // rewrite: 403 confirms the route exists to anyone who asks, and this is a
  // development-only endpoint that should be indistinguishable from an unrouted
  // path in every other mode.
  if (process.env.NODE_ENV !== 'development')
    return apiError({
      message: MSG_PAGE_NOT_FOUND,
      status: HTTP_STATUS.NOT_FOUND,
    });

  const session = await auth.api.getSession({ headers: ctx.headers });
  const userId = validID(session?.user?.id);
  if (!session || !userId)
    return apiError({
      message: MSG_LOGIN_REQUIRED,
      status: HTTP_STATUS.UNAUTHORIZED,
    });

  const currentEmail = session.user.email;
  const randomPrefix = Math.random().toString(36).slice(2, 8);
  const newEmail = `${randomPrefix}-${currentEmail}`;

  await db.update(users).set({ email: newEmail }).where(eq(users.id, userId));

  const refreshed = await auth.api.getSession({
    headers: ctx.headers,
    query: { disableCookieCache: true },
    returnHeaders: true,
  });

  return apiSuccess({
    message: 'email rotated',
    data: { oldEmail: currentEmail, newEmail },
    cookies: parseSetCookieHeaders(refreshed.headers.getSetCookie()),
  });
};
