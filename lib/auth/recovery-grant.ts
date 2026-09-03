/**
 * The bridge between proving a recovery contact and rewriting a password, for
 * accounts that hold a second factor.
 *
 * ⚠️ The property it exists for: **no single possession may satisfy both the
 * recovery proof and the second-factor proof in one authentication chain.**
 * Checking that SOME factor survives the contact-kind exclusion is not enough;
 * that factor has to be proven before the password is written.
 *
 * It is a grant rather than a check inside `processOtpVerify` because the second
 * factor cannot be proven inside that transaction: an OTP to the other contact
 * needs a round trip, and holding a row lock across it is not an option. So the
 * code verification commits, and the proof plus the password write happen
 * against the grant in a later request.
 *
 * Constraints, and every one of them is load-bearing:
 *
 *   - single-use, short-lived, bound to ONE user;
 *   - bound to the excluded contact kind, so the second factor can never be a
 *     code to the contact the recovery code already arrived on;
 *   - **not sufficient alone** — possession of the grant plus nothing else
 *     fails, because completion still verifies a factor;
 *   - invalidated when the enrolled method set changes between the two
 *     requests, through a fingerprint of the offered options;
 *   - its own attempt budget, so the grant window is not a free brute-force
 *     window against a six-digit code;
 *   - trusted devices are NOT honoured. A device trusted earlier is not a
 *     second factor for someone who has just proven only a mailbox.
 *
 * Stored as two rows, the same shape the sign-in challenge uses: `recovery-<t>`
 * carries the user id so a credential rotation sweeps it, and
 * `recovery-state-<t>` carries the payload.
 */
import crypto from 'node:crypto';
import type { ContactKind, OfferedOption } from './two-factor-challenge';
import type { EntityID } from '@/types';

import { and, eq, gt } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { verifications } from '@/db/schema';
import { validID } from '@/utils';

const GRANT_BYTES = 24;

/** Long enough to receive a code on another channel, short enough to be useless later. */
export const RECOVERY_GRANT_MAX_AGE_S = 900;

/** Shared across every method, so switching option buys no fresh allowance. */
export const RECOVERY_ALLOWED_ATTEMPTS = 5;

export const recoveryIdentifier = (token: string) => `recovery-${token}`;
export const recoveryStateIdentifier = (token: string) =>
  `recovery-state-${token}`;
const recoveryAttemptsIdentifier = (token: string) =>
  `recovery-attempts-${token}`;

export interface RecoveryGrantState {
  userId: EntityID;
  /** The contact the recovery code arrived on. Never a second factor here. */
  excludeContactKind: ContactKind;
  /** The option identities offered at issuance, in order. */
  options: string[];
}

export interface IssuedRecoveryGrant {
  token: string;
  options: OfferedOption[];
}

export async function issueRecoveryGrant(params: {
  userId: EntityID;
  excludeContactKind: ContactKind;
  options: OfferedOption[];
}): Promise<string> {
  const token = crypto.randomBytes(GRANT_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + RECOVERY_GRANT_MAX_AGE_S * 1000);

  await withTransaction(async (tx) => {
    await tx.insert(verifications).values([
      {
        identifier: recoveryStateIdentifier(token),
        value: JSON.stringify({
          userId: params.userId,
          excludeContactKind: params.excludeContactKind,
          options: params.options.map((option) => option.id),
        } satisfies RecoveryGrantState),
        expiresAt,
      },
      {
        identifier: recoveryIdentifier(token),
        value: params.userId,
        expiresAt,
      },
      {
        identifier: recoveryAttemptsIdentifier(token),
        value: '0',
        expiresAt,
      },
    ]);
  });

  return token;
}

function parseState(raw: string): RecoveryGrantState | null {
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
    (record.excludeContactKind !== 'email' &&
      record.excludeContactKind !== 'phone') ||
    !Array.isArray(options) ||
    !options.every((entry) => typeof entry === 'string')
  )
    return null;
  return {
    userId,
    excludeContactKind: record.excludeContactKind,
    options,
  };
}

/** Reads the grant WITHOUT spending it — the send step needs it to survive. */
export async function readRecoveryGrant(
  token: unknown
): Promise<RecoveryGrantState | null> {
  if (typeof token !== 'string' || token.length === 0) return null;

  const [holder] = await db
    .select({ value: verifications.value })
    .from(verifications)
    .where(
      and(
        eq(verifications.identifier, recoveryIdentifier(token)),
        gt(verifications.expiresAt, new Date())
      )
    )
    .limit(1);
  if (!holder) return null;

  const [state] = await db
    .select({ value: verifications.value })
    .from(verifications)
    .where(
      and(
        eq(verifications.identifier, recoveryStateIdentifier(token)),
        gt(verifications.expiresAt, new Date())
      )
    )
    .limit(1);
  if (!state) return null;

  const parsed = parseState(state.value);
  // Both rows must agree: a state row whose user differs from the holder row is
  // either corruption or a rotation caught mid-flight, and neither is a grant.
  return parsed && parsed.userId === validID(holder.value) ? parsed : null;
}

/**
 * Spends one of the grant's shared attempts.
 *
 * The same consume-and-do-not-write-back protocol the sign-in challenge uses,
 * for the same reason: between the spend and the caller's outcome there must be
 * no row for a concurrent request to read.
 */
export async function spendRecoveryAttempt(token: string): Promise<{
  ok: boolean;
  recordFailure: () => Promise<void>;
  restore: () => Promise<void>;
}> {
  const identifier = recoveryAttemptsIdentifier(token);
  const noop = { recordFailure: async () => {}, restore: async () => {} };

  const consumed = await withTransaction(async (tx) => {
    const [row] = await tx
      .delete(verifications)
      .where(eq(verifications.identifier, identifier))
      .returning({
        value: verifications.value,
        expiresAt: verifications.expiresAt,
      });
    return row ?? null;
  }).catch(() => null);
  if (!consumed) return { ok: false, ...noop };

  // Digits only, for the reason `spendChallengeAttempt` states: `Number('')` is
  // zero, and an empty value would read as a fresh budget.
  const raw = consumed.value.trim();
  const parsed = /^\d+$/u.test(raw) ? Number(raw) : NaN;
  const used =
    Number.isSafeInteger(parsed) && parsed >= 0
      ? parsed
      : RECOVERY_ALLOWED_ATTEMPTS;

  if (used >= RECOVERY_ALLOWED_ATTEMPTS) {
    await invalidateRecoveryGrant(token);
    return { ok: false, ...noop };
  }

  const rearm = async (count: number): Promise<void> => {
    await withTransaction((tx) =>
      tx.insert(verifications).values({
        identifier,
        value: String(count),
        expiresAt: consumed.expiresAt,
      })
    ).catch(() => {});
  };

  return {
    ok: true,
    recordFailure: () => rearm(used + 1),
    restore: () => rearm(used),
  };
}

/**
 * Spends the grant, inside the caller's transaction so the password write and
 * the consumption commit together.
 *
 * Returns `false` when the row was already gone, which is what makes it
 * single-use under concurrency: the DELETE returns the row to exactly one of two
 * racing callers.
 */
export async function consumeRecoveryGrant(
  tx: Parameters<Parameters<typeof withTransaction>[0]>[0],
  token: string,
  userId: EntityID
): Promise<boolean> {
  const [row] = await tx
    .delete(verifications)
    .where(
      and(
        eq(verifications.identifier, recoveryIdentifier(token)),
        eq(verifications.value, userId),
        gt(verifications.expiresAt, new Date())
      )
    )
    .returning({ id: verifications.id });
  if (!row) return false;

  await tx
    .delete(verifications)
    .where(eq(verifications.identifier, recoveryStateIdentifier(token)));
  await tx
    .delete(verifications)
    .where(eq(verifications.identifier, recoveryAttemptsIdentifier(token)));
  return true;
}

export async function invalidateRecoveryGrant(token: string): Promise<void> {
  await withTransaction(async (tx) => {
    for (const identifier of [
      recoveryIdentifier(token),
      recoveryStateIdentifier(token),
      recoveryAttemptsIdentifier(token),
    ])
      await tx
        .delete(verifications)
        .where(eq(verifications.identifier, identifier));
  }).catch(() => {});
}
