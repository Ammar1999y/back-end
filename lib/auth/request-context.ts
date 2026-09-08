import type { AuthContext } from './two-factor-challenge';

import { db } from '@/db';

import { authenticationDenied } from './api-error';
import { resolveRequestSession } from './two-factor-challenge';
import { roleAllowsLogin } from './user-eligibility';

export async function requireReauthSession(ctx: AuthContext) {
  const session = await resolveRequestSession(ctx);
  if (!session) throw authenticationDenied();
  const user = await db.query.users.findFirst({
    where: (users, { eq }) => eq(users.id, session.userId),
    with: { role: true },
  });
  if (!user || !roleAllowsLogin(user.role)) throw authenticationDenied();
  return session;
}
