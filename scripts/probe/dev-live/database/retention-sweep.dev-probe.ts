/* eslint-disable unicorn/no-top-level-assignment-in-function --
   Dev probe: module-level fixture ids are assigned by `beforeAll` and read by the
   tests and by `afterAll` cleanup. Same shape, and same suppression, as
   `otp-verify-budget.dev-probe.ts`. */
/**
 * ⚠️ DEV ONLY — DESTRUCTIVE — DISPOSABLE SERVICES ONLY ⚠️
 *
 * Writes to the real database in `.env`: inserts users, roles, sessions,
 * verification rows and file rows, then runs the real retention sweep, which
 * deletes EVERY qualifying row in the database — not only the ones seeded here.
 * Not a test, not safe for CI/staging/production. See
 * `scripts/probe/dev-live/README.md`.
 *
 * Run: bun run probe:db
 *
 * ---
 *
 * `db/maintenance.ts` — the retention sweep behind `/api/internal/db-sweep`.
 *
 * Every assertion is paired: one row that must go, and one adjacent row that
 * must stay. A sweep is only correct if it is also narrow, and a `WHERE` clause
 * that deletes too much passes any test that only checks the target vanished.
 *
 * What it pins down:
 *  - an expired session past the grace window goes; one inside it stays
 *  - a consumed proof row goes, and its code goes with it by cascade
 *  - a proof row older than the TTL goes; a fresh unconsumed one stays
 *  - an expired code on a LIVE session goes without taking the session
 *  - a temporary file's row survives a FAILED R2 delete, so the object is never
 *    orphaned; a recent one and a non-temporary one are not touched at all
 *
 * The R2 case is the reason this probe is worth keeping. It asserts the ordering
 * that cannot be recovered from if it is wrong, and it asserts it in the state
 * this machine is actually in — no R2 credentials, so every delete fails.
 */
import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/db';
import { runDatabaseSweep } from '@/db/maintenance';
import {
  files,
  roles,
  sessions,
  users,
  verificationCodes,
  verificationSessions,
} from '@/db/schema';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { getR2ConfigStatus } from '@/lib/r2/client';

const STAMP = process.env.PROBE_STAMP ?? '900000002';
const EMAIL = `retention-probe-${STAMP}@probe.test`;
const ROLE_NAME = `retention-role-${STAMP}`;
const KEY_OLD_TEMP = `temp/retention-probe-${STAMP}-old.webp`;
const KEY_NEW_TEMP = `temp/retention-probe-${STAMP}-new.webp`;
const KEY_PERMANENT = `perm/retention-probe-${STAMP}-kept.webp`;

let userId = '';
let roleId = '';
let consumedId = '';
let staleId = '';
let freshId = '';
let swept: Awaited<ReturnType<typeof runDatabaseSweep>>;

beforeAll(async () => {
  const [role] = await db
    .insert(roles)
    .values({ roleName: ROLE_NAME, scope: 'standard', isActive: true })
    .returning({ id: roles.id });
  roleId = role!.id;

  const [user] = await db
    .insert(users)
    .values({
      name: 'Retention sweep probe',
      email: EMAIL,
      roleId,
      isActive: true,
    })
    .returning({ id: users.id });
  userId = user!.id;

  // 31 days past expiry vs 1 day past: the grace window is 30.
  await db.insert(sessions).values([
    {
      userId,
      token: `retention-old-${STAMP}`,
      expiresAt: sql`now() - interval '31 days'`,
      ipAddress: '127.0.0.1',
    },
    {
      userId,
      token: `retention-recent-${STAMP}`,
      expiresAt: sql`now() - interval '1 day'`,
      ipAddress: '127.0.0.1',
    },
  ]);

  const [consumed] = await db
    .insert(verificationSessions)
    .values({
      userId,
      channel: 'email',
      identifier: `consumed-${STAMP}@probe.test`,
      purpose: 'verify_contact',
      verifiedAt: sql`now()`,
      consumedAt: sql`now()`,
    })
    .returning({ id: verificationSessions.id });
  consumedId = consumed!.id;

  const [stale] = await db
    .insert(verificationSessions)
    .values({
      userId,
      channel: 'sms',
      identifier: `9665${STAMP.slice(0, 8)}`,
      purpose: 'passwordless_login',
      createdAt: sql`now() - interval '2 days'`,
    })
    .returning({ id: verificationSessions.id });
  staleId = stale!.id;

  const [fresh] = await db
    .insert(verificationSessions)
    .values({
      userId,
      channel: 'email',
      identifier: `fresh-${STAMP}@probe.test`,
      purpose: 'forgot_password',
    })
    .returning({ id: verificationSessions.id });
  freshId = fresh!.id;

  await db.insert(verificationCodes).values([
    // Live code on a row that is going anyway — must disappear by cascade.
    {
      sessionId: consumedId,
      code: 'o1:probe:cascade',
      expiresAt: sql`now() + interval '10 minutes'`,
    },
    // Expired code on a row that must SURVIVE.
    {
      sessionId: freshId,
      code: 'o1:probe:expired',
      expiresAt: sql`now() - interval '1 minute'`,
    },
  ]);

  await db.insert(files).values([
    {
      r2Key: KEY_OLD_TEMP,
      bucketType: 'public',
      mimeType: 'image/webp',
      isTemporary: true,
      uploadedBy: userId,
      createdAt: sql`now() - interval '2 days'`,
    },
    {
      r2Key: KEY_NEW_TEMP,
      bucketType: 'public',
      mimeType: 'image/webp',
      isTemporary: true,
      uploadedBy: userId,
    },
    {
      r2Key: KEY_PERMANENT,
      bucketType: 'public',
      mimeType: 'image/webp',
      isTemporary: false,
      uploadedBy: userId,
      createdAt: sql`now() - interval '2 days'`,
    },
  ]);

  swept = await runDatabaseSweep();
});

afterAll(async () => {
  await db.delete(files).where(eq(files.uploadedBy, userId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db
    .delete(verificationSessions)
    .where(eq(verificationSessions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(roles).where(eq(roles.id, roleId));
});

const sessionExists = async (token: string) => {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), eq(sessions.token, token)));
  return rows.length === 1;
};

const proofExists = async (id: string) => {
  const rows = await db
    .select({ id: verificationSessions.id })
    .from(verificationSessions)
    .where(eq(verificationSessions.id, id));
  return rows.length === 1;
};

const codeCount = async (sessionId: string) => {
  const rows = await db
    .select({ id: verificationCodes.id })
    .from(verificationCodes)
    .where(eq(verificationCodes.sessionId, sessionId));
  return rows.length;
};

const fileExists = async (key: string) => {
  const rows = await db
    .select({ id: files.id })
    .from(files)
    .where(eq(files.r2Key, key));
  return rows.length === 1;
};

test('the sweep reports success', () => {
  expect(swept.status).toBe('ok');
});

test('an expired session past the grace window is removed', async () => {
  expect(await sessionExists(`retention-old-${STAMP}`)).toBe(false);
});

test('a session expired inside the grace window is kept', async () => {
  expect(await sessionExists(`retention-recent-${STAMP}`)).toBe(true);
});

test('a consumed proof row is removed', async () => {
  expect(await proofExists(consumedId)).toBe(false);
});

test("a consumed row's live code goes with it by cascade", async () => {
  expect(await codeCount(consumedId)).toBe(0);
});

test('a proof row older than the TTL is removed', async () => {
  expect(await proofExists(staleId)).toBe(false);
});

test('a fresh unconsumed proof row is kept', async () => {
  expect(await proofExists(freshId)).toBe(true);
});

test('an expired code is removed without taking its live session', async () => {
  expect(await codeCount(freshId)).toBe(0);
  expect(await proofExists(freshId)).toBe(true);
});

test('a recent temporary file is not touched', async () => {
  expect(await fileExists(KEY_NEW_TEMP)).toBe(true);
});

test('a non-temporary file is not touched however old it is', async () => {
  expect(await fileExists(KEY_PERMANENT)).toBe(true);
});

test('a temporary file row survives when its R2 delete fails', async () => {
  // Guarded rather than assumed: on a machine WITH R2 credentials this key does
  // not exist in the bucket, S3 answers a delete of a missing key with success,
  // and the row is then correctly removed. Both outcomes are correct — what must
  // never happen is the row going while the object stays.
  if (getR2ConfigStatus().configured) {
    expect(await fileExists(KEY_OLD_TEMP)).toBe(false);
    return;
  }

  expect(await fileExists(KEY_OLD_TEMP)).toBe(true);
  expect(swept.removed.tempFiles.removed).toBe(0);
  // A batch that made no progress must still report unfinished work, or a total
  // R2 outage would look like a clean sweep.
  expect(swept.hasMore).toBe(true);
});
