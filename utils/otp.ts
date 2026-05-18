import crypto from 'node:crypto';
import type { WsTx } from '@/db/ws';
import type { OtpChannel } from '@/utils/validation/otp';

import { and, eq, gt, sql } from 'drizzle-orm';

import { verificationCodes, verificationSessions } from '@/db/schema';
import { withTransaction } from '@/db/ws';
import { auditLog } from '@/lib/audit';
import { sanitizeForLog } from '@/utils';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import nodemailer from 'nodemailer';

import { HTTP_STATUS } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';
import {
  OTP_BLOCK_DURATION_HOURS,
  OTP_EXPIRY_MINUTES,
  OTP_MAX_ATTEMPTS,
  OTP_MAX_DAILY_VERIFY_ATTEMPTS,
  OTP_MAX_VERIFY_ATTEMPTS,
} from '@/utils/validation/constants';
import { EntityID } from '@/types';

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

// ── Delivery Functions ──

export async function sendOtpSms(
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
    const errorData = await response.json().catch(() => null);
    console.error(sanitizeForLog(errorData));
    throw new CustomError(
      'حدثت مشكلة اثناء إرسال رمز التحقق عبر SMS',
      HTTP_STATUS.INTERNAL_ERROR
    );
  }
}

export async function sendOtpWhatsApp(phoneNumber: string, code: string) {
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
    const errorData = await response.json().catch(() => null);
    console.error(sanitizeForLog(errorData));
    throw new CustomError(
      'حدثت مشكلة اثناء إرسال رمز التحقق',
      HTTP_STATUS.INTERNAL_ERROR
    );
  }

  const data = await response.json();
  if (!data.status) {
    console.error(sanitizeForLog(data));
    throw new CustomError(
      'حدثت مشكلة اثناء إرسال رمز التحقق',
      HTTP_STATUS.INTERNAL_ERROR
    );
  }
}

export async function sendOtpEmail(email: string, code: string) {
  const info = await getTransporter().sendMail({
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

  if (!info.messageId) {
    throw new CustomError(
      'حدثت مشكلة اثناء إرسال رمز التحقق عبر البريد الإلكتروني',
      HTTP_STATUS.INTERNAL_ERROR
    );
  }
}

/** Dispatches OTP to the appropriate channel */
async function sendOtp(
  channel: OtpChannel,
  identifier: string,
  code: string,
  messageText?: string
) {
  if (channel === 'sms') return sendOtpSms(identifier, code, messageText);
  if (channel === 'whatsapp') return sendOtpWhatsApp(identifier, code);
  return sendOtpEmail(identifier, code);
}

// ── Reusable OTP Send Logic ──

interface ProcessOtpSendOptions {
  /** User ID to bind the verification session to */
  userId: EntityID;
  /** Unique key for the verification session (e.g. email, phone) */
  identifier: string;
  channel: OtpChannel;
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
 * Runs inside a transaction with row-level locking.
 */
export async function processOtpSend({
  userId,
  identifier,
  channel,
  sendTo,
  entityName,
  smsMessage,
}: ProcessOtpSendOptions): Promise<ProcessOtpSendResult> {
  // Buffer deferred errors so max-attempts block persists (commit) before we throw.
  let deferredError: CustomError | null = null;

  const result = await withTransaction(async (tx) => {
    // Advisory lock serializes concurrent first-send requests for the same user+channel.
    // FOR UPDATE only works when a row already exists — without this, two concurrent
    // requests for a new identifier both see "no row" and both proceed to INSERT.
    // Two-argument form gives a 64-bit keyspace, avoiding the birthday-
    // collision rate of the single-arg int4 form at high OTP concurrency.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${userId}), hashtext(${channel}))`
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
          eq(verificationSessions.channel, channel)
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

      // Block expired — reset
      const [unblocked] = await tx
        .update(verificationSessions)
        .set({
          isBlocked: false,
          blockedUntil: null,
          attemptNumber: 0,
        })
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

    // ── Generate & hash OTP ──
    const otpCode = generateOtpCode();
    const hashedCode = await hashOtpCode(otpCode);
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
        attemptNumber: 1,
        verifyAttemptNumber: 0,
        lastSentAt: now.toISOString(),
        nextAllowedAt: nextAllowedAt.toISOString(),
      })
      .onConflictDoUpdate({
        target: [verificationSessions.userId, verificationSessions.channel],
        set: {
          identifier,
          attemptNumber: sql`${verificationSessions.attemptNumber} + 1`,
          verifyAttemptNumber: 0,
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
    await sendOtp(channel, sendTo, otpCode, smsMessage?.(otpCode));

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

// ── Reusable OTP Verify Logic ──

interface ProcessOtpVerifyOptions {
  /** User ID that owns the verification session */
  userId: EntityID;
  /** User email — required when auditMeta is provided so the block transition can be audited */
  userEmail?: string;
  /** Channel used when sending */
  channel: OtpChannel;
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
  /** Callback executed inside the same transaction after successful verification */
  onVerified?: (tx: WsTx) => Promise<void>;
}

/**
 * Verifies an OTP code and runs an optional post-verify callback atomically.
 * Deletes the verification session (and cascaded codes) on success.
 */
type VerifyOutcome =
  | { kind: 'matched' }
  | { kind: 'mismatch' }
  | { kind: 'no-code' }
  | { kind: 'blocked' };

export async function processOtpVerify({
  userId,
  userEmail,
  channel,
  identifier,
  code,
  auditMeta,
  onVerified,
}: ProcessOtpVerifyOptions): Promise<void> {
  // Deferred errors: the throw must fire AFTER the transaction commits so the
  // increment/block writes persist. Throwing inside withTransaction rolls back.
  const outcome = await withTransaction<VerifyOutcome>(async (tx) => {
    // ── Get session with row-level lock — serializes concurrent verifies.
    const [session] = await tx
      .select({
        id: verificationSessions.id,
        isBlocked: verificationSessions.isBlocked,
        blockedUntil: verificationSessions.blockedUntil,
      })
      .from(verificationSessions)
      .where(
        and(
          eq(verificationSessions.userId, userId),
          eq(verificationSessions.channel, channel),
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
    if (
      session.isBlocked &&
      session.blockedUntil &&
      new Date(session.blockedUntil) > new Date()
    ) {
      return { kind: 'blocked' };
    }

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
      return { kind: 'blocked' };
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

    // Return (don't throw) so the increment/block writes commit.
    if (!activeCode) return { kind: 'no-code' };

    const matched = await verifyOtpCode(code, activeCode.code);

    if (matched) {
      // Session deleted — no block audit even if shouldBlock fired above,
      // because the user never actually got blocked from a usable session.
      if (onVerified) await onVerified(tx);
      await tx
        .delete(verificationSessions)
        .where(eq(verificationSessions.id, session.id));
      return { kind: 'matched' };
    }

    if (shouldBlock) await auditBlockTransition('threshold_crossed');
    return { kind: shouldBlock ? 'blocked' : 'mismatch' };
  });

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
