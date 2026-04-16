import type { WsTx } from '@/db/ws';

import { and, eq, isNull, sql } from 'drizzle-orm';

import { accounts, users } from '@/db/schema';
import { withTransaction } from '@/db/ws';
import { verifyPassword } from 'better-auth/crypto';

import { CREDENTIAL_PROVIDER_ID } from '@/utils/api-messages';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_SECONDS = 5 * 60; // 5 minutes

export interface VerifyAttemptOptions {
  password: string;
  /** Find user by email (login flow) */
  email?: string;
  /** Find user by ID (authenticated endpoints — skips email lookup) */
  userId?: string;
  /** Skip the fake-hash timing guard (for authenticated endpoints where user is known) */
  skipTimingGuard?: boolean;
  /** Reuse an existing transaction instead of creating a new one */
  tx?: WsTx;
}

/**
 * Atomic login verification: locks the user row, checks lock status,
 * verifies the password, and updates attempt counters — all in a single
 * transaction. Eliminates the TOCTOU race between check and increment.
 *
 * Returns true on successful verification, throws on any failure.
 */
export async function verifyLoginAttempt(
  options: VerifyAttemptOptions
): Promise<true> {
  const {
    password,
    email,
    userId,
    skipTimingGuard = false,
    tx: externalTx,
  } = options;

  const executor = async (tx: WsTx): Promise<true> => {
    const whereClause = userId
      ? and(eq(users.id, userId), isNull(users.deletedAt))
      : and(eq(users.email, email!), isNull(users.deletedAt));

    const [user] = await tx
      .select({
        id: users.id,
        isActive: users.isActive,
        failedLoginAttempts: users.failedLoginAttempts,
        lockedUntil: users.lockedUntil,
      })
      .from(users)
      .where(whereClause)
      .for('update')
      .limit(1);

    // User not found — don't reveal whether account exists
    if (!user) return reject(password, skipTimingGuard);

    if (!user.isActive) return reject(password, skipTimingGuard);

    // Account locked and lock not yet expired
    if (user.lockedUntil) {
      const lockTime = new Date(user.lockedUntil).getTime();
      if (lockTime > Date.now()) return reject(password, skipTimingGuard);

      // Lock expired — reset within the same transaction before proceeding
      await tx
        .update(users)
        .set({ failedLoginAttempts: 0, lockedUntil: null })
        .where(eq(users.id, user.id));
    }

    const [account] = await tx
      .select({ password: accounts.password })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, user.id),
          eq(accounts.providerId, CREDENTIAL_PROVIDER_ID)
        )
      );

    const ok = await verifyPassword({
      hash: account?.password ?? '',
      password,
    });

    if (!ok) {
      // Increment counter + lock if threshold reached — single atomic UPDATE
      await tx
        .update(users)
        .set({
          failedLoginAttempts: sql`${users.failedLoginAttempts} + 1`,
          lockedUntil: sql`
            CASE
              WHEN ${users.failedLoginAttempts} + 1 >= ${MAX_FAILED_ATTEMPTS}
              THEN NOW() + make_interval(secs => ${LOCK_DURATION_SECONDS})
              ELSE ${users.lockedUntil}
            END`,
        })
        .where(eq(users.id, user.id));

      throw new LoginRejected();
    }

    // Successful — reset attempts (no-op if already 0)
    if (user.failedLoginAttempts > 0) {
      await tx
        .update(users)
        .set({ failedLoginAttempts: 0, lockedUntil: null })
        .where(eq(users.id, user.id));
    }

    return true;
  };

  if (externalTx) return executor(externalTx);
  return withTransaction<true>(executor);
}

// Pre-computed hash of a dummy password — guarantees the full scrypt computation
// runs even when the user doesn't exist, equalizing response timing.
// Generated via: hashPassword('__timing_guard_dummy__')
const DUMMY_HASH =
  '87d098331f88fd6812baa9e6d1d7bf2d:8fbe29d3b3bfb0e282b0687f5f6e097920bcd715261674570ba60881289bb47c585ca68c7095d2768c42c900406c464a302e167076a09cac2e1320c662be229d';

async function reject(
  password: string,
  skipTimingGuard: boolean
): Promise<never> {
  if (!skipTimingGuard) {
    await verifyPassword({ hash: DUMMY_HASH, password });
  }
  throw new LoginRejected();
}

export class LoginRejected extends Error {
  constructor() {
    super('login_rejected');
  }
}
