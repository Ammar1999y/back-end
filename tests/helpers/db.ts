import './env';

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';

import * as schema from '@/db/schema';

if (!process.env.DATABASE_URL)
  throw new Error('tests: DATABASE_URL must be set');

const client = neon(process.env.DATABASE_URL);
export const tdb = drizzle<typeof schema>(client, { schema });

// `tag:` is a per-test-process prefix folded into names and emails so parallel
// runs don't collide, and `wipe()` can target only this run's data.
export const TAG = `t${Date.now().toString(36)}${Math.random()
  .toString(36)
  .slice(2, 6)}`;
export const tag = (suffix: string) => `${TAG}-${suffix}`;
export const tagEmail = (local: string, domain = 'gmail.com') =>
  `${TAG}-${local}@${domain}`.toLowerCase();

/**
 * Removes every row inserted under TAG (test users, their roles, audit
 * trails, sessions). Runs at the end of a suite — keeps the shared dev
 * database tidy without disturbing rows other suites are still using.
 *
 * Order matters: dependent tables before the rows they reference.
 */
export async function wipeTag() {
  // Audit log rows pointing at things we created (by email match — the audit
  // log records user_email at action time).
  await tdb.execute(
    sql`DELETE FROM audit_logs WHERE user_email LIKE ${`${TAG}-%`}`
  );
  // Verification sessions for users we created.
  await tdb.execute(
    sql`DELETE FROM verification_sessions WHERE identifier LIKE ${`${TAG}-%`} OR identifier LIKE ${`%@${TAG}.test`}`
  );
  await tdb.execute(
    sql`DELETE FROM users WHERE email LIKE ${`${TAG}-%`} OR email LIKE ${`%${TAG}%`}`
  );
  // Roles tagged with the run prefix. role_permissions cascades on delete.
  await tdb.execute(
    sql`DELETE FROM roles WHERE role_name LIKE ${`${TAG}-%`} OR role_name LIKE ${`custom-${TAG}%`}`
  );
}

/**
 * Hard-resets a single user's brute-force lock counters. Useful between
 * login-attempt tests so the same email isn't locked out from the previous
 * test's failures.
 */
export async function unlockUser(email: string) {
  await tdb.execute(sql`
    UPDATE users SET failed_login_attempts = 0, locked_until = NULL
    WHERE email = ${email.toLowerCase()}
  `);
}
