import type { AcceptedPasswordHashes } from './auth/login-guard';
import type { EntityID } from '@/types';
import type { TwoFactorMethod } from '@/utils/validation/two-factor';

import { eq } from 'drizzle-orm';

import { twoFactorMsg } from '@/app/api/auth/otp/messages';
import { db, withTransaction } from '@/db';
import * as schema from '@/db/schema';
import { users } from '@/db/schema';
import { sanitizeForLog, validID } from '@/utils';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import {
  APIError,
  createAuthMiddleware,
  formCsrfMiddleware,
  isAPIError,
} from 'better-auth/api';
import { captcha, openAPI } from 'better-auth/plugins';
import { PUBLIC_ORIGIN } from '@/lib/env';

import {
  CUSTOM_AUTH_CODE,
  EMAIL_NOT_VERIFIED_CODE,
  HTTP_STATUS,
  MSG_EMAIL_NOT_VERIFIED,
  MSG_INVALID_CREDENTIALS,
  MSG_INVALID_INPUT,
  MSG_LOGIN_REQUIRED,
  MSG_PAGE_NOT_FOUND,
  MSG_PHONE_NOT_VERIFIED,
  PHONE_NOT_VERIFIED_CODE,
} from '@/utils/api-messages';
import {
  REQUIRE_EMAIL_VERIFICATION,
  REQUIRE_PHONE_VERIFICATION,
} from '@/utils/config';
import { loginSchema } from '@/utils/validation/auth';
import { NAME_MAX, PASSWORD_MAX } from '@/utils/validation/constants';
import {
  EMAIL_OTP_AVAILABLE,
  PHONE_OTP_AVAILABLE,
} from '@/utils/validation/otp';
import { normalizePasswordInput } from '@/utils/validation/rules';

import {
  API_PATH_MAX,
  auditLog,
  getClientIp,
  TRUSTED_IP_HEADERS,
  USER_AGENT_MAX,
} from './audit';
import { BETTER_AUTH_ALLOWED_PATH_SET } from './auth/allowed-paths';
import { BASE_ERROR_CODES } from './auth/code-errors';
import { assertLiveSession } from './auth/live-session';
import { LoginRejected, verifyLoginAttempt } from './auth/login-guard';
import { hashPassword } from './auth/password';
import { consumePasswordProof, mintPasswordProof } from './auth/password-proof';
import { passwordless } from './auth/passwordless';
import { consumeReauthGrant } from './auth/reauth-grant';
import { submittedRememberMe } from './auth/remember-me';
import { twoFactorPlugins } from './auth/two-factor';
import {
  PLUGIN_VERIFIER_METHOD,
  resolveRequestSession,
  resolveTwoFactorChallenge,
} from './auth/two-factor-challenge';
import { REQUIRE_ROLE_FOR_LOGIN } from './permissions/constants';
import { sanitizePermissions } from './permissions/utils';

// ⚠️ WARNING: password.verify below accepts ONLY a proof minted by the before
// hook after a real verifyLoginAttempt(). If you add a path that relies on
// Better Auth's built-in password verification, you MUST mint a proof for it in
// the before hook — see PASSWORD_PROOF_PATHS. Without that the path rejects
// every password, which is the deliberate failure direction: it is visible
// immediately, where the previous `async () => true` accepted every password.
/**
 * The complete Better Auth surface this deployment exposes. Every other Better
 * Auth path is answered 404 by the `before` hook below, so this set — not Better
 * Auth's own route table — is what the API contract may advertise.
 *
 * Defined in `./auth/allowed-paths` so `routes.ts` can read the same set without
 * importing Better Auth. Enforcement and advertisement cannot drift apart.
 */
const ALLOWED_PATHS = BETTER_AUTH_ALLOWED_PATH_SET;

const CUSTOM_CODE = CUSTOM_AUTH_CODE;

/**
 * Everything the 2FA and passkey paths need before Better Auth's own middleware
 * runs: a live session, a really-verified password, and no client-chosen device
 * trust. One function because all three answers share the session lookup.
 *
 * Returns the modified context when the body had to change, `undefined`
 * otherwise.
 */
async function enforceTwoFactorPathPolicy(
  ctx: HookContext
): Promise<{ context: unknown } | undefined> {
  const path = ctx.path ?? '';
  assertPasskeyInputBounds(ctx, path);
  const needsProof = PASSWORD_PROOF_PATHS.has(path);
  const needsLiveSession = LIVE_SESSION_PATHS.has(path);
  const stripsTrustDevice = TRUST_DEVICE_STRIPPED_PATHS.has(path);
  const dualMode = DUAL_MODE_LIVE_SESSION_PATHS.has(path);
  const needsGrant = REAUTH_GRANT_PATHS.has(path);

  const pluginMethod = PLUGIN_VERIFIER_METHOD[path];
  if (pluginMethod) await assertPluginVerifierOffered(ctx, pluginMethod);

  if (dualMode || needsGrant) {
    const mode = await resolveRequestSession(ctx);
    if (mode) {
      // The DATABASE, not the cookie cache: liveness is exactly the question
      // the cache cannot answer.
      try {
        await assertLiveSession(mode.sessionId, mode.userId);
      } catch {
        throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
          message: MSG_LOGIN_REQUIRED,
          code: CUSTOM_CODE,
        });
      }
      if (
        needsGrant &&
        !(await consumeReauthGrant(ctx, {
          userId: mode.userId,
          purpose: 'two_factor_enrolment',
          token: grantToken(ctx),
        }))
      )
        throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
          message: MSG_INVALID_CREDENTIALS,
          code: CUSTOM_CODE,
        });
    } else if (needsGrant)
      throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
        message: MSG_LOGIN_REQUIRED,
        code: CUSTOM_CODE,
      });
  }

  if (!needsProof && !needsLiveSession && !stripsTrustDevice) return undefined;

  const body =
    ctx.body && typeof ctx.body === 'object'
      ? (ctx.body as Record<string, unknown>)
      : {};

  // Overwritten rather than deleted: the dispatcher MERGES the returned body,
  // so an omitted key keeps the caller's value. See lib/auth/trusted-device.ts
  // for why the plugin's own trust record is refused.
  // `disableSession` rides along: set on a sign-in verification it consumes a
  // backup code and rewrites the set, then returns WITHOUT completing the
  // challenge or re-arming the attempt counter, which spends a code and bricks
  // the challenge in one call.
  const patch: Record<string, unknown> = stripsTrustDevice
    ? { trustDevice: false, disableSession: false }
    : {};

  if (!needsProof && !needsLiveSession)
    return { context: { ...ctx, body: { ...body, ...patch } } };

  const session = await readRequestSession(ctx);
  if (!session)
    throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
      message: MSG_LOGIN_REQUIRED,
      code: CUSTOM_CODE,
    });

  if (needsLiveSession) {
    try {
      await assertLiveSession(session.sessionId, session.userId);
    } catch {
      throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
        message: MSG_LOGIN_REQUIRED,
        code: CUSTOM_CODE,
      });
    }
  }

  if (!needsProof) return { context: { ...ctx, body: { ...body, ...patch } } };

  const supplied = body.password;
  if (typeof supplied !== 'string')
    throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
      message: MSG_INVALID_CREDENTIALS,
      code: CUSTOM_CODE,
    });

  const reqHeaders = requestHeaders(ctx);
  let acceptedHashes: AcceptedPasswordHashes;
  try {
    acceptedHashes = await verifyLoginAttempt({
      userId: session.userId,
      password: supplied,
      // The timing floor guards anonymous enumeration; the caller here is
      // already authenticated.
      skipTimingGuard: true,
      auditMeta: {
        ip: getClientIp(reqHeaders),
        userAgent:
          reqHeaders.get('user-agent')?.slice(0, USER_AGENT_MAX) ?? null,
        apiPath: (ctx.path ?? '').slice(0, API_PATH_MAX),
      },
      purpose: 'reauth_two_factor',
    });
  } catch (e) {
    if (e instanceof LoginRejected)
      throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
        message: MSG_INVALID_CREDENTIALS,
        code: CUSTOM_CODE,
      });
    throw e;
  }

  return {
    context: {
      ...ctx,
      body: { ...body, ...patch, password: mintPasswordProof(acceptedHashes) },
    },
  };
}

/**
 * The plugin's verifiers resolve their credential row and consult no offered
 * set, so an unacknowledged or removed backup-code set, or a TOTP confirmed
 * after the challenge was issued, would complete a sign-in the challenge never
 * offered. Sign-in mode only; a resolved session is the enrolment branch, which
 * is refused because enrolment is owned (`lib/auth/two-factor-enrolment.ts`).
 */
async function assertPluginVerifierOffered(
  ctx: HookContext,
  method: TwoFactorMethod
): Promise<void> {
  // Resolved through the library's own function, so the answer here and the
  // branch the plugin takes cannot differ.
  if (await resolveRequestSession(ctx))
    throw new APIError(HTTP_STATUS.BAD_REQUEST, {
      message: MSG_INVALID_INPUT,
      code: CUSTOM_CODE,
    });

  const challenge = await resolveTwoFactorChallenge(ctx);
  if (!challenge)
    throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
      message: twoFactorMsg.challengeMissing,
      code: CUSTOM_CODE,
    });
  if (!challenge.methods.includes(method))
    throw new APIError(HTTP_STATUS.BAD_REQUEST, {
      message: twoFactorMsg.methodUnavailable,
      code: CUSTOM_CODE,
    });
}

/**
 * From the signed cookie and the database, not the cookie cache — whose answer
 * is precisely what must not be trusted here. See `LIVE_SESSION_PATHS`.
 */
async function readRequestSession(
  ctx: HookContext
): Promise<{ userId: EntityID; sessionId: string } | null> {
  const token = await ctx.getSignedCookie(
    ctx.context.authCookies.sessionToken.name,
    ctx.context.secret
  );
  if (!token) return null;
  const found = await ctx.context.internalAdapter.findSession(token);
  const userId = validID(found?.user.id);
  if (!found || !userId) return null;
  return { userId, sessionId: found.session.id };
}

function requestHeaders(ctx: HookContext): Headers {
  return ctx.headers ?? ctx.request?.headers ?? new Headers();
}

/**
 * The bounds this schema stores under, applied to the plugin's own bodies.
 *
 * ⚠️ These paths are the library's, with the library's Zod schemas: an unbounded
 * `name` and a plain `string` id. This schema stores names in `varchar(150)` and
 * ids as UUID, so an overlong name reached the database and answered 500, and a
 * malformed id reached a UUID comparison instead of a validation response —
 * both on an authenticated surface whose contract is a 4xx envelope everywhere
 * else. `app.ts` mounts one wildcard, so this hook is the only boundary a
 * per-path schema could live on (see the Elysia note in the audit).
 */
function assertPasskeyInputBounds(ctx: HookContext, path: string): void {
  if (!PASSKEY_BOUNDED_PATHS.has(path)) return;
  const body =
    ctx.body && typeof ctx.body === 'object'
      ? (ctx.body as Record<string, unknown>)
      : {};

  const name = body.name;
  const overlongName =
    typeof name === 'string' && name.trim().length > NAME_MAX;
  const id = body.id;
  const malformedId =
    PASSKEY_ID_PATHS.has(path) && (typeof id !== 'string' || !validID(id));

  if (overlongName || malformedId)
    throw new APIError(HTTP_STATUS.UNPROCESSABLE, {
      message: MSG_INVALID_INPUT,
      code: CUSTOM_CODE,
    });
}

/** `?grant=` on the GET ceremony route, `grant` in the body on the POST ones. */
function grantToken(ctx: HookContext): unknown {
  const body =
    ctx.body && typeof ctx.body === 'object'
      ? (ctx.body as Record<string, unknown>)
      : undefined;
  return body?.grant ?? (ctx.query as { grant?: unknown } | undefined)?.grant;
}

function rejectOverlongPassword(body: unknown): void {
  if (!body || typeof body !== 'object') return;
  const supplied = (body as Record<string, unknown>).password;
  if (typeof supplied !== 'string') return;
  if (normalizePasswordInput(supplied).length <= PASSWORD_MAX) return;
  throw new APIError(HTTP_STATUS.UNPROCESSABLE, {
    message: MSG_INVALID_INPUT,
    code: CUSTOM_CODE,
  });
}

/**
 * The paths a browser reaches with no cookie at all, where Better Auth's
 * router-level origin check is skipped and its `formCsrfMiddleware` runs on the
 * endpoint itself — AFTER this hook. Anything the hook does for these paths
 * before that check runs against an unvalidated origin, so the check is run
 * here first. Every other listed path needs a session or a challenge cookie,
 * which the router-level check already validates.
 */
const FIRST_LOGIN_PATHS: ReadonlySet<string> = new Set([
  '/sign-in/email',
  '/passwordless/verify',
]);

/** How a session came to exist, from the endpoint that created it. */
const SESSION_METHOD_BY_PATH: Readonly<Record<string, string>> = {
  '/sign-in/email': 'password',
  '/passwordless/verify': 'passwordless',
  // ⚠️ The FIRST factor is not knowable from the path — a challenge completed
  // here may have followed either route — so these say only that a second
  // factor finished the login. The chain is on the completion event
  // `completeTwoFactorChallenge` writes.
  '/two-factor/verify-totp': 'two_factor',
  '/two-factor/verify-backup-code': 'two_factor',
  '/two-factor/otp/verify': 'two_factor',
  '/two-factor/passkey/verify': 'two_factor',
};

/**
 * Better Auth paths that verify a password through `validatePassword` /
 * `checkPassword`, and therefore reach `password.verify`.
 *
 * ⚠️ A password-taking path that is NOT here mints no proof and so rejects every
 * password. Update this whenever the allow-list grows.
 */
const PASSWORD_PROOF_PATHS: ReadonlySet<string> = new Set([
  // The one remaining Better Auth path that takes a password. Enable, disable
  // and backup-code generation are this deployment's own endpoints now
  // (`lib/auth/two-factor-enrolment.ts`); they call `verifyLoginAttempt`
  // directly and never reach the stubbed `password.verify`.
  '/two-factor/get-totp-uri',
]);

/**
 * Session-bearing Better Auth paths that must pass this application's liveness
 * predicate before the plugin's own middleware sees them.
 *
 * `sessionMiddleware` and `freshSessionMiddleware` resolve a session through the
 * cookie CACHE and consult neither `users.is_active` nor `users.deleted_at`, so
 * a suspended or soft-deleted user whose row still exists otherwise keeps full
 * access here — the class `lib/auth/live-session.ts` exists to close.
 */
const LIVE_SESSION_PATHS: ReadonlySet<string> = new Set([
  '/two-factor/disable',
  '/two-factor/get-totp-uri',
  '/two-factor/generate-backup-codes',
  '/two-factor/totp/start',
  '/two-factor/totp/confirm',
  '/two-factor/trust-device',
  '/two-factor/trusted-devices',
  '/two-factor/trusted-devices/revoke',
  '/two-factor/methods',
  '/two-factor/methods/disable',
  '/two-factor/methods/default',
  '/two-factor/backup-codes/acknowledge',
  '/two-factor/passkey/grant',
  // A suspended user could otherwise register a credential that survives every
  // later revocation.
  '/passkey/generate-register-options',
  '/passkey/verify-registration',
  '/passkey/list-user-passkeys',
  '/passkey/delete-passkey',
  '/passkey/update-passkey',
]);

/**
 * Paths that serve BOTH an enrolment and a sign-in verification.
 *
 * They cannot go in `LIVE_SESSION_PATHS`, which is path-keyed and would demand a
 * session on the sign-in branch, where the caller holds only a challenge cookie.
 * Liveness is required on the session branch alone — and it is required, because
 * these are writes: `sessionMiddleware` answers from the cookie cache and asks
 * nothing about `is_active`, so a suspended account was mutating its own
 * second-factor state through them.
 */
const DUAL_MODE_LIVE_SESSION_PATHS: ReadonlySet<string> = new Set([
  '/two-factor/otp/send',
  '/two-factor/otp/verify',
]);

/**
 * WebAuthn paths that add or remove a factor, and cannot carry a password of
 * their own — the ceremony spans two requests with the library's bodies. They
 * spend a grant minted by `/two-factor/passkey/grant` instead.
 */
const REAUTH_GRANT_PATHS: ReadonlySet<string> = new Set([
  '/passkey/verify-registration',
  '/passkey/delete-passkey',
]);

/** Plugin paths carrying a `name` this schema bounds at `NAME_MAX`. */
const PASSKEY_BOUNDED_PATHS: ReadonlySet<string> = new Set([
  '/passkey/verify-registration',
  '/passkey/update-passkey',
  '/passkey/delete-passkey',
]);

/** …and the subset whose `id` must be a UUID this schema could actually hold. */
const PASSKEY_ID_PATHS: ReadonlySet<string> = new Set([
  '/passkey/update-passkey',
  '/passkey/delete-passkey',
]);

/** The plugin's verification endpoints, whose `trustDevice` flag is forced off. */
const TRUST_DEVICE_STRIPPED_PATHS: ReadonlySet<string> = new Set(
  Object.keys(PLUGIN_VERIFIER_METHOD)
);

/**
 * What Better Call reports as the path of an endpoint declared without one.
 * Mirrored, and it fails closed: if the placeholder changes upstream, our own
 * `auth.api.*` calls to server-only endpoints answer 404.
 */
const SERVER_ONLY_VIRTUAL_PATH = '/';

/**
 * The server-only endpoints this deployment actually calls, by the operation id
 * the dispatcher carries (`toAuthEndpoints` sets it to the `auth.api` key).
 *
 * ⚠️ A NAMED set, not a blanket pass on the placeholder path. Every
 * `createAuthEndpoint.serverOnly` endpoint reports `'/'`, so exempting the path
 * exempted all of them at once — including `viewBackupCodes`, which returns a
 * user's DECRYPTED recovery codes for any user id. Nothing here calls it, and
 * the day something does, that has to be a deliberate edit to this list rather
 * than a consequence of the endpoint existing.
 */
const SERVER_ONLY_OPERATIONS: ReadonlySet<string> = new Set(['generateTOTP']);

type HookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

export const auth = betterAuth({
  // `PUBLIC_ORIGIN`, not the raw environment variable. Both used to be read
  // independently — CORS took a value canonicalised to scheme + hostname while
  // Better Auth took the raw string — so a path, a query, a fragment or embedded
  // credentials were discarded by one consumer and kept as input by the other.
  // Reading the parsed value here is what makes `lib/env.js` the single parse:
  // the CORS allow-list entry and the origin cookies are signed against are now
  // the same string by construction. It also means the variable rename in
  // lib/env.js (`PUBLIC_URL`, with `NEXT_PUBLIC_URL` as a legacy alias) reaches
  // this consumer; reading `process.env` directly here left `baseURL` undefined
  // whenever only the new name was set.
  baseURL: PUBLIC_ORIGIN,
  database: drizzleAdapter(db, { provider: 'pg', schema: schema }),
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
    password: {
      hash: hashPassword,
      // NOT a password check — the before hook already ran the real one. This
      // only confirms that it did, for THIS request and THIS account row. See
      // lib/auth/password-proof.ts for why it is a one-shot token rather than
      // the `async () => true` it replaces.
      verify: async ({ hash, password }) =>
        consumePasswordProof(hash, password),
    },
  },

  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      const internalSchemaGeneration =
        ctx.path === '/open-api/generate-schema' && !ctx.request;
      // A `createAuthEndpoint.serverOnly` endpoint is declared with no path and
      // never registered on the router, so Better Call gives it the placeholder
      // `'/'`. It is outside the surface this list bounds: `app.ts` enforces the
      // same list before `auth.handler` runs, so nothing arriving over HTTP
      // reaches here unlisted.
      //
      // All three are required: `!ctx.request` alone would exempt every
      // `auth.api.*` call, the placeholder alone a request for `/api/auth/`, and
      // without the operation id every server-only endpoint the dependency ships
      // is exempt at once.
      const serverOnlyEndpoint =
        ctx.path === SERVER_ONLY_VIRTUAL_PATH &&
        !ctx.request &&
        SERVER_ONLY_OPERATIONS.has(
          String((ctx as { operationId?: unknown }).operationId ?? '')
        );
      if (
        !internalSchemaGeneration &&
        !serverOnlyEndpoint &&
        !ALLOWED_PATHS.has(ctx.path)
      )
        throw new APIError(HTTP_STATUS.NOT_FOUND, {
          message: MSG_PAGE_NOT_FOUND,
          code: CUSTOM_CODE,
        });

      if (FIRST_LOGIN_PATHS.has(ctx.path)) await formCsrfMiddleware(ctx);

      rejectOverlongPassword(ctx.body);

      const twoFactorContext = await enforceTwoFactorPathPolicy(ctx);
      if (twoFactorContext) return twoFactorContext;

      if (ctx.path === '/sign-in/email') {
        const { email, password, rememberMe } =
          ctx.body && typeof ctx.body === 'object'
            ? (ctx.body as Record<string, unknown>)
            : {};

        const { success, data } = loginSchema.safeParse({
          email,
          password,
          rememberMe,
          // Already verified by the captcha plugin's `onRequest`, which runs
          // ahead of every hook.
          captcha: 'success',
        });

        if (!success) {
          throw new APIError(HTTP_STATUS.UNPROCESSABLE, {
            message: MSG_INVALID_INPUT,
            code: CUSTOM_CODE,
          });
        }

        const reqHeaders = requestHeaders(ctx);
        const auditMeta = {
          ip: getClientIp(reqHeaders),
          userAgent:
            reqHeaders.get('user-agent')?.slice(0, USER_AGENT_MAX) ?? null,
          apiPath: ctx.path.slice(0, API_PATH_MAX),
        };

        let acceptedHashes: AcceptedPasswordHashes;
        try {
          acceptedHashes = await verifyLoginAttempt({
            email: data.email,
            password: data.password,
            auditMeta,
            purpose: 'sign_in',
          });
        } catch (e) {
          if (e instanceof LoginRejected)
            throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
              message: MSG_INVALID_CREDENTIALS,
              code: CUSTOM_CODE,
            });
          throw e;
        }

        // The plaintext stops here: Better Auth's handler re-reads the account
        // and calls `password.verify` with whatever hash the row now holds, and
        // the proof accepts exactly the hashes this verification made valid.
        return {
          context: {
            ...ctx,
            body: {
              email: data.email,
              password: mintPasswordProof(acceptedHashes),
              // Carried explicitly rather than left to the dispatcher's merge:
              // it decides a session lifetime, and it has to survive into the
              // two-factor challenge's companion record.
              rememberMe: submittedRememberMe({ rememberMe: data.rememberMe }),
            },
          },
        };
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      // Better Auth's own predicate, not `instanceof`: it also accepts an
      // APIError that crossed a module-instance boundary, which is the same
      // value the dispatcher itself treats as the failure.
      const returned = ctx.context?.returned;
      const failure = isAPIError(returned) ? returned : undefined;
      const errorCode = failure?.body?.code;

      // `Object.hasOwn` + an own-property read, not `BASE_ERROR_CODES[code]`:
      // the code is framework-supplied text, and a plain object resolves
      // inherited members — `constructor` or `toString` would look like a
      // mapped code and put a function where the message belongs.
      const mappedMessage =
        typeof errorCode === 'string' &&
        Object.hasOwn(BASE_ERROR_CODES, errorCode)
          ? BASE_ERROR_CODES[errorCode]
          : undefined;

      if (errorCode && errorCode !== CUSTOM_CODE && mappedMessage) {
        throw new APIError(
          failure?.status || failure?.statusCode || HTTP_STATUS.BAD_REQUEST,
          {
            message: mappedMessage,
            code: CUSTOM_CODE,
          }
        );
      }
      if (
        errorCode &&
        errorCode !== CUSTOM_CODE &&
        errorCode !== EMAIL_NOT_VERIFIED_CODE &&
        errorCode !== PHONE_NOT_VERIFIED_CODE
      )
        console.error(sanitizeForLog(ctx.context?.returned));
    }),
  },

  advanced: {
    database: {
      generateId: false,
    },
    // Better Auth otherwise resolves the client IP from `x-forwarded-for`,
    // which is client-controllable whenever the origin is directly reachable.
    // Pin it to the same trusted edge headers the rest of the app uses so the
    // IP written into session metadata — and any Better Auth limiter — can't
    // be forged. IPv6 is bucketed by /64, matching `ipBucket`.
    //
    // TODO(proxy-trust): the header is trusted on syntax alone here too — see
    // the note on TRUSTED_IP_HEADERS in lib/audit.ts and
    // reports/should-ignore.md #63. Note also that the development fallback in
    // `getClientIp` does NOT apply to this path: Better Auth reads the headers
    // itself, so it resolves no IP locally.
    ipAddress: {
      ipAddressHeaders: [...TRUSTED_IP_HEADERS],
      ipv6Subnet: 64,
    },
  },

  logger: {
    disabled: true,
  },

  session: {
    expiresIn: 28 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60,
    freshAge: 10 * 60 * 60,
    cookieCache: {
      enabled: true,
      // TODO: set from the deployment's security policy.
      maxAge: 5 * 60,
    },
    additionalFields: {
      metadata: {
        type: 'json',
        required: false,
        defaultValue: '{}',
        input: false,
      },
    },
    modelName: 'sessions',
  },
  databaseHooks: {
    session: {
      create: {
        // Fail-closed: any error here must block session creation
        before: async (session) => {
          const userId = validID(session.userId);
          if (!userId)
            throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
              message: MSG_INVALID_CREDENTIALS,
              code: CUSTOM_CODE,
            });

          const userData = await db.query.users.findFirst({
            where: (users, { eq, and, isNull }) =>
              and(eq(users.id, userId), isNull(users.deletedAt)),
            columns: {
              isActive: true,
              roleId: true,
              emailVerified: true,
              phoneNumberVerified: true,
            },
            with: {
              role: {
                columns: {
                  id: true,
                  roleName: true,
                  scope: true,
                  isActive: true,
                },
                with: {
                  rolePermissions: {
                    columns: { pageName: true, permissions: true },
                  },
                },
              },
            },
          });

          // Block inactive users or users with inactive roles from getting sessions
          if (
            !userData ||
            !userData.isActive ||
            (userData.role && !userData.role.isActive)
          ) {
            throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
              message: MSG_INVALID_CREDENTIALS,
              code: CUSTOM_CODE,
            });
          }

          // Verification gates. These run AFTER the password has already been
          // verified (verifyLoginAttempt in the /sign-in/email before hook), so
          // revealing the distinct signal leaks nothing to someone who doesn't
          // know the password — every other login failure still returns the
          // generic 401 above. The frontend keys on the code to start the OTP
          // flow.
          //
          // Enforced ONLY when the contact can actually be verified right now
          // (an OTP channel for it is enabled). This is the deliberate design
          // (report/owner decision): the verified flag always reflects reality
          // and is never auto-flipped. So when OTP is off the gate is inert and
          // users work freely; turning OTP on later makes unverified users
          // verify at their next login, without ever losing track of who is
          // genuinely verified.
          if (
            REQUIRE_EMAIL_VERIFICATION &&
            EMAIL_OTP_AVAILABLE &&
            !userData.emailVerified
          ) {
            throw new APIError(HTTP_STATUS.FORBIDDEN, {
              message: MSG_EMAIL_NOT_VERIFIED,
              code: EMAIL_NOT_VERIFIED_CODE,
            });
          }

          if (
            REQUIRE_PHONE_VERIFICATION &&
            PHONE_OTP_AVAILABLE &&
            !userData.phoneNumberVerified
          ) {
            throw new APIError(HTTP_STATUS.FORBIDDEN, {
              message: MSG_PHONE_NOT_VERIFIED,
              code: PHONE_NOT_VERIFIED_CODE,
            });
          }

          if (!userData.roleId || !userData.role) {
            if (REQUIRE_ROLE_FOR_LOGIN) {
              throw new APIError(HTTP_STATUS.UNAUTHORIZED, {
                message: MSG_INVALID_CREDENTIALS,
                code: CUSTOM_CODE,
              });
            }
            return {
              data: {
                ...session,
                metadata: {},
              },
            };
          }

          return {
            data: {
              ...session,
              metadata: {
                roleId: userData.roleId,
                roleName: userData.role.roleName,
                roleScope: userData.role.scope,
                permissions: sanitizePermissions(userData.role.rolePermissions),
              },
            },
          };
        },
        /**
         * The ONE place `loginSuccess` is written, for every method that issues
         * a session: it runs only after the session row exists, so the marker
         * means exactly that. Password proofs are a different event
         * (`passwordVerified`, labelled by purpose), written by
         * `verifyLoginAttempt`, and a rejected sign-in produces only that one.
         *
         * Best-effort: the session is already created and the cookie already on
         * its way, so failing the request now would log the user in and tell them
         * it did not work. The authoritative record for what was PROVEN is the
         * in-transaction event each method writes (`passwordVerified` for
         * password sign-in, `passwordlessProofVerified` for the OTP path).
         *
         * `context.path` is a WEAK method discriminator and `SESSION_METHOD_BY_PATH`
         * is best-effort labelling, not the factor chain: several 2FA verify
         * paths create sessions here, a first-factor session is logged
         * successful before the challenge withdraws it, and a trusted-device
         * skip is not represented at all. The authoritative record of what was
         * proven is the completion event `completeTwoFactorChallenge` writes.
         */
        after: async (session, context) => {
          try {
            const userId = validID(session.userId);
            if (!userId) return;

            const [user] = await db
              .select({ email: users.email })
              .from(users)
              .where(eq(users.id, userId))
              .limit(1);
            // `audit_logs.user_email` is NOT NULL, so there is nothing to write
            // without it.
            if (!user) return;

            const path = context?.path ?? null;
            await withTransaction((tx) =>
              auditLog(tx, {
                userId,
                userEmail: user.email,
                // INSERT, not UPDATE: the row this describes was just created,
                // and `computeChangedFields({}, newData)` was reporting every
                // key as changed against a prior state that never existed.
                // `oldData: null` says the same thing honestly.
                action: 'INSERT',
                tableName: 'sessions',
                recordId: session.id,
                oldData: null,
                newData: {
                  loginSuccess: true,
                  method: SESSION_METHOD_BY_PATH[path ?? ''] ?? 'unknown',
                  authPath: path,
                },
                meta: {
                  // The values Better Auth resolved for the session row itself,
                  // so the audit row and the session agree by construction.
                  ip: session.ipAddress ?? null,
                  userAgent:
                    session.userAgent?.slice(0, USER_AGENT_MAX) ?? null,
                  apiPath: (path ?? 'session.create').slice(0, API_PATH_MAX),
                },
              })
            );
          } catch (error) {
            console.error(
              sanitizeForLog({ msg: 'session.loginAudit.failed', error })
            );
          }
        },
      },
    },
  },

  rateLimit: {
    enabled: false,
  },

  user: {
    modelName: 'users',
    additionalFields: {
      // Better Auth reads the Drizzle result key (`roleId`), not the SQL column
      // name. Setting `fieldName: 'role_id'` drops the value from the session.
      roleId: {
        type: 'string',
        required: false,
        defaultValue: null,
        input: false,
      },
      // Virtual field - populated from session metadata
      roleName: {
        type: 'string',
        required: false,
        defaultValue: null,
        input: false,
        returned: false,
      },
    },
  },
  account: {
    modelName: 'accounts',
  },
  // The adapter resolves a model as `schema[modelName]`, so this string and the
  // export in `db/schema.ts` must stay identical.
  verification: {
    modelName: 'verifications',
  },
  // read more https://www.better-auth.com/docs/reference/options#emailverification

  plugins: [
    captcha({
      provider: 'cloudflare-turnstile',
      secretKey:
        process.env.NODE_ENV === 'development'
          ? '1x0000000000000000000000000000000AA'
          : (process.env.TURNSTILE_SECRET_KEY ?? ''),
      // Paths are matched EXACTLY from 1.7 (base path stripped first), not by
      // substring as through 1.6.26. So an entry covers one path and nothing
      // else: `'/sign-in'` would protect nothing, and a prefix has to be written
      // as `'/sign-in/*'`. Verified on 1.7.1 — omitting the header here answers
      // `400 MISSING_RESPONSE`, and `/api/auth/zz/sign-in/email/zz` no longer
      // matches at all.
      // TODO: add the proper endpoints — and write each one in full.
      endpoints: ['/sign-in/email'],
    }),
    // Passwordless sign-in (OTP → session). Verifies its own captcha/OTP.
    passwordless(),
    // Empty unless a method is configured.
    ...twoFactorPlugins,
    openAPI({ disableDefaultReference: true }),
  ],
});
