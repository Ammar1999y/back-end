/**
 * ⚠️ DEV ONLY — DESTRUCTIVE — DISPOSABLE SERVICES ONLY ⚠️
 *
 * Writes to the real database in `.env`: inserts users, roles and sessions, and
 * deletes what it created. Not a test, not safe for CI/staging/production. See
 * `scripts/probe/dev-live/README.md`.
 *
 * Run: bun run probe:db
 *
 * ---
 *
 * The `bun:sql` driver contract — the properties that only a live PostgreSQL can
 * prove, and that broke or nearly broke during the Neon removal.
 *
 * `scripts/probe/local/log-serializer.test.ts` already pins the serializer's
 * handling of a `PostgresError` built by hand from Bun's own constructor. That
 * runs in CI and needs no server, but it cannot prove the one thing underneath
 * it: that Bun POPULATES those fields from the wire the way the constructor
 * suggests. Everything here exists because a real server is the only witness.
 *
 * What it pins down:
 *  - the SQLSTATE arrives in `errno`, not `code` — the relocation that silently
 *    disabled `isUniqueViolation` and `isForeignKeyViolation`
 *  - a real constraint name reaches `getConstraintName`, and a real users
 *    violation still maps to 409 rather than a generic 500
 *  - `sanitizeForLog` keeps the SQLSTATE while still withholding the bound
 *    parameter PostgreSQL echoes back
 *  - every jsonb write lands as a jsonb OBJECT, and the `||` merge in the
 *    permission-refresh path merges instead of concatenating
 *  - a transaction is one session: same backend PID, advisory lock visible,
 *    rollback on throw, nested block behaves as a savepoint
 *  - `db.execute()` yields rows as an array, which three call sites read
 *
 * See reports/test-strategy.md §7.4 for why each one is here.
 */
import type { SessionMetadata } from '@/lib/permissions/constants';

import { eq, sql } from 'drizzle-orm';

import { db, withTransaction } from '@/db';
import { roles, sessions, users } from '@/db/schema';
import {
  getConstraintName,
  isForeignKeyViolation,
  isUniqueViolation,
  sanitizeForLog,
} from '@/utils';
import { afterAll, expect, test } from 'bun:test';
import { refreshUserSessions } from '@/lib/permissions/utils';

import { handleUserUniqueViolation } from '@/utils/api-response';

/** Every row this probe creates carries the stamp, so cleanup is unambiguous. */
const STAMP = 'drvprobe';

/**
 * The email schema allowlists a few consumer providers, so the domain is not
 * free-form; the stamped local part is what makes these rows identifiable.
 */
const mail = (name: string) => `${STAMP}-${name}@gmail.com`;

async function seedRole(name: string, scope: 'system' | 'standard' = 'system') {
  const [role] = await db
    .insert(roles)
    .values({ roleName: `${STAMP}-${name}`, scope, isActive: true })
    .returning({ id: roles.id });
  if (!role) throw new Error('probe: role insert returned no row');
  return role.id;
}

async function seedUser(roleId: string, name: string) {
  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    name: `${STAMP} ${name}`,
    email: mail(name),
    roleId,
    isActive: true,
  });
  return id;
}

afterAll(async () => {
  const seeded = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`${users.email} LIKE ${`${STAMP}-%`}`);
  for (const { id } of seeded)
    await db.delete(sessions).where(eq(sessions.userId, id));
  await db.delete(users).where(sql`${users.email} LIKE ${`${STAMP}-%`}`);
  await db.delete(roles).where(sql`${roles.roleName} LIKE ${`${STAMP}-%`}`);
});

test('a real unique violation carries its SQLSTATE in errno, and its constraint name', async () => {
  const roleId = await seedRole('uniq');
  await seedUser(roleId, 'uniq');

  let thrown: unknown;
  try {
    await seedUser(roleId, 'uniq');
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeDefined();
  expect(isUniqueViolation(thrown)).toBe(true);
  // The index name, not an empty string: `getConstraintName` feeds the resolver
  // that turns this into a field-specific message.
  expect(getConstraintName(thrown)).toContain('email');
  // The relocation itself, stated as an assertion rather than as a comment: the
  // wire code is NOT in `code`, so a matcher reading `code` alone sees nothing.
  const raw = thrown as { code?: unknown; errno?: unknown };
  expect(
    raw.errno ?? (thrown as { cause?: { errno?: unknown } }).cause?.errno
  ).toBe('23505');
  expect(raw.code).not.toBe('23505');
});

test('a real users unique violation maps to 409, not a generic 500', async () => {
  const roleId = await seedRole('409');
  await seedUser(roleId, '409');

  let thrown: unknown;
  try {
    await seedUser(roleId, '409');
  } catch (error) {
    thrown = error;
  }
  expect(handleUserUniqueViolation(thrown)?.status).toBe(409);
});

test('a real foreign-key violation is recognised', async () => {
  let thrown: unknown;
  try {
    // a role id that exists nowhere
    await seedUser(crypto.randomUUID(), 'fk');
  } catch (error) {
    thrown = error;
  }
  expect(isForeignKeyViolation(thrown)).toBe(true);
});

test('the log line keeps the SQLSTATE and withholds the bound parameter', async () => {
  let undefinedTable: unknown;
  try {
    await db.execute(sql`SELECT 1 FROM a_table_that_does_not_exist`);
  } catch (error) {
    undefinedTable = error;
  }
  expect(JSON.stringify(sanitizeForLog(undefinedTable))).toContain('42P01');

  // PostgreSQL echoes the offending value into a 22P02 message, so this is the
  // containment half: the code survives, the value does not.
  const secret = 'not-a-uuid-3f9a2b';
  let badCast: unknown;
  try {
    await db.select().from(users).where(eq(users.id, secret));
  } catch (error) {
    badCast = error;
  }
  const serialized = JSON.stringify(sanitizeForLog(badCast));
  expect(serialized).toContain('22P02');
  expect(serialized).not.toContain(secret);
});

test('every jsonb write lands as an object, and the permission merge merges', async () => {
  const roleId = await seedRole('jsonb', 'standard');
  const userId = await seedUser(roleId, 'jsonb');
  /**
   * A key `SessionMetadata` does not declare, which is the point: the property
   * under test is that the merge preserves keys the type does not know about, so
   * a REPLACE — or the array concatenation the double encode produced — is
   * visible. The intersection widens the value without an `as` cast.
   */
  const seededMetadata: SessionMetadata & Record<string, unknown> = {
    keepMe: 'must survive',
  };
  const [session] = await db
    .insert(sessions)
    .values({
      userId,
      token: `${STAMP}-token`,
      // `expires_at` is declared `mode: 'string'`, so the column's type is an
      // ISO string rather than a Date. A Date coerces at runtime and would only
      // fail the typecheck.
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      metadata: seededMetadata,
    })
    .returning({ id: sessions.id });
  if (!session) throw new Error('probe: session insert returned no row');

  // `jsonb_typeof`, not a select through drizzle: the ORM's own read path parses
  // a string back into an object, which is exactly what hid the double encode.
  const kindAfterInsert = await db.execute(
    sql`SELECT jsonb_typeof(metadata) AS kind FROM sessions WHERE id = ${session.id}`
  );
  expect(kindAfterInsert[0]?.kind).toBe('object');

  await refreshUserSessions(userId);

  const kindAfterMerge = await db.execute(
    sql`SELECT jsonb_typeof(metadata) AS kind FROM sessions WHERE id = ${session.id}`
  );
  expect(kindAfterMerge[0]?.kind).toBe('object');

  const [merged] = await db
    .select({ metadata: sessions.metadata })
    .from(sessions)
    .where(eq(sessions.id, session.id));
  const metadata = merged?.metadata as Record<string, unknown>;
  expect(metadata.keepMe).toBe('must survive'); // merged, not replaced
  expect(metadata.roleId).toBe(roleId); // and the patch actually landed
});

test('a transaction is one session: same backend, advisory lock, rollback', async () => {
  const observed = await withTransaction(async (tx) => {
    const first = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
    // the statement `processOtpSend` really issues
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${'probe-user'}), hashtext(${'email'} || ':' || ${'verify_contact'}))`
    );
    const locks = await tx.execute(
      sql`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()`
    );
    const second = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
    return {
      samePid: first[0]?.pid === second[0]?.pid,
      advisoryLocks: locks[0]?.n,
    };
  });
  expect(observed.samePid).toBe(true);
  expect(observed.advisoryLocks).toBe(1);

  const roleName = `${STAMP}-rollback`;
  await expect(
    withTransaction(async (tx) => {
      await tx
        .insert(roles)
        .values({ roleName, scope: 'system', isActive: true });
      throw new Error('probe: deliberate rollback');
    })
  ).rejects.toThrow('deliberate rollback');
  const survivors = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.roleName, roleName));
  expect(survivors).toHaveLength(0);
});

test('a nested transaction is a savepoint: the inner throw does not take the outer', async () => {
  const outerId = await seedRole('sp-outer');

  await withTransaction(async (tx) => {
    try {
      await tx.transaction(async (inner) => {
        await inner.insert(roles).values({
          roleName: `${STAMP}-sp-inner`,
          scope: 'system',
          isActive: true,
        });
        throw new Error('probe: inner fails');
      });
    } catch {
      // the savepoint rolled back; the outer transaction continues
    }
    await tx
      .update(roles)
      .set({ description: 'outer survived' })
      .where(eq(roles.id, outerId));
  });

  const inner = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.roleName, `${STAMP}-sp-inner`));
  const [outer] = await db
    .select({ description: roles.description })
    .from(roles)
    .where(eq(roles.id, outerId));
  expect(inner).toHaveLength(0);
  expect(outer?.description).toBe('outer survived');
});

test('db.execute yields rows as an array, the way three call sites read it', async () => {
  const roleId = await seedRole('exec');

  // the role-delete guard: `.rows.length === 0` on an array is `undefined === 0`,
  // i.e. false, so this shape is what keeps that guard able to reject at all
  const deleted = await db.execute(sql`
    DELETE FROM roles r
    WHERE r.id = ${roleId}
      AND NOT EXISTS (
        SELECT 1 FROM users u WHERE u.role_id = r.id AND u.deleted_at IS NULL
      )
    RETURNING r.id
  `);
  expect(Array.isArray(deleted)).toBe(true);
  expect(deleted).toHaveLength(1);

  const again = await db.execute(
    sql`DELETE FROM roles r WHERE r.id = ${roleId} RETURNING r.id`
  );
  expect(again).toHaveLength(0);
});
