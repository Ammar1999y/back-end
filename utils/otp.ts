import crypto from 'node:crypto';
import type { WsTx } from '@/db/ws';
import type { OtpChannel, OtpPurpose } from '@/utils/validation/otp';

import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import { users, verificationCodes, verificationSessions } from '@/db/schema';
import { withTransaction } from '@/db/ws';
import { EntityID } from '@/types';
import { sanitizeForLog } from '@/utils';
import nodemailer from 'nodemailer';
import { auditLog } from '@/lib/audit';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import {
  enforceOtpVerifyDailyBudget,
  refundOtpVerifyAttempt,
} from '@/lib/rate-limit';

import { HTTP_STATUS } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';
import {
  OTP_BLOCK_DURATION_HOURS,
  OTP_EXPIRY_MINUTES,
  OTP_MAX_ATTEMPTS,
  OTP_MAX_DAILY_VERIFY_ATTEMPTS,
  OTP_MAX_VERIFY_ATTEMPTS,
} from '@/utils/validation/constants';

// ── Email Transport (lazy-initialized to avoid crash when env vars are missing) ──
let _transporter: nodemailer.Transporter | null = null;
function getTransporter() {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return _transporter;
}

// ── OTP Generation & Hashing ──

export function generateOtpCode() {
  return crypto.randomInt(100_000, 1_000_000).toString();
}

export async function hashOtpCode(code: string) {
  return hashPassword(code);
}

export async function verifyOtpCode(code: string, hashedCode: string) {
  return verifyPassword({ password: code, hash: hashedCode });
}

// ── Time Calculations ──

/** Exponential backoff: 30 * 2^(n-1) seconds (30s, 60s, 120s, 240s, 480s...) */
function calculateNextAllowedAt(attemptNumber: number): Date {
  const delaySeconds = 30 * Math.pow(2, attemptNumber - 1);
  return new Date(Date.now() + delaySeconds * 1000);
}

function calculateOtpExpiry(): Date {
  return new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
}

function calculateBlockDuration(): Date {
  return new Date(Date.now() + OTP_BLOCK_DURATION_HOURS * 60 * 60 * 1000);
}

/**
 * The single definition of "this block has been served".
 *
 * BOTH per-cycle counters must clear, from every entry path. Clearing only the
 * counter the current path cares about leaves the other at its cap, so the
 * very next request re-blocks for another full duration and the penalty never
 * actually ends. `verifyAttemptDaily` and its window are deliberately absent:
 * that is the rolling 24h abuse bound and rolls on its own schedule, not on
 * block expiry.
 */
const BLOCK_EXPIRY_RESET = {
  isBlocked: false,
  blockedUntil: null,
  attemptNumber: 0,
  verifyAttemptNumber: 0,
} as const;

// ── Delivery Functions ──

/**
 * Summarize a failed delivery for the log.
 *
 * NOTHING provider-controlled is logged here — not the body, not the message,
 * not an error code. These APIs echo the submitted message text back on
 * failure and that text contains the plaintext OTP, so any value the provider
 * chooses is a potential carrier for it.
 *
 * Filtering by shape does not work. Successive attempts here rejected raw
 * bodies, then values with whitespace, then a bare `123456`, then any run of
 * six digits — and `OTP_1_2_3_4_5_6`, `OTP-12-34-56` and `OTP.123.456` still
 * got through. Every heuristic only blocks the encodings you thought of, while
 * the provider is free to pick another.
 *
 * What is left is fully sufficient to diagnose an outage: which channel, and
 * the transport-level HTTP status (from `fetch`, not from the payload). If a
 * specific provider's error codes are ever needed, add them as an explicit
 * hard-coded allowlist of known constants — never a pattern over arbitrary
 * provider output.
 */
function describeProviderFailure(channel: OtpChannel, response: Response) {
  return sanitizeForLog({
    msg: 'otp.provider.failed',
    channel,
    status: response.status,
  });
}

async function sendOtpSms(
  phoneNumber: string,
  code: string,
  messageText?: string
) {
  const response = await fetch('https://apis.deewan.sa/sms/v1/messages', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      Authorization: `Bearer ${process.env.DEEWAN_SMS_TOKEN}`,
    },
    body: JSON.stringify({
      senderName: process.env.DEEWAN_SENDER_NAME,
      messageType: 'text',
      messageText: messageText ?? `رمز التحقق هو: ${code}`,
      recipients: phoneNumber,
    }),
  });

  if (!response.ok) {
    console.error(describeProviderFailure('sms', response));
    throw new CustomError(MSG_SMS_SEND_FAILED, HTTP_STATUS.INTERNAL_ERROR);
  }
}

async function sendOtpWhatsApp(phoneNumber: string, code: string) {
  const formData = new FormData();
  formData.append('message_type', 'text');
  formData.append('recipients', phoneNumber);
  formData.append('content', `رمز التحقق هو: ${code}`);

  const response = await fetch('https://services.rmz.one/api/whatsapp/send', {
    method: 'POST',
    headers: {
      AUTHORIZATION: `Bearer ${process.env.WHATSAPP_API_KEY}`,
      Accept: 'application/json',
    },
    body: formData,
  });

  if (!response.ok) {
    console.error(describeProviderFailure('whatsapp', response));
    throw new CustomError(MSG_WHATSAPP_SEND_FAILED, HTTP_STATUS.INTERNAL_ERROR);
  }

  // Parsing is inside the boundary too. A provider-controlled 2xx body that
  // isn't JSON makes `response.json()` throw a SyntaxError whose message
  // QUOTES the body — `Unexpected token 'O', "OTP_1_2_3_4_5_6" is not valid
  // JSON` — and callers log the thrown error.
  let data: { status?: unknown } | null;
  try {
    data = (await response.json()) as { status?: unknown } | null;
  } catch {
    console.error(
      sanitizeForLog({
        msg: 'otp.provider.unparsable',
        channel: 'whatsapp',
        status: response.status,
      })
    );
    throw new CustomError(MSG_WHATSAPP_SEND_FAILED, HTTP_STATUS.INTERNAL_ERROR);
  }

  if (!data?.status) {
    // Application-level rejection on a 2xx. Same rule as above — nothing from
    // `data` is logged, since any field it controls can carry the code.
    console.error(describeProviderFailure('whatsapp', response));
    throw new CustomError(MSG_WHATSAPP_SEND_FAILED, HTTP_STATUS.INTERNAL_ERROR);
  }
}

/**
 * Nodemailer's own failure classes. These are set by the client library from a
 * fixed vocabulary — unlike `err.message` / `err.response`, which carry the
 * SMTP server's reply and can quote the rejected message, i.e. the code.
 * A hard-coded allowlist is the only safe way to keep any diagnostic value.
 */
const SMTP_ERROR_CODES = new Set([
  'EAUTH',
  'ECONNECTION',
  'EDNS',
  'EENVELOPE',
  'EMESSAGE',
  'EPROTOCOL',
  'ESOCKET',
  'ESTREAM',
  'ETIMEDOUT',
]);

// Fixed, user-facing delivery failures. Every error leaving the delivery layer
// must carry one of these — never text derived from a provider response.
const MSG_OTP_SEND_FAILED = 'حدثت مشكلة اثناء إرسال رمز التحقق';
const MSG_SMS_SEND_FAILED = 'حدثت مشكلة اثناء إرسال رمز التحقق عبر SMS';
const MSG_WHATSAPP_SEND_FAILED = MSG_OTP_SEND_FAILED;
const MSG_EMAIL_SEND_FAILED =
  'حدثت مشكلة اثناء إرسال رمز التحقق عبر البريد الإلكتروني';

/**
 * The complete set of messages permitted to leave the delivery layer. The
 * dispatcher CHECKS membership rather than assuming it: `instanceof
 * CustomError` says nothing about where a message came from, so a future
 * sender doing `new CustomError(providerText, 500)` would otherwise pass
 * provider text straight through the boundary it is supposed to be behind.
 */
const SAFE_DELIVERY_MESSAGES: ReadonlySet<string> = new Set([
  MSG_OTP_SEND_FAILED,
  MSG_SMS_SEND_FAILED,
  MSG_EMAIL_SEND_FAILED,
]);

/**
 * Error classes whose NAME is safe to log. An arbitrary `error.name` is
 * attacker-influencable in principle (a thrown custom class can name itself
 * anything), so it goes through an allowlist like every other provider-adjacent
 * value in this module.
 */
/**
 * Read a string field off an unknown throwable without letting it throw again.
 * A property getter can itself raise, and an exception from inside the catch
 * block escapes the boundary the block exists to enforce.
 */
function readErrorField(
  error: unknown,
  key: 'message' | 'name'
): string | null {
  try {
    const value = (error as Record<string, unknown> | null | undefined)?.[key];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/**
 * `instanceof` walks the prototype chain, so a Proxy with a throwing
 * `getPrototypeOf` trap can raise from the test itself — inside the catch block
 * whose whole job is to stop things escaping.
 */
function isCustomError(error: unknown): boolean {
  try {
    return error instanceof CustomError;
  } catch {
    return false;
  }
}

const LOGGABLE_ERROR_NAMES: ReadonlySet<string> = new Set([
  'Error',
  'TypeError',
  'SyntaxError',
  'RangeError',
  'AbortError',
  'TimeoutError',
  'CustomError',
  'DrizzleQueryError',
]);

async function sendOtpEmail(email: string, code: string) {
  let info: Awaited<ReturnType<nodemailer.Transporter['sendMail']>>;

  try {
    info = await getTransporter().sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email,
      subject: 'رمز التحقق - مجتمع الوقف',
      text: `رمز التحقق هو: ${code}`,
      html: `<div dir="rtl" style="font-family: sans-serif; text-align: center; padding: 20px;">
      <h2>رمز التحقق</h2>
      <p style="font-size: 32px; font-weight: bold; letter-spacing: 8px; margin: 20px 0;">${code}</p>
      <p>صالح لمدة ${OTP_EXPIRY_MINUTES} دقائق</p>
    </div>`,
    });
  } catch (error) {
    // The transport error must NOT escape. Callers log the thrown error, and
    // an SMTP rejection quotes the message it rejected — which is the body
    // containing the plaintext code. Replace it with a fixed error here, at
    // the boundary, and log only the library's own failure class.
    const smtpCode = (error as { code?: unknown })?.code;
    console.error(
      sanitizeForLog({
        msg: 'otp.provider.failed',
        channel: 'email',
        // Not `smtpCode`: the serializer redacts *code keys by default.
        smtpClass:
          typeof smtpCode === 'string' && SMTP_ERROR_CODES.has(smtpCode)
            ? smtpCode
            : 'UNKNOWN',
      })
    );
    throw new CustomError(MSG_EMAIL_SEND_FAILED, HTTP_STATUS.INTERNAL_ERROR);
  }

  if (!info.messageId) {
    console.error(
      sanitizeForLog({
        msg: 'otp.provider.rejected',
        channel: 'email',
      })
    );
    throw new CustomError(MSG_EMAIL_SEND_FAILED, HTTP_STATUS.INTERNAL_ERROR);
  }
}

/**
 * Dispatches OTP to the appropriate channel, and is the single containment
 * boundary for delivery failures.
 *
 * Callers log the error they catch, and the outbound payload contains the
 * plaintext code — so ANY error escaping this function with provider- or
 * payload-derived text in its message is a leak. Three separate ones came from
 * exactly here (raw SMS/WhatsApp bodies, SMTP rejections, and a JSON parse
 * error quoting the body), each fixed one channel at a time.
 *
 * The guarantee is enforced, not assumed:
 *  - the outward message must be a member of `SAFE_DELIVERY_MESSAGES`;
 *    anything else is replaced, including a `CustomError` carrying text a
 *    future sender chose;
 *  - the logged error name must be a member of `LOGGABLE_ERROR_NAMES`;
 *  - `smsMessage` is invoked INSIDE the boundary. Evaluating it in the caller
 *    handed the OTP to a caller-supplied callback outside this `try`, so a
 *    throw from it bypassed the boundary entirely.
 */
async function sendOtp(
  channel: OtpChannel,
  identifier: string,
  code: string,
  smsMessage?: (code: string) => string
) {
  try {
    if (channel === 'sms')
      return await sendOtpSms(identifier, code, smsMessage?.(code));
    if (channel === 'whatsapp') return await sendOtpWhatsApp(identifier, code);
    return await sendOtpEmail(identifier, code);
  } catch (error) {
    const message = readErrorField(error, 'message');

    if (
      message &&
      isCustomError(error) &&
      SAFE_DELIVERY_MESSAGES.has(message)
    ) {
      // A FRESH error, not the original. Rethrowing carried whatever `code`,
      // `status`, `responseHeaders` — or any field added later — the thrower
      // attached, and the serializer copies several of those. Only the message
      // has been checked, so only the message is kept.
      throw new CustomError(message, HTTP_STATUS.INTERNAL_ERROR);
    }

    const name = readErrorField(error, 'name') ?? 'Unknown';
    console.error(
      sanitizeForLog({
        msg: 'otp.delivery.unexpectedError',
        channel,
        errorName: LOGGABLE_ERROR_NAMES.has(name) ? name : 'Unknown',
      })
    );
    throw new CustomError(MSG_OTP_SEND_FAILED, HTTP_STATUS.INTERNAL_ERROR);
  }
}

// ── Reusable OTP Send Logic ──

interface ProcessOtpSendOptions {
  /** User ID to bind the verification session to */
  userId: EntityID;
  /** Unique key for the verification session (e.g. email, phone) */
  identifier: string;
  channel: OtpChannel;
  /**
   * Reason the code is being issued. Bound into the session so a code proven
   * for one purpose can never authorize a different sensitive action.
   */
  purpose: OtpPurpose;
  /**
   * For contact-change purposes (change_email/change_phone): the NEW contact
   * whose ownership is being proven. Persisted so verify can commit exactly
   * that value. Must be null for every other purpose.
   */
  targetIdentifier?: string | null;
  /** The actual phone number or email to deliver the OTP to */
  sendTo: string;
  /** Human-readable label for error messages (e.g. "رقم الهاتف") */
  entityName: string;
  /** Optional custom SMS message. Receives the OTP code as argument */
  smsMessage?: (code: string) => string;
}

interface ProcessOtpSendResult {
  nextAllowedIn: number;
  attemptsRemaining: number;
}

/**
 * Handles rate-limiting, OTP generation, storage, and delivery.
 * Storage and delivery run inside a transaction with row-level locking.
 */
export async function processOtpSend({
  userId,
  identifier,
  channel,
  purpose,
  targetIdentifier = null,
  sendTo,
  entityName,
  smsMessage,
}: ProcessOtpSendOptions): Promise<ProcessOtpSendResult> {
  // Argon2id is intentionally computed before acquiring advisory or row locks.
  const otpCode = generateOtpCode();
  const hashedCode = await hashOtpCode(otpCode);

  // Buffer deferred errors so max-attempts block persists (commit) before we throw.
  let deferredError: CustomError | null = null;

  const result = await withTransaction(async (tx) => {
    // Advisory lock serializes concurrent first-send requests for the same user+channel.
    // FOR UPDATE only works when a row already exists — without this, two concurrent
    // requests for a new identifier both see "no row" and both proceed to INSERT.
    // Two-argument form gives a 64-bit keyspace, avoiding the birthday-
    // collision rate of the single-arg int4 form at high OTP concurrency.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${userId}), hashtext(${channel} || ':' || ${purpose}))`
    );

    const now = new Date();
    let [session] = await tx
      .select({
        id: verificationSessions.id,
        attemptNumber: verificationSessions.attemptNumber,
        isBlocked: verificationSessions.isBlocked,
        blockedUntil: verificationSessions.blockedUntil,
        nextAllowedAt: verificationSessions.nextAllowedAt,
      })
      .from(verificationSessions)
      .where(
        and(
          eq(verificationSessions.userId, userId),
          eq(verificationSessions.channel, channel),
          eq(verificationSessions.purpose, purpose)
        )
      )
      .for('update');

    // ── Block check ──
    if (session?.isBlocked && session.blockedUntil) {
      if (new Date(session.blockedUntil) > now) {
        const blockedMinutes = Math.ceil(
          (new Date(session.blockedUntil).getTime() - now.getTime()) / 60_000
        );
        const message =
          blockedMinutes >= 60
            ? `تم حظر ${entityName} مؤقتاً. يرجى المحاولة بعد ${Math.ceil(blockedMinutes / 60)} ساعة`
            : `تم حظر ${entityName} مؤقتاً. يرجى المحاولة بعد ${blockedMinutes} دقيقة`;
        throw new CustomError(message, HTTP_STATUS.TOO_MANY_REQUESTS);
      }

      // Block expired — the penalty has been served.
      const [unblocked] = await tx
        .update(verificationSessions)
        .set(BLOCK_EXPIRY_RESET)
        .where(eq(verificationSessions.id, session.id))
        .returning({
          id: verificationSessions.id,
          attemptNumber: verificationSessions.attemptNumber,
          isBlocked: verificationSessions.isBlocked,
          blockedUntil: verificationSessions.blockedUntil,
          nextAllowedAt: verificationSessions.nextAllowedAt,
        });
      session = unblocked;
    }

    // ── Rate-limit check ──
    if (session?.nextAllowedAt && new Date(session.nextAllowedAt) > now) {
      const waitSeconds = Math.ceil(
        (new Date(session.nextAllowedAt).getTime() - now.getTime()) / 1000
      );
      throw new CustomError(
        `يرجى الانتظار ${waitSeconds} ثانية قبل إعادة الإرسال`,
        HTTP_STATUS.TOO_MANY_REQUESTS
      );
    }

    // ── Max-attempts → block (app-level check before DB increment — prevents raw constraint violation) ──
    // Defer the throw so the block update COMMITS with the transaction.
    // Throwing inside withTransaction rolls back the block write.
    if (session && session.attemptNumber >= OTP_MAX_ATTEMPTS) {
      const blockedUntil = calculateBlockDuration();
      await tx
        .update(verificationSessions)
        .set({
          isBlocked: true,
          blockedUntil: blockedUntil.toISOString(),
        })
        .where(eq(verificationSessions.id, session.id));

      deferredError = new CustomError(
        `تجاوزت الحد الأقصى من المحاولات. تم حظر ${entityName} لمدة ${OTP_BLOCK_DURATION_HOURS} ساعة`,
        HTTP_STATUS.TOO_MANY_REQUESTS
      );
      return null;
    }

    const expiresAt = calculateOtpExpiry();

    const currentAttempts = session?.attemptNumber ?? 0;
    const nextAllowedAt = calculateNextAllowedAt(currentAttempts + 1);

    // ── Upsert session (atomic) — reset per-cycle verifyAttemptNumber on
    // resend, but KEEP the rolling daily counter so attackers can't reset
    // the 24h bound by requesting a fresh code (issue 1.6).
    const [updatedSession] = await tx
      .insert(verificationSessions)
      .values({
        userId,
        channel,
        identifier,
        purpose,
        targetIdentifier,
        attemptNumber: 1,
        verifyAttemptNumber: 0,
        lastSentAt: now.toISOString(),
        nextAllowedAt: nextAllowedAt.toISOString(),
      })
      .onConflictDoUpdate({
        // Must match ux_verification_sessions_user_channel_purpose — otherwise a
        // change_email send would clobber an in-flight verify_contact code.
        target: [
          verificationSessions.userId,
          verificationSessions.channel,
          verificationSessions.purpose,
        ],
        set: {
          identifier,
          targetIdentifier,
          attemptNumber: sql`${verificationSessions.attemptNumber} + 1`,
          verifyAttemptNumber: 0,
          // A fresh code voids any prior proof for this (user, channel, purpose).
          verifiedAt: null,
          consumedAt: null,
          // Intentionally do NOT touch verifyAttemptDaily /
          // verifyAttemptWindowStart — they survive resends.
          lastSentAt: now.toISOString(),
          nextAllowedAt: nextAllowedAt.toISOString(),
        },
      })
      .returning({
        id: verificationSessions.id,
        attemptNumber: verificationSessions.attemptNumber,
      });

    if (!updatedSession)
      throw new CustomError(MSG_OTP_SEND_FAILED, HTTP_STATUS.INTERNAL_ERROR);

    // ── Invalidate old codes by upserting the latest into the
    //    one-row-per-session slot guarded by `ux_verification_codes_session`.
    //    Single round-trip vs DELETE+INSERT.
    await tx
      .insert(verificationCodes)
      .values({
        sessionId: updatedSession.id,
        code: hashedCode,
        expiresAt: expiresAt.toISOString(),
      })
      .onConflictDoUpdate({
        target: verificationCodes.sessionId,
        set: {
          code: hashedCode,
          expiresAt: expiresAt.toISOString(),
        },
      });

    // TODO: Test this, if it takes more than 1s, move it outside the transaction — see `External OTP Delivery Inside Database Transaction` from TODO.md
    // ── Send OTP (still inside tx so a delivery failure rolls back) ──
    await sendOtp(channel, sendTo, otpCode, smsMessage);

    return {
      nextAllowedIn: Math.ceil(
        (nextAllowedAt.getTime() - now.getTime()) / 1000
      ),
      attemptsRemaining: OTP_MAX_ATTEMPTS - updatedSession.attemptNumber,
    };
  });

  if (deferredError) throw deferredError;
  // result is non-null when no deferred error was set.
  return result as ProcessOtpSendResult;
}

// ── Contact Verified Flag ──

/**
 * Idempotently flip a contact's verified flag and audit the transition, under a
 * row lock on the user. Shared by the OTP verify success path and the
 * OTP_AUTO_VERIFY bypass so the flag is set in exactly one place. Runs inside
 * the caller's transaction. The flag is only set here — never carried onto an
 * unproven address.
 */
export async function markContactVerified(
  tx: WsTx,
  opts: {
    userId: EntityID;
    channel: OtpChannel;
    auditMeta?: {
      ip: string | null;
      userAgent: string | null;
      apiPath: string;
    };
    /** Invoked (must throw) when the user vanished/deactivated mid-flow. */
    onMissing: () => never;
  }
): Promise<void> {
  const [currentUser] = await tx
    .select({
      email: users.email,
      emailVerified: users.emailVerified,
      phoneNumberVerified: users.phoneNumberVerified,
    })
    .from(users)
    .where(
      and(
        eq(users.id, opts.userId),
        isNull(users.deletedAt),
        eq(users.isActive, true)
      )
    )
    .for('update');

  if (!currentUser) opts.onMissing();

  const isEmail = opts.channel === 'email';
  const alreadyVerified = isEmail
    ? currentUser.emailVerified
    : currentUser.phoneNumberVerified;

  // Idempotent re-verification: skip the UPDATE and the audit row so the log
  // only reflects real transitions.
  if (alreadyVerified) return;

  await tx
    .update(users)
    .set(isEmail ? { emailVerified: true } : { phoneNumberVerified: true })
    .where(eq(users.id, opts.userId));

  const fieldName = isEmail ? 'emailVerified' : 'phoneNumberVerified';
  if (opts.auditMeta)
    await auditLog(tx, {
      userId: opts.userId,
      userEmail: currentUser.email,
      action: 'UPDATE',
      tableName: 'users',
      recordId: opts.userId,
      oldData: { [fieldName]: false },
      newData: { [fieldName]: true },
      meta: opts.auditMeta,
    });
}

// ── Reusable OTP Verify Logic ──

interface ProcessOtpVerifyOptions {
  /** User ID that owns the verification session */
  userId: EntityID;
  /** User email — required when auditMeta is provided so the block transition can be audited */
  userEmail?: string;
  /** Channel used when sending */
  channel: OtpChannel;
  /**
   * Reason the code was issued. Bound into the locked lookup so a code proven
   * for one purpose cannot be matched against a verify for another.
   */
  purpose: OtpPurpose;
  /**
   * Normalized identifier (email/phone) submitted by the client. Bound into
   * the locked session lookup so a stale session pointing at an old contact
   * can't be matched against a verify for a different one.
   */
  identifier: string;
  code: string;
  /** Request metadata; when provided, OTP-block transitions are audited */
  auditMeta?: {
    ip: string | null;
    userAgent: string | null;
    apiPath: string;
  };
  /**
   * Callback executed inside the same transaction after successful verification.
   * Receives the matched session's authoritative `targetIdentifier` so the
   * committed value comes from the proven row, never from the request body — a
   * future change to the lookup can't let the written value diverge from what
   * was proven. `verificationSessionId` lets a rotation purge the user's other
   * pending proofs while preserving the one being consumed here.
   */
  onVerified?: (
    tx: WsTx,
    matched: { targetIdentifier: string | null; verificationSessionId: string }
  ) => Promise<void>;
}

/**
 * Verifies an OTP code and runs an optional post-verify callback atomically.
 * Deletes the verification session (and cascaded codes) on success.
 */
type VerifyOutcome =
  | { kind: 'matched' }
  | { kind: 'mismatch' }
  | { kind: 'no-code' }
  // `codeChecked` distinguishes "a wrong code was actually submitted and this
  // attempt crossed the cap" from "the row was already locked". Only the
  // former is a real failure, and only real failures are charged to the
  // shared cross-purpose budget.
  | { kind: 'blocked'; codeChecked: boolean };

export async function processOtpVerify({
  userId,
  userEmail,
  channel,
  purpose,
  identifier,
  code,
  auditMeta,
  onVerified,
}: ProcessOtpVerifyOptions): Promise<void> {
  // Cross-purpose daily bound, checked BEFORE the transaction so no row lock
  // is held across the limiter round-trip. The DB counter below lives on the
  // purpose-scoped proof row, so on its own it grants the documented 24h
  // budget once per reachable purpose instead of once per identity.
  //
  // Consume-then-refund: the token is taken here so concurrent attempts can't
  // all clear the same reading, and given back below when the attempt turns
  // out not to be a failure. Charging unconditionally would count successful
  // verifications and let ordinary use lock an account out of every OTP flow.
  await enforceOtpVerifyDailyBudget({
    channel,
    userId,
    limit: OTP_MAX_DAILY_VERIFY_ATTEMPTS,
  });

  // The token is kept ONLY for an explicitly confirmed wrong-code comparison.
  // Everything else refunds — including every THROWN path (no verification
  // session, DB error). Refunding solely on the normal return let an attacker
  // drain a known user's 24h budget with requests that never reach a code
  // comparison at all.
  let confirmedCodeFailure = false;
  const releaseBudget = async () => {
    if (confirmedCodeFailure) return;
    await refundOtpVerifyAttempt({
      channel,
      userId,
      limit: OTP_MAX_DAILY_VERIFY_ATTEMPTS,
    });
  };

  // Deferred errors: the throw must fire AFTER the transaction commits so the
  // increment/block writes persist. Throwing inside withTransaction rolls back.
  let outcome: VerifyOutcome;
  try {
    outcome = await withTransaction<VerifyOutcome>(async (tx) => {
      // ── Lock the user row FIRST to keep a single, consistent lock order
      // (users → verification_sessions) across all flows. The email-change,
      // admin-edit, and user-delete paths all lock `users` before touching
      // verification_sessions; without this, verify's reverse order
      // (verification_sessions → users via onVerified) can deadlock under
      // concurrent requests. onVerified re-reads under this same lock.
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .for('update');

      // ── Get session with row-level lock — serializes concurrent verifies.
      const [session] = await tx
        .select({
          id: verificationSessions.id,
          isBlocked: verificationSessions.isBlocked,
          blockedUntil: verificationSessions.blockedUntil,
          targetIdentifier: verificationSessions.targetIdentifier,
        })
        .from(verificationSessions)
        .where(
          and(
            eq(verificationSessions.userId, userId),
            eq(verificationSessions.channel, channel),
            eq(verificationSessions.purpose, purpose),
            eq(verificationSessions.identifier, identifier)
          )
        )
        .for('update');

      if (!session)
        throw new CustomError(
          'لم يتم إرسال رمز التحقق. يرجى طلب رمز جديد',
          HTTP_STATUS.NOT_FOUND
        );

      // A session can be flagged blocked by processOtpSend (send-cap) while
      // the verify counters are still under their caps. Without this guard,
      // a leftover non-expired code could be successfully verified on a
      // session that should be locked entirely.
      if (session.isBlocked && session.blockedUntil) {
        // Already locked — no code is looked at, so nothing is charged.
        if (new Date(session.blockedUntil) > new Date())
          return { kind: 'blocked', codeChecked: false };

        // Block expired — same reset as the send path. Clearing only the verify
        // counter here would unblock verification while leaving a send-cap block
        // armed, so the next send would immediately re-block for another full
        // duration.
        await tx
          .update(verificationSessions)
          .set(BLOCK_EXPIRY_RESET)
          .where(eq(verificationSessions.id, session.id));
        session.isBlocked = false;
      }

      // ── Is there anything to verify AGAINST?
      // This runs before the counters are touched. Incrementing first meant an
      // expired or already-consumed session charged a failed attempt for a
      // request that could not possibly be a guess — five of them imposed the
      // full six-hour block, which the send path then honours, so an expired
      // code could be turned into a targeted six-hour denial with no guessing
      // involved. The row is already held under FOR UPDATE, so moving the read
      // above the increment costs no atomicity.
      const [activeCode] = await tx
        .select({
          id: verificationCodes.id,
          code: verificationCodes.code,
        })
        .from(verificationCodes)
        .where(
          and(
            eq(verificationCodes.sessionId, session.id),
            gt(verificationCodes.expiresAt, new Date().toISOString())
          )
        )
        .limit(1);

      if (!activeCode) return { kind: 'no-code' };

      // ── Atomic DB-side check + increment for BOTH counters:
      //   - verify_attempt_number: per-send-cycle counter, reset on resend.
      //   - verify_attempt_daily: rolling 24h counter, survives resends.
      // The WHERE clause enforces both bounds; if either is already at its
      // cap, no row is updated and we'll block. Defense-in-depth on top of
      // FOR UPDATE — the row lock serializes, but doing the bound check in
      // SQL prevents regression if the lock is ever removed.
      const windowExpired = sql`NOW() - ${verificationSessions.verifyAttemptWindowStart} > INTERVAL '24 hours'`;

      const [bumped] = await tx
        .update(verificationSessions)
        .set({
          verifyAttemptNumber: sql`${verificationSessions.verifyAttemptNumber} + 1`,
          // Roll the 24h window: if the stored windowStart is older than 24h,
          // start a fresh window with daily=1; otherwise just increment.
          verifyAttemptDaily: sql`CASE WHEN ${windowExpired} THEN 1 ELSE ${verificationSessions.verifyAttemptDaily} + 1 END`,
          verifyAttemptWindowStart: sql`CASE WHEN ${windowExpired} THEN NOW() ELSE ${verificationSessions.verifyAttemptWindowStart} END`,
        })
        .where(
          and(
            eq(verificationSessions.id, session.id),
            sql`${verificationSessions.verifyAttemptNumber} < ${OTP_MAX_VERIFY_ATTEMPTS}`,
            // Daily bound check post-roll: if the window expired, treat the
            // stored daily value as 0 for the comparison.
            sql`(CASE WHEN ${windowExpired} THEN 0 ELSE ${verificationSessions.verifyAttemptDaily} END) < ${OTP_MAX_DAILY_VERIFY_ATTEMPTS}`
          )
        )
        .returning({
          verifyAttemptNumber: verificationSessions.verifyAttemptNumber,
          verifyAttemptDaily: verificationSessions.verifyAttemptDaily,
        });

      const auditBlockTransition = async (reason: string) => {
        // Only audit the FIRST transition into blocked. If the session was
        // already blocked, this update is a no-op and would emit a misleading
        // "transition" event. Requires userEmail (audit_logs.user_email NOT NULL).
        if (!auditMeta || !userEmail || session.isBlocked) return;
        await auditLog(tx, {
          userId,
          userEmail,
          action: 'UPDATE',
          tableName: 'verification_sessions',
          recordId: session.id,
          oldData: { isBlocked: false },
          newData: { isBlocked: true, channel, reason },
          meta: auditMeta,
        });
      };

      if (!bumped) {
        // A bound was already at cap before this attempt. Mark the session
        // blocked only on the FIRST transition — re-stamping blockedUntil on
        // every subsequent attempt would silently extend the window into a
        // rolling block, which is not the documented OTP_BLOCK_DURATION_HOURS
        // contract and lets an attacker keep a victim locked indefinitely.
        if (!session.isBlocked) {
          await tx
            .update(verificationSessions)
            .set({
              isBlocked: true,
              blockedUntil: calculateBlockDuration().toISOString(),
            })
            .where(eq(verificationSessions.id, session.id));
          await auditBlockTransition('cap_reached');
        }
        // Cap was already spent before this request; the code is never read.
        return { kind: 'blocked', codeChecked: false };
      }

      const shouldBlock =
        bumped.verifyAttemptNumber >= OTP_MAX_VERIFY_ATTEMPTS ||
        bumped.verifyAttemptDaily >= OTP_MAX_DAILY_VERIFY_ATTEMPTS;
      if (shouldBlock) {
        await tx
          .update(verificationSessions)
          .set({
            isBlocked: true,
            blockedUntil: calculateBlockDuration().toISOString(),
          })
          .where(eq(verificationSessions.id, session.id));
      }

      const matched = await verifyOtpCode(code, activeCode.code);

      if (matched) {
        // onVerified runs first so the sensitive action (e.g. committing the new
        // email + flipping the verified flag) and the proof bookkeeping below
        // commit atomically — there is no verify→action window.
        // No block audit even if shouldBlock fired above: the user never actually
        // got blocked from a usable session.
        if (onVerified)
          await onVerified(tx, {
            targetIdentifier: session.targetIdentifier,
            verificationSessionId: session.id,
          });

        if (purpose === 'verify_contact') {
          // Pure ownership proof — nothing downstream consumes it later.
          await tx
            .delete(verificationSessions)
            .where(eq(verificationSessions.id, session.id));
        } else {
          // Sensitive-action proof (change_email/change_phone, passwordless,
          // forgot_password): keep the row as an auditable single-use record,
          // but drop the code so the same proof can never be replayed. The two
          // writes go out in order, not through `Promise.all`: they share the
          // transaction's one connection, so the driver serializes them either
          // way and fanning them out only obscured which of the two failed.
          //
          // The cycle is CLOSED here, so its counters reset:
          //  - `shouldBlock` above may have stamped a block before the code was
          //    even checked. On a correct code the user was never really
          //    blocked, and leaving the flag set would lock the whole
          //    (user, channel, purpose) slot for the full block duration.
          //  - attemptNumber/nextAllowedAt are send-cycle state. Retained
          //    purposes never cleared them, so five successful passwordless
          //    logins left the counter at the cap and the sixth ordinary login
          //    self-inflicted a six-hour block.
          //  - verifyAttemptDaily is REFUNDED, not reset. The column is a
          //    rolling 24h counter of FAILED verifies (see db/schema.ts), but
          //    the bound has to be charged before the code can be checked to
          //    stay atomic. Giving the token back on success is what makes it
          //    an actual failure counter: without it the 16th successful
          //    passwordless login in a day was rejected. The window itself is
          //    untouched, so an attacker can't reset the budget — they would
          //    have to know the code, which is the whole point.
          await tx
            .update(verificationSessions)
            .set({
              verifiedAt: sql`now()`,
              consumedAt: sql`now()`,
              isBlocked: false,
              blockedUntil: null,
              attemptNumber: 0,
              verifyAttemptNumber: 0,
              verifyAttemptDaily: sql`GREATEST(${verificationSessions.verifyAttemptDaily} - 1, 0)`,
              nextAllowedAt: null,
            })
            .where(eq(verificationSessions.id, session.id));

          await tx
            .delete(verificationCodes)
            .where(eq(verificationCodes.sessionId, session.id));
        }
        return { kind: 'matched' };
      }

      // A wrong code WAS submitted and checked here. When it also crossed the
      // cap the outcome is `blocked`, but it is still a failed attempt and must
      // be charged — otherwise every cap-crossing guess is free.
      if (shouldBlock) {
        await auditBlockTransition('threshold_crossed');
        return { kind: 'blocked', codeChecked: true };
      }
      return { kind: 'mismatch' };
    });
  } catch (error) {
    // No code was compared, so the attempt is not chargeable.
    await releaseBudget();
    throw error;
  }

  // Charge only a real wrong-code comparison — including the one that crossed
  // the cap, which also reports as `blocked`. `no-code` is NOT charged: the
  // code had expired, so nothing was compared, and charging it would let an
  // attacker drain the cross-purpose budget against a stale session.
  confirmedCodeFailure =
    outcome.kind === 'mismatch' ||
    (outcome.kind === 'blocked' && outcome.codeChecked);

  await releaseBudget();

  if (outcome.kind === 'matched') return;

  if (outcome.kind === 'no-code')
    throw new CustomError(
      'انتهت صلاحية رمز التحقق. يرجى طلب رمز جديد',
      HTTP_STATUS.BAD_REQUEST
    );
  if (outcome.kind === 'blocked')
    throw new CustomError(
      'تجاوزت الحد الأقصى من محاولات التحقق. يرجى طلب رمز جديد',
      HTTP_STATUS.TOO_MANY_REQUESTS
    );
  throw new CustomError('رمز التحقق غير صحيح', HTTP_STATUS.BAD_REQUEST);
}
