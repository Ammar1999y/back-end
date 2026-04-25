import type { WsTx } from '@/db/ws';

import { and, eq, isNull, sql } from 'drizzle-orm';

import { accounts, users } from '@/db/schema';
import { withTransaction } from '@/db/ws';
import { auditLog } from '@/lib/audit';
import { EntityID } from '@/types';
import { verifyPassword } from 'better-auth/crypto';

import { CREDENTIAL_PROVIDER_ID } from '@/utils/api-messages';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_SECONDS = 5 * 60; // 5 minutes

export interface VerifyAttemptOptions {
  password: string;
  /** Find user by email (login flow) */
  email?: string;
  /** Find user by ID (authenticated endpoints — skips email lookup) */
  userId?: EntityID;
  /** Skip the fake-hash timing guard (for authenticated endpoints where user is known) */
  skipTimingGuard?: boolean;
  /** Reuse an existing transaction instead of creating a new one */
  tx?: WsTx;
  /**
   * When provided, lockout enter/exit and successful-login transitions are
   * recorded in audit_logs. Failed-password attempts are intentionally not
   * audited (high volume, low signal); only the lockout transition is.
   */
  auditMeta?: {
    ip: string | null;
    userAgent: string | null;
    apiPath: string;
  };
}

type Outcome =
  | 'success'
  | 'reject_unknown_or_inactive'
  | 'reject_locked'
  | 'reject_bad_password';

/**
 * Atomic login verification: locks the user row, checks lock status,
 * verifies the password, and updates attempt counters — all in a single
 * transaction. Eliminates the TOCTOU race between check and increment.
 *
 * The decision (success / reject) is computed inside the transaction and
 * returned. The throw and the optional timing guard run AFTER the tx
 * commits so the failed-attempt increment and lockout audit persist
 * (a throw inside withTransaction would roll the writes back).
 *
 * Returns true on successful verification, throws LoginRejected on any failure.
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
    auditMeta,
  } = options;

  const executor = async (tx: WsTx): Promise<Outcome> => {
    const whereClause = userId
      ? and(eq(users.id, userId), isNull(users.deletedAt))
      : and(eq(users.email, email!), isNull(users.deletedAt));

    const [user] = await tx
      .select({
        id: users.id,
        email: users.email,
        isActive: users.isActive,
        failedLoginAttempts: users.failedLoginAttempts,
        lockedUntil: users.lockedUntil,
      })
      .from(users)
      .where(whereClause)
      .for('update')
      .limit(1);

    // User not found — don't reveal whether account exists
    if (!user) return 'reject_unknown_or_inactive';
    if (!user.isActive) return 'reject_unknown_or_inactive';

    // Account locked and lock not yet expired
    if (user.lockedUntil) {
      const lockTime = new Date(user.lockedUntil).getTime();
      if (lockTime > Date.now()) return 'reject_locked';

      // Lock expired — reset within the same transaction before proceeding
      await tx
        .update(users)
        .set({ failedLoginAttempts: 0, lockedUntil: null })
        .where(eq(users.id, user.id));

      if (auditMeta) {
        await auditLog(tx, {
          userId: user.id,
          userEmail: user.email,
          action: 'UPDATE',
          tableName: 'users',
          recordId: user.id,
          oldData: {
            lockedUntil: user.lockedUntil,
            failedLoginAttempts: user.failedLoginAttempts,
          },
          newData: {
            lockedUntil: null,
            failedLoginAttempts: 0,
            lockoutCleared: true,
          },
          meta: auditMeta,
        });
      }
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
      const willLock =
        user.failedLoginAttempts + 1 >= MAX_FAILED_ATTEMPTS;

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

      if (willLock && auditMeta) {
        const lockedUntil = new Date(
          Date.now() + LOCK_DURATION_SECONDS * 1000
        ).toISOString();
        await auditLog(tx, {
          userId: user.id,
          userEmail: user.email,
          action: 'UPDATE',
          tableName: 'users',
          recordId: user.id,
          oldData: {
            failedLoginAttempts: user.failedLoginAttempts,
            lockedUntil: null,
          },
          newData: {
            failedLoginAttempts: user.failedLoginAttempts + 1,
            lockedUntil,
            accountLocked: true,
          },
          meta: auditMeta,
        });
      }

      return 'reject_bad_password';
    }

    // Successful — reset attempts (no-op if already 0)
    if (user.failedLoginAttempts > 0) {
      await tx
        .update(users)
        .set({ failedLoginAttempts: 0, lockedUntil: null })
        .where(eq(users.id, user.id));
    }

    if (auditMeta) {
      await auditLog(tx, {
        userId: user.id,
        userEmail: user.email,
        action: 'UPDATE',
        tableName: 'users',
        recordId: user.id,
        oldData: {
          failedLoginAttempts: user.failedLoginAttempts,
          lockedUntil: user.lockedUntil,
        },
        newData: {
          failedLoginAttempts: 0,
          lockedUntil: null,
          loginSuccess: true,
        },
        meta: auditMeta,
      });
    }

    return 'success';
  };

  const outcome = externalTx
    ? await executor(externalTx)
    : await withTransaction<Outcome>(executor);

  if (outcome === 'success') return true;

  // Bad password: verifyPassword already ran, so timing is naturally normalised.
  // Unknown user / locked: run the dummy hash to equalise timing with the real path.
  if (outcome !== 'reject_bad_password' && !skipTimingGuard) {
    await verifyPassword({ hash: DUMMY_HASH, password });
  }
  throw new LoginRejected();
}

// Pre-computed hash of a dummy password — guarantees the full scrypt computation
// runs even when the user doesn't exist, equalizing response timing.
// Generated via: hashPassword('__timing_guard_dummy__')
const DUMMY_HASH =
  '87d098331f88fd6812baa9e6d1d7bf2d:8fbe29d3b3bfb0e282b0687f5f6e097920bcd715261674570ba60881289bb47c585ca68c7095d2768c42c900406c464a302e167076a09cac2e1320c662be229d';

export class LoginRejected extends Error {
  constructor() {
    super('login_rejected');
  }
}
