import crypto from 'node:crypto';
import type { AuthContext } from './two-factor-challenge';
import type { BetterAuthPlugin } from 'better-auth';

import { sanitizeForLog } from '@/utils';
import { APIError, createAuthEndpoint, isAPIError } from 'better-auth/api';
import {
  deleteSessionCookie,
  expireCookie,
  setSessionCookie,
} from 'better-auth/cookies';
import { generateState, parseState } from 'better-auth/oauth2';
import { google, verifyGoogleIdToken } from 'better-auth/social-providers';
import * as z from 'zod';
import { auditLog } from '@/lib/audit';
import { verifyTurnstileRequest } from '@/lib/captcha';
import { PUBLIC_ORIGIN } from '@/lib/env';

import {
  CUSTOM_AUTH_CODE,
  HTTP_STATUS,
  MSG_INVALID_INPUT,
} from '@/utils/api-messages';
import { TWO_FACTOR_ENABLED } from '@/utils/validation/two-factor';

import { authenticationDenied } from './api-error';
import { authAuditMeta } from './audit-meta';
import { authenticationStartedAt } from './authentication-time';
import { assertLiveSession } from './live-session';
import {
  ENABLED_OAUTH_PROVIDERS,
  GOOGLE_CREDENTIALS,
  GOOGLE_ENABLED,
} from './oauth-config';
import {
  GOOGLE_ISSUER,
  googleIdentity,
  GoogleIdentityDenied,
  resolveGoogleIdentity,
} from './oauth-identity';
import { envelopeResponse } from './plugin-openapi';
import { submittedRememberMe } from './remember-me';
import { recordAbandonedSession } from './session-audit';
import { withAuthTransaction } from './transaction';
import {
  issueTwoFactorChallenge,
  readEnrollmentState,
} from './two-factor-challenge';

export const googleStartSchema = z
  .object({
    mode: z.literal('sign_in').default('sign_in'),
    callbackURL: z.string().min(1).max(2048).optional(),
    rememberMe: z.boolean().optional(),
  })
  .strict();

const flowSchema = z.object({
  startedAt: z.number(),
  rememberMe: z.boolean(),
  returnURL: z.string().nullable(),
});

const outcomeData = {
  type: 'object',
  properties: { loggedIn: { const: true } },
  required: ['loggedIn'],
  additionalProperties: false,
};

const googleProvider = GOOGLE_CREDENTIALS
  ? google({
      ...GOOGLE_CREDENTIALS,
      disableDefaultScope: true,
      scope: ['openid', 'email'],
      accessType: 'online',
      includeGrantedScopes: false,
      disableSignUp: true,
    })
  : null;

function returnURL(input: string | undefined) {
  if (!input) return null;
  try {
    const url = new URL(input, PUBLIC_ORIGIN);
    if (
      url.origin !== PUBLIC_ORIGIN ||
      url.username ||
      url.password ||
      url.hash
    )
      throw authenticationDenied();
    return url.href;
  } catch {
    throw authenticationDenied();
  }
}

async function completeResponse(
  ctx: AuthContext,
  body: object,
  destination: string | null,
  userId: string
) {
  if (!destination) return ctx.json(body);
  const token = crypto.randomBytes(32).toString('base64url');
  await ctx.context.internalAdapter.createVerificationValue({
    identifier: `oauth-result-${token}`,
    value: JSON.stringify(body),
    expiresAt: new Date(Date.now() + 60_000),
  });
  await ctx.context.internalAdapter.createVerificationValue({
    identifier: `oauth-result-owner-${token}`,
    // The user-valued companion lets credential rotation invalidate the pending result without parsing its body.
    value: userId,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const cookie = ctx.context.createAuthCookie('oauth_result', { maxAge: 60 });
  await ctx.setSignedCookie(
    cookie.name,
    token,
    ctx.context.secret,
    cookie.attributes
  );
  return ctx.redirect(destination);
}

export const oauth = () =>
  ({
    id: 'existing-user-oauth',
    endpoints: {
      authCapabilities: createAuthEndpoint(
        '/capabilities',
        {
          method: 'GET',
          metadata: {
            openapi: envelopeResponse('Enabled OAuth sign-in providers.', {
              type: 'object',
              properties: {
                oauthProviders: {
                  type: 'array',
                  items: { type: 'string', enum: ['google'] },
                },
              },
              required: ['oauthProviders'],
              additionalProperties: false,
            }),
          },
        },
        (ctx) =>
          ctx.json({
            success: true,
            data: { oauthProviders: ENABLED_OAUTH_PROVIDERS },
          })
      ),
      ...(GOOGLE_ENABLED && {
        googleStart: createAuthEndpoint(
          '/oauth/google/start',
          {
            method: 'POST',
            body: googleStartSchema,
            metadata: {
              openapi: envelopeResponse(
                'Navigate to the returned Google authorization URL.',
                {
                  type: 'object',
                  properties: { url: { type: 'string', format: 'uri' } },
                  required: ['url'],
                }
              ),
            },
          },
          async (ctx) => {
            if (!googleProvider) throw authenticationDenied();
            const headers =
              ctx.headers ?? ctx.request?.headers ?? new Headers();
            if (!(await verifyTurnstileRequest(headers)))
              throw new APIError(HTTP_STATUS.FORBIDDEN, {
                code: CUSTOM_AUTH_CODE,
                message: MSG_INVALID_INPUT,
              });
            const destination = returnURL(ctx.body.callbackURL);
            const nonce = crypto.randomBytes(32).toString('base64url');
            const { state, codeVerifier } = await generateState(ctx, {
              idTokenNonce: nonce,
              additionalData: {
                flow: {
                  startedAt: await authenticationStartedAt(),
                  rememberMe: submittedRememberMe(ctx.body),
                  returnURL: destination,
                },
              },
            });
            // Better Auth consumes redirect state by read/delete; this marker makes concurrent callbacks single-use.
            await ctx.context.internalAdapter.createVerificationValue({
              identifier: `oauth-once-${state}`,
              value: '-',
              expiresAt: new Date(Date.now() + 600_000),
            });
            const url = await googleProvider.createAuthorizationURL({
              state,
              codeVerifier,
              redirectURI: `${PUBLIC_ORIGIN}/api/auth/oauth/google/callback`,
              additionalParams: {
                claims: JSON.stringify({
                  id_token: {
                    amr: { essential: true },
                  },
                }),
              },
            });
            url.searchParams.set('nonce', nonce);
            return ctx.json({
              success: true,
              data: { url: url.href },
            });
          }
        ),
        googleCallback: createAuthEndpoint(
          '/oauth/google/callback',
          {
            method: 'GET',
            query: z.object({
              code: z.string().min(1).max(4096).optional(),
              state: z.string().min(1).max(128),
              error: z.string().max(256).optional(),
              iss: z.string().max(255).optional(),
            }),
            metadata: {
              openapi: envelopeResponse(
                'Google sign-in result or local two-factor challenge. A supplied callbackURL receives a redirect; retrieve the result once at /oauth/result.',
                outcomeData
              ),
            },
          },
          async (ctx) => {
            let destination: string | null = null;
            let stage = 'state';
            try {
              if (!googleProvider || !GOOGLE_CREDENTIALS)
                throw authenticationDenied();
              const state = await parseState(ctx);
              const flow = flowSchema.parse(state.flow);
              destination = returnURL(flow.returnURL ?? undefined);
              const once =
                await ctx.context.internalAdapter.consumeVerificationValue(
                  `oauth-once-${ctx.query.state}`
                );
              if (
                !once ||
                !ctx.query.code ||
                ctx.query.error ||
                !state.idTokenNonce ||
                (ctx.query.iss && ctx.query.iss !== GOOGLE_ISSUER)
              )
                throw authenticationDenied();
              stage = 'token_exchange';
              const tokens = await googleProvider.validateAuthorizationCode({
                code: ctx.query.code,
                codeVerifier: state.codeVerifier,
                redirectURI: `${PUBLIC_ORIGIN}/api/auth/oauth/google/callback`,
              });
              if (!tokens.idToken) throw authenticationDenied();
              stage = 'token_verification';
              const claims = await verifyGoogleIdToken({
                token: tokens.idToken,
                audience: GOOGLE_CREDENTIALS.clientId,
                nonce: state.idTokenNonce,
              });
              // The verifier validates exp when present, but does not require the claim.
              if (
                !claims ||
                typeof claims.exp !== 'number' ||
                !Number.isSafeInteger(claims.exp) ||
                claims.exp <= Math.floor(Date.now() / 1000) ||
                (claims.azp !== undefined &&
                  claims.azp !== GOOGLE_CREDENTIALS.clientId)
              )
                throw authenticationDenied();
              stage = 'identity';
              const identity = googleIdentity(claims);
              const meta = authAuditMeta(ctx);
              const result = await withAuthTransaction(ctx, async (tx) => {
                const user = await resolveGoogleIdentity(
                  tx,
                  identity,
                  flow.startedAt,
                  meta
                );
                const bypassTwoFactor = TWO_FACTOR_ENABLED && identity.mfa;
                const enrolled = bypassTwoFactor
                  ? await readEnrollmentState(user.id, tx)
                  : null;
                const session = await ctx.context.internalAdapter.createSession(
                  user.id,
                  !flow.rememberMe
                );
                if (!session) throw authenticationDenied();
                if (enrolled?.enabled)
                  await auditLog(tx, {
                    userId: user.id,
                    userEmail: user.email,
                    action: 'INSERT',
                    tableName: 'sessions',
                    recordId: session.id,
                    oldData: null,
                    newData: {
                      firstFactor: 'google',
                      twoFactorBypass: 'google_mfa',
                      reason: 'two_factor_skipped_google_mfa',
                    },
                    meta,
                  });
                const outcome = bypassTwoFactor
                  ? null
                  : await issueTwoFactorChallenge(ctx, {
                      userId: user.id,
                      userEmail: user.email,
                      session,
                      firstFactor: 'google',
                      transaction: tx,
                      rememberMe: flow.rememberMe,
                      auditMeta: meta,
                    });
                if (outcome?.kind === 'refused') throw authenticationDenied();
                return { user, session, outcome };
              });
              const session = result.session;
              if (!session) throw authenticationDenied();
              stage = 'post_commit_admission';
              try {
                if (result.outcome?.kind === 'challenge') {
                  stage = 'result_delivery';
                  return await completeResponse(
                    ctx,
                    result.outcome.body,
                    destination,
                    result.user.id
                  );
                }
                await assertLiveSession(session.id, result.user.id);
                const user = await ctx.context.internalAdapter.findUserById(
                  result.user.id
                );
                if (!user || user.email !== identity.email)
                  throw authenticationDenied();
                stage = 'cookie_delivery';
                await setSessionCookie(
                  ctx,
                  { session, user },
                  !flow.rememberMe
                );
                if (flow.rememberMe)
                  expireCookie(ctx, ctx.context.authCookies.dontRememberToken);
                stage = 'result_delivery';
                return await completeResponse(
                  ctx,
                  { success: true, data: { loggedIn: true } },
                  destination,
                  result.user.id
                );
              } catch (error) {
                try {
                  await ctx.context.internalAdapter.deleteSession(
                    session.token
                  );
                } finally {
                  deleteSessionCookie(ctx, true);
                  await recordAbandonedSession({
                    userId: result.user.id,
                    userEmail: result.user.email,
                    sessionId: session.id,
                    auditMeta: meta,
                    reason:
                      stage === 'post_commit_admission'
                        ? 'post_commit_admission_failed'
                        : stage === 'result_delivery'
                          ? 'result_delivery_failed'
                          : 'cookie_delivery_failed',
                  });
                }
                throw error;
              }
            } catch (error) {
              const denial = error instanceof GoogleIdentityDenied;
              const diagnostic = sanitizeForLog({
                msg: 'oauth.signIn.failed',
                provider: 'google',
                stage,
                reason: denial
                  ? error.reason
                  : isAPIError(error)
                    ? 'authentication_denied'
                    : 'unexpected_failure',
              });
              if (denial) console.warn(diagnostic);
              else console.error(diagnostic);
              if (destination)
                return completeResponse(
                  ctx,
                  { success: false },
                  destination,
                  '-'
                );
              throw authenticationDenied();
            }
          }
        ),
        oauthResult: createAuthEndpoint(
          '/oauth/result',
          {
            method: 'GET',
            metadata: {
              openapi: envelopeResponse(
                'Consume the Google redirect result once.',
                outcomeData
              ),
            },
          },
          async (ctx) => {
            const cookie = ctx.context.createAuthCookie('oauth_result');
            const token = await ctx.getSignedCookie(
              cookie.name,
              ctx.context.secret
            );
            if (!token || !/^[\w-]{43}$/.test(token))
              throw authenticationDenied();
            expireCookie(ctx, cookie);
            const owner =
              await ctx.context.internalAdapter.consumeVerificationValue(
                `oauth-result-owner-${token}`
              );
            const result =
              await ctx.context.internalAdapter.consumeVerificationValue(
                `oauth-result-${token}`
              );
            if (!owner || !result) throw authenticationDenied();
            const body: unknown = JSON.parse(result.value);
            if (
              !body ||
              typeof body !== 'object' ||
              Array.isArray(body) ||
              !('success' in body) ||
              body.success !== true
            )
              throw authenticationDenied();
            return ctx.json(body);
          }
        ),
      }),
    },
  }) satisfies BetterAuthPlugin;
