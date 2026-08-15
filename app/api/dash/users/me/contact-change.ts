import type { WsTx } from '@/db/ws';
import type { HandlerCookie } from '@/lib/http/contract';
import type { EntityID } from '@/types';

import { and, eq, isNull } from 'drizzle-orm';

import { users } from '@/db/schema';
import { sanitizeForLog } from '@/utils';
import { auditLog, getAuditMeta } from '@/lib/audit';
import { auth } from '@/lib/auth';
import { revokeOtherSessions, revokePendingProofs } from '@/lib/auth/rotation';
import { parseSetCookieHeaders } from '@/lib/http/contract';

import {
  HTTP_STATUS,
  MSG_INSUFFICIENT_PERMISSIONS,
  MSG_NOT_FOUND,
} from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';
import { markContactVerified } from '@/utils/otp';

type AuditMeta = ReturnType<typeof getAuditMeta>;

/**
 * Refresh the cookie-cached session after an identity field (email) changed so
 * the stale cached identity is replaced. Failure is non-fatal — the DB change
 * already committed.
 */
export async function refreshSessionCookies(
  headers: Headers
): Promise<HandlerCookie[] | undefined> {
  try {
    const refreshed = await auth.api.getSession({
      headers,
      query: { disableCookieCache: true },
      returnHeaders: true,
    });
    const cookies = parseSetCookieHeaders(refreshed.headers.getSetCookie());
    return cookies.length > 0 ? cookies : undefined;
  } catch (e) {
    console.error('cookie cache refresh failed:', sanitizeForLog(e));
    return undefined;
  }
}

/**
 * Atomically commit a verified contact change. Called either from inside
 * `processOtpVerify`'s transaction (real OTP path) or from a fresh transaction
 * when OTP_AUTO_VERIFY bypasses code entry.
 *
 * Where the verified flag may be set true (the earlier "single writer" wording
 * was never what the code did): alongside a NEW address, only in the one
 * `UPDATE` below that writes the address — splitting them would leave the row
 * carrying a new address with the old flag; on an UNCHANGED address, only via
 * `markContactVerified`. Clearing it is unrestricted; only granting needs a
 * boundary.
 *
 * A unique-constraint violation (address already taken) propagates to the
 * caller, which maps it to 409.
 */

interface CommitContactChangeOpts {
  tx: WsTx;
  userId: EntityID;
  /** Auth session to preserve; all the user's other sessions are revoked. */
  keepSessionId?: string | null;
  /**
   * The verification session being consumed right now. It survives the
   * sibling-proof purge so the caller can still stamp it verified/consumed;
   * every other pending proof for this user is dropped.
   */
  keepVerificationSessionId?: string | null;
  auditMeta: AuditMeta;
}

interface CommitEmailChangeOpts extends CommitContactChangeOpts {
  newEmail: string;
}

export async function commitEmailChange({
  tx,
  userId,
  newEmail,
  keepSessionId,
  keepVerificationSessionId,
  auditMeta,
}: CommitEmailChangeOpts): Promise<void> {
  // Fresh read under FOR UPDATE — a concurrently deactivated/demoted user must
  // not be able to rotate their email during the cookie-cache staleness window.
  const [current] = await tx
    .select({
      email: users.email,
      emailVerified: users.emailVerified,
      roleId: users.roleId,
    })
    .from(users)
    .where(
      and(
        eq(users.id, userId),
        isNull(users.deletedAt),
        eq(users.isActive, true)
      )
    )
    .for('update');

  if (!current) throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
  if (!current.roleId)
    throw new CustomError(MSG_INSUFFICIENT_PERMISSIONS, HTTP_STATUS.FORBIDDEN);

  // Idempotent: the address is already committed (e.g. a duplicate verify after
  // an auto-verify), so only the flag can be missing. Writing it inline here
  // skipped the audit row every other verified-flag transition produces.
  if (current.email === newEmail) {
    await markContactVerified(tx, {
      userId,
      channel: 'email',
      auditMeta,
      onMissing: () => {
        throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      },
    });
    return;
  }

  await tx
    .update(users)
    .set({ email: newEmail, emailVerified: true })
    .where(eq(users.id, userId));

  // Email is an identity/credential change — same revocation policy as every
  // other rotation: other sessions die, and sibling proofs issued against the
  // old identity die with them.
  await revokeOtherSessions(tx, userId, keepSessionId);
  await revokePendingProofs(tx, userId, keepVerificationSessionId);

  await auditLog(tx, {
    userId,
    userEmail: current.email,
    action: 'UPDATE',
    tableName: 'users',
    recordId: userId,
    oldData: { email: current.email, emailVerified: current.emailVerified },
    newData: { email: newEmail, emailVerified: true },
    meta: auditMeta,
  });
}

interface CommitPhoneChangeOpts extends CommitContactChangeOpts {
  newPhoneNumber: string;
}

export async function commitPhoneChange({
  tx,
  userId,
  newPhoneNumber,
  keepSessionId,
  keepVerificationSessionId,
  auditMeta,
}: CommitPhoneChangeOpts): Promise<void> {
  const [current] = await tx
    .select({
      email: users.email,
      phoneNumber: users.phoneNumber,
      phoneNumberVerified: users.phoneNumberVerified,
      roleId: users.roleId,
    })
    .from(users)
    .where(
      and(
        eq(users.id, userId),
        isNull(users.deletedAt),
        eq(users.isActive, true)
      )
    )
    .for('update');

  if (!current) throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
  if (!current.roleId)
    throw new CustomError(MSG_INSUFFICIENT_PERMISSIONS, HTTP_STATUS.FORBIDDEN);

  // Same idempotent branch as the email flow — see `commitEmailChange`.
  if (current.phoneNumber === newPhoneNumber) {
    await markContactVerified(tx, {
      userId,
      // The helper only distinguishes email from phone; `sms` and `whatsapp`
      // both name the same `phone_number_verified` flag, and the transport used
      // to prove it is not recorded on the user row.
      channel: 'sms',
      auditMeta,
      onMissing: () => {
        throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      },
    });
    return;
  }

  await tx
    .update(users)
    .set({ phoneNumber: newPhoneNumber, phoneNumberVerified: true })
    .where(eq(users.id, userId));

  // The phone is a passwordless login factor, so replacing it is a credential
  // rotation exactly like email: a session obtained through the OLD number
  // must not outlive it.
  await revokeOtherSessions(tx, userId, keepSessionId);
  await revokePendingProofs(tx, userId, keepVerificationSessionId);

  await auditLog(tx, {
    userId,
    userEmail: current.email,
    action: 'UPDATE',
    tableName: 'users',
    recordId: userId,
    oldData: {
      phoneNumber: current.phoneNumber,
      phoneNumberVerified: current.phoneNumberVerified,
    },
    newData: { phoneNumber: newPhoneNumber, phoneNumberVerified: true },
    meta: auditMeta,
  });
}
