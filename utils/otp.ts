import crypto from 'node:crypto';
import type { WsTx } from '@/db/ws';
import type { OtpChannel } from '@/utils/validation/otp';

import { and, eq, gt, sql } from 'drizzle-orm';

import { verificationCodes, verificationSessions } from '@/db/schema';
import { withTransaction } from '@/db/ws';
import { sanitizeForLog } from '@/utils';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import nodemailer from 'nodemailer';

import { HTTP_STATUS } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';
import {
  OTP_BLOCK_DURATION_HOURS,
  OTP_EXPIRY_MINUTES,
  OTP_MAX_ATTEMPTS,
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
  if (channel === 'phone') return sendOtpWhatsApp(identifier, code);
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
  return withTransaction(async (tx) => {
    // Advisory lock serializes concurrent first-send requests for the same user+channel.
    // FOR UPDATE only works when a row already exists — without this, two concurrent
    // requests for a new identifier both see "no row" and both proceed to INSERT.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${userId} || ${channel}))`
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
    if (session && session.attemptNumber >= OTP_MAX_ATTEMPTS) {
      const blockedUntil = calculateBlockDuration();
      await tx
        .update(verificationSessions)
        .set({
          isBlocked: true,
          blockedUntil: blockedUntil.toISOString(),
        })
        .where(eq(verificationSessions.id, session.id));

      throw new CustomError(
        `تجاوزت الحد الأقصى من المحاولات. تم حظر ${entityName} لمدة ${OTP_BLOCK_DURATION_HOURS} ساعة`,
        HTTP_STATUS.TOO_MANY_REQUESTS
      );
    }

    // ── Generate & hash OTP ──
    const otpCode = generateOtpCode();
    const hashedCode = await hashOtpCode(otpCode);
    const expiresAt = calculateOtpExpiry();

    const currentAttempts = session?.attemptNumber ?? 0;
    const nextAllowedAt = calculateNextAllowedAt(currentAttempts + 1);

    // ── Upsert session (atomic) — reset verifyAttemptNumber on resend ──
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
          lastSentAt: now.toISOString(),
          nextAllowedAt: nextAllowedAt.toISOString(),
        },
      })
      .returning({
        id: verificationSessions.id,
        attemptNumber: verificationSessions.attemptNumber,
      });

    // ── Invalidate old codes so only the latest is valid (fixes sequential argon2 cost) ──
    await tx
      .delete(verificationCodes)
      .where(eq(verificationCodes.sessionId, updatedSession.id));

    // ── Save hashed OTP code ──
    await tx.insert(verificationCodes).values({
      sessionId: updatedSession.id,
      code: hashedCode,
      expiresAt: expiresAt.toISOString(),
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
}

// ── Reusable OTP Verify Logic ──

interface ProcessOtpVerifyOptions {
  /** User ID that owns the verification session */
  userId: EntityID;
  /** Channel used when sending */
  channel: OtpChannel;
  code: string;
  /** Callback executed inside the same transaction after successful verification */
  onVerified?: (tx: WsTx) => Promise<void>;
}

/**
 * Verifies an OTP code and runs an optional post-verify callback atomically.
 * Deletes the verification session (and cascaded codes) on success.
 */
export async function processOtpVerify({
  userId,
  channel,
  code,
  onVerified,
}: ProcessOtpVerifyOptions): Promise<void> {
  await withTransaction(async (tx) => {
    // ── Get session with row-level lock ──
    const [session] = await tx
      .select({
        id: verificationSessions.id,
        verifyAttemptNumber: verificationSessions.verifyAttemptNumber,
      })
      .from(verificationSessions)
      .where(
        and(
          eq(verificationSessions.userId, userId),
          eq(verificationSessions.channel, channel)
        )
      )
      .for('update');

    if (!session)
      throw new CustomError(
        'لم يتم إرسال رمز التحقق. يرجى طلب رمز جديد',
        HTTP_STATUS.NOT_FOUND
      );

    // ── Brute-force protection (app-level check before DB increment) ──
    if (session.verifyAttemptNumber >= OTP_MAX_VERIFY_ATTEMPTS)
      throw new CustomError(
        'تجاوزت الحد الأقصى من محاولات التحقق. يرجى طلب رمز جديد',
        HTTP_STATUS.TOO_MANY_REQUESTS
      );

    // ── Get active (unexpired) code — only one exists since old codes are invalidated on resend ──
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

    if (!activeCode)
      throw new CustomError(
        'انتهت صلاحية رمز التحقق. يرجى طلب رمز جديد',
        HTTP_STATUS.BAD_REQUEST
      );

    // ── Verify code ──
    const matched = await verifyOtpCode(code, activeCode.code);

    if (!matched) {
      // Increment verify attempt counter
      await tx
        .update(verificationSessions)
        .set({
          verifyAttemptNumber: sql`${verificationSessions.verifyAttemptNumber} + 1`,
        })
        .where(eq(verificationSessions.id, session.id));

      throw new CustomError('رمز التحقق غير صحيح', HTTP_STATUS.BAD_REQUEST);
    }

    // ── Post-verify callback (same transaction) ──
    if (onVerified) await onVerified(tx);

    // ── Clean up session (cascades to codes) ──
    await tx
      .delete(verificationSessions)
      .where(eq(verificationSessions.id, session.id));
  });
}
