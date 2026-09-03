/**
 * The second factor's own lifecycle — enable, confirm, add, remove, disable —
 * owned end to end rather than compensated after the library's.
 *
 * ⚠️ Why these are not the plugin's endpoints. Every invariant this deployment
 * adds (method intent, capability, backup-code acknowledgement, session
 * rotation, trust revocation) lives OUTSIDE the transitions the plugin performs,
 * and no hook after the fact makes them atomic with it. The observable failures
 * were a database error leaving an account 2FA-on with nothing to prove it with,
 * a repeat enable silently replacing a verified authenticator, and two supported
 * configurations — backup-code-only and passkey-only — with no route to a first
 * enable at all, because the plugin's `/two-factor/enable` can only produce TOTP
 * here.
 *
 * So `/two-factor/enable` is not served, and `/two-factor/disable` and
 * `/two-factor/generate-backup-codes` are these. The plugin's `verify-totp` and
 * `verify-backup-code` stay, in SIGN-IN mode only: they are verifiers, not
 * transitions.
 *
 * Every mutation here is one transaction over `users`, `two_factor_credentials`
 * and `two_factor_methods`, taken in the canonical lock order.
 */
import crypto from 'node:crypto';
import type {
  AuthContext,
  ContactKind,
  RequestSession,
} from './two-factor-challenge';
import type { Tx } from '@/db';
import type { EntityID } from '@/types';
import type { TwoFactorMethod } from '@/utils/validation/two-factor';
import type { BetterAuthPlugin } from 'better-auth';

import { and, eq, sql } from 'drizzle-orm';

import { twoFactorMsg } from '@/app/api/auth/otp/messages';
import { db, withTransaction } from '@/db';
import {
  passkeys,
  twoFactorCredentials,
  twoFactorMethods,
  users,
} from '@/db/schema';
import { validID } from '@/utils';
import { createOTP } from '@better-auth/utils/otp';
import {
  APIError,
  createAuthEndpoint,
  sessionMiddleware,
} from 'better-auth/api';
import {
  generateRandomString,
  symmetricDecrypt,
  symmetricEncrypt,
} from 'better-auth/crypto';
import * as z from 'zod';

import { CUSTOM_AUTH_CODE, HTTP_STATUS } from '@/utils/api-messages';
import {
  isTwoFactorMethodEnabled,
  ownedRowSchema,
  twoFactorMethodOptionSchema,
  twoFactorTotpConfirmSchema,
} from '@/utils/validation/two-factor';

import { API_PATH_MAX, auditLog, getClientIp, USER_AGENT_MAX } from '../audit';
import { envelopeResponse } from './plugin-openapi';
import { mintReauthGrant, requireReauthPassword } from './reauth-grant';
import { revokeOtherSessions, revokeTwoFactorState } from './rotation';
import {
  listEnrolledMethods,
  markTwoFactorProven,
  optionId,
  readEnrollmentState,
  recordMethodIntent,
  removalStrandsTwoFactor,
  removeMethodIntent,
  resolveRequestSession,
} from './two-factor-challenge';

/** Matches the plugin's own generator, so a stored set reads back identically. */
const BACKUP_CODE_ALPHABET =
  'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 10;

/** The plugin's TOTP secret length. Changing it re-enrols every authenticator. */
const TOTP_SECRET_LENGTH = 32;

const TOTP_ISSUER = 'Dashboard';

function unauthorized(): APIError {
  return new APIError(HTTP_STATUS.UNAUTHORIZED, {
    message: twoFactorMsg.challengeMissing,
    code: CUSTOM_AUTH_CODE,
  });
}

function conflict(message: string): APIError {
  return new APIError(HTTP_STATUS.CONFLICT, {
    message,
    code: CUSTOM_AUTH_CODE,
  });
}

function notFound(): APIError {
  return new APIError(HTTP_STATUS.NOT_FOUND, {
    message: twoFactorMsg.methodUnavailable,
    code: CUSTOM_AUTH_CODE,
  });
}

/**
 * Who changed what about a second factor, written INSIDE the transaction that
 * changed it. Every lifecycle transition writes one, including the OTP and
 * passkey enrolments served outside this file.
 */
export async function auditLifecycle(
  tx: Tx,
  ctx: AuthContext,
  session: RequestSession,
  newData: Record<string, unknown>
): Promise<void> {
  const headers = ctx.headers ?? ctx.request?.headers ?? new Headers();
  await auditLog(tx, {
    userId: session.userId,
    userEmail: session.userEmail,
    action: 'UPDATE',
    tableName: 'two_factor_methods',
    recordId: session.userId,
    oldData: {},
    newData: { ...newData, actor: session.userId },
    meta: {
      ip: getClientIp(headers),
      userAgent: headers.get('user-agent')?.slice(0, USER_AGENT_MAX) ?? null,
      apiPath: (ctx.path ?? '').slice(0, API_PATH_MAX),
    },
  });
}

async function requireSession(ctx: AuthContext) {
  const session = await resolveRequestSession(ctx);
  if (!session) throw unauthorized();
  return session;
}

function generateBackupCodes(): string[] {
  return Array.from({ length: BACKUP_CODE_COUNT }, () => {
    let code = '';
    for (let i = 0; i < BACKUP_CODE_LENGTH; i++)
      code += BACKUP_CODE_ALPHABET.charAt(
        crypto.randomInt(BACKUP_CODE_ALPHABET.length)
      );
    return `${code.slice(0, 5)}-${code.slice(5)}`;
  });
}

/**
 * The exact storage the plugin's `verify-backup-code` reads back: a JSON array
 * under `symmetricEncrypt`, which is what `storeBackupCodes: "encrypted"` — the
 * default this deployment leaves in place — means.
 */
function encodeBackupCodes(ctx: AuthContext, codes: string[]): Promise<string> {
  return symmetricEncrypt({
    key: ctx.context.secretConfig,
    data: JSON.stringify(codes),
  });
}

/**
 * Locks the user row first, exactly as every other mutation in this codebase
 * does, so the canonical order (users → everything else) holds and a concurrent
 * removal cannot decide "not the last method" against a stale read.
 */
async function lockUser(tx: Tx, userId: EntityID): Promise<void> {
  await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .for('update');
}

function unprocessable(message: string): APIError {
  return new APIError(HTTP_STATUS.UNPROCESSABLE, {
    message,
    code: CUSTOM_AUTH_CODE,
  });
}

export const twoFactorEnrolment = () =>
  ({
    id: 'two-factor-enrolment',
    endpoints: {
      /**
       * Step one of TOTP enrolment: a secret, and nothing else.
       *
       * `two_factor_enabled` is deliberately NOT set here. An abandoned setup
       * must leave the account exactly as it was — the plugin's own enable set
       * the flag first and left users 2FA-on with an unverified secret.
       */
      startTotpEnrolment: createAuthEndpoint(
        '/two-factor/totp/start',
        {
          method: 'POST',
          body: z.record(z.string(), z.unknown()),
          use: [sessionMiddleware],
          metadata: {
            openapi: envelopeResponse('A TOTP secret to enrol.', {
              type: 'object',
              properties: { totpURI: { type: 'string' } },
              required: ['totpURI'],
            }),
          },
        },
        async (ctx) => {
          if (!isTwoFactorMethodEnabled('totp')) throw notFound();
          const session = await requireSession(ctx);
          const { userId } = session;
          await requireReauthPassword(ctx, userId);

          const [user] = await db
            .select({ email: users.email })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);
          if (!user) throw unauthorized();

          const secret = generateRandomString(TOTP_SECRET_LENGTH);
          const encrypted = await symmetricEncrypt({
            key: ctx.context.secretConfig,
            data: secret,
          });

          await withTransaction(async (tx) => {
            await lockUser(tx, userId);
            const [existing] = await tx
              .select({
                id: twoFactorCredentials.id,
                verified: twoFactorCredentials.verified,
              })
              .from(twoFactorCredentials)
              .where(eq(twoFactorCredentials.userId, userId))
              .limit(1);

            // A verified authenticator is never silently replaced. The plugin's
            // enable overwrote `secret` and `backupCodes` on every call, so a
            // second setup invalidated a working factor without saying so.
            if (existing?.verified === true)
              throw conflict(twoFactorMsg.totpAlreadyEnrolled);

            if (existing)
              await tx
                .update(twoFactorCredentials)
                .set({ secret: encrypted, verified: false })
                .where(eq(twoFactorCredentials.id, existing.id));
            else
              await tx.insert(twoFactorCredentials).values({
                userId,
                secret: encrypted,
                // Not generated here: backup codes are their own method with
                // their own acknowledgement, and minting them as a side effect
                // is how an unacknowledged set came to be advertised.
                backupCodes: await encodeBackupCodes(ctx, []),
                verified: false,
              });
            await auditLifecycle(tx, ctx, session, {
              totpEnrolmentStarted: true,
            });
          });

          return ctx.json({
            success: true,
            data: {
              totpURI: createOTP(secret).url(TOTP_ISSUER, user.email),
            },
          });
        }
      ),

      /**
       * Step two, and the ONLY writer that turns TOTP on.
       *
       * One transaction: the credential becomes verified, the intent row
       * appears, the flag flips and the other sessions go. The plugin's
       * `/two-factor/verify-totp` did the first two of those and left the rest
       * to a hook that could fail after it committed.
       */
      confirmTotpEnrolment: createAuthEndpoint(
        '/two-factor/totp/confirm',
        {
          method: 'POST',
          body: z.record(z.string(), z.unknown()),
          use: [sessionMiddleware],
          metadata: {
            openapi: envelopeResponse('TOTP is enrolled and enabled.'),
          },
        },
        async (ctx) => {
          if (!isTwoFactorMethodEnabled('totp')) throw notFound();
          const session = await requireSession(ctx);

          const parsed = twoFactorTotpConfirmSchema.safeParse(ctx.body);
          if (!parsed.success) throw unprocessable(twoFactorMsg.invalidCode);
          const { code } = parsed.data;

          const [credential] = await db
            .select({
              id: twoFactorCredentials.id,
              secret: twoFactorCredentials.secret,
              verified: twoFactorCredentials.verified,
            })
            .from(twoFactorCredentials)
            .where(eq(twoFactorCredentials.userId, session.userId))
            .limit(1);
          if (!credential) throw notFound();
          if (credential.verified)
            throw conflict(twoFactorMsg.totpAlreadyEnrolled);

          const secret = await symmetricDecrypt({
            key: ctx.context.secretConfig,
            data: credential.secret,
          }).catch(() => null);
          if (!secret) throw notFound();

          // The same one-period tolerance the plugin's verifier allows, so a
          // clock a few seconds out does not fail enrolment and then work at
          // every later sign-in.
          if (!(await createOTP(secret).verify(code, { window: 1 })))
            throw new APIError(HTTP_STATUS.BAD_REQUEST, {
              message: twoFactorMsg.invalidCode,
              code: CUSTOM_AUTH_CODE,
            });

          await withTransaction(async (tx) => {
            await lockUser(tx, session.userId);
            await tx
              .update(twoFactorCredentials)
              .set({ verified: true })
              .where(eq(twoFactorCredentials.id, credential.id));
            await recordMethodIntent(tx, {
              userId: session.userId,
              method: 'totp',
            });
            await tx
              .update(users)
              .set({ twoFactorEnabled: true })
              .where(eq(users.id, session.userId));
            // On confirmation, not on setup: an abandoned enrolment logs nobody
            // out, and a completed one evicts an attacker already holding a
            // session. The caller's own session is the one kept.
            await revokeOtherSessions(tx, session.userId, session.sessionId);
            await auditLifecycle(tx, ctx, session, {
              twoFactorMethodAdded: 'totp',
              twoFactorEnabled: true,
            });
          });

          // A TOTP code WAS just proven on this session, so "remember this
          // device" is redeemable from here — the same rule as a sign-in
          // completion, and the reason trust is bound to a proof rather than to
          // holding a session.
          await markTwoFactorProven(ctx, session.sessionId);

          return ctx.json({
            success: true,
            message: twoFactorMsg.enabled,
            data: { method: 'totp' },
          });
        }
      ),

      /**
       * A new set of backup codes, which INVALIDATES the previous one.
       *
       * The version bump is what unbinds the old acknowledgement: until the user
       * confirms the new set, `backup_code` stops being offered. Without that
       * pairing one acknowledgement kept advertising whatever set existed later,
       * including an exhausted one.
       */
      generateBackupCodes: createAuthEndpoint(
        '/two-factor/generate-backup-codes',
        {
          method: 'POST',
          body: z.record(z.string(), z.unknown()),
          use: [sessionMiddleware],
          metadata: {
            openapi: envelopeResponse('A fresh set of backup codes.', {
              type: 'object',
              properties: {
                backupCodes: { type: 'array', items: { type: 'string' } },
              },
              required: ['backupCodes'],
            }),
          },
        },
        async (ctx) => {
          if (!isTwoFactorMethodEnabled('backup_code')) throw notFound();
          const session = await requireSession(ctx);
          const { userId } = session;
          await requireReauthPassword(ctx, userId);

          const codes = generateBackupCodes();
          const encoded = await encodeBackupCodes(ctx, codes);

          await withTransaction(async (tx) => {
            await lockUser(tx, userId);
            const [existing] = await tx
              .select({
                id: twoFactorCredentials.id,
                version: twoFactorCredentials.backupCodesVersion,
              })
              .from(twoFactorCredentials)
              .where(eq(twoFactorCredentials.userId, userId))
              .limit(1);

            if (existing)
              await tx
                .update(twoFactorCredentials)
                .set({
                  backupCodes: encoded,
                  backupCodesVersion: existing.version + 1,
                  backupCodesAcknowledgedVersion: null,
                  backupCodesAcknowledgedAt: null,
                  backupCodesRemaining: codes.length,
                })
                .where(eq(twoFactorCredentials.id, existing.id));
            else
              // A backup-code-only deployment has no TOTP secret to hang this
              // off, and `secret` is NOT NULL — so the row carries an unverified
              // placeholder. `verified` stays false, so it is never a factor.
              await tx.insert(twoFactorCredentials).values({
                userId,
                secret: await symmetricEncrypt({
                  key: ctx.context.secretConfig,
                  data: generateRandomString(TOTP_SECRET_LENGTH),
                }),
                backupCodes: encoded,
                verified: false,
                backupCodesVersion: 1,
                backupCodesRemaining: codes.length,
              });

            await auditLifecycle(tx, ctx, session, {
              backupCodesRegenerated: true,
              backupCodesCount: codes.length,
            });

            // The intent row is deliberately left alone: the user's choice of
            // method survives a regeneration, and `backupCodesReady` already
            // answers false until the new set is acknowledged.
          });

          return ctx.json({
            success: true,
            data: { backupCodes: codes },
          });
        }
      ),

      /**
       * Binds the acknowledgement to the set that exists NOW, and is the writer
       * that turns backup codes into an offered method.
       */
      acknowledgeBackupCodes: createAuthEndpoint(
        '/two-factor/backup-codes/acknowledge',
        {
          method: 'POST',
          body: z.record(z.string(), z.unknown()),
          use: [sessionMiddleware],
          metadata: {
            openapi: envelopeResponse('The backup codes were acknowledged.'),
          },
        },
        async (ctx) => {
          if (!isTwoFactorMethodEnabled('backup_code')) throw notFound();
          const session = await requireSession(ctx);
          // It flips the flag and revokes the caller's other sessions, so it
          // takes the proof every other transition that does either takes: a
          // hijacked session must not be able to turn the feature on and sign
          // the owner out of every device with one unauthenticated call.
          await requireReauthPassword(ctx, session.userId);

          const acknowledged = await withTransaction(async (tx) => {
            await lockUser(tx, session.userId);
            const [credential] = await tx
              .select({
                id: twoFactorCredentials.id,
                version: twoFactorCredentials.backupCodesVersion,
                remaining: twoFactorCredentials.backupCodesRemaining,
              })
              .from(twoFactorCredentials)
              .where(eq(twoFactorCredentials.userId, session.userId))
              .limit(1);
            if (!credential || credential.remaining === 0) return false;

            await tx
              .update(twoFactorCredentials)
              .set({
                backupCodesAcknowledgedAt: new Date(),
                backupCodesAcknowledgedVersion: credential.version,
              })
              .where(eq(twoFactorCredentials.id, credential.id));
            await recordMethodIntent(tx, {
              userId: session.userId,
              method: 'backup_code',
            });
            await tx
              .update(users)
              .set({ twoFactorEnabled: true })
              .where(eq(users.id, session.userId));
            await revokeOtherSessions(tx, session.userId, session.sessionId);
            await auditLifecycle(tx, ctx, session, {
              twoFactorMethodAdded: 'backup_code',
              backupCodesVersion: credential.version,
              twoFactorEnabled: true,
            });
            return true;
          });

          if (!acknowledged) throw notFound();
          return ctx.json({ success: true, message: twoFactorMsg.enabled });
        }
      ),

      listTwoFactorMethods: createAuthEndpoint(
        '/two-factor/methods',
        {
          method: 'GET',
          use: [sessionMiddleware],
          metadata: {
            openapi: envelopeResponse('The caller’s enrolled methods.', {
              type: 'object' as const,
              properties: {
                methods: { type: 'array', items: { type: 'object' } },
              },
              required: ['methods'],
            }),
          },
        },
        async (ctx) => {
          const userId = validID(ctx.context.session?.user.id);
          if (!userId) throw unauthorized();
          return ctx.json({
            success: true,
            data: { methods: await listEnrolledMethods(userId) },
          });
        }
      ),

      /**
       * Removes ONE enrolment.
       *
       * ⚠️ The enrolled set is read INSIDE the transaction that deletes, under
       * the user lock: read through the pool, two concurrent removals both see
       * two methods and both succeed, leaving an account 2FA-on with nothing.
       *
       * Two refusals. The sole intent row cannot be removed at all — "disable"
       * is the route for that. And a removal that would leave nothing a
       * challenge OFFERS is refused even when other rows exist, because a row
       * whose channel, contact or backup set is gone is not a factor; see
       * `removalStrandsTwoFactor`.
       */
      disableTwoFactorMethod: createAuthEndpoint(
        '/two-factor/methods/disable',
        {
          method: 'POST',
          body: z.record(z.string(), z.unknown()),
          use: [sessionMiddleware],
          metadata: {
            openapi: envelopeResponse('The method was removed.'),
          },
        },
        async (ctx) => {
          const session = await requireSession(ctx);
          const { userId } = session;
          await requireReauthPassword(ctx, userId);

          const parsed = twoFactorMethodOptionSchema.safeParse(ctx.body);
          if (!parsed.success)
            throw unprocessable(twoFactorMsg.methodUnavailable);
          const { method } = parsed.data;
          const contactKind = parsed.data.contactKind as
            ContactKind | undefined;

          await withTransaction(async (tx) => {
            await lockUser(tx, userId);
            const enrolled = await listEnrolledMethods(userId, tx);
            const target = enrolled.find(
              (entry) =>
                entry.method === method &&
                (method !== 'otp' ||
                  !contactKind ||
                  entry.contactKind === contactKind)
            );
            if (!target) throw notFound();
            if (enrolled.length === 1) throw conflict(twoFactorMsg.lastMethod);
            const state = await readEnrollmentState(userId, tx);
            if (removalStrandsTwoFactor(state, method, target.contactKind))
              throw conflict(twoFactorMsg.lastMethod);

            await removeMethodIntent(tx, userId, method, target.contactKind);
            await clearCapabilityFor(tx, userId, method);
            await auditLifecycle(tx, ctx, session, {
              twoFactorMethodRemoved: optionId(method, target.contactKind),
              remaining: enrolled.length - 1,
            });
            // Removing a factor keeps the caller's sessions and drops every
            // standing skip of it: a trust row granted against the factor being
            // removed is a bypass of a factor that no longer exists.
            await revokeTwoFactorState(tx, userId);
          });

          return ctx.json({ success: true, message: twoFactorMsg.disabled });
        }
      ),

      /** The method a challenge routes to first, within what is enrolled. */
      setDefaultTwoFactorMethod: createAuthEndpoint(
        '/two-factor/methods/default',
        {
          method: 'POST',
          body: z.record(z.string(), z.unknown()),
          use: [sessionMiddleware],
          metadata: {
            openapi: envelopeResponse('The default method was set.'),
          },
        },
        async (ctx) => {
          const session = await requireSession(ctx);
          const { userId } = session;
          const parsed = twoFactorMethodOptionSchema.safeParse(ctx.body);
          if (!parsed.success)
            throw unprocessable(twoFactorMsg.methodUnavailable);
          const { method } = parsed.data;
          const contactKind = parsed.data.contactKind as
            ContactKind | undefined;

          const defaultMethod = await withTransaction(async (tx) => {
            await lockUser(tx, userId);
            const enrolled = await listEnrolledMethods(userId, tx);
            // Only ever a REORDER within the issued set: naming something the
            // user has not enrolled would produce a default that is never
            // offered, which is the empty-set branch by another route.
            const target = enrolled.find(
              (entry) =>
                entry.method === method &&
                (method !== 'otp' ||
                  !contactKind ||
                  entry.contactKind === contactKind)
            );
            if (!target) throw notFound();

            await tx
              .update(twoFactorMethods)
              .set({ isDefault: false })
              .where(eq(twoFactorMethods.userId, userId));
            await tx
              .update(twoFactorMethods)
              .set({ isDefault: true })
              .where(
                and(
                  eq(twoFactorMethods.userId, userId),
                  eq(twoFactorMethods.method, method),
                  ...(method === 'otp' && target.contactKind
                    ? [eq(twoFactorMethods.contactKind, target.contactKind)]
                    : [])
                )
              );
            const chosen = optionId(method, target.contactKind);
            await auditLifecycle(tx, ctx, session, {
              twoFactorDefaultChanged: chosen,
            });
            return chosen;
          });

          return ctx.json({ success: true, data: { defaultMethod } });
        }
      ),

      /**
       * Deletes ONE credential, and with the last one the `passkey` method.
       *
       * Served here rather than by the passkey plugin because a credential can
       * be a second factor: the plugin's endpoint deleted the row and nothing
       * else, so a user's last passkey went while the intent row, the flag and
       * every trusted device stayed — a locked-out account with a standing skip
       * of the factor it had just lost. The last-method rule and the trust
       * revocation are the ones `/two-factor/methods/disable` applies; the
       * password proof arrives as the enrolment grant, consumed in `lib/auth.ts`.
       */
      deletePasskey: createAuthEndpoint(
        '/passkey/delete-passkey',
        {
          method: 'POST',
          body: z.record(z.string(), z.unknown()),
          use: [sessionMiddleware],
          metadata: {
            openapi: envelopeResponse('The passkey was deleted.', {
              type: 'object',
              properties: { deleted: { type: 'boolean' } },
              required: ['deleted'],
            }),
          },
        },
        async (ctx) => {
          if (!isTwoFactorMethodEnabled('passkey')) throw notFound();
          const session = await requireSession(ctx);
          const { userId } = session;

          const parsed = ownedRowSchema.safeParse(ctx.body);
          if (!parsed.success)
            throw unprocessable(twoFactorMsg.methodUnavailable);
          const passkeyId = parsed.data.id;

          await withTransaction(async (tx) => {
            await lockUser(tx, userId);
            // Ownership is in the WHERE, so another user's id and a missing one
            // answer identically.
            const owned = await tx
              .select({ id: passkeys.id })
              .from(passkeys)
              .where(eq(passkeys.userId, userId));
            if (!owned.some((row) => row.id === passkeyId)) throw notFound();

            const enrolled = await listEnrolledMethods(userId, tx);
            const isFactor = enrolled.some(
              (entry) => entry.method === 'passkey'
            );
            const removesMethod = isFactor && owned.length === 1;
            if (
              removesMethod &&
              (enrolled.length === 1 ||
                removalStrandsTwoFactor(
                  await readEnrollmentState(userId, tx),
                  'passkey',
                  null
                ))
            )
              throw conflict(twoFactorMsg.lastMethod);

            await tx.delete(passkeys).where(eq(passkeys.id, passkeyId));

            if (removesMethod) {
              await removeMethodIntent(tx, userId, 'passkey');
              await auditLifecycle(tx, ctx, session, {
                passkeyDeleted: passkeyId,
                twoFactorMethodRemoved: 'passkey',
                remaining: enrolled.length - 1,
              });
              await revokeTwoFactorState(tx, userId);
              return;
            }
            await auditLifecycle(tx, ctx, session, {
              passkeyDeleted: passkeyId,
              passkeysRemaining: owned.length - 1,
            });
          });

          return ctx.json({ success: true, data: { deleted: true } });
        }
      ),

      /**
       * Turns the whole feature off for the caller.
       *
       * Replaces the plugin's `/two-factor/disable`, which touched the flag, the
       * credential row, the caller's session and its own trust cookie — leaving
       * intent rows, this deployment's trusted devices, and any live challenge
       * behind.
       */
      disableTwoFactor: createAuthEndpoint(
        '/two-factor/disable',
        {
          method: 'POST',
          body: z.record(z.string(), z.unknown()),
          use: [sessionMiddleware],
          metadata: {
            openapi: envelopeResponse('Two-factor authentication is off.'),
          },
        },
        async (ctx) => {
          const session = await requireSession(ctx);
          const { userId } = session;
          await requireReauthPassword(ctx, userId);

          await withTransaction(async (tx) => {
            await lockUser(tx, userId);
            await tx
              .delete(twoFactorMethods)
              .where(eq(twoFactorMethods.userId, userId));
            await tx
              .delete(twoFactorCredentials)
              .where(eq(twoFactorCredentials.userId, userId));
            await tx
              .update(users)
              .set({ twoFactorEnabled: false })
              .where(eq(users.id, userId));
            // Registered passkeys are deliberately KEPT: they are named
            // credentials the user manages at `/passkey/*`, and with no intent
            // row none of them is a second factor. Deleting them here would
            // make "turn 2FA off" quietly destroy hardware enrolments.
            await revokeTwoFactorState(tx, userId);
            await auditLifecycle(tx, ctx, session, {
              twoFactorEnabled: false,
              twoFactorDisabled: true,
            });
          });

          return ctx.json({ success: true, message: twoFactorMsg.disabled });
        }
      ),

      /**
       * The re-authentication in front of a WebAuthn ceremony.
       *
       * The ceremony endpoints are the library's, take the library's bodies and
       * span two requests, so the password cannot ride on them. It is proven
       * here once and spent by `/passkey/verify-registration` and
       * `/passkey/delete-passkey` — the two that add and remove a factor.
       */
      passkeyEnrolmentGrant: createAuthEndpoint(
        '/two-factor/passkey/grant',
        {
          method: 'POST',
          body: z.record(z.string(), z.unknown()),
          use: [sessionMiddleware],
          metadata: {
            openapi: envelopeResponse('A single-use enrolment grant.', {
              type: 'object',
              properties: { grant: { type: 'string' } },
              required: ['grant'],
            }),
          },
        },
        async (ctx) => {
          if (!isTwoFactorMethodEnabled('passkey')) throw notFound();
          const { userId } = await requireSession(ctx);
          await requireReauthPassword(ctx, userId);
          return ctx.json({
            success: true,
            data: {
              grant: await mintReauthGrant(ctx, {
                userId,
                purpose: 'two_factor_enrolment',
              }),
            },
          });
        }
      ),
    },
  }) satisfies BetterAuthPlugin;

/**
 * Removing a method removes what made it usable, or the method could be re-added
 * by an intent write alone and be live again with no proof.
 *
 * `passkey` is the exception and it is deliberate: the credentials stay, because
 * a user removing "passkey as a second factor" has not asked for their hardware
 * keys to be destroyed. With no intent row they are not offered.
 */
async function clearCapabilityFor(
  tx: Tx,
  userId: EntityID,
  method: TwoFactorMethod
): Promise<void> {
  if (method === 'totp')
    await tx
      .update(twoFactorCredentials)
      .set({ verified: false })
      .where(eq(twoFactorCredentials.userId, userId));
  else if (method === 'backup_code')
    await tx
      .update(twoFactorCredentials)
      .set({
        backupCodesAcknowledgedVersion: null,
        backupCodesAcknowledgedAt: null,
      })
      .where(eq(twoFactorCredentials.userId, userId));
}

/**
 * Records a registered passkey as a second factor.
 *
 * ⚠️ Never throws: the plugin has already persisted the credential when this
 * runs. The failure direction is benign — no intent row means the passkey is
 * simply not offered, and `two_factor_enabled` is written in the same
 * transaction, so a failure adds nothing rather than half of something.
 */
export async function recordPasskeyEnrolment(
  ctx: AuthContext,
  session: RequestSession
): Promise<boolean> {
  try {
    await withTransaction(async (tx) => {
      await lockUser(tx, session.userId);
      await recordMethodIntent(tx, {
        userId: session.userId,
        method: 'passkey',
      });
      await tx
        .update(users)
        .set({ twoFactorEnabled: true })
        .where(eq(users.id, session.userId));
      // Adding a method evicts every other session, the caller's own kept —
      // the same rotation the TOTP confirmation and the OTP enrolment perform.
      await revokeOtherSessions(tx, session.userId, session.sessionId);
      await auditLifecycle(tx, ctx, session, {
        twoFactorMethodAdded: 'passkey',
        twoFactorEnabled: true,
      });
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * One backup code was just spent by the plugin's verifier.
 *
 * ⚠️ The count is kept in a column because the codes themselves live in one
 * encrypted blob that cannot be counted without the key, and `readEnrollment`
 * runs on every sign-in. The plugin owns the blob, so this is the one place the
 * two can disagree — and the direction is chosen: a LOST decrement leaves the
 * count too high, so the method stays offered and an exhausted set answers
 * "invalid code" rather than the user being silently refused a factor they
 * still hold. `GREATEST(..., 0)` is what keeps it from going negative when they
 * do drift.
 */
export async function spendBackupCode(userId: EntityID): Promise<void> {
  await db
    .update(twoFactorCredentials)
    .set({
      backupCodesRemaining: sql`GREATEST(${twoFactorCredentials.backupCodesRemaining} - 1, 0)`,
    })
    .where(eq(twoFactorCredentials.userId, userId));
}
