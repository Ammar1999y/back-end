/**
 * Trusted devices: the one mechanism here that skips the second factor, and so
 * the one a user has to be able to see and revoke.
 *
 * The plugin's own version is a bare `verification` row holding a user id, whose
 * identifier rotates on every sign-in — nothing to list, and any companion
 * record would be orphaned within one login. `trustDevice` is therefore forced
 * off on the plugin's verify endpoints (`lib/auth.ts`) and every record that
 * grants a skip is written here.
 *
 * The cookie keeps the plugin's format, `<hmac>!<identifier>` over
 * `<userId>!<identifier>`. Binding the user into the signature is what stops a
 * holder of one device's cookie naming another user's row.
 */
import crypto from 'node:crypto';
import type { AuthContext } from './two-factor-challenge';
import type { Tx } from '@/db';
import type { EntityID } from '@/types';
import type { BetterAuthPlugin } from 'better-auth';

import { and, desc, eq, gt } from 'drizzle-orm';

import { twoFactorMsg } from '@/app/api/auth/otp/messages';
import { db, withTransaction } from '@/db';
import { trustedDevices } from '@/db/schema';
import { sanitizeForLog, validID } from '@/utils';
import {
  APIError,
  createAuthEndpoint,
  sessionMiddleware,
} from 'better-auth/api';
import { expireCookie } from 'better-auth/cookies';
import * as z from 'zod';

import {
  CUSTOM_AUTH_CODE,
  HTTP_STATUS,
  MSG_INVALID_INPUT,
  MSG_LOGIN_REQUIRED,
  MSG_NOT_FOUND,
} from '@/utils/api-messages';

import { getClientIp, USER_AGENT_MAX } from '../audit';
import { envelopeResponse } from './plugin-openapi';
import { consumeTwoFactorProof } from './two-factor-challenge';

const TRUST_COOKIE_NAME = 'trust_device';

/** Refreshed on each use, so an active device stays trusted and an idle one lapses. */
const TRUST_DEVICE_MAX_AGE_S = 30 * 24 * 60 * 60;

const IDENTIFIER_BYTES = 24;

/**
 * `node:crypto` rather than `@better-auth/utils/hmac`, a transitive dependency
 * this project does not declare. The encoding is pinned by the cookie format.
 */
function signTrust(secret: string, userId: string, identifier: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${userId}!${identifier}`, 'utf8')
    .digest('base64url');
}

/**
 * Whether this request carries trust for `userId`, refreshing it if so. Any
 * failure expires the cookie rather than leaving a value that fails again on
 * every later request.
 *
 * The identifier is deliberately not rotated on use: the row is already bounded
 * by `expiresAt`, revocable by the user, and dropped by credential rotation.
 */
export async function consumeDeviceTrust(
  ctx: AuthContext,
  userId: EntityID
): Promise<boolean> {
  const cookie = ctx.context.createAuthCookie(TRUST_COOKIE_NAME, {
    maxAge: TRUST_DEVICE_MAX_AGE_S,
  });
  const raw = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (typeof raw !== 'string' || !raw) return false;

  const [token, identifier] = raw.split('!', 2);
  if (!token || !identifier) {
    expireCookie(ctx, cookie);
    return false;
  }

  const expected = signTrust(ctx.context.secret, userId, identifier);
  // Length-checked first: `timingSafeEqual` throws on differing lengths.
  const matches =
    token.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  if (!matches) {
    expireCookie(ctx, cookie);
    return false;
  }

  const [row] = await db
    .update(trustedDevices)
    .set({
      lastUsedAt: new Date(),
      expiresAt: new Date(Date.now() + TRUST_DEVICE_MAX_AGE_S * 1000),
    })
    .where(
      and(
        eq(trustedDevices.trustIdentifier, identifier),
        eq(trustedDevices.userId, userId),
        gt(trustedDevices.expiresAt, new Date())
      )
    )
    .returning({ id: trustedDevices.id });

  if (!row) {
    expireCookie(ctx, cookie);
    return false;
  }

  // Refreshed in the response too, so the cookie does not lapse before its row.
  await ctx.setSignedCookie(
    cookie.name,
    raw,
    ctx.context.secret,
    cookie.attributes
  );
  return true;
}

async function grantDeviceTrust(
  ctx: AuthContext,
  userId: EntityID
): Promise<void> {
  const identifier = `trust-device-${crypto.randomBytes(IDENTIFIER_BYTES).toString('base64url')}`;
  const headers = ctx.headers ?? ctx.request?.headers ?? new Headers();
  const expiresAt = new Date(Date.now() + TRUST_DEVICE_MAX_AGE_S * 1000);

  try {
    await withTransaction((tx) =>
      tx.insert(trustedDevices).values({
        userId,
        trustIdentifier: identifier,
        userAgent: headers.get('user-agent')?.slice(0, USER_AGENT_MAX) ?? null,
        ipAddress: getClientIp(headers),
        expiresAt,
      })
    );
  } catch (error) {
    // Raised, not swallowed. The caller keeps its session either way, but
    // answering `{ trusted: true }` with no row and no cookie tells the user
    // this device is remembered when nothing recorded it.
    console.error(
      sanitizeForLog({ msg: 'twoFactor.trustDevice.failed', userId, error })
    );
    throw new APIError(HTTP_STATUS.INTERNAL_ERROR, {
      message: twoFactorMsg.sendError,
      code: CUSTOM_AUTH_CODE,
    });
  }

  const cookie = ctx.context.createAuthCookie(TRUST_COOKIE_NAME, {
    maxAge: TRUST_DEVICE_MAX_AGE_S,
  });
  await ctx.setSignedCookie(
    cookie.name,
    `${signTrust(ctx.context.secret, userId, identifier)}!${identifier}`,
    ctx.context.secret,
    cookie.attributes
  );
}

async function listTrustedDevices(userId: EntityID) {
  return db
    .select({
      id: trustedDevices.id,
      userAgent: trustedDevices.userAgent,
      ipAddress: trustedDevices.ipAddress,
      lastUsedAt: trustedDevices.lastUsedAt,
      expiresAt: trustedDevices.expiresAt,
      createdAt: trustedDevices.createdAt,
    })
    .from(trustedDevices)
    .where(
      and(
        eq(trustedDevices.userId, userId),
        gt(trustedDevices.expiresAt, new Date())
      )
    )
    .orderBy(desc(trustedDevices.lastUsedAt));
}

/**
 * The ownership predicate is in the WHERE clause rather than a prior read: a
 * check-then-delete would let a concurrent request move the row between the two.
 */
async function revokeTrustedDevice(
  tx: Tx,
  userId: EntityID,
  deviceId: string
): Promise<boolean> {
  const [removed] = await tx
    .delete(trustedDevices)
    .where(
      and(eq(trustedDevices.id, deviceId), eq(trustedDevices.userId, userId))
    )
    .returning({ id: trustedDevices.id });
  return Boolean(removed);
}

/**
 * Session-gated, plus `assertLiveSession` in `lib/auth.ts`: Better Auth's own
 * session resolution answers from the cookie cache and asks nothing about
 * whether the user is still active.
 *
 * Granting is its own endpoint rather than a `trustDevice` flag on each verify
 * call, because the plugin's verify endpoints have that flag forced off.
 *
 * ⚠️ FRONTEND: a "remember this device" checkbox on the 2FA prompt is TWO calls
 * — verify, then this — not a field on the first.
 */
export const trustedDevicePlugin = () =>
  ({
    id: 'trusted-device',
    endpoints: {
      trustCurrentDevice: createAuthEndpoint(
        '/two-factor/trust-device',
        {
          method: 'POST',
          use: [sessionMiddleware],
          metadata: {
            openapi: envelopeResponse('This device is now trusted.'),
          },
        },
        async (ctx) => {
          const userId = validID(ctx.context.session?.user.id);
          const sessionId = validID(ctx.context.session?.session.id);
          if (!userId || !sessionId)
            throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
              message: MSG_LOGIN_REQUIRED,
              code: CUSTOM_AUTH_CODE,
            });

          // A session alone is not enough. This grants a 30-day skip of the
          // second factor, so it is redeemable only against a single-use proof
          // that THIS session was created by completing one — otherwise a
          // session planted before the user enabled 2FA could mint the skip.
          if (!(await consumeTwoFactorProof(ctx, sessionId)))
            throw new APIError(HTTP_STATUS.FORBIDDEN, {
              message: twoFactorMsg.trustRequiresProof,
              code: CUSTOM_AUTH_CODE,
            });

          await grantDeviceTrust(ctx, userId);
          return ctx.json({ success: true, data: { trusted: true } });
        }
      ),

      listTrustedDevices: createAuthEndpoint(
        '/two-factor/trusted-devices',
        {
          method: 'GET',
          use: [sessionMiddleware],
          metadata: {
            openapi: envelopeResponse('The caller’s trusted devices.', {
              type: 'object',
              properties: {
                devices: { type: 'array', items: { type: 'object' } },
              },
              required: ['devices'],
            }),
          },
        },
        async (ctx) => {
          const userId = validID(ctx.context.session?.user.id);
          if (!userId)
            throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
              message: MSG_LOGIN_REQUIRED,
              code: CUSTOM_AUTH_CODE,
            });
          return ctx.json({
            success: true,
            data: { devices: await listTrustedDevices(userId) },
          });
        }
      ),

      revokeTrustedDevice: createAuthEndpoint(
        '/two-factor/trusted-devices/revoke',
        {
          method: 'POST',
          body: z.record(z.string(), z.unknown()),
          use: [sessionMiddleware],
          metadata: {
            openapi: envelopeResponse('The device was revoked.'),
          },
        },
        async (ctx) => {
          const userId = validID(ctx.context.session?.user.id);
          if (!userId)
            throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
              message: MSG_LOGIN_REQUIRED,
              code: CUSTOM_AUTH_CODE,
            });

          const deviceId = validID(
            (ctx.body as { id?: unknown } | undefined)?.id
          );
          if (!deviceId)
            throw new APIError(HTTP_STATUS.UNPROCESSABLE, {
              message: MSG_INVALID_INPUT,
              code: CUSTOM_AUTH_CODE,
            });

          const removed = await withTransaction((tx) =>
            revokeTrustedDevice(tx, userId, deviceId)
          );
          // A device that is not the caller's and one that does not exist answer
          // identically, so the response cannot probe for other users' rows.
          if (!removed)
            throw new APIError(HTTP_STATUS.NOT_FOUND, {
              message: MSG_NOT_FOUND,
              code: CUSTOM_AUTH_CODE,
            });

          return ctx.json({ success: true, data: { revoked: true } });
        }
      ),
    },
  }) satisfies BetterAuthPlugin;
