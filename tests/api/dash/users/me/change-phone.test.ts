import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { eq } from 'drizzle-orm';

import { users } from '@/db/schema';

import '../../../../helpers/env';
import { tdb, wipeTag } from '../../../../helpers/db';
import { api, waitForServer } from '../../../../helpers/http';
import { signIn } from '../../../../helpers/auth';
import { ALL_PERMISSIONS, createRole, createUser, seedOtp } from '../../../../helpers/seed';

const PATH = '/api/dash/users/me/change-phone';
const VERIFY_PATH = '/api/dash/users/me/change-phone/verify';

// A valid normalized Saudi number (matches chk_phone_number_format and the
// phoneSchema output, so the seeded identifier equals the submitted value).
const NEW_PHONE = '966512345678';
const OTHER_PHONE = '966512345679';

beforeAll(async () => {
  await waitForServer();
});

afterAll(async () => {
  await wipeTag();
});

describe('POST /api/dash/users/me/change-phone (initiate)', () => {
  test('401 with no session', async () => {
    const res = await api(PATH, {
      method: 'POST',
      body: { currentPassword: 'X', newPhoneNumber: NEW_PHONE, channel: 'sms' },
    });
    expect(res.status).toBe(401);
  });

  test(
    '503 when the requested phone channel is not enabled (no bypass)',
    async () => {
      // Test env enables only the email channel, so sms/whatsapp delivery is
      // unavailable and the change must be refused rather than stranded.
      const role = await createRole({ permissions: ALL_PERMISSIONS });
      const user = await createUser({ roleId: role.id });
      const signed = await signIn(user);

      const res = await api(PATH, {
        method: 'POST',
        cookie: signed.cookie,
        body: {
          currentPassword: user.password,
          newPhoneNumber: NEW_PHONE,
          channel: 'sms',
        },
      });
      expect(res.status).toBe(503);
    },
    30_000
  );

  test(
    '422 when newPhoneNumber is malformed',
    async () => {
      const role = await createRole({ permissions: ALL_PERMISSIONS });
      const user = await createUser({ roleId: role.id });
      const signed = await signIn(user);

      const res = await api(PATH, {
        method: 'POST',
        cookie: signed.cookie,
        body: {
          currentPassword: user.password,
          newPhoneNumber: 'not-a-phone',
          channel: 'sms',
        },
      });
      expect(res.status).toBe(422);
    },
    30_000
  );

  test(
    '403 when captcha header is missing',
    async () => {
      const role = await createRole({ permissions: ALL_PERMISSIONS });
      const user = await createUser({ roleId: role.id });
      const signed = await signIn(user);

      const res = await api(PATH, {
        method: 'POST',
        cookie: signed.cookie,
        noCaptcha: true,
        body: {
          currentPassword: user.password,
          newPhoneNumber: NEW_PHONE,
          channel: 'sms',
        },
      });
      expect(res.status).toBe(403);
    },
    30_000
  );
});

describe('POST /api/dash/users/me/change-phone/verify', () => {
  test('401 with no session', async () => {
    const res = await api(VERIFY_PATH, {
      method: 'POST',
      body: { newPhoneNumber: NEW_PHONE, channel: 'sms', code: '123456' },
    });
    expect(res.status).toBe(401);
  });

  test(
    '200 commits new phone and sets phoneNumberVerified',
    async () => {
      const role = await createRole({ permissions: ALL_PERMISSIONS });
      const user = await createUser({ roleId: role.id });
      const signed = await signIn(user);

      const { plaintextCode } = await seedOtp({
        userId: user.id,
        channel: 'sms',
        purpose: 'change_phone',
        identifier: NEW_PHONE,
        targetIdentifier: NEW_PHONE,
        code: '424242',
      });

      const res = await api(VERIFY_PATH, {
        method: 'POST',
        cookie: signed.cookie,
        body: { newPhoneNumber: NEW_PHONE, channel: 'sms', code: plaintextCode },
      });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ verified: true });

      const [u] = await tdb
        .select({
          phoneNumber: users.phoneNumber,
          phoneNumberVerified: users.phoneNumberVerified,
        })
        .from(users)
        .where(eq(users.id, user.id));
      expect(u.phoneNumber).toBe(NEW_PHONE);
      expect(u.phoneNumberVerified).toBe(true);
    },
    60_000
  );

  test(
    'wrong code does NOT change the phone or flip the flag',
    async () => {
      const role = await createRole({ permissions: ALL_PERMISSIONS });
      const user = await createUser({ roleId: role.id });
      const signed = await signIn(user);

      await seedOtp({
        userId: user.id,
        channel: 'sms',
        purpose: 'change_phone',
        identifier: OTHER_PHONE,
        targetIdentifier: OTHER_PHONE,
        code: '999999',
      });

      const res = await api(VERIFY_PATH, {
        method: 'POST',
        cookie: signed.cookie,
        body: { newPhoneNumber: OTHER_PHONE, channel: 'sms', code: '000000' },
      });

      expect(res.status).toBe(400);

      const [u] = await tdb
        .select({
          phoneNumber: users.phoneNumber,
          phoneNumberVerified: users.phoneNumberVerified,
        })
        .from(users)
        .where(eq(users.id, user.id));
      expect(u.phoneNumber).toBeNull();
      expect(u.phoneNumberVerified).toBe(false);
    },
    60_000
  );
});
