import type { WsTx } from '@/db/ws';

import { and, eq, isNull, ne } from 'drizzle-orm';

import { sessions, users } from '@/db/schema';
import { auditLog, getAuditMeta } from '@/lib/audit';
import { EntityID } from '@/types';

import {
  HTTP_STATUS,
  MSG_INSUFFICIENT_PERMISSIONS,
  MSG_NOT_FOUND,
} from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';

type AuditMeta = ReturnType<typeof getAuditMeta>;

/**
 * Atomically commit a verified contact change. Called either from inside
 * `processOtpVerify`'s transaction (real OTP path) or from a fresh transaction
 * when OTP_AUTO_VERIFY bypasses code entry. The verified flag is only ever set
 * here — i.e. as the direct result of a proven (or explicitly bypassed)
 * verification — so `email`/`phone_number` can never carry a stale verified
 * state onto an unproven address (report SEC-1 / DATA-1).
 *
 * A unique-constraint violation (address already taken) propagates to the
 * caller, which maps it to 409.
 */

interface CommitEmailChangeOpts {
  tx: WsTx;
  userId: EntityID;
  newEmail: string;
  /** Auth session to preserve; all the user's other sessions are revoked. */
  keepSessionId?: string | null;
  auditMeta: AuditMeta;
}

export async function commitEmailChange({
  tx,
  userId,
  newEmail,
  keepSessionId,
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

  // Idempotent: the address is already committed (e.g. a duplicate verify call
  // after an auto-verify). Just ensure the verified flag is set.
  if (current.email === newEmail) {
    if (!current.emailVerified)
      await tx
        .update(users)
        .set({ emailVerified: true })
        .where(eq(users.id, userId));
    return;
  }

  await tx
    .update(users)
    .set({ email: newEmail, emailVerified: true })
    .where(eq(users.id, userId));

  // Email is an identity/credential change — revoke the user's other sessions.
  await tx
    .delete(sessions)
    .where(
      keepSessionId
        ? and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId))
        : eq(sessions.userId, userId)
    );

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

interface CommitPhoneChangeOpts {
  tx: WsTx;
  userId: EntityID;
  newPhoneNumber: string;
  auditMeta: AuditMeta;
}

export async function commitPhoneChange({
  tx,
  userId,
  newPhoneNumber,
  auditMeta,
}: CommitPhoneChangeOpts): Promise<void> {
  const [current] = await tx
    .select({
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

  if (current.phoneNumber === newPhoneNumber) {
    if (!current.phoneNumberVerified)
      await tx
        .update(users)
        .set({ phoneNumberVerified: true })
        .where(eq(users.id, userId));
    return;
  }

  await tx
    .update(users)
    .set({ phoneNumber: newPhoneNumber, phoneNumberVerified: true })
    .where(eq(users.id, userId));

  await auditLog(tx, {
    userId,
    userEmail: current.phoneNumber ?? '',
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
