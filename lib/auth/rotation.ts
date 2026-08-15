import type { WsTx } from '@/db/ws';
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
  tx: WsTx,
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
 * Drop the user's pending OTP proofs.
 *
 * An unconsumed `forgot_password` / `passwordless_login` proof outliving a
 * password change lets whoever holds that code reset the *new* password —
 * i.e. it defeats the remediation the user just performed. Sibling
 * `change_email` / `change_phone` proofs are equally stale once the identity
 * they were issued against has moved.
 *
 * `keepVerificationSessionId` preserves the proof currently being consumed so
 * the caller can still stamp it verified/consumed as an auditable record.
 *
 * Retention note: this deletes ALREADY-CONSUMED sibling rows too. Those rows
 * are single-use replay markers, not the audit trail: their code is already
 * deleted and `consumedAt` makes them unreplayable, so nothing depends on them
 * surviving. Every flow that consumes one now writes its own `audit_logs`
 * entry (contact change, password reset, and — since this was previously
 * missing — passwordless sign-in), so the forensic record does not live in
 * this table. Rotation is the natural point to clear them; see the
 * verification-session TTL item in TODO.md for the periodic sweep.
 */
export async function revokePendingProofs(
  tx: WsTx,
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
