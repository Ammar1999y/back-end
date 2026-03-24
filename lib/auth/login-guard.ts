import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import { users } from '@/db/schema';
import { withTransaction } from '@/db/ws';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Checks if a user account is locked due to too many failed login attempts.
 * If the lock has expired, atomically resets it within the same transaction.
 * Uses FOR UPDATE to serialize concurrent login checks on the same row.
 */
export async function checkLoginLock(
  email: string
): Promise<{ locked: boolean; secondsLeft: number } | null> {
  return withTransaction(async (tx) => {
    const [user] = await tx
      .select({
        failedLoginAttempts: users.failedLoginAttempts,
        lockedUntil: users.lockedUntil,
      })
      .from(users)
      .where(and(eq(users.email, email), isNull(users.deletedAt)))
      .for('update')
      .limit(1);

    if (!user) return null;

    if (user.lockedUntil) {
      const lockTime = new Date(user.lockedUntil).getTime();
      const now = Date.now();

      if (lockTime > now) {
        return {
          locked: true,
          secondsLeft: Math.ceil((lockTime - now) / 1000),
        };
      }

      // Lock expired — reset inside the same locked transaction
      await tx
        .update(users)
        .set({ failedLoginAttempts: 0, lockedUntil: null })
        .where(and(eq(users.email, email), isNull(users.deletedAt)));
    }

    return { locked: false, secondsLeft: 0 };
  });
}

/**
 * Records a failed login attempt atomically in a single SQL statement.
 * If the threshold is reached, locks the account in the same UPDATE.
 */
export async function recordFailedLogin(email: string): Promise<void> {
  const lockDurationSeconds = LOCK_DURATION_MS / 1000;
  const { db } = await import('@/db');

  await db.execute(sql`
    UPDATE users
    SET
      failed_login_attempts = failed_login_attempts + 1,
      locked_until = CASE
        WHEN failed_login_attempts + 1 >= ${MAX_FAILED_ATTEMPTS}
          THEN NOW() + make_interval(secs => ${lockDurationSeconds})
        ELSE locked_until
      END
    WHERE email = ${email} AND deleted_at IS NULL
  `);
}

/**
 * Resets failed login attempts and lock on successful login.
 * Only issues an UPDATE if the user actually has failed attempts,
 * avoiding unnecessary writes on every successful login.
 */
export async function resetLoginAttempts(email: string): Promise<void> {
  const { db } = await import('@/db');

  await db
    .update(users)
    .set({ failedLoginAttempts: 0, lockedUntil: null })
    .where(
      and(
        eq(users.email, email),
        isNull(users.deletedAt),
        gt(users.failedLoginAttempts, 0)
      )
    );
}
