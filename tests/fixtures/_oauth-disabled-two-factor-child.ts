import * as z from 'zod';

import { installEgressGuard } from '../helpers/egress';

installEgressGuard();
const { eq } = await import('drizzle-orm');
const { db, closeDatabase } = await import('@/db');
const { users } = await import('@/db/schema');
const { seedUser, signIn, baseHeaders, uniquePhone } =
  await import('../helpers/session');
const { app } = await import('@/app');
const { PUBLIC_ORIGIN } = await import('@/lib/env');
const { REAUTH_REQUIRED_CODE } = await import('@/utils/api-messages');
const { startGoogle } = await import('../helpers/google');
const { TWO_FACTOR_ENABLED } = await import('@/utils/validation/two-factor');
if (TWO_FACTOR_ENABLED) throw new Error('Two-factor feature must be disabled.');
const owner = await seedUser();
await db
  .update(users)
  .set({ twoFactorEnabled: true })
  .where(eq(users.id, owner.userId));
const { cookie } = await signIn(owner);
const phone = await app.handle(
  new Request(`${PUBLIC_ORIGIN}/api/dash/users/me/change-phone`, {
    method: 'POST',
    headers: baseHeaders({
      cookie,
      origin: PUBLIC_ORIGIN,
      'content-type': 'application/json',
    }),
    body: JSON.stringify({ newPhoneNumber: uniquePhone(), channel: 'sms' }),
  })
);
if (phone.status !== 401)
  throw new Error(`Phone proof returned ${phone.status}.`);
z.object({ code: z.literal(REAUTH_REQUIRED_CODE) }).parse(await phone.json());
const flow = await startGoogle({
  sub: 'feature-off-subject',
  email: owner.email,
});
const response = await flow.callback();
if (response.status !== 200)
  throw new Error(
    `Password succeeded; Google returned ${response.status} with global 2FA disabled.`
  );
await closeDatabase();
console.log('Google and password honor disabled two-factor configuration.');
