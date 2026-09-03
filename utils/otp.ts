import crypto from 'node:crypto';
import type { Tx } from '@/db';
import type { EntityID } from '@/types';
import type { OtpChannel, OtpPurpose } from '@/utils/validation/otp';
import type { Transporter } from 'nodemailer';

import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import { withTransaction } from '@/db';
import { users, verificationCodes, verificationSessions } from '@/db/schema';
import { sanitizeForLog } from '@/utils';
import { createTransport } from 'nodemailer';
import { auditLog } from '@/lib/audit';
import {
  canEvaluateOtp,
  hashOtpCode,
  verifyOtpCode,
} from '@/lib/auth/otp-hash';
import { enforceOtpGlobalSendBudget, otpContactKind } from '@/lib/rate-limit';

import { HTTP_STATUS } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';
import { recordOutboxDelivery } from '@/utils/otp-outbox';
import {
  OTP_BLOCK_DURATION_HOURS,
  OTP_EXPIRY_MINUTES,
  OTP_MAX_ATTEMPTS,
  OTP_MAX_DAILY_VERIFY_ATTEMPTS,
  OTP_MAX_VERIFY_ATTEMPTS,
} from '@/utils/validation/constants';
import { OTP_DELIVERY_OUTBOX } from '@/utils/validation/otp';

const PROVIDER_TIMEOUT_MS = 5000;

// ── Email Transport (lazy-initialized to avoid crash when env vars are missing) ──
let _transporter: Transporter | null = null;
function getTransporter() {
  if (!_transporter) {
    // eslint-disable-next-line unicorn/no-top-level-assignment-in-function -- memoized lazy singleton; the assignment IS the cache
    _transporter = createTransport({
      service: 'gmail',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },

      connectionTimeout: PROVIDER_TIMEOUT_MS,
      dnsTimeout: PROVIDER_TIMEOUT_MS,
      greetingTimeout: PROVIDER_TIMEOUT_MS,
      socketTimeout: PROVIDER_TIMEOUT_MS,
    });
  }
  return _transporter;
}

// ── OTP Generation & Hashing ──

function generateOtpCode() {
  return crypto.randomInt(100_000, 1_000_000).toString();
}

// Re-exported, not reimplemented: the primitive and its key lifecycle live in
// `lib/auth/otp-hash.ts`, which records why OTPs no longer share the password
// KDF profile or the password pepper keyring. Imported as well as re-exported —
// `export ... from` does not bind the names in this module, and both are used
// below.

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
 * that bound ages out on its own anchor, not on block expiry.
 */
const BLOCK_EXPIRY_RESET = {
  isBlocked: false,
  blockedUntil: null,
  attemptNumber: 0,
  verifyAttemptNumber: 0,
} as const;

const VERIFY_BLOCK_CLEARED_BY_RESEND = {
  isBlocked: false,
  blockedUntil: null,
  verifyAttemptNumber: 0,
} as const;

/**
 * Marks a 429 that came from PROOF-ROW state rather than from a limiter.
 *
 * The distinction is a disclosure boundary. A proof row exists only for an
 * account that exists, so its throttle is account-dependent: measured on both
 * anonymous verification endpoints, four wrong codes for a real address answered
 * `400` and the fifth answered `429` with `Retry-After: 21600` and the block
 * message, while an unknown address answered the generic `400` throughout — an
 * exact, CAPTCHA-solvable existence test in five requests. The pre-lookup IP and
 * destination limiters carry no marker and keep their 429, because they fire for
 * real and fake identifiers alike.
 */
const OTP_PROOF_THROTTLE_CODE = 'otp_proof_throttle';

/**
 * Errors that represent a code that was actually COMPARED and rejected, as
 * opposed to a request that never reached a comparison.
 *
 * A `WeakSet` rather than another `code` value because `blockedError` already
 * spends `CustomError.code` on the disclosure marker, and both facts have to
 * travel on the same throw. Nothing here reaches the wire.
 *
 * The distinction exists for callers holding a budget of their own — the 2FA
 * challenge's five attempts — which must be charged for guesses and refunded
 * for everything else. See `spendChallengeAttempt`.
 */
const evaluatedGuesses = new WeakSet<object>();

function markEvaluatedGuess<E extends object>(error: E): E {
  evaluatedGuesses.add(error);
  return error;
}

/** Did `error` come from a submitted code losing a comparison? */
export function otpGuessWasEvaluated(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && evaluatedGuesses.has(error)
  );
}

function blockedError(message: string, until: Date | null): CustomError {
  const error = new CustomError(
    message,
    HTTP_STATUS.TOO_MANY_REQUESTS,
    OTP_PROOF_THROTTLE_CODE
  );
  const seconds = until
    ? Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000))
    : OTP_BLOCK_DURATION_HOURS * 3600;
  error.responseHeaders = { 'Retry-After': String(seconds) };
  return error;
}

/**
 * Collapse an account-dependent proof throttle to the generic invalid-code
 * rejection, for use at every ANONYMOUS verification boundary.
 *
 * Returns the error unchanged when it is not one, so a call site can hand it
 * whatever it caught. Authenticated boundaries deliberately do NOT call this —
 * there is no account to reveal to a caller who already holds its session, and
 * the accurate `Retry-After` is worth more there.
 */
export function collapseProofThrottle(
  error: unknown,
  genericMessage: string
): unknown {
  if (error instanceof CustomError && error.code === OTP_PROOF_THROTTLE_CODE)
    return new CustomError(genericMessage, HTTP_STATUS.BAD_REQUEST);
  return error;
}

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

/**
 * What the code is FOR, in the message that carries it: a user who cannot tell a
 * login code from a password-reset code will approve whichever an attacker
 * triggered.
 */
const OTP_PURPOSE_LABEL: Readonly<Record<OtpPurpose, string>> = {
  verify_contact: 'تأكيد وسيلة التواصل',
  forgot_password: 'إعادة تعيين كلمة المرور',
  change_password: 'تغيير كلمة المرور',
  passwordless_login: 'تسجيل الدخول',
  change_email: 'تغيير البريد الإلكتروني',
  change_phone: 'تغيير رقم الهاتف',
  two_factor: 'التحقق بخطوتين',
};

/** The body a phone channel sends. One line, because SMS is billed per segment. */
export function otpTextFor(purpose: OtpPurpose, code: string): string {
  return `رمز ${OTP_PURPOSE_LABEL[purpose]}: ${code}\nلا تشارك هذا الرمز مع أي شخص`;
}

/** The subject an email carries, which is what a user sees before opening it. */
export function otpSubjectFor(purpose: OtpPurpose): string {
  return `${OTP_PURPOSE_LABEL[purpose]} — رمز التحقق`;
}

async function sendOtpSms(
  phoneNumber: string,
  code: string,
  messageText?: string
) {
  const response = await fetch('https://apis.deewan.sa/sms/v1/messages', {
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      Authorization: `Bearer ${process.env.DEEWAN_SMS_TOKEN}`,
    },
    body: JSON.stringify({
      senderName: process.env.DEEWAN_SENDER_NAME,
      messageType: 'text',
      messageText: messageText ?? otpTextFor('verify_contact', code),
      recipients: phoneNumber,
    }),
  });

  if (!response.ok) {
    console.error(describeProviderFailure('sms', response));
    throw new CustomError(MSG_SMS_SEND_FAILED, HTTP_STATUS.INTERNAL_ERROR);
  }
}

async function sendOtpWhatsApp(
  phoneNumber: string,
  code: string,
  purpose: OtpPurpose
) {
  const formData = new FormData();
  formData.append('message_type', 'text');
  formData.append('recipients', phoneNumber);
  formData.append('content', otpTextFor(purpose, code));

  const response = await fetch('https://services.rmz.one/api/whatsapp/send', {
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
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
 * Everything reaching this boundary is created inside the process (fetch,
 * Nodemailer, our own `CustomError`), so a plain read is enough. The provider's
 * PAYLOAD is the untrusted part — which is why `message` is only ever tested
 * against `SAFE_DELIVERY_MESSAGES`, never logged.
 */
function readErrorField(
  error: unknown,
  key: 'message' | 'name' | 'code'
): string | null {
  if (typeof error !== 'object' || error === null || !(key in error))
    return null;
  const value: unknown = Reflect.get(error, key);
  return typeof value === 'string' ? value : null;
}

async function sendOtpEmail(email: string, code: string, purpose: OtpPurpose) {
  let info: Awaited<ReturnType<Transporter['sendMail']>>;

  try {
    info = await getTransporter().sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email,
      subject: otpSubjectFor(purpose),
      text: otpTextFor(purpose, code),
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
    const rawCode = readErrorField(error, 'code');
    console.error(
      sanitizeForLog({
        msg: 'otp.provider.failed',
        channel: 'email',
        smtpCode:
          rawCode !== null && SMTP_ERROR_CODES.has(rawCode)
            ? rawCode
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
 *  - `smsMessage` is invoked INSIDE the boundary. Evaluating it in the caller
 *    handed the OTP to a caller-supplied callback outside this `try`, so a
 *    throw from it bypassed the boundary entirely.
 */
async function sendOtp(
  channel: OtpChannel,
  identifier: string,
  code: string,
  purpose: OtpPurpose,
  smsMessage?: (code: string) => string
) {
  try {
    const text =
      channel === 'sms'
        ? (smsMessage?.(code) ?? otpTextFor(purpose, code))
        : otpTextFor(purpose, code);
    if (OTP_DELIVERY_OUTBOX) {
      recordOutboxDelivery({
        channel,
        destination: identifier,
        purpose,
        code,
        subject: channel === 'email' ? otpSubjectFor(purpose) : null,
        text,
      });
      return;
    }
    if (channel === 'sms') return await sendOtpSms(identifier, code, text);
    if (channel === 'whatsapp')
      return await sendOtpWhatsApp(identifier, code, purpose);
    return await sendOtpEmail(identifier, code, purpose);
  } catch (error) {
    const message = readErrorField(error, 'message');

    if (
      message &&
      error instanceof CustomError &&
      SAFE_DELIVERY_MESSAGES.has(message)
    ) {
      // A FRESH error, not the original. Rethrowing carried whatever `code`,
      // `status`, `responseHeaders` — or any field added later — the thrower
      // attached, and the serializer copies several of those. Only the message
      // has been checked, so only the message is kept.
      throw new CustomError(message, HTTP_STATUS.INTERNAL_ERROR);
    }

    // The class name only: `Error` / `TypeError` / `CustomError` from our own
    // dependencies. Never `message` or `response` — those quote the provider's
    // reply, which quotes the body carrying the plaintext code.
    console.error(
      sanitizeForLog({
        msg: 'otp.delivery.unexpectedError',
        channel,
        errorName: readErrorField(error, 'name') ?? 'Unknown',
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
  /** Localized entity label used in error messages */
  entityName: string;
  /** Optional custom SMS message. Receives the OTP code as argument */
  smsMessage?: (code: string) => string;
  /**
   * Hands the provider call to the caller to run AFTER its response is on the
   * wire. Every HTTP caller passes one; without it the delivery is awaited
   * inline, which is what a script or a future non-HTTP caller wants.
   *
   * **This is what stops the send endpoints being an existence oracle.**
   * `ensureMinDelay` is a floor with no ceiling, and the provider call sat on
   * the response path — so with the SMS provider stubbed to 3 000 ms, four
   * unregistered numbers answered in 1 502–1 588 ms and four registered ones in
   * 3 079–3 106 ms, with an identical 200 body every time. The signal is
   * one-sided and sound: any response above the floor proves the real branch
   * ran. Raising `MINIMUM_RESPONSE_MS` cannot fix it — the floor would have to
   * exceed an unbounded third-party call — so the call has to leave the path.
   *
   * It also removes two other consequences of the old placement: a slow provider
   * could exceed the route's 60 s idle ceiling and drop the client's connection
   * with an empty body while the handler kept running, and those in-flight
   * requests counted as busy connections that held `app.stop()` open during a
   * deploy.
   */
  deferDelivery?: (task: () => Promise<void>) => void;
}

interface ProcessOtpSendResult {
  nextAllowedIn: number;
  attemptsRemaining: number;
}

async function refundFailedDelivery(
  sessionId: EntityID,
  hashedCode: string
): Promise<void> {
  await withTransaction(async (tx) => {
    const [removed] = await tx
      .delete(verificationCodes)
      .where(
        and(
          eq(verificationCodes.sessionId, sessionId),
          eq(verificationCodes.code, hashedCode)
        )
      )
      .returning({ id: verificationCodes.id });
    if (!removed) return;
    await tx
      .update(verificationSessions)
      .set({
        attemptNumber: sql`GREATEST(${verificationSessions.attemptNumber} - 1, 0)`,
        nextAllowedAt: null,
      })
      .where(eq(verificationSessions.id, sessionId));
  });
}

/**
 * Handles rate-limiting, OTP generation, storage, and delivery.
 *
 * Storage runs inside a transaction with row-level locking; delivery runs after
 * it commits, for the pool-exhaustion reason recorded at the call itself.
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
  deferDelivery,
}: ProcessOtpSendOptions): Promise<ProcessOtpSendResult> {
  // The session row is keyed on what is being proven, not on the transport.
  const contactKind = otpContactKind(channel);

  // Still computed before the locks are taken. It is an HMAC now rather than a
  // 64 MiB Argon2id hash, so the ordering no longer buys much — but "do no work
  // you can do earlier while holding a row lock" is the rule worth keeping.
  const otpCode = generateOtpCode();
  const hashedCode = hashOtpCode(otpCode);

  // Buffer deferred errors so max-attempts block persists (commit) before we throw.
  let deferredError: CustomError | null = null;

  const result = await withTransaction(async (tx) => {
    // Advisory lock serializes concurrent first-send requests for the same row.
    // FOR UPDATE only works when a row already exists — without this, two concurrent
    // requests for a new identifier both see "no row" and both proceed to INSERT.
    // Two-argument form gives a 64-bit keyspace, avoiding the birthday-
    // collision rate of the single-arg int4 form at high OTP concurrency.
    // Keyed on the contact KIND, matching the unique index: locking on the
    // transport let a concurrent sms and whatsapp send take different locks and
    // then race for the same row.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${userId}), hashtext(${contactKind} || ':' || ${purpose}))`
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
          eq(verificationSessions.contactKind, contactKind),
          eq(verificationSessions.purpose, purpose)
        )
      )
      .for('update');

    // Captured BEFORE the clear below, so the max-attempts branch can preserve
    // an existing send-side deadline instead of minting a new one.
    const existingBlockedUntil = session?.isBlocked
      ? session.blockedUntil
      : null;

    // ── Block check ──
    //
    // A live block is CLEARED here, not thrown on — see
    // `VERIFY_BLOCK_CLEARED_BY_RESEND` for why that does not weaken anything.
    // A send-side block survives it, because `attemptNumber` survives it and the
    // max-attempts branch below re-derives the same block from that counter.
    if (session?.isBlocked && session.blockedUntil) {
      const [unblocked] = await tx
        .update(verificationSessions)
        .set(
          session.blockedUntil > now
            ? VERIFY_BLOCK_CLEARED_BY_RESEND
            : // Expired: the penalty has been served, so both cycle counters go
              // back to zero and the send ladder restarts.
              BLOCK_EXPIRY_RESET
        )
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
    if (session?.nextAllowedAt && session.nextAllowedAt > now) {
      const waitSeconds = Math.ceil(
        (session.nextAllowedAt.getTime() - now.getTime()) / 1000
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
      // The deadline is stamped ONCE and then preserved. Re-deriving it from
      // `Date.now()` on every request turns a fixed `OTP_BLOCK_DURATION_HOURS`
      // penalty into a ROLLING one that anyone who knows the identifier can
      // extend indefinitely — which is the failure the verify side already
      // guards against with its own `if (!session.isBlocked)`.
      //
      // Reachable specifically because the block check above now CLEARS a live
      // block before this branch runs (see `VERIFY_BLOCK_CLEARED_BY_RESEND`), so
      // `session.isBlocked` is always false here and cannot be used as the
      // guard. `existingBlockedUntil` is captured before that clear.
      const blockedUntil =
        existingBlockedUntil && existingBlockedUntil > now
          ? existingBlockedUntil
          : calculateBlockDuration();
      await tx
        .update(verificationSessions)
        .set({
          isBlocked: true,
          blockedUntil,
        })
        .where(eq(verificationSessions.id, session.id));

      deferredError = blockedError(
        `تجاوزت الحد الأقصى من المحاولات. تم حظر ${entityName} لمدة ${OTP_BLOCK_DURATION_HOURS} ساعة`,
        blockedUntil
      );
      return null;
    }

    const expiresAt = calculateOtpExpiry();

    const currentAttempts = session?.attemptNumber ?? 0;
    const nextAllowedAt = calculateNextAllowedAt(currentAttempts + 1);

    // ── Upsert session (atomic) — reset per-cycle verifyAttemptNumber on
    // resend, but KEEP verifyAttemptDaily so attackers can't reset the 24h
    // bound by requesting a fresh code.
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
        lastSentAt: now,
        nextAllowedAt,
      })
      .onConflictDoUpdate({
        // Must match ux_verification_sessions_user_contact_purpose — otherwise a
        // change_email send would clobber an in-flight verify_contact code.
        target: [
          verificationSessions.userId,
          verificationSessions.contactKind,
          verificationSessions.purpose,
        ],
        set: {
          // The transport can change between resends (sms -> whatsapp) while the
          // row stays the same; record the one actually used.
          channel,
          identifier,
          targetIdentifier,
          attemptNumber: sql`${verificationSessions.attemptNumber} + 1`,
          verifyAttemptNumber: 0,
          // A fresh code voids any prior proof for this (user, contact, purpose).
          verifiedAt: null,
          consumedAt: null,
          // Intentionally do NOT touch verifyAttemptDaily /
          // verifyAttemptWindowStart — they survive resends.
          lastSentAt: now,
          nextAllowedAt,
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
        expiresAt,
      })
      .onConflictDoUpdate({
        target: verificationCodes.sessionId,
        set: {
          code: hashedCode,
          expiresAt,
        },
      });

    // Charged HERE and nowhere else, once eligibility is established. Charged
    // earlier in the chain, requests naming addresses nobody owns could exhaust
    // the whole deployment's daily OTP delivery. Inside the transaction so a
    // rejection rolls back the code just stored.
    await enforceOtpGlobalSendBudget({ channel });

    return {
      nextAllowedIn: Math.ceil(
        (nextAllowedAt.getTime() - now.getTime()) / 1000
      ),
      attemptsRemaining: OTP_MAX_ATTEMPTS - updatedSession.attemptNumber,
      sessionId: updatedSession.id,
    };
  });

  // Before delivery: a max-attempts block stored no code, so there is nothing to
  // send. The throw also has to precede `sendOtp` because `result` is null on
  // that path.
  if (deferredError) throw deferredError;

  // Delivery follows the commit so provider latency cannot hold row locks and a
  // pool connection. A failed delivery removes and refunds only the matching
  // code, so it cannot erase or refund a newer send. Anonymous callers defer the
  // provider call to keep its latency from revealing that the account exists;
  // authenticated callers await it and receive the delivery failure.
  if (!result)
    throw new CustomError(MSG_OTP_SEND_FAILED, HTTP_STATUS.INTERNAL_ERROR);
  const deliver = async () => {
    try {
      await sendOtp(channel, sendTo, otpCode, purpose, smsMessage);
    } catch (error) {
      try {
        await refundFailedDelivery(result.sessionId, hashedCode);
      } catch (refundError) {
        console.error(
          sanitizeForLog({
            msg: 'otp.delivery.refundFailed',
            error: refundError,
          })
        );
      }
      throw error;
    }
  };
  if (deferDelivery) deferDelivery(deliver);
  else await deliver();

  // result is non-null when no deferred error was set.
  return {
    nextAllowedIn: result.nextAllowedIn,
    attemptsRemaining: result.attemptsRemaining,
  };
}

// ── Contact Verified Flag ──

/**
 * Idempotently flip a contact's verified flag and audit the transition, under a
 * row lock on the user. Runs inside the caller's transaction.
 *
 * Owns every verification of an UNCHANGED address — the OTP verify success path
 * and the OTP_AUTO_VERIFY bypass. Contact REPLACEMENT does not route through
 * here: `contact-change.ts` writes the new address and its verified flag in one
 * atomic UPDATE, because splitting them would leave the row carrying a new
 * address with the old flag.
 */
export async function markContactVerified(
  tx: Tx,
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
    tx: Tx,
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
  /**
   * `blockedUntil` travels out of the transaction so the 429 can carry an
   * accurate `Retry-After`. Null only when the row was blocked with no expiry
   * recorded, which the writes below never produce — `blockedError` falls back
   * to the full duration rather than omitting the header.
   */
  | {
      kind: 'blocked';
      blockedUntil: Date | null;
      /** Whether a submitted code was compared before the block was raised. */
      evaluated: boolean;
    };

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
  // What this code proves, independent of how it was delivered. Every lookup
  // and budget below keys on it, so switching sms -> whatsapp reaches the same
  // row rather than a second allowance against the same phone number.
  const contactKind = otpContactKind(channel);

  // Deferred errors: the throw must fire AFTER the transaction commits so the
  // increment/block writes persist. Throwing inside withTransaction rolls back.
  const outcome = await withTransaction<VerifyOutcome>(async (tx) => {
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
        // The transport the code was actually SENT over, for the audit payload
        // below. The request's `channel` is client-supplied and only has to agree
        // with the proof's `contactKind` — `sms` and `whatsapp` both reach the
        // same row — so recording it could misreport how the message was
        // delivered.
        channel: verificationSessions.channel,
      })
      .from(verificationSessions)
      .where(
        and(
          eq(verificationSessions.userId, userId),
          eq(verificationSessions.contactKind, contactKind),
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
      if (session.blockedUntil > new Date())
        return {
          kind: 'blocked',
          blockedUntil: session.blockedUntil,
          evaluated: false,
        };

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
          gt(verificationCodes.expiresAt, new Date())
        )
      )
      .limit(1);

    if (!activeCode) return { kind: 'no-code' };

    // An OTP hashed under a key generation that is no longer configured can
    // never match. Checked HERE — before the attempt counters, so an operator's
    // mis-timed rotation cannot spend a user's budget — and answered as an
    // expired code, because that is exactly what it is: the code is unusable and
    // requesting a new one fixes it. Letting `verifyOtpCode` throw instead rolled
    // the transaction back into a 500, which distinguished a real live proof from
    // an unknown account on both anonymous verification endpoints.
    if (!canEvaluateOtp(activeCode.code)) {
      // No identifier and no secret: the key id is the actionable part and it is
      // already stored in every envelope.
      console.error(
        JSON.stringify({
          msg: 'otp.verify.keyUnavailable',
          effect: 'live codes under a retired key cannot be verified',
          purpose,
          contactKind,
        })
      );
      return { kind: 'no-code' };
    }

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
        newData: { isBlocked: true, channel: session.channel, reason },
        meta: auditMeta,
      });
    };

    const windowExpired = sql`NOW() - ${verificationSessions.verifyAttemptWindowStart} > INTERVAL '24 hours'`;

    // 24h failure budget for THIS proof row. The filter is the row's unique
    // key (ux_verification_sessions_user_contact_purpose), so the SUM reads one
    // row; it is a SUM only to fold an aged-out window to zero in SQL. Scoped
    // to the purpose deliberately: a wider scope let failed verify_contact
    // attempts deny the victim's forgot_password flow.
    //
    // NOT a rolling window — the row anchors its own 24h period at
    // verifyAttemptWindowStart. Read-then-write is safe: `users` is held FOR
    // UPDATE above, so verifies for this user are serialized.
    const [dailyUsage] = await tx
      .select({
        used: sql<number>`COALESCE(SUM(CASE WHEN ${windowExpired} THEN 0 ELSE ${verificationSessions.verifyAttemptDaily} END), 0)`.mapWith(
          Number
        ),
      })
      .from(verificationSessions)
      .where(
        and(
          eq(verificationSessions.userId, userId),
          eq(verificationSessions.contactKind, contactKind),
          eq(verificationSessions.purpose, purpose)
        )
      );

    const dailyUsed = dailyUsage?.used ?? 0;
    // Budget already spent: the code is never read, so this request cannot be
    // a guess and is not charged.
    if (dailyUsed >= OTP_MAX_DAILY_VERIFY_ATTEMPTS) {
      let blockedUntil = session.blockedUntil;
      if (!session.isBlocked) {
        blockedUntil = calculateBlockDuration();
        await tx
          .update(verificationSessions)
          .set({ isBlocked: true, blockedUntil })
          .where(eq(verificationSessions.id, session.id));
        await auditBlockTransition('daily_cap_reached');
      }
      return { kind: 'blocked', blockedUntil, evaluated: false };
    }

    // The per-cycle bound stays in the WHERE clause as defense in depth if the
    // row lock is ever removed. The daily bound is NOT here — it is not a
    // property of this row.
    const [bumped] = await tx
      .update(verificationSessions)
      .set({
        verifyAttemptNumber: sql`${verificationSessions.verifyAttemptNumber} + 1`,
        // Reset an EXPIRED anchored window — this does not slide it. If the
        // anchor is older than 24h the counter restarts at 1 from a new anchor;
        // otherwise it increments. So two full budgets can fall inside one
        // moving 24-hour interval, one just before an anchor expires and one
        // just after. That is the accepted limitation, not a rolling window.
        verifyAttemptDaily: sql`CASE WHEN ${windowExpired} THEN 1 ELSE ${verificationSessions.verifyAttemptDaily} + 1 END`,
        verifyAttemptWindowStart: sql`CASE WHEN ${windowExpired} THEN NOW() ELSE ${verificationSessions.verifyAttemptWindowStart} END`,
      })
      .where(
        and(
          eq(verificationSessions.id, session.id),
          sql`${verificationSessions.verifyAttemptNumber} < ${OTP_MAX_VERIFY_ATTEMPTS}`
        )
      )
      .returning({
        verifyAttemptNumber: verificationSessions.verifyAttemptNumber,
      });

    if (!bumped) {
      // The per-cycle cap was already spent before this attempt. Mark the
      // session blocked only on the FIRST transition — re-stamping
      // blockedUntil on every subsequent attempt would silently extend the
      // window into a rolling block, which is not the documented
      // OTP_BLOCK_DURATION_HOURS contract and lets an attacker keep a victim
      // locked indefinitely.
      let blockedUntil = session.blockedUntil;
      if (!session.isBlocked) {
        blockedUntil = calculateBlockDuration();
        await tx
          .update(verificationSessions)
          .set({ isBlocked: true, blockedUntil })
          .where(eq(verificationSessions.id, session.id));
        await auditBlockTransition('cap_reached');
      }
      // Cap was already spent before this request; the code is never read.
      return { kind: 'blocked', blockedUntil, evaluated: false };
    }

    const shouldBlock =
      bumped.verifyAttemptNumber >= OTP_MAX_VERIFY_ATTEMPTS ||
      dailyUsed + 1 >= OTP_MAX_DAILY_VERIFY_ATTEMPTS;
    const blockUntil = shouldBlock ? calculateBlockDuration() : null;
    if (blockUntil) {
      await tx
        .update(verificationSessions)
        .set({ isBlocked: true, blockedUntil: blockUntil })
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
        //    (user, contactKind, purpose) slot for the full block duration.
        //  - attemptNumber/nextAllowedAt are send-cycle state. Retained
        //    purposes never cleared them, so five successful passwordless
        //    logins left the counter at the cap and the sixth ordinary login
        //    self-inflicted a six-hour block.
        //  - verifyAttemptDaily is REFUNDED, not reset. The column counts
        //    FAILED verifies in a 24h anchored window (see db/schema.ts), but
        //    the bound has to be charged before the code can be checked to
        //    stay atomic. Giving the token back on success is what makes it
        //    an actual failure counter: without it the 16th successful
        //    passwordless login in a day was rejected. It commits with this
        //    transaction, so unlike an external counter it cannot be lost. The
        //    window is untouched, so resetting the budget still requires
        //    knowing the code.
        //
        // Accepted tradeoff: a user who can complete verifies never accumulates
        // the DB-side SEND throttle. Their remaining bound is the
        // `otp.send.*` limiter chain — the bound moved, it did not disappear.
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

    // A wrong code WAS submitted and checked here, and it crossed a cap. The
    // increment above already charged it — every path that reaches a code
    // comparison charges, and only the ones that never look at a code
    // (`no-code`, already-blocked, budget spent) return before it.
    if (shouldBlock) {
      await auditBlockTransition('threshold_crossed');
      return { kind: 'blocked', blockedUntil: blockUntil, evaluated: true };
    }
    return { kind: 'mismatch' };
  });

  if (outcome.kind === 'matched') return;

  if (outcome.kind === 'no-code')
    throw new CustomError(
      'انتهت صلاحية رمز التحقق. يرجى طلب رمز جديد',
      HTTP_STATUS.BAD_REQUEST
    );
  if (outcome.kind === 'blocked') {
    // Says it is a block, and carries how long it lasts — see `blockedError`.
    // The message also tells the caller a NEW code will lift it, which is true
    // now that a resend clears a verify-side block.
    const blocked = blockedError(
      'تم حظر التحقق مؤقتاً بعد تجاوز عدد المحاولات. يرجى طلب رمز جديد',
      outcome.blockedUntil
    );
    throw outcome.evaluated ? markEvaluatedGuess(blocked) : blocked;
  }
  throw markEvaluatedGuess(
    new CustomError('رمز التحقق غير صحيح', HTTP_STATUS.BAD_REQUEST)
  );
}

export { hashOtpCode } from '@/lib/auth/otp-hash';
