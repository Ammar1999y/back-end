/**
 * The pending-second-factor state: issued when a first factor succeeds but the
 * login is not finished, consumed by every verification method that finishes it.
 *
 * ⚠️ The challenge is stored in the shape the plugin's own `verifyTwoFactor`
 * expects, because the plugin's TOTP and backup-code endpoints still read it.
 * Three private formats are mirrored from `better-auth/dist/plugins/two-factor/`
 * (the package's `exports` map refuses a deep import): the cookie name
 * `two_factor`, the challenge identifier prefix `2fa-`, and the attempt-counter
 * identifier `2fa-attempts-<challenge>`. Each fails closed on upstream drift —
 * a cookie or row that is not found rejects.
 */
import crypto from 'node:crypto';
import type { Tx } from '@/db';
import type { EntityID } from '@/types';
import type { OtpChannel } from '@/utils/validation/otp';
import type { TwoFactorMethod } from '@/utils/validation/two-factor';
import type { GenericEndpointContext } from '@better-auth/core';

import { and, eq, isNull, sql } from 'drizzle-orm';

import { twoFactorMsg } from '@/app/api/auth/otp/messages';
import { db, withTransaction } from '@/db';
import {
  passkeys,
  twoFactorCredentials,
  twoFactorMethods,
  users,
  verificationSessions,
} from '@/db/schema';
import { sanitizeForLog, validID } from '@/utils';
import { APIError, getSessionFromCtx } from 'better-auth/api';
import {
  deleteSessionCookie,
  expireCookie,
  setSessionCookie,
} from 'better-auth/cookies';

import { HTTP_STATUS, TWO_FACTOR_UNAVAILABLE_CODE } from '@/utils/api-messages';
import {
  ENABLED_TWO_FACTOR_METHODS,
  isTwoFactorOtpChannelEnabled,
  TWO_FACTOR_ENABLED,
  twoFactorContactKind,
} from '@/utils/validation/two-factor';

import { API_PATH_MAX, auditLog, USER_AGENT_MAX } from '../audit';
import { consumeDeviceTrust } from './trusted-device';

/**
 * Either kind of Better Auth context. `better-auth` does not re-export it, so
 * `@better-auth/core` is declared here — in `devDependencies`, because the
 * import is type-only, and pinned EXACTLY to the version `better-auth` pins.
 */
export type AuthContext = GenericEndpointContext;

const TWO_FACTOR_COOKIE_NAME = 'two_factor';

const CHALLENGE_ID_BYTES = 20;

const attemptsIdentifier = (challengeId: string) =>
  `2fa-attempts-${challengeId}`;

/**
 * The companion record: what this challenge was ISSUED for.
 *
 * Separate from the challenge row because that row's `value` is the user id and
 * the plugin's own verifiers read it as one. Written first and deleted last, so
 * the failure direction is a state row with no challenge rather than a challenge
 * with no state.
 */
const stateIdentifier = (challengeId: string) => `2fa-state-${challengeId}`;

interface ChallengeState {
  userId: EntityID;
  /** Exact option identities, never method names — see `optionId`. */
  options: string[];
  defaultMethod: string | null;
  firstFactor: FirstFactor;
  excludeContactKind: ContactKind | null;
  rememberMe: boolean;
}

function parseChallengeState(raw: string): ChallengeState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const userId = validID(record.userId);
  const options = record.options;
  if (
    !userId ||
    !Array.isArray(options) ||
    !options.every((entry) => typeof entry === 'string')
  )
    return null;
  return {
    userId,
    options,
    defaultMethod:
      typeof record.defaultMethod === 'string' ? record.defaultMethod : null,
    firstFactor:
      record.firstFactor === 'passwordless' ? 'passwordless' : 'password',
    excludeContactKind:
      record.excludeContactKind === 'email' ||
      record.excludeContactKind === 'phone'
        ? record.excludeContactKind
        : null,
    rememberMe: record.rememberMe === true,
  };
}

async function readChallengeState(
  ctx: AuthContext,
  challengeId: string
): Promise<ChallengeState | null> {
  const row = await ctx.context.internalAdapter
    .findVerificationValue(stateIdentifier(challengeId))
    .catch(() => null);
  if (!row || row.expiresAt <= new Date()) return null;
  return parseChallengeState(row.value);
}

export const TWO_FACTOR_CHALLENGE_MAX_AGE_S = 600;

/**
 * Failed verifications per challenge, shared across every method so switching
 * from TOTP to backup codes buys no fresh allowance. Must stay equal to the
 * `allowedAttempts` the plugin's own verify endpoints pass to `beginAttempt`.
 */
export const TWO_FACTOR_ALLOWED_ATTEMPTS = 5;

export type ContactKind = 'email' | 'phone';

export interface EnrolledMethod {
  method: TwoFactorMethod;
  /** Set for `otp` and nothing else, per `chk_two_factor_method_channel`. */
  channel: OtpChannel | null;
  /** Generated from `channel`. The identity half of an `otp` enrolment. */
  contactKind: ContactKind | null;
  isDefault: boolean;
}

/** Intent and capability read in one pass — see `two_factor_methods` in `db/schema.ts`. */
export interface EnrollmentState {
  enabled: boolean;
  intent: EnrolledMethod[];
  capability: {
    totpVerified: boolean;
    backupCodesReady: boolean;
    hasPasskey: boolean;
    emailVerified: boolean;
    phoneVerified: boolean;
  };
}

/**
 * What the user is actually offered, as a STABLE identity rather than a method
 * name.
 *
 * A method name cannot distinguish an OTP to the email from an OTP to the
 * phone, and those are different possessions — which is the whole subject of the
 * recovery rule and of the contact-kind exclusion. Everything downstream (the
 * challenge response, the default choice, send, verify, removal, the companion
 * record) keys on `id`.
 */
export interface OfferedOption {
  id: string;
  method: TwoFactorMethod;
  contactKind: ContactKind | null;
  /** Delivery preference for an `otp` option; never part of its identity. */
  channel: OtpChannel | null;
}

export function optionId(
  method: TwoFactorMethod,
  contactKind: ContactKind | null
): string {
  return method === 'otp' ? `otp:${contactKind ?? 'unknown'}` : method;
}

/** An option as the challenge RESPONSE carries it: the identity plus routing hints. */
export interface OfferedOptionHint extends OfferedOption {
  /** `otp` only: seconds before a code may be sent to this contact. `0` is now. */
  nextAllowedIn?: number;
}

/**
 * The plugin's two verifiers and the method each completes. Both are
 * single-method, so the map is static and total; `lib/auth.ts` gates them on it
 * before the plugin runs and `lib/auth/two-factor.ts` records the completion
 * after.
 */
export const PLUGIN_VERIFIER_METHOD: Readonly<Record<string, TwoFactorMethod>> =
  {
    '/two-factor/verify-totp': 'totp',
    '/two-factor/verify-backup-code': 'backup_code',
  };

/**
 * System priority. `backup_code` is last AND excluded from auto-routing, so a
 * routine login never spends recovery material.
 */
const METHOD_PRIORITY: Readonly<Record<TwoFactorMethod, number>> = {
  passkey: 0,
  totp: 1,
  otp: 2,
  backup_code: 3,
};

/** Recovery material, never the method a challenge routes to on its own. */
const AUTO_ROUTABLE = (option: OfferedOption): boolean =>
  option.method !== 'backup_code';

/**
 * `executor` exists because callers run inside a transaction that already holds a
 * pooled connection. Reading through the module-level `db` from there acquires a
 * second one and deadlocks the pool once every connection is held by a
 * transaction waiting for another.
 */
async function readEnrollment(
  userId: EntityID,
  executor: Tx | typeof db = db
): Promise<EnrollmentState> {
  const [intent, [credential], [passkeyRow], [user]] = await Promise.all([
    executor
      .select({
        method: twoFactorMethods.method,
        channel: twoFactorMethods.channel,
        contactKind: twoFactorMethods.contactKind,
        isDefault: twoFactorMethods.isDefault,
      })
      .from(twoFactorMethods)
      .where(eq(twoFactorMethods.userId, userId))
      // Deterministic, because the response order is the order a client offers
      // and a default the database reorders between requests is not a default.
      .orderBy(twoFactorMethods.method, twoFactorMethods.contactKind),
    executor
      .select({
        secret: twoFactorCredentials.secret,
        verified: twoFactorCredentials.verified,
        acknowledgedVersion:
          twoFactorCredentials.backupCodesAcknowledgedVersion,
        version: twoFactorCredentials.backupCodesVersion,
        remaining: twoFactorCredentials.backupCodesRemaining,
      })
      .from(twoFactorCredentials)
      .where(eq(twoFactorCredentials.userId, userId))
      .limit(1),
    executor
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(eq(passkeys.userId, userId))
      .limit(1),
    executor
      .select({
        twoFactorEnabled: users.twoFactorEnabled,
        emailVerified: users.emailVerified,
        phoneNumberVerified: users.phoneNumberVerified,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  ]);

  return {
    enabled: user?.twoFactorEnabled === true,
    intent: intent.map((row) => ({
      method: row.method,
      channel: row.channel,
      contactKind: asContactKind(row.contactKind),
      isDefault: row.isDefault,
    })),
    capability: {
      totpVerified:
        Boolean(credential?.secret) && credential?.verified === true,
      // ⚠️ Three conditions, and dropping any one advertises recovery material
      // the user does not have: the acknowledgement must belong to the CURRENT
      // set (regeneration replaces every code), and the set must still hold an
      // unspent code.
      backupCodesReady:
        credential != null &&
        credential.acknowledgedVersion === credential.version &&
        credential.remaining > 0,
      hasPasskey: passkeyRow != null,
      emailVerified: user?.emailVerified === true,
      phoneVerified: user?.phoneNumberVerified === true,
    },
  };
}

/** The generated column is `text`; nothing else can legally be in it. */
function asContactKind(value: string | null): ContactKind | null {
  return value === 'email' || value === 'phone' ? value : null;
}

/**
 * The user's intent, intersected with capability and with the deployment's
 * enabled set.
 *
 * `excludeContactKind` is the possession the first factor already proved — a
 * passwordless sign-in passes the contact kind its code reached, and an OTP
 * second factor aimed at the same kind proves nothing. Password sign-in passes
 * nothing: a knowledge factor leaves every contact a real second factor.
 */
export function offeredMethods(
  state: EnrollmentState,
  excludeContactKind?: ContactKind
): OfferedOption[] {
  const { capability } = state;
  const offered = state.intent.filter(({ method, channel }) => {
    if (!ENABLED_TWO_FACTOR_METHODS.includes(method)) return false;
    switch (method) {
      case 'totp': {
        return capability.totpVerified;
      }
      case 'backup_code': {
        return capability.backupCodesReady;
      }
      case 'passkey': {
        return capability.hasPasskey;
      }
      case 'otp': {
        if (!channel) return false;
        // The CHANNEL list, not just the method list. The configuration is
        // channel-granular and this intersection was method-granular, so an
        // operator who removed a channel — the documented way to stop the
        // second factor sharing a mailbox with recovery — kept offering it to
        // exactly the users who had it enrolled.
        if (!isTwoFactorOtpChannelEnabled(channel)) return false;
        const kind = twoFactorContactKind(channel);
        if (kind === excludeContactKind) return false;
        return kind === 'email'
          ? capability.emailVerified
          : capability.phoneVerified;
      }
    }
  });

  return offered
    .map((row) => ({
      id: optionId(row.method, row.contactKind),
      method: row.method,
      contactKind: row.contactKind,
      channel: row.channel,
      isDefault: row.isDefault,
    }))
    .toSorted((a, b) => {
      // The user's own default first, then system priority, then a stable tie
      // break on the identity itself so the order cannot move between requests.
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      const byPriority = METHOD_PRIORITY[a.method] - METHOD_PRIORITY[b.method];
      return byPriority === 0 ? a.id.localeCompare(b.id) : byPriority;
    })
    .map(({ id, method, contactKind, channel }) => ({
      id,
      method,
      contactKind,
      channel,
    }));
}

/**
 * The distinct method NAMES of an offered set, for the published
 * `twoFactorMethods` field.
 *
 * Kept alongside `twoFactorOptions` rather than replaced by it: the field is
 * documented and clients read it. Two OTP channels collapse to one `otp` here,
 * which is exactly why it cannot be the thing the server keys on.
 */
export function offeredMethodNames(
  options: OfferedOption[]
): TwoFactorMethod[] {
  return [...new Set(options.map((option) => option.method))];
}

/**
 * Where the challenge routes with no choice from the user.
 *
 * `null` means "ask" — which is the honest answer when the only thing left is
 * recovery material, because auto-routing there spends a backup code on a
 * routine login.
 */
export function defaultOption(options: OfferedOption[]): string | null {
  return options.find(AUTO_ROUTABLE)?.id ?? null;
}

/**
 * Attaches the send throttle each OTP option is under, so a client auto-routing
 * to an `otp` default knows whether to send or to wait without a round trip
 * that answers 429. One indexed read, skipped when nothing is an OTP.
 */
export async function withOtpSendHints(
  userId: EntityID,
  options: OfferedOption[],
  executor: Tx | typeof db = db
): Promise<OfferedOptionHint[]> {
  if (!options.some((option) => option.method === 'otp')) return options;

  const rows = await executor
    .select({
      contactKind: verificationSessions.contactKind,
      nextAllowedAt: verificationSessions.nextAllowedAt,
    })
    .from(verificationSessions)
    .where(
      and(
        eq(verificationSessions.userId, userId),
        eq(verificationSessions.purpose, 'two_factor')
      )
    );

  const now = Date.now();
  const waitByKind = new Map(
    rows.map((row) => [
      row.contactKind,
      row.nextAllowedAt
        ? Math.max(0, Math.ceil((row.nextAllowedAt.getTime() - now) / 1000))
        : 0,
    ])
  );
  return options.map((option) =>
    option.method === 'otp'
      ? {
          ...option,
          nextAllowedIn: option.contactKind
            ? (waitByKind.get(option.contactKind) ?? 0)
            : 0,
        }
      : option
  );
}

export interface RequestSession {
  userId: EntityID;
  sessionId: string;
  /** `audit_logs.user_email` is NOT NULL, and every lifecycle write audits. */
  userEmail: string;
}

/**
 * The session behind this request, resolved the way the library resolves it.
 *
 * ⚠️ The one discriminator for every path that serves both enrolment and
 * sign-in. The plugin's `verifyTwoFactor` reads a session FIRST and only falls
 * back to the challenge cookie, so a caller holding both is an enrolment to it;
 * anything of ours that branches on the cookie instead guards the other branch
 * — the one where the caller also holds a live session for that user.
 *
 * `getSessionFromCtx` memoises onto `ctx.context.session`, so calling it here
 * makes the plugin reuse this answer rather than recompute one that can differ.
 */
export async function resolveRequestSession(
  ctx: AuthContext
): Promise<RequestSession | null> {
  const resolved = await getSessionFromCtx(ctx).catch(() => null);
  const userId = validID(resolved?.user.id);
  const sessionId = resolved?.session.id;
  const userEmail = resolved?.user.email;
  if (
    !userId ||
    typeof sessionId !== 'string' ||
    !sessionId ||
    typeof userEmail !== 'string'
  )
    return null;
  return { userId, sessionId, userEmail };
}

/** True when this request is finishing a sign-in rather than an enrolment. */
export async function isSignInVerification(ctx: AuthContext): Promise<boolean> {
  return (await resolveRequestSession(ctx)) === null;
}

export type FirstFactor = 'password' | 'passwordless';

export interface IssueChallengeParams {
  userId: EntityID;
  userEmail: string;
  /** The session the first factor created, which must not survive this call. */
  session: { id: string; token: string };
  firstFactor: FirstFactor;
  excludeContactKind?: ContactKind;
  /** The user's submitted choice, already filtered by `HONOUR_REMEMBER_ME`. */
  rememberMe: boolean;
  auditMeta: {
    ip: string | null;
    userAgent: string | null;
    apiPath: string;
  };
}

export interface ChallengeIssued {
  twoFactorRedirect: true;
  /**
   * Distinct method names. Documented, and what existing clients read — but two
   * OTP channels collapse into one entry here, so it cannot drive a choice.
   */
  twoFactorMethods: TwoFactorMethod[];
  /** The ordered, identity-carrying set. This is what a client should render. */
  twoFactorOptions: OfferedOptionHint[];
  /** `null` means "ask": only recovery material is left, and it is never auto-routed. */
  defaultMethod: string | null;
}

/**
 * `refused` is the fail-closed case: 2FA is on and nothing can complete it. The
 * first factor's session is withdrawn rather than kept, because an empty offered
 * set must never grant access — a third party can produce one through an
 * ordinary contact edit, so treating it as a downgrade made `users.edit` a way
 * to disarm someone else's second factor.
 *
 * The exit for a user in that state is the administrative reset, not a login.
 */
export type ChallengeOutcome =
  | { kind: 'challenge'; body: ChallengeIssued }
  | { kind: 'proceed' }
  | { kind: 'refused' };

/** The refusal every caller raises, so the status and code cannot drift apart. */
export function twoFactorUnavailableError(): APIError {
  return new APIError(HTTP_STATUS.FORBIDDEN, {
    message: twoFactorMsg.twoFactorUnavailable,
    code: TWO_FACTOR_UNAVAILABLE_CODE,
  });
}

/**
 * Withdraws the session the first factor created and puts a challenge in its
 * place, or refuses the login outright when nothing can complete it.
 */
export async function issueTwoFactorChallenge(
  ctx: AuthContext,
  params: IssueChallengeParams
): Promise<ChallengeOutcome> {
  // ⚠️ Two different questions, and answering them in one branch is what let
  // the three first-factor paths disagree about one account:
  //
  //   feature off      — the method list is empty, so there is no second factor
  //                      to enforce anywhere and every path downgrades. This is
  //                      the operator's intent; it is audited per affected
  //                      account so the rollback is attributable.
  //   empty for a user — the list is non-empty and nothing survives the
  //                      intersection. Fail closed, on every path, and the exit
  //                      is the administrative reset.
  //
  // The reset is therefore NOT gated on the method list: under an empty list it
  // is the only way back for an account still holding stored 2FA state.
  if (!TWO_FACTOR_ENABLED) {
    const [row] = await db
      .select({ enabled: users.twoFactorEnabled })
      .from(users)
      .where(eq(users.id, params.userId))
      .limit(1);
    if (row?.enabled === true)
      await recordChallengeEvent(
        params,
        { loginSuccess: true },
        {
          reason: 'two_factor_downgraded_feature_disabled',
          twoFactorDowngraded: true,
          serverEnabled: [],
        }
      );
    return { kind: 'proceed' };
  }

  const state = await readEnrollment(params.userId);
  // From the database, not the caller's session object: a stale copy would
  // decide a login in the direction that skips the factor.
  if (!state.enabled) return { kind: 'proceed' };

  const options = offeredMethods(state, params.excludeContactKind);

  if (options.length === 0) {
    // Two causes, one outcome, and only one of them is anybody's fault: a
    // possession exclusion leaves the user a working password route, capability
    // loss leaves them needing the operator reset. Alerting and the rollout
    // preflight both key on the difference, so it is split at the branch where
    // the discriminator is still in scope.
    const withoutExclusion = params.excludeContactKind
      ? offeredMethods(state)
      : options;
    await withdrawFirstFactorSession(ctx, params.session.token);
    await recordChallengeEvent(
      params,
      { loginSuccess: true },
      {
        sessionAbandoned: true,
        reason:
          withoutExclusion.length > 0
            ? 'two_factor_excluded_by_first_factor'
            : 'two_factor_capability_unavailable',
        twoFactorRefused: true,
        enrolled: state.intent.map((entry) => entry.method),
        serverEnabled: [...ENABLED_TWO_FACTOR_METHODS],
      }
    );
    return { kind: 'refused' };
  }

  // AFTER the offered set, never before: a trust row outlives the factor it was
  // granted against, so honouring it first let exactly the population an
  // operator's method-list change strands keep signing in with the password
  // alone while every other holder of that enrolment was refused. The skip has
  // to be a skip of a factor that still exists.
  if (await consumeDeviceTrust(ctx, params.userId)) {
    // The one path that completes a login without a second factor, and the one
    // an incident review looks for. Nothing else records it.
    await recordChallengeEvent(
      params,
      { loginSuccess: true },
      {
        reason: 'two_factor_skipped_trusted_device',
        twoFactorBypass: 'trusted_device',
        firstFactor: params.firstFactor,
      }
    );
    return { kind: 'proceed' };
  }

  await withdrawFirstFactorSession(ctx, params.session.token);
  await carryRememberChoice(ctx, params.rememberMe);

  // `session.create.after` in lib/auth.ts already committed `loginSuccess: true`
  // for the row just deleted, and the audit log is append-only.
  await recordChallengeEvent(
    params,
    { loginSuccess: true },
    {
      sessionAbandoned: true,
      reason: 'two_factor_challenge_issued',
      firstFactor: params.firstFactor,
      twoFactorOptions: options.map((option) => option.id),
    }
  );

  const challengeId = `2fa-${randomToken(CHALLENGE_ID_BYTES)}`;
  const expiresAt = new Date(
    Date.now() + TWO_FACTOR_CHALLENGE_MAX_AGE_S * 1000
  );
  const defaultMethod = defaultOption(options);

  // ⚠️ Written BEFORE the challenge, and that order is the whole safety
  // argument: a state row with no challenge expires harmlessly, while a
  // challenge with no state row is refused by every verifier. The set issued
  // here is immutable for the life of the challenge — current capability may
  // NARROW it at verification and may never widen it — so a capability that
  // appears mid-flight cannot become a factor the user was not challenged on,
  // and the issuance-time contact exclusion cannot be recomputed away.
  await ctx.context.internalAdapter.createVerificationValue({
    value: JSON.stringify({
      userId: params.userId,
      options: options.map((option) => option.id),
      defaultMethod,
      firstFactor: params.firstFactor,
      excludeContactKind: params.excludeContactKind ?? null,
      rememberMe: params.rememberMe,
    } satisfies ChallengeState),
    identifier: stateIdentifier(challengeId),
    expiresAt,
  });
  await ctx.context.internalAdapter.createVerificationValue({
    value: params.userId,
    identifier: challengeId,
    expiresAt,
  });
  await ctx.context.internalAdapter.createVerificationValue({
    value: '0',
    identifier: attemptsIdentifier(challengeId),
    expiresAt,
  });

  const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE_NAME, {
    maxAge: TWO_FACTOR_CHALLENGE_MAX_AGE_S,
  });
  await ctx.setSignedCookie(
    cookie.name,
    challengeId,
    ctx.context.secret,
    cookie.attributes
  );

  return {
    kind: 'challenge',
    body: {
      twoFactorRedirect: true,
      twoFactorMethods: offeredMethodNames(options),
      twoFactorOptions: await withOtpSendHints(params.userId, options),
      defaultMethod,
    },
  };
}

/**
 * Drops the session the first factor created, before anything else. A failure
 * after this point must leave the user signed out and retrying, never signed in
 * without a second factor.
 */
async function withdrawFirstFactorSession(
  ctx: AuthContext,
  token: string
): Promise<void> {
  await ctx.context.internalAdapter.deleteSession(token);
  deleteSessionCookie(ctx, true);
  ctx.context.setNewSession(null);
}

/**
 * Writes the `dont_remember` marker as THIS sign-in submitted it.
 *
 * The plugin's verifiers read that cookie alone to pick the session lifetime,
 * so a marker left by an earlier "do not remember" login would shorten a later
 * remembered one, and the passwordless path never set it at all. Cleared for a
 * remembered login, set for one that asked not to be — the same two states
 * `completeTwoFactorChallenge` produces from the companion record.
 */
async function carryRememberChoice(
  ctx: AuthContext,
  rememberMe: boolean
): Promise<void> {
  const marker = ctx.context.authCookies.dontRememberToken;
  if (rememberMe) {
    expireCookie(ctx, marker);
    return;
  }
  await ctx.setSignedCookie(
    marker.name,
    'true',
    ctx.context.secret,
    marker.attributes
  );
}

/** Swallowed: a logging fault must not decide whether a user can sign in. */
async function recordChallengeEvent(
  params: IssueChallengeParams,
  oldData: Record<string, unknown>,
  newData: Record<string, unknown>
): Promise<void> {
  try {
    await withTransaction((tx) =>
      auditLog(tx, {
        userId: params.userId,
        userEmail: params.userEmail,
        action: 'UPDATE',
        tableName: 'sessions',
        recordId: params.session.id,
        oldData,
        newData,
        meta: {
          ip: params.auditMeta.ip,
          userAgent:
            params.auditMeta.userAgent?.slice(0, USER_AGENT_MAX) ?? null,
          apiPath: params.auditMeta.apiPath.slice(0, API_PATH_MAX),
        },
      })
    );
  } catch (error) {
    console.error(
      sanitizeForLog({
        msg: 'twoFactor.challengeAudit.failed',
        userId: params.userId,
        error,
      })
    );
  }
}

function randomToken(bytes: number): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export interface ChallengeOtpTarget {
  channel: OtpChannel;
  /** Read from the user row, never from the request. */
  destination: string;
}

export interface ResolvedChallenge {
  challengeId: string;
  user: { id: EntityID; email: string; phoneNumber: string | null };
  /** The issued set, narrowed by current capability. Never widened. */
  options: OfferedOption[];
  methods: TwoFactorMethod[];
  defaultMethod: string | null;
  firstFactor: FirstFactor;
  rememberMe: boolean;
}

/**
 * Reads the pending challenge without consuming it — sending an OTP and
 * choosing a method both need it to survive. `completeTwoFactorChallenge` is the
 * only consumer, and the only writer of a session.
 */
export async function resolveTwoFactorChallenge(
  ctx: AuthContext
): Promise<ResolvedChallenge | null> {
  const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE_NAME);
  const challengeId = await ctx.getSignedCookie(
    cookie.name,
    ctx.context.secret
  );
  if (!challengeId) return null;

  const record =
    await ctx.context.internalAdapter.findVerificationValue(challengeId);
  if (!record || record.expiresAt <= new Date()) return null;

  // Through `validID`: a non-UUID from the verification row would reach the
  // driver as a cast error, a 500 on a path whose failures are quiet nulls.
  const challengeUserId = validID(record.value);
  if (!challengeUserId) return null;

  // Fail closed: a challenge whose companion record is gone cannot say what it
  // was issued for, and recomputing the set here is exactly the mistake the
  // record exists to prevent — it would drop the issuance-time contact
  // exclusion and admit whatever capability has appeared since.
  const issued = await readChallengeState(ctx, challengeId);
  if (!issued || issued.userId !== challengeUserId) return null;

  // Repeated here rather than left to `session.create.before`: a suspended user
  // must not be told which second factors their account has.
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      phoneNumber: users.phoneNumber,
    })
    .from(users)
    .where(
      and(
        eq(users.id, challengeUserId),
        eq(users.isActive, true),
        isNull(users.deletedAt)
      )
    )
    .limit(1);
  if (!user) return null;

  const state = await readEnrollment(user.id);
  // The intersection, in this direction only: what is still usable, out of what
  // was issued.
  const issuedIds = new Set(issued.options);
  const options = offeredMethods(state).filter((option) =>
    issuedIds.has(option.id)
  );

  return {
    challengeId,
    user: { id: user.id, email: user.email, phoneNumber: user.phoneNumber },
    options,
    methods: offeredMethodNames(options),
    // The issued default survives only while it survives the narrowing.
    defaultMethod: options.some((option) => option.id === issued.defaultMethod)
      ? issued.defaultMethod
      : defaultOption(options),
    firstFactor: issued.firstFactor,
    rememberMe: issued.rememberMe,
  };
}

/**
 * Which contact an OTP for `optionId` would reach.
 *
 * The destination comes from the user row, never from the request, and the
 * option has to be one the challenge actually offers — otherwise a caller could
 * name `otp:email` on a challenge that deliberately excluded it.
 */
export function otpTargetFor(
  challenge: ResolvedChallenge,
  optionId?: string | null
): ChallengeOtpTarget | null {
  const candidates = challenge.options.filter(
    (option) => option.method === 'otp'
  );
  const chosen = optionId
    ? candidates.find((option) => option.id === optionId)
    : (candidates.find((option) => option.id === challenge.defaultMethod) ??
      candidates[0]);
  if (!chosen?.channel) return null;

  const destination =
    chosen.contactKind === 'email'
      ? challenge.user.email
      : challenge.user.phoneNumber;
  return destination ? { channel: chosen.channel, destination } : null;
}

/**
 * Spends one of the challenge's shared failure budget.
 *
 * ⚠️ The counter row is consumed and NOT written back, so between this call and
 * the caller's `recordFailure()` / `restore()` there is no row for a concurrent
 * request to read. Re-arming eagerly here let N parallel guesses each read the
 * pre-increment count and cost one attempt between them. Matches the library's
 * `beginAttempt` protocol exactly.
 *
 * **The caller must invoke exactly one of `recordFailure` and `restore` on every
 * path that does not consume the challenge.** A wrong answer records; anything
 * that produced no verdict restores; a success consumes the challenge and lets
 * the orphaned counter expire, which is what the library does.
 *
 * On `ok: false` the caller must reject without looking at the submitted value.
 */
export async function spendChallengeAttempt(
  ctx: AuthContext,
  challengeId: string
): Promise<{
  ok: boolean;
  recordFailure: () => Promise<void>;
  restore: () => Promise<void>;
}> {
  const identifier = attemptsIdentifier(challengeId);
  const consumed = await ctx.context.internalAdapter
    .consumeVerificationValue(identifier)
    .catch(() => null);
  const noop = { recordFailure: async () => {}, restore: async () => {} };
  if (!consumed) return { ok: false, ...noop };

  // An unparseable counter is exhausted, not zero: corruption and tampering are
  // the only ways it is not a number, and neither earns a fresh budget.
  //
  // Digits-only, because `Number('')` is 0 — an empty `value` (the column is
  // `text NOT NULL`, so it is a legal write) would otherwise read as a fresh
  // budget, which is the one direction this check exists to prevent.
  const raw = consumed.value.trim();
  const parsed = /^\d+$/u.test(raw) ? Number(raw) : NaN;
  const used =
    Number.isSafeInteger(parsed) && parsed >= 0
      ? parsed
      : TWO_FACTOR_ALLOWED_ATTEMPTS;

  if (used >= TWO_FACTOR_ALLOWED_ATTEMPTS) {
    await invalidateChallenge(ctx, challengeId);
    return { ok: false, ...noop };
  }

  const rearm = async (count: number): Promise<void> => {
    await ctx.context.internalAdapter
      .createVerificationValue({
        value: String(count),
        identifier,
        expiresAt: consumed.expiresAt,
      })
      .catch(() => {});
  };

  return {
    ok: true,
    recordFailure: () => rearm(used + 1),
    restore: () => rearm(used),
  };
}

/**
 * How long a completed second factor stays redeemable for a device-trust grant.
 * Long enough for a "remember this device" click on the page that follows the
 * verification, short enough that a session cannot cash it in days later.
 */
const TWO_FACTOR_PROOF_MAX_AGE_S = 600;

const proofIdentifier = (sessionId: string) => `2fa-proven-${sessionId}`;

/**
 * Records that THIS session was created by completing a second factor.
 *
 * `/two-factor/trust-device` consumes it, which is what binds a 30-day challenge
 * skip to a proof rather than to the mere possession of a session. Without it any
 * authenticated session could mint the skip — including one planted before the
 * user enabled 2FA at all.
 */
export async function markTwoFactorProven(
  ctx: AuthContext,
  sessionId: string
): Promise<void> {
  await ctx.context.internalAdapter
    .createVerificationValue({
      value: sessionId,
      identifier: proofIdentifier(sessionId),
      expiresAt: new Date(Date.now() + TWO_FACTOR_PROOF_MAX_AGE_S * 1000),
    })
    .catch(() => {});
}

/** Single-use: a second "remember this device" needs a second verification. */
export async function consumeTwoFactorProof(
  ctx: AuthContext,
  sessionId: string
): Promise<boolean> {
  const consumed = await ctx.context.internalAdapter
    .consumeVerificationValue(proofIdentifier(sessionId))
    .catch(() => null);
  return consumed?.value === sessionId;
}

/** Drops the challenge and its counter, and expires the cookie carrying it. */
export async function invalidateChallenge(
  ctx: AuthContext,
  challengeId: string
): Promise<void> {
  await ctx.context.internalAdapter
    .deleteVerificationByIdentifier(challengeId)
    .catch(() => {});
  await ctx.context.internalAdapter
    .deleteVerificationByIdentifier(attemptsIdentifier(challengeId))
    .catch(() => {});
  await ctx.context.internalAdapter
    .deleteVerificationByIdentifier(stateIdentifier(challengeId))
    .catch(() => {});
  expireCookie(ctx, ctx.context.createAuthCookie(TWO_FACTOR_COOKIE_NAME));
  // The abandoned attempt's remember choice dies with it. Nothing else cleared
  // this cookie on any served path, so a later `rememberMe: true` in the same
  // browser inherited an earlier `false`.
  expireCookie(ctx, ctx.context.authCookies.dontRememberToken);
}

/**
 * Consumes the challenge and issues the session it stood in for.
 *
 * `consumeVerificationValue` returns the row to exactly one concurrent caller,
 * so two verifications racing on one challenge produce one session; a value that
 * no longer matches the resolved user means the challenge was rotated underneath
 * this request and is refused.
 */
export async function completeTwoFactorChallenge(
  ctx: AuthContext,
  challenge: ResolvedChallenge,
  /** The option that actually completed it, for the audit chain. */
  completedWith: string
): Promise<{ token: string } | null> {
  const consumed = await ctx.context.internalAdapter.consumeVerificationValue(
    challenge.challengeId
  );
  if (!consumed || consumed.value !== challenge.user.id) {
    await invalidateChallenge(ctx, challenge.challengeId);
    return null;
  }

  await ctx.context.internalAdapter
    .deleteVerificationByIdentifier(attemptsIdentifier(challenge.challengeId))
    .catch(() => {});
  await ctx.context.internalAdapter
    .deleteVerificationByIdentifier(stateIdentifier(challenge.challengeId))
    .catch(() => {});

  const user = await ctx.context.internalAdapter.findUserById(
    challenge.user.id
  );
  if (!user) return null;

  // The submitted choice, carried from issuance. The library passes
  // `!!dontRememberMe` here and this path passed nothing, so a user who asked
  // not to be remembered got a 28-day row behind a session-scoped cookie.
  const dontRememberMe = !challenge.rememberMe;
  const session = await ctx.context.internalAdapter.createSession(
    challenge.user.id,
    dontRememberMe
  );
  if (!session) return null;

  await setSessionCookie(ctx, { session, user }, dontRememberMe);
  // `setSessionCookie` SETS the marker when the answer is "do not remember" and
  // never clears it when the answer changes, so the positive case has to.
  if (!dontRememberMe)
    expireCookie(ctx, ctx.context.authCookies.dontRememberToken);
  expireCookie(ctx, ctx.context.createAuthCookie(TWO_FACTOR_COOKIE_NAME));
  await markTwoFactorProven(ctx, session.id);

  await recordCompletionEvent({
    user: challenge.user,
    session,
    firstFactor: challenge.firstFactor,
    completedWith,
    rememberMe: challenge.rememberMe,
    apiPath: ctx.path ?? '/two-factor',
  });

  // Device trust is a separate call: the library's TOTP and backup-code
  // endpoints complete a challenge without passing through here, so a flag on
  // this path would work for one method and silently do nothing for the rest.
  return { token: session.token };
}

interface CompletedSession {
  id: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * The factor CHAIN, which no path-keyed map can express: `session.create.after`
 * sees one path and cannot say which first factor preceded it, nor that a
 * trusted device skipped the second. Swallowed — the session exists and its
 * cookie is on its way, so failing here would sign the user in and tell them it
 * did not work.
 */
async function recordCompletionEvent(params: {
  user: { id: EntityID; email: string };
  session: CompletedSession;
  firstFactor: FirstFactor;
  completedWith: string;
  rememberMe: boolean;
  apiPath: string;
}): Promise<void> {
  try {
    await withTransaction((tx) =>
      auditLog(tx, {
        userId: params.user.id,
        userEmail: params.user.email,
        action: 'UPDATE',
        tableName: 'sessions',
        recordId: params.session.id,
        oldData: null,
        newData: {
          twoFactorCompleted: true,
          firstFactor: params.firstFactor,
          secondFactor: params.completedWith,
          rememberMe: params.rememberMe,
        },
        meta: {
          ip: params.session.ipAddress ?? null,
          userAgent: params.session.userAgent?.slice(0, USER_AGENT_MAX) ?? null,
          apiPath: params.apiPath.slice(0, API_PATH_MAX),
        },
      })
    );
  } catch (error) {
    console.error(
      sanitizeForLog({
        msg: 'twoFactor.completionAudit.failed',
        userId: params.user.id,
        error,
      })
    );
  }
}

/**
 * The tail of a completion the plugin's own verifier performed.
 *
 * Its `valid()` consumed the challenge row and minted the session; what it
 * cannot do is read the companion record, so the completion event and the
 * cleanup of the two companion rows happen here. The request cookie still
 * carries the challenge id even though the response has just expired it.
 */
export async function recordPluginCompletion(
  ctx: AuthContext,
  completedWith: TwoFactorMethod,
  created: { user: { id: string; email: string }; session: CompletedSession }
): Promise<void> {
  const challengeId = await readChallengeCookie(ctx);
  if (!challengeId) return;

  const issued = await readChallengeState(ctx, challengeId);
  await ctx.context.internalAdapter
    .deleteVerificationByIdentifier(attemptsIdentifier(challengeId))
    .catch(() => {});
  await ctx.context.internalAdapter
    .deleteVerificationByIdentifier(stateIdentifier(challengeId))
    .catch(() => {});

  const userId = validID(created.user.id);
  if (!issued || !userId || issued.userId !== userId) return;
  await recordCompletionEvent({
    user: { id: userId, email: created.user.email },
    session: created.session,
    firstFactor: issued.firstFactor,
    completedWith,
    rememberMe: issued.rememberMe,
    apiPath: ctx.path ?? '/two-factor',
  });
}

/**
 * The options a password reset may ask for as a second factor.
 *
 * Two subtractions from the offered set, and they are different in kind:
 *
 *  - the CONTACT the recovery code arrived on, because a second code to the same
 *    mailbox proves nothing that the first did not — this is `D1`, and it is a
 *    property of the authentication chain rather than of the enrolled set;
 *  - `passkey`, because this flow has no request context to run a WebAuthn
 *    ceremony in. Offering an option that cannot be checked would be worse than
 *    not offering it: the reset would either hang or, if it fell through, run
 *    unproven.
 */
export function recoveryOptions(
  state: EnrollmentState,
  contactKind: ContactKind
): OfferedOption[] {
  return offeredMethods(state, contactKind).filter(
    (option) => option.method !== 'passkey'
  );
}

/** The state a recovery flow needs, without exposing the reader itself. */
export async function readEnrollmentState(
  userId: EntityID,
  executor: Tx | typeof db = db
): Promise<EnrollmentState> {
  return readEnrollment(userId, executor);
}

/**
 * Would resetting the password through `contactKind` hand one holder of that
 * contact both factors — or leave the reset unable to ask for anything?
 *
 * Refused rather than gated when nothing is left to ask for: the account keeps
 * its second factor and the route back is the administrative reset. When
 * something IS left, the reset does not proceed on the recovery code alone —
 * `lib/auth/recovery-grant.ts` carries it to a second request that proves the
 * surviving factor first.
 */
export async function recoveryDefeatsTwoFactor(
  userId: EntityID,
  contactKind: ContactKind,
  executor: Tx | typeof db = db
): Promise<boolean> {
  const state = await readEnrollment(userId, executor);
  if (!state.enabled) return false;
  // Capability, not intent: a user whose rows survive but whose capability is
  // gone (last passkey deleted, method dropped from the env list, credential
  // row cleared) is already refused at sign-in, so refusing recovery too would
  // leave them with no route at all.
  if (offeredMethods(state).length === 0) return false;
  return recoveryOptions(state, contactKind).length === 0;
}

/**
 * Would changing these contacts leave this user with no factor they can
 * complete?
 *
 * `offeredMethods` reads the user row's verified flags, so any write that clears
 * one — or that moves the address the OTP enrolment points at — takes the OTP
 * option bound to it out of the offered set. Asked BEFORE the write, and only
 * true when the change is what removes the last usable factor: a user already at
 * zero is refused at sign-in regardless, and blocking the edit would leave an
 * operator unable to correct their contact at all.
 *
 * ⚠️ `contactKinds` is a SET, asked ONCE. Per-kind questions against unmodified
 * state are exact only while a user can hold one OTP enrolment: with two, a
 * single request changing both contacts passes both checks — email survives
 * because phone still counts, phone survives because email still counts — and
 * strands the user anyway.
 */
export async function contactChangeStrandsTwoFactor(
  userId: EntityID,
  contactKinds: readonly ContactKind[],
  executor: Tx | typeof db = db
): Promise<boolean> {
  if (contactKinds.length === 0) return false;
  const state = await readEnrollment(userId, executor);
  if (!state.enabled) return false;
  if (offeredMethods(state).length === 0) return false;

  const stranded: EnrollmentState = {
    ...state,
    capability: {
      ...state.capability,
      emailVerified: contactKinds.includes('email')
        ? false
        : state.capability.emailVerified,
      phoneVerified: contactKinds.includes('phone')
        ? false
        : state.capability.phoneVerified,
    },
  };
  return offeredMethods(stranded).length === 0;
}

/**
 * Would removing this enrolment leave the user with no factor a challenge would
 * offer?
 *
 * Asked against the OFFERED set, not the intent rows. A row whose channel was
 * dropped from the deployment, whose contact is no longer verified or whose
 * backup set is spent is still a row, and counting rows let a user remove their
 * last usable method while an unusable one stood in for it — the state the
 * administrative reset exists to exit. Only true when the removal is what
 * empties the set: a user already at zero is refused at sign-in regardless, and
 * blocking their cleanup would leave them no better off.
 */
export function removalStrandsTwoFactor(
  state: EnrollmentState,
  method: TwoFactorMethod,
  contactKind: ContactKind | null
): boolean {
  if (offeredMethods(state).length === 0) return false;
  const remaining: EnrollmentState = {
    ...state,
    intent: state.intent.filter(
      (entry) =>
        !(
          entry.method === method &&
          (method !== 'otp' || entry.contactKind === contactKind)
        )
    ),
  };
  return offeredMethods(remaining).length === 0;
}

/** The pending challenge id from the request cookie, unverified against any row. */
export async function readChallengeCookie(
  ctx: AuthContext
): Promise<string | null> {
  const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE_NAME);
  // `false` for a present-but-unverifiable cookie, `undefined` for an absent
  // one. Neither is a challenge.
  const value = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Idempotent: the call site is "a verification succeeded", true both at
 * enrolment and at every later sign-in. Writing intent twice is a no-op; failing
 * to write it at enrolment silently disables the whole feature for that user.
 */
export async function recordMethodIntent(
  tx: Tx,
  params: {
    userId: EntityID;
    method: TwoFactorMethod;
    channel?: OtpChannel | null;
  }
): Promise<void> {
  const channel = params.channel ?? null;
  const values = {
    userId: params.userId,
    method: params.method,
    channel,
  };

  // ⚠️ Two conflict targets, matching the two partial indexes in `db/schema.ts`
  // exactly. An `otp` row's identity is its CONTACT KIND, so re-enrolling
  // `sms` over `whatsapp` updates the delivery preference of the phone
  // enrolment while an `email` enrolment is a separate row. Every other method
  // is one row per user. A single `(user_id, method)` target made a second OTP
  // channel replace the first.
  if (params.method === 'otp') {
    await tx
      .insert(twoFactorMethods)
      .values(values)
      .onConflictDoUpdate({
        target: [twoFactorMethods.userId, twoFactorMethods.contactKind],
        targetWhere: sql`method = 'otp'`,
        set: { channel },
      });
    return;
  }

  await tx
    .insert(twoFactorMethods)
    .values(values)
    .onConflictDoUpdate({
      target: [twoFactorMethods.userId, twoFactorMethods.method],
      targetWhere: sql`method <> 'otp'`,
      set: { channel },
    });
}

/** The caller owns the last-method rule; this only performs the removal. */
export async function removeMethodIntent(
  tx: Tx,
  userId: EntityID,
  method: TwoFactorMethod,
  /** Required to name ONE of a user's two possible OTP enrolments. */
  contactKind?: ContactKind | null
): Promise<number> {
  const removed = await tx
    .delete(twoFactorMethods)
    .where(
      and(
        eq(twoFactorMethods.userId, userId),
        eq(twoFactorMethods.method, method),
        ...(method === 'otp' && contactKind
          ? [eq(twoFactorMethods.contactKind, contactKind)]
          : [])
      )
    )
    .returning({ id: twoFactorMethods.id });
  return removed.length;
}

export async function listEnrolledMethods(
  userId: EntityID,
  executor: Tx | typeof db = db
): Promise<EnrolledMethod[]> {
  const rows = await executor
    .select({
      method: twoFactorMethods.method,
      channel: twoFactorMethods.channel,
      contactKind: twoFactorMethods.contactKind,
      isDefault: twoFactorMethods.isDefault,
    })
    .from(twoFactorMethods)
    .where(eq(twoFactorMethods.userId, userId))
    .orderBy(twoFactorMethods.method, twoFactorMethods.contactKind);
  return rows.map((row) => ({
    method: row.method,
    channel: row.channel,
    contactKind: asContactKind(row.contactKind),
    isDefault: row.isDefault,
  }));
}
