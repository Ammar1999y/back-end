// TODO: remove this endpoint in production — dev-only test for F-9
// Applies the proposed fix: requests `returnHeaders: true` from Better Auth
// so the Set-Cookie values are addressable, then forwards them on the
// outgoing response. Adapter-agnostic — does not rely on next/headers.
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { users } from '@/db/schema';
import { validID } from '@/utils';
import { auth } from '@/lib/auth';

export async function GET(request: Request) {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { success: false, message: 'dev only' },
      { status: 403 }
    );
  }

  const session = await auth.api.getSession({ headers: request.headers });
  const userId = validID(session?.user?.id);
  if (!session || !userId) {
    return NextResponse.json(
      { success: false, message: 'login required' },
      { status: 401 }
    );
  }

  const currentEmail = session.user.email;
  const randomPrefix = Math.random().toString(36).slice(2, 8);
  const newEmail = `${randomPrefix}-${currentEmail}`;

  await db.update(users).set({ email: newEmail }).where(eq(users.id, userId));

  const refreshed = await auth.api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
    returnHeaders: true,
  });

  const response = NextResponse.json({
    success: true,
    data: { oldEmail: currentEmail, newEmail },
  });

  for (const cookie of refreshed.headers.getSetCookie()) {
    response.headers.append('Set-Cookie', cookie);
  }

  return response;
}
