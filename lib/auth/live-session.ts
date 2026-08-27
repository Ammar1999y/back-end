import type { EntityID } from '@/types';

import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import { db } from '@/db';
import { sessions, users } from '@/db/schema';
import { validID } from '@/utils';

import { HTTP_STATUS, MSG_LOGIN_REQUIRED } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';

/**
 * Proves the session row behind a cached session still exists.
 *
 * `auth.api.getSession` answers from Better Auth's cookie cache for up to
 * `cookieCache.maxAge`, and that cached copy outlives the row it describes. Every
 * revocation path in this codebase works by DELETING rows — credential rotation
 * (password, email, phone), admin edit, explicit session revocation — so any
 * check that re-reads the user and role but not the session will authorize a
 * session that was revoked minutes ago. An active user with an active role passes
 * everything else.
 *
 * Lives in one module because it has to be asked by every authorization entry
 * point: fixing it in the permission checker alone left `requireSession` — which
 * guards change-password and both contact-change flows — trusting the cache. A
 * session revoked mid-OTP-flow could still commit the contact change.
 *
 * **The user's status is part of the predicate, not a separate question.** The
 * session row surviving is not enough: `getSession` joins `users` but knows
 * nothing about `is_active` or `deleted_at`, so a suspended AND soft-deleted
 * account kept full read access to every dashboard endpoint until
 * `sessions.expiresAt` — 28 DAYS, not the 300 s of `should-ignore.md` Known
 * Issue #5, whose bound only ever described the cookie-cache window. Measured
 * with the cache deliberately missed: `GET /api/dash/roles` answered 200 for a
 * user that was both. Writes were refused, because the write path repeats these
 * two predicates inside its own transaction — which is exactly the problem: the
 * property held only because two unrelated handlers remembered to ask.
 */
export async function assertLiveSession(
  sessionId: string | null | undefined,
  userId: EntityID
): Promise<EntityID> {
  const validSessionId = validID(sessionId);
  if (!validSessionId)
    throw new CustomError(MSG_LOGIN_REQUIRED, HTTP_STATUS.UNAUTHORIZED);

  const [row] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.id, validSessionId),
        eq(sessions.userId, userId),
        gt(sessions.expiresAt, sql`now()`),
        isNull(users.deletedAt),
        eq(users.isActive, true)
      )
    );

  if (!row) throw new CustomError(MSG_LOGIN_REQUIRED, HTTP_STATUS.UNAUTHORIZED);
  return validSessionId;
}
