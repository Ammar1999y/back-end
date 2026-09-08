import { mock } from 'bun:test';

import * as z from 'zod';

import { installEgressGuard } from '../helpers/egress';

const defaults = await import('@/utils/config');
if (defaults.REQUIRE_EMAIL_VERIFICATION !== false)
  throw new Error('Shipped email verification default changed.');
await mock.module('@/utils/config', () => ({
  ...defaults,
  REQUIRE_EMAIL_VERIFICATION: true,
}));
installEgressGuard();
const { seedUser } = await import('../helpers/session');
const { startGoogle } = await import('../helpers/google');
const { app } = await import('@/app');
const { baseHeaders } = await import('../helpers/session');
const { PUBLIC_ORIGIN } = await import('@/lib/env');
const { closeDatabase } = await import('@/db');
const owner = await seedUser({ emailVerified: false });
const password = () =>
  app.handle(
    new Request(`${PUBLIC_ORIGIN}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: baseHeaders({
        'content-type': 'application/json',
        origin: PUBLIC_ORIGIN,
      }),
      body: JSON.stringify({ email: owner.email, password: owner.password }),
    })
  );
const unverified = await password();
if (unverified.status !== 403)
  throw new Error('Test-only verification gate was not active.');
const flow = await startGoogle({
  sub: 'required-verification-subject',
  email: owner.email,
});
const response = await flow.callback();
if (response.status !== 200)
  throw new Error('Google did not verify and sign in without email OTP.');
z.object({ data: z.object({ loggedIn: z.literal(true) }) }).parse(
  await response.json()
);
const verified = await password();
if (verified.status !== 200)
  throw new Error('Verification was not permanent for password login.');
await closeDatabase();
console.log('Required-email-verification Google flow passed.');
