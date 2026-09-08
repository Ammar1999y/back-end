import type { ReauthMethod } from './reauth-methods';
import type { Tx } from '@/db';
import type { EntityID } from '@/types';

import { and, eq, gt } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { sessions, users, verifications } from '@/db/schema';
import { validID } from '@/utils';

import {
  HTTP_STATUS,
  MSG_INVALID_CREDENTIALS,
  MSG_REAUTH_REQUIRED,
  REAUTH_REQUIRED_CODE,
} from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';

import { authenticationStartedAt } from './authentication-time';
import { availableReauthMethods } from './reauth-methods';
import { lockEligibleAuthUser } from './user-eligibility';

const ADMIN_REAUTH_MAX_AGE_S = 900;

const identifierOf = (sessionId: string) => `admin-reauth-${sessionId}`;

// One session-bound window guards self-service credentials, 2FA management and administrative D12 actions.
export async function mintAdminReauth(
  actorUserId: EntityID,
  sessionId: string,
  method: ReauthMethod = 'password',
  executor?: Tx,
  startedAt?: number
): Promise<{ expiresIn: number }> {
  const proofStartedAt = startedAt ?? (await authenticationStartedAt(executor));
  const write = async (tx: Tx) => {
    const user = await lockEligibleAuthUser(tx, eq(users.id, actorUserId));
    const [live] = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.userId, actorUserId),
          gt(sessions.expiresAt, new Date())
        )
      );
    const available = await availableReauthMethods(actorUserId, tx);
    if (
      !live ||
      !user ||
      !available.includes(method) ||
      (user.authRevokedAt && user.authRevokedAt.getTime() >= proofStartedAt)
    )
      throw new CustomError(MSG_INVALID_CREDENTIALS, HTTP_STATUS.UNAUTHORIZED);
    await tx
      .delete(verifications)
      .where(eq(verifications.identifier, identifierOf(sessionId)));
    await tx.insert(verifications).values({
      identifier: identifierOf(sessionId),
      // Rotation finds every actor-owned proof by value, including windows on sessions it preserves.
      value: actorUserId,
      expiresAt: new Date(Date.now() + ADMIN_REAUTH_MAX_AGE_S * 1000),
    });
    await tx
      .delete(verifications)
      .where(eq(verifications.identifier, `reauth-method-${sessionId}`));
    await tx.insert(verifications).values({
      identifier: `reauth-method-${sessionId}`,
      value: method,
      expiresAt: new Date(Date.now() + ADMIN_REAUTH_MAX_AGE_S * 1000),
    });
  };
  if (executor) await write(executor);
  else await withTransaction(write);
  return { expiresIn: ADMIN_REAUTH_MAX_AGE_S };
}

// Read without consuming: repeated actions share the window, but still require this live session and their permissions.
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
  if (validID(row?.value) !== actorUserId) return false;
  const [method] = await db
    .select({ value: verifications.value })
    .from(verifications)
    .where(
      and(
        eq(verifications.identifier, `reauth-method-${sessionId}`),
        gt(verifications.expiresAt, new Date())
      )
    );
  const available: readonly string[] =
    await availableReauthMethods(actorUserId);
  return available.includes(method?.value ?? '');
}

export async function requireReauthWindow(
  userId: EntityID,
  sessionId: string
): Promise<void> {
  if (!(await hasAdminReauth(sessionId, userId)))
    throw new CustomError(
      MSG_REAUTH_REQUIRED,
      HTTP_STATUS.UNAUTHORIZED,
      REAUTH_REQUIRED_CODE
    );
}
