import type { WsTx } from '@/db/ws';
import type { EntityID } from '@/types';

import { and, eq, isNull, sql } from 'drizzle-orm';

import { accounts, users } from '@/db/schema';
import { withTransaction } from '@/db/ws';
import { auditLog } from '@/lib/audit';

import { CREDENTIAL_PROVIDER_ID } from '@/utils/api-messages';

import {
  hashPassword,
  runPasswordTimingGuard,
  verifyPasswordDetailed,
} from './password';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_SECONDS = 5 * 60; // 5 minutes

interface AuditMeta {
  ip: string | null;
  userAgent: string | null;
  apiPath: string;
}

const PASSWORD_UPGRADE_AUDIT_META = {
  ip: null,
  userAgent: null,
  apiPath: 'internal/password-hash-upgrade',
} satisfies AuditMeta;

export interface VerifyAttemptOptions {
  password: string;
  /** Find user by email (login flow) */
  email?: string;
  /** Find user by ID (authenticated endpoints — skips email lookup) */
  userId?: EntityID;
  /** Skip the Argon2 timing guard (for authenticated endpoints where user is known) */
  skipTimingGuard?: boolean;
  /** Return a CAS proof and leave the verified hash unchanged for an immediate password mutation */
  returnPasswordProof?: boolean;
  /** Reuse an existing transaction instead of creating a new one */
  tx?: WsTx;
  /**
   * When provided, lockout enter/exit and successful-login transitions are
   * recorded in audit_logs. Failed-password attempts are intentionally not
   * audited (high volume, low signal); only the lockout transition is.
   */
  auditMeta?: AuditMeta;
}

export interface VerifiedPasswordProof {
  readonly accountId: EntityID;
  readonly expectedHash: string;
}

type RejectedOutcome =
  'reject_unknown_or_inactive' | 'reject_locked' | 'reject_bad_password';

interface PendingPasswordUpgrade {
  accountId: EntityID;
  userId: EntityID;
  userEmail: string;
  expectedHash: string;
  previousPepperId: string;
  activePepperId: string;
}

type AttemptResult =
  | {
      outcome: 'success';
      passwordProof: VerifiedPasswordProof;
      passwordUpgrade?: PendingPasswordUpgrade;
    }
  | { outcome: RejectedOutcome; passwordCostPaid: boolean };

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
 * Returns true on successful verification and throws LoginRejected on any
 * credential rejection. The explicit proof mode returns a compare-and-swap
 * proof instead and suppresses the automatic hash upgrade.
 */
export function verifyLoginAttempt(
  options: VerifyAttemptOptions & { returnPasswordProof: true }
): Promise<VerifiedPasswordProof>;
export function verifyLoginAttempt(
  options: VerifyAttemptOptions & { returnPasswordProof?: false }
): Promise<true>;
export async function verifyLoginAttempt(
  options: VerifyAttemptOptions
): Promise<true | VerifiedPasswordProof> {
  const {
    password,
    email,
    userId,
    skipTimingGuard = false,
    returnPasswordProof = false,
    tx: externalTx,
    auditMeta,
  } = options;

  const executor = async (tx: WsTx): Promise<AttemptResult> => {
    const identityFilter = userId
      ? eq(users.id, userId)
      : email
        ? eq(users.email, email)
        : undefined;

    if (!identityFilter)
      throw new Error('verifyLoginAttempt requires either email or userId');

    const whereClause = and(identityFilter, isNull(users.deletedAt));

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
    if (!user) {
      return {
        outcome: 'reject_unknown_or_inactive',
        passwordCostPaid: false,
      };
    }
    if (!user.isActive) {
      return {
        outcome: 'reject_unknown_or_inactive',
        passwordCostPaid: false,
      };
    }

    // Account locked and lock not yet expired
    if (user.lockedUntil) {
      const lockTime = new Date(user.lockedUntil).getTime();
      if (lockTime > Date.now()) {
        return { outcome: 'reject_locked', passwordCostPaid: false };
      }

      // Lock expired — reset within the same transaction before proceeding
      const [reset] = await tx
        .update(users)
        .set({ failedLoginAttempts: 0, lockedUntil: null })
        .where(eq(users.id, user.id))
        .returning({
          failedLoginAttempts: users.failedLoginAttempts,
          lockedUntil: users.lockedUntil,
        });

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

      // Adopt the post-reset row as the authoritative state. The branches
      // below derive `willLock` and both audit payloads from these values;
      // keeping the pre-reset counter made the next failed attempt report
      // "attempt 6, accountLocked: true" while the DB actually stored
      // attempt 1 and no lock.
      user.failedLoginAttempts = reset?.failedLoginAttempts ?? 0;
      user.lockedUntil = reset?.lockedUntil ?? null;
    }

    const [account] = await tx
      .select({ id: accounts.id, password: accounts.password })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, user.id),
          eq(accounts.providerId, CREDENTIAL_PROVIDER_ID)
        )
      );

    const storedHash = account?.password ?? '';
    const verification = await verifyPasswordDetailed({
      hash: storedHash,
      password,
    });

    if (!verification.valid) {
      const willLock = user.failedLoginAttempts + 1 >= MAX_FAILED_ATTEMPTS;

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

      return {
        outcome: 'reject_bad_password',
        passwordCostPaid: verification.costPaid,
      };
    }

    if (!account?.password) {
      throw new Error('Verified credential account is missing its hash');
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

    const passwordUpgrade = verification.needsRehash
      ? {
          accountId: account.id,
          userId: user.id,
          userEmail: user.email,
          expectedHash: account.password,
          previousPepperId: verification.pepperId,
          activePepperId: verification.activePepperId,
        }
      : undefined;

    return {
      outcome: 'success',
      passwordProof: {
        accountId: account.id,
        expectedHash: account.password,
      },
      passwordUpgrade,
    };
  };

  const result = externalTx
    ? await executor(externalTx)
    : await withTransaction<AttemptResult>(executor);

  if (result.outcome === 'success') {
    if (returnPasswordProof) return result.passwordProof;

    if (!externalTx && result.passwordUpgrade) {
      try {
        await upgradePasswordHash({
          password,
          upgrade: result.passwordUpgrade,
          auditMeta,
        });
      } catch (error) {
        console.error(
          'Automatic password hash upgrade failed; it will be retried after a later successful verification',
          { errorName: error instanceof Error ? error.name : 'UnknownError' }
        );
      }
    }
    return true;
  }

  // Any branch that did not verify a PHC hash pays the active Argon2 cost after
  // the transaction commits, including missing or unsupported credentials.
  if (!skipTimingGuard && !result.passwordCostPaid) {
    await runPasswordTimingGuard(password);
  }
  throw new LoginRejected();
}

async function upgradePasswordHash({
  password,
  upgrade,
  auditMeta,
}: {
  password: string;
  upgrade: PendingPasswordUpgrade;
  auditMeta?: AuditMeta;
}): Promise<void> {
  const upgradedHash = await hashPassword(password);

  await withTransaction(async (tx) => {
    const [updated] = await tx
      .update(accounts)
      .set({ password: upgradedHash })
      .where(
        and(
          eq(accounts.id, upgrade.accountId),
          eq(accounts.password, upgrade.expectedHash)
        )
      )
      .returning({ id: accounts.id });

    if (!updated) return;

    await auditLog(tx, {
      userId: upgrade.userId,
      userEmail: upgrade.userEmail,
      action: 'UPDATE',
      tableName: 'accounts',
      recordId: updated.id,
      oldData: { passwordPepperId: upgrade.previousPepperId },
      newData: {
        passwordPepperId: upgrade.activePepperId,
        passwordHashUpgraded: true,
      },
      // The pepper's VERSION id, not the pepper. Declared because the generic
      // denylist matches the substring `password` and would otherwise strip the
      // only fields this event exists to record.
      safeFields: ['passwordPepperId'],
      meta: auditMeta ?? PASSWORD_UPGRADE_AUDIT_META,
    });
  });
}

export class LoginRejected extends Error {
  constructor() {
    super('login_rejected');
  }
}
