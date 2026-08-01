import { eq } from 'drizzle-orm';

import { auditLogs, sessions, users } from '@/db/schema';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import '../../../../helpers/env';

import { signIn } from '../../../../helpers/auth';
import { tagEmail, tdb, wipeTag } from '../../../../helpers/db';
import { api, waitForServer } from '../../../../helpers/http';
import {
  ALL_PERMISSIONS,
  createRole,
  createUser,
  seedOtp,
} from '../../../../helpers/seed';

const PATH = '/api/dash/users/me/change-email';
const VERIFY_PATH = '/api/dash/users/me/change-email/verify';

beforeAll(async () => {
  await waitForServer();
});

afterAll(async () => {
  await wipeTag();
});

// ── Initiate: validation / authz (all fail before any OTP delivery) ──
describe('POST /api/dash/users/me/change-email (initiate)', () => {
  test('401 with no session', async () => {
    const res = await api(PATH, {
      method: 'POST',
      body: { currentPassword: 'X', newEmail: tagEmail('a') },
    });
    expect(res.status).toBe(401);
  });

  test('does NOT change the email on initiate — only on verify', async () => {
    const role = await createRole({ permissions: ALL_PERMISSIONS });
    const user = await createUser({ roleId: role.id });
    const signed = await signIn(user);
    const newEmail = tagEmail('pending');

    await api(PATH, {
      method: 'POST',
      cookie: signed.cookie,
      body: { currentPassword: user.password, newEmail },
    });

    // Regardless of whether delivery succeeded, users.email must be untouched.
    const [u] = await tdb
      .select({ email: users.email, emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.id, user.id));
    expect(u.email).toBe(user.email);
  }, 30_000);

  test('400 when newEmail equals current email', async () => {
    const role = await createRole({ permissions: ALL_PERMISSIONS });
    const user = await createUser({ roleId: role.id });
    const signed = await signIn(user);

    const res = await api(PATH, {
      method: 'POST',
      cookie: signed.cookie,
      body: { currentPassword: user.password, newEmail: user.email },
    });
    expect(res.status).toBe(400);
  }, 30_000);

  test('400 when currentPassword is wrong', async () => {
    const role = await createRole({ permissions: ALL_PERMISSIONS });
    const user = await createUser({ roleId: role.id });
    const signed = await signIn(user);

    const res = await api(PATH, {
      method: 'POST',
      cookie: signed.cookie,
      body: {
        currentPassword: 'TotallyWrong1!@#',
        newEmail: tagEmail('new'),
      },
    });
    expect(res.status).toBe(400);
  }, 30_000);

  test('403 when captcha header is missing', async () => {
    const role = await createRole({ permissions: ALL_PERMISSIONS });
    const user = await createUser({ roleId: role.id });
    const signed = await signIn(user);

    const res = await api(PATH, {
      method: 'POST',
      cookie: signed.cookie,
      noCaptcha: true,
      body: { currentPassword: user.password, newEmail: tagEmail('cap') },
    });
    expect(res.status).toBe(403);
  }, 30_000);

  test('409 when newEmail collides with an existing user (before any send)', async () => {
    const role = await createRole({ permissions: ALL_PERMISSIONS });
    const user = await createUser({ roleId: role.id });
    const other = await createUser({
      roleId: role.id,
      email: tagEmail('owner'),
    });
    const signed = await signIn(user);

    const res = await api(PATH, {
      method: 'POST',
      cookie: signed.cookie,
      body: { currentPassword: user.password, newEmail: other.email },
    });
    expect(res.status).toBe(409);
  }, 30_000);

  test('422 when newEmail is malformed', async () => {
    const role = await createRole({ permissions: ALL_PERMISSIONS });
    const user = await createUser({ roleId: role.id });
    const signed = await signIn(user);

    const res = await api(PATH, {
      method: 'POST',
      cookie: signed.cookie,
      body: { currentPassword: user.password, newEmail: 'not-an-email' },
    });
    expect(res.status).toBe(422);
  }, 30_000);

  test('422 when payload is missing fields', async () => {
    const role = await createRole({ permissions: ALL_PERMISSIONS });
    const user = await createUser({ roleId: role.id });
    const signed = await signIn(user);

    const res = await api(PATH, {
      method: 'POST',
      cookie: signed.cookie,
      body: {},
    });
    expect(res.status).toBe(422);
  }, 30_000);
});

// ── Verify + commit (deterministic via a seeded change_email OTP) ──
describe('POST /api/dash/users/me/change-email/verify', () => {
  test('401 with no session', async () => {
    const res = await api(VERIFY_PATH, {
      method: 'POST',
      body: { newEmail: tagEmail('a'), code: '123456' },
    });
    expect(res.status).toBe(401);
  });

  test('200 commits new email, sets emailVerified, revokes other sessions, audits', async () => {
    const role = await createRole({ permissions: ALL_PERMISSIONS });
    const user = await createUser({ roleId: role.id, emailVerified: false });
    const newEmail = tagEmail('verified-new');

    // Two sessions; only the requesting one survives.
    const s1 = await signIn(user);
    await signIn(user);

    const { plaintextCode } = await seedOtp({
      userId: user.id,
      channel: 'email',
      purpose: 'change_email',
      identifier: newEmail,
      targetIdentifier: newEmail,
      code: '424242',
    });

    const res = await api(VERIFY_PATH, {
      method: 'POST',
      cookie: s1.cookie,
      body: { newEmail, code: plaintextCode },
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ verified: true });

    const [u] = await tdb
      .select({ email: users.email, emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.id, user.id));
    expect(u.email).toBe(newEmail);
    expect(u.emailVerified).toBe(true);

    const sessRows = await tdb
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, user.id));
    expect(sessRows.length).toBe(1);

    const audits = await tdb
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.recordId, user.id));
    expect(audits.some((a) => a.action === 'UPDATE')).toBe(true);
  }, 60_000);

  test('wrong code does NOT change the email or flip the flag', async () => {
    const role = await createRole({ permissions: ALL_PERMISSIONS });
    const user = await createUser({ roleId: role.id, emailVerified: false });
    const newEmail = tagEmail('should-not-commit');
    const signed = await signIn(user);

    await seedOtp({
      userId: user.id,
      channel: 'email',
      purpose: 'change_email',
      identifier: newEmail,
      targetIdentifier: newEmail,
      code: '999999',
    });

    const res = await api(VERIFY_PATH, {
      method: 'POST',
      cookie: signed.cookie,
      body: { newEmail, code: '000000' },
    });

    expect(res.status).toBe(400);

    const [u] = await tdb
      .select({ email: users.email, emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.id, user.id));
    expect(u.email).toBe(user.email);
    expect(u.emailVerified).toBe(false);
  }, 60_000);

  test('409 when the verified new email now collides with another user', async () => {
    const role = await createRole({ permissions: ALL_PERMISSIONS });
    const user = await createUser({ roleId: role.id, emailVerified: false });
    const other = await createUser({
      roleId: role.id,
      email: tagEmail('taken-at-verify'),
    });
    const signed = await signIn(user);

    const { plaintextCode } = await seedOtp({
      userId: user.id,
      channel: 'email',
      purpose: 'change_email',
      identifier: other.email,
      targetIdentifier: other.email,
      code: '333333',
    });

    const res = await api(VERIFY_PATH, {
      method: 'POST',
      cookie: signed.cookie,
      body: { newEmail: other.email, code: plaintextCode },
    });

    expect(res.status).toBe(409);
  }, 60_000);
});
