import type { Tx } from '@/db';
import type { EntityID } from '@/types';

import { and, eq, ne } from 'drizzle-orm';

import { sessions, verificationSessions } from '@/db/schema';

/**
 * Single policy for what a credential / identity rotation invalidates.
 *
 * Password, email and phone are all credentials — phone is a passwordless
 * login factor, so replacing it has to carry the same session semantics as
 * replacing an email. Routing every rotation through these two helpers keeps
 * the paths from drifting apart (which is exactly how phone-change ended up
 * without session revocation and password-change without proof revocation).
 *
 * Both run inside the caller's transaction, after the `users` row is already
 * locked, so the canonical lock order (users -> sessions /
 * verification_sessions) is preserved.
 */

/** Revoke every auth session for the user except the one making the request. */
export async function revokeOtherSessions(
  tx: Tx,
  userId: EntityID,
  keepSessionId?: string | null
): Promise<void> {
  await tx
    .delete(sessions)
    .where(
      keepSessionId
        ? and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId))
        : eq(sessions.userId, userId)
    );
}

/**
 * Removes proofs invalidated by credential rotation. The proof being consumed
 * may be retained long enough to record its final state.
 */
export async function revokePendingProofs(
  tx: Tx,
  userId: EntityID,
  keepVerificationSessionId?: string | null
): Promise<void> {
  await tx
    .delete(verificationSessions)
    .where(
      keepVerificationSessionId
        ? and(
            eq(verificationSessions.userId, userId),
            ne(verificationSessions.id, keepVerificationSessionId)
          )
        : eq(verificationSessions.userId, userId)
    );
}
