import type { Tx } from '@/db';
import type { getAuditMeta } from '@/lib/audit';
import type { EntityID } from '@/types';

import { and, eq, inArray, like, ne, sql } from 'drizzle-orm';

import { db } from '@/db';
import {
  accounts,
  sessions,
  trustedDevices,
  users,
  verifications,
  verificationSessions,
} from '@/db/schema';
import { auditLog } from '@/lib/audit';

/**
 * Single policy for what a credential / identity rotation invalidates.
 *
 * Password, email and phone are all credentials — phone is a passwordless
 * login factor, so replacing it has to carry the same session semantics as
 * replacing an email. Routing every rotation through these helpers keeps
 * the paths from drifting apart (which is exactly how phone-change ended up
 * without session revocation and password-change without proof revocation).
 *
 * Both run inside the caller's transaction, after the `users` row is already
 * locked, so the canonical lock order (users -> sessions /
 * verification_sessions -> trusted_devices / verifications) is preserved. The
 * two newest tables sit at the END of that order: nothing else locks them, so
 * appending cannot introduce a cycle.
 */

/**
 * Every `verifications` row this deployment writes on a user's behalf.
 *
 * ⚠️ `WHERE value = userId` finds ONE of them. The challenge row stores the user
 * id, but its three companions do not: the attempt counter stores a count, the
 * companion state a JSON document, the WebAuthn ceremony a challenge string —
 * and the device-trust proof stores a SESSION id. Each is reached from something
 * that does name the user: the challenge ids, and the user's own session ids.
 *
 * Not covered, and deliberately: the passkey plugin's own registration ceremony
 * rows carry a random identifier and a JSON value, with nothing joining them to
 * a user. They are single-use, short-lived, and useless without the challenge
 * cookie the browser holds, so they are left to the retention sweep.
 */
/**
 * The `verifications` rows keyed by SESSION id: the two-factor proof and both
 * re-authentication windows.
 *
 * Reachable only THROUGH the session id — none of the three stores the user id —
 * so a session deleted without them leaves rows nothing can find again until
 * they expire. Every path that deletes a session owes this call.
 *
 * Two kinds of path do, and both are bound to it rather than trusted to remember:
 * this codebase's own deletes call it inside their transaction, and Better Auth's
 * — `/sign-out`, a revoked session, an expired row the library reaps — reach it
 * through the `session.delete.after` database hook in `lib/auth.ts`. That hook is
 * why the executor is widened: it runs after the library's transaction has
 * committed, so what it has is the pool.
 */
export async function revokeSessionArtifacts(
  tx: Tx | typeof db,
  sessionIds: readonly string[]
): Promise<void> {
  if (sessionIds.length === 0) return;
  await tx.delete(verifications).where(
    inArray(
      verifications.identifier,
      sessionIds.flatMap((id) => [
        `2fa-proven-${id}`,
        `reauth-method-${id}`,
        `reauth-passkey-${id}`,
      ])
    )
  );
}

async function revokeVerificationArtifacts(
  tx: Tx,
  userId: EntityID
): Promise<void> {
  const challenges = await tx
    .delete(verifications)
    .where(
      and(
        eq(verifications.value, userId),
        like(verifications.identifier, '2fa-%')
      )
    )
    .returning({ identifier: verifications.identifier });

  for (const challenge of challenges)
    await tx
      .delete(verifications)
      .where(
        inArray(verifications.identifier, [
          `2fa-attempts-${challenge.identifier}`,
          `2fa-state-${challenge.identifier}`,
          `2fa-webauthn-${challenge.identifier}`,
        ])
      );

  // Everything else keyed on the user id: the re-authentication grants.
  await tx.delete(verifications).where(eq(verifications.value, userId));

  // ⚠️ The device-trust proof is keyed by SESSION id, and it is the one that
  // matters here. Method removal deliberately KEEPS the caller's session, so a
  // surviving marker lets that same session mint a new trusted device
  // immediately after the revocation below removed the old ones.
  //
  // This reaches the SURVIVING sessions only. A session already deleted by this
  // rotation is no longer here to be found, which is why every delete carries
  // `revokeSessionArtifacts` itself rather than relying on call order.
  const owned = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, userId));
  await revokeSessionArtifacts(
    tx,
    owned.map((session) => session.id)
  );
}

/**
 * Drops every standing skip of the second factor, and any in-flight challenge.
 *
 * Recovery, method removal, an administrative reset and capability loss all take
 * this: each is a moment where a device trusted against a factor is a bypass of
 * a factor that may no longer exist. A VOLUNTARY password change does not — see
 * `revokePendingProofs`.
 */
export async function revokeTwoFactorState(
  tx: Tx,
  userId: EntityID
): Promise<void> {
  await revokeTrustedDevices(tx, userId);
  await revokeVerificationArtifacts(tx, userId);
}

/**
 * Every standing second-factor skip this user holds, and nothing else.
 *
 * Split out of `revokeTwoFactorState` for the containment case: bulk session
 * revocation must remove the trusted devices — they are keyed by their own
 * cookie and outlive every session, so signing out everywhere without them
 * leaves the attacker's device still skipping 2FA — but must NOT touch the
 * user's enrolment or an in-flight challenge, which that function also clears.
 */
export async function revokeTrustedDevices(
  tx: Tx,
  userId: EntityID
): Promise<void> {
  await tx.delete(trustedDevices).where(eq(trustedDevices.userId, userId));
}

/** Revoke every auth session for the user except the one making the request. */
export async function revokeOtherSessions(
  tx: Tx,
  userId: EntityID,
  keepSessionId?: string | null
): Promise<void> {
  const removed = await tx
    .delete(sessions)
    .where(
      keepSessionId
        ? and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId))
        : eq(sessions.userId, userId)
    )
    .returning({ id: sessions.id });
  await revokeSessionArtifacts(
    tx,
    removed.map((session) => session.id)
  );
}

/**
 * Removes proofs invalidated by credential rotation. The proof being consumed
 * may be retained long enough to record its final state.
 *
 * `trustedDevices` is a PARAMETER because the answer differs by event, and
 * folding it in unconditionally made a voluntary password change un-remember
 * every device the user had deliberately remembered:
 *
 *  - `'revoke'` — recovery, contact change, administrative reset, user deletion.
 *    The person performing the change may not be the account's owner, or the
 *    factor the trust was granted against has just gone.
 *  - `'keep'` — a voluntary password change made by a caller who already proved
 *    the old password on a live session. Their trusted devices are theirs; the
 *    user should be TOLD about them, not silently signed out of them.
 */
export async function revokePendingProofs(
  tx: Tx,
  userId: EntityID,
  keepVerificationSessionId?: string | null,
  trustedDeviceRotation: 'revoke' | 'keep' = 'revoke'
): Promise<void> {
  await tx
    .update(users)
    .set({ authRevokedAt: sql`clock_timestamp()`, updatedAt: users.updatedAt })
    .where(eq(users.id, userId));
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

  if (trustedDeviceRotation === 'revoke')
    await revokeTwoFactorState(tx, userId);
  else await revokeVerificationArtifacts(tx, userId);
}

export async function unlinkGoogle(
  tx: Tx,
  userId: EntityID,
  auditMeta: ReturnType<typeof getAuditMeta>
): Promise<void> {
  const removed = await tx
    .delete(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, 'google')))
    .returning({ id: accounts.id });
  if (removed.length === 0) return;
  const [user] = await tx
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) throw new Error('Unlinked identity has no local user.');
  for (const account of removed)
    await auditLog(tx, {
      userId,
      userEmail: user.email,
      action: 'DELETE',
      tableName: 'accounts',
      recordId: account.id,
      oldData: { provider: 'google', identityLinked: true },
      newData: {
        provider: 'google',
        identityLinked: false,
        reason: 'google_identity_unlinked',
      },
      meta: auditMeta,
    });
}
