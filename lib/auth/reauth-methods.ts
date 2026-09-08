import type { Tx } from '@/db';
import type { EntityID } from '@/types';

import { and, eq, isNotNull } from 'drizzle-orm';

import { db } from '@/db';
import { accounts, passkeys } from '@/db/schema';

import { CREDENTIAL_PROVIDER_ID } from '@/utils/api-messages';
import { isTwoFactorMethodEnabled } from '@/utils/validation/two-factor';

export type ReauthMethod = 'password' | 'passkey';

export async function availableReauthMethods(
  userId: EntityID,
  executor: Tx | typeof db = db
): Promise<ReauthMethod[]> {
  const methods: ReauthMethod[] = [];
  const credentials = await executor
    .select({ provider: accounts.providerId })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), isNotNull(accounts.password)));
  if (credentials.some((entry) => entry.provider === CREDENTIAL_PROVIDER_ID))
    methods.push('password');
  if (isTwoFactorMethodEnabled('passkey')) {
    const [credential] = await executor
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(eq(passkeys.userId, userId))
      .limit(1);
    if (credential) methods.push('passkey');
  }
  return methods;
}
