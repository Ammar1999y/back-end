/**
 * The administrator's short-window re-authentication, and the class it guards.
 *
 * ⚠️ `D12`: administrative re-authentication is a CLASS, not an endpoint. Either
 * every admin action that lowers another account's security posture sits behind
 * this boundary or none does — and the observable failure was that the one that
 * removes a second factor sat behind nothing while
 * `/api/dash/users/me/change-password` re-authenticated for something strictly
 * less dangerous.
 *
 * A short WINDOW, not a single use, and that is deliberate: a per-request prompt
 * on every row of a batch is what gets a control turned off. The proof is bound
 * to one administrator and expires; it never authorises on its own, because
 * every consumer still requires that administrator's live session and their
 * permission grant.
 *
 * ⚠️ Bound to the SESSION, not carried in a header the client echoes back. A
 * header token adds no security here — anyone who can send the session cookie
 * can send the header with it — while giving a bearer-shaped secret somewhere to
 * leak. Binding it to the session id means the window belongs to the browser
 * that proved the password and to nothing else.
 *
 * The value is the ACTOR's user id, deliberately: `revokeTwoFactorState` deletes
 * `value = userId`, so an administrator's own credential rotation closes their
 * open window.
 */
import type { EntityID } from '@/types';

import { and, eq, gt } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { verifications } from '@/db/schema';
import { validID } from '@/utils';

/** Long enough for a batch of related edits, short enough not to be a session. */
const ADMIN_REAUTH_MAX_AGE_S = 900;

const identifierOf = (sessionId: string) => `admin-reauth-${sessionId}`;

export async function mintAdminReauth(
  actorUserId: EntityID,
  sessionId: string
): Promise<{ expiresIn: number }> {
  await withTransaction(async (tx) => {
    // Re-proving replaces the window rather than stacking two: the row is one
    // per session, and a fresh proof should extend the window from now.
    await tx
      .delete(verifications)
      .where(eq(verifications.identifier, identifierOf(sessionId)));
    await tx.insert(verifications).values({
      identifier: identifierOf(sessionId),
      value: actorUserId,
      expiresAt: new Date(Date.now() + ADMIN_REAUTH_MAX_AGE_S * 1000),
    });
  });
  return { expiresIn: ADMIN_REAUTH_MAX_AGE_S };
}

/**
 * Is there a live proof on THIS session, for THIS administrator?
 *
 * Read, not consumed — the window is the point. Both halves are checked: a row
 * whose user no longer matches is a session id reused after a rotation, and that
 * is not a proof.
 */
export async function hasAdminReauth(
  sessionId: string,
  actorUserId: EntityID
): Promise<boolean> {
  if (!sessionId) return false;

  const [row] = await db
    .select({ value: verifications.value })
    .from(verifications)
    .where(
      and(
        eq(verifications.identifier, identifierOf(sessionId)),
        gt(verifications.expiresAt, new Date())
      )
    )
    .limit(1);
  return validID(row?.value) === actorUserId;
}
