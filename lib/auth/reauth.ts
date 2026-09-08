import type { BetterAuthPlugin } from 'better-auth';

import { and, eq, gt } from 'drizzle-orm';

import { withTransaction } from '@/db';
import { passkeys, sessions, users, verifications } from '@/db/schema';
import { sanitizeForLog } from '@/utils';
import { createAuthEndpoint } from 'better-auth/api';
import * as z from 'zod';
import { auditLog } from '@/lib/audit';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

import { CustomError } from '@/utils/error-class';
import { isTwoFactorMethodEnabled } from '@/utils/validation/two-factor';

import { mintAdminReauth } from './admin-reauth';
import { authenticationDenied, toAuthApiError } from './api-error';
import { authAuditMeta } from './audit-meta';
import { authenticationStartedAt } from './authentication-time';
import {
  advancePasskeyCounter,
  passkeyOptions,
  verifyUserPasskey,
} from './passkey-assertion';
import { envelopeResponse } from './plugin-openapi';
import { availableReauthMethods } from './reauth-methods';
import { requireReauthSession } from './request-context';
import { lockEligibleAuthUser } from './user-eligibility';

export const reauthPasskeySchema = z
  .object({ response: z.record(z.string(), z.unknown()) })
  .strict();

const ceremonySchema = z.object({
  challenge: z.string(),
  startedAt: z.number().int().safe(),
});

export const reauthentication = () =>
  ({
    id: 'reauthentication',
    endpoints: {
      reauthMethods: createAuthEndpoint(
        '/reauth/methods',
        {
          method: 'GET',
          metadata: {
            openapi: envelopeResponse(
              'Methods available for this authenticated account.',
              {
                type: 'object',
                properties: {
                  methods: {
                    type: 'array',
                    items: {
                      type: 'string',
                      enum: ['password', 'passkey'],
                    },
                  },
                },
                required: ['methods'],
              }
            ),
          },
        },
        async (ctx) => {
          const { userId } = await requireReauthSession(ctx);
          return ctx.json({
            success: true,
            data: { methods: await availableReauthMethods(userId) },
          });
        }
      ),
      ...(isTwoFactorMethodEnabled('passkey') && {
        reauthPasskeyOptions: createAuthEndpoint(
          '/reauth/passkey/options',
          {
            method: 'POST',
            metadata: {
              openapi: envelopeResponse(
                'User-verifying WebAuthn options bound to this session.',
                { type: 'object' }
              ),
            },
          },
          async (ctx) => {
            try {
              const { userId, sessionId } = await requireReauthSession(ctx);
              await enforceRateLimit({
                scope: 'dash.reauth',
                identifier: userIdentifier(userId),
                limit: 10,
                failClosed: true,
              });
              const options = await passkeyOptions(userId);
              await withTransaction(async (tx) => {
                const user = await lockEligibleAuthUser(
                  tx,
                  eq(users.id, userId)
                );
                const [live] = await tx
                  .select({ id: sessions.id })
                  .from(sessions)
                  .where(
                    and(
                      eq(sessions.id, sessionId),
                      eq(sessions.userId, userId),
                      gt(sessions.expiresAt, new Date())
                    )
                  );
                if (!user || !live) throw authenticationDenied();
                await tx
                  .delete(verifications)
                  .where(
                    eq(verifications.identifier, `reauth-passkey-${sessionId}`)
                  );
                await tx.insert(verifications).values({
                  identifier: `reauth-passkey-${sessionId}`,
                  value: JSON.stringify({
                    challenge: options.challenge,
                    startedAt: await authenticationStartedAt(tx),
                  }),
                  expiresAt: new Date(Date.now() + 300_000),
                });
              });
              return ctx.json({ success: true, data: options });
            } catch (error) {
              if (error instanceof CustomError)
                throw toAuthApiError(error, 'Reauthentication failed.');
              throw error;
            }
          }
        ),
        reauthPasskeyVerify: createAuthEndpoint(
          '/reauth/passkey/verify',
          {
            method: 'POST',
            body: reauthPasskeySchema,
            metadata: {
              openapi: envelopeResponse('Reauthentication granted.', {
                type: 'object',
                properties: { expiresIn: { type: 'integer' } },
                required: ['expiresIn'],
              }),
            },
          },
          async (ctx) => {
            try {
              const { userId, sessionId, userEmail } =
                await requireReauthSession(ctx);
              await enforceRateLimit({
                scope: 'dash.reauth',
                identifier: userIdentifier(userId),
                limit: 10,
                failClosed: true,
              });
              const stored =
                await ctx.context.internalAdapter.consumeVerificationValue(
                  `reauth-passkey-${sessionId}`
                );
              if (!stored) throw authenticationDenied();
              const ceremony = ceremonySchema.parse(JSON.parse(stored.value));
              const verified = await verifyUserPasskey(
                userId,
                ctx.body.response,
                ceremony.challenge
              );
              const grant = await withTransaction(async (tx) => {
                await tx
                  .select({ id: users.id })
                  .from(users)
                  .where(eq(users.id, userId))
                  .for('update');
                const [credential] = await tx
                  .select()
                  .from(passkeys)
                  .where(
                    and(
                      eq(passkeys.id, verified.credential.id),
                      eq(passkeys.userId, userId)
                    )
                  )
                  .for('update');
                if (
                  !credential ||
                  credential.publicKey !== verified.credential.publicKey
                )
                  throw authenticationDenied();
                if (
                  !(await advancePasskeyCounter(
                    credential.id,
                    verified.newCounter,
                    tx
                  ))
                )
                  console.error(
                    sanitizeForLog({
                      msg: 'reauth.passkey.counterReconciled',
                      passkeyId: credential.id,
                    })
                  );
                await auditLog(tx, {
                  userId,
                  userEmail,
                  action: 'UPDATE',
                  tableName: 'sessions',
                  recordId: sessionId,
                  oldData: {},
                  newData: { reauthenticated: true, method: 'passkey' },
                  meta: authAuditMeta(ctx),
                });
                return mintAdminReauth(
                  userId,
                  sessionId,
                  'passkey',
                  tx,
                  ceremony.startedAt
                );
              });
              return ctx.json({ success: true, data: grant });
            } catch (error) {
              if (error instanceof CustomError)
                throw toAuthApiError(error, 'Reauthentication failed.');
              throw authenticationDenied();
            }
          }
        ),
      }),
    },
  }) satisfies BetterAuthPlugin;
