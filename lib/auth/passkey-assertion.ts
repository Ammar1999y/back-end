import type { Tx } from '@/db';
import type { EntityID } from '@/types';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/server';

import { and, eq, lt } from 'drizzle-orm';

import { db } from '@/db';
import { passkeys } from '@/db/schema';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import * as z from 'zod';
import { PUBLIC_ORIGIN } from '@/lib/env';

import { authenticationDenied } from './api-error';

const RP_ID = new URL(PUBLIC_ORIGIN).hostname;

const transportSchema: z.ZodType<AuthenticatorTransportFuture> = z.enum([
  'ble',
  'cable',
  'hybrid',
  'internal',
  'nfc',
  'smart-card',
  'usb',
]);

function transports(value: string | null) {
  const parsed = z.array(transportSchema).safeParse(value?.split(','));
  return parsed.success ? parsed.data : undefined;
}

export async function passkeyOptions(
  userId: EntityID,
  onEmpty: () => never = () => {
    throw authenticationDenied();
  }
) {
  const credentials = await db
    .select({
      credentialID: passkeys.credentialID,
      transports: passkeys.transports,
    })
    .from(passkeys)
    .where(eq(passkeys.userId, userId));
  if (credentials.length === 0) onEmpty();
  return generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: 'required',
    allowCredentials: credentials.map((credential) => ({
      id: credential.credentialID,
      transports: transports(credential.transports),
    })),
  });
}

// Concurrent assertions may verify against the same old counter. Keep their maximum, never a losing compare-and-swap value.
export async function advancePasskeyCounter(
  passkeyId: string,
  to: number,
  executor: Tx | typeof db = db
): Promise<boolean> {
  if (to === 0) return true;
  const [advanced] = await executor
    .update(passkeys)
    .set({ counter: to })
    .where(and(eq(passkeys.id, passkeyId), lt(passkeys.counter, to)))
    .returning({ id: passkeys.id });
  return Boolean(advanced);
}

const assertionSchema = z.object({
  id: z.string(),
  rawId: z.string(),
  type: z.literal('public-key'),
  response: z.object({
    authenticatorData: z.string(),
    clientDataJSON: z.string(),
    signature: z.string(),
    userHandle: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
  }),
});

export async function verifyUserPasskey(
  userId: EntityID,
  input: unknown,
  challenge: string
) {
  const parsed = assertionSchema.safeParse(input);
  if (!parsed.success) throw authenticationDenied();
  const response: AuthenticationResponseJSON = {
    ...parsed.data,
    clientExtensionResults: {},
  };
  const [credential] = await db
    .select()
    .from(passkeys)
    .where(
      and(eq(passkeys.userId, userId), eq(passkeys.credentialID, response.id))
    );
  if (!credential) throw authenticationDenied();
  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: PUBLIC_ORIGIN,
    expectedRPID: RP_ID,
    credential: {
      id: credential.credentialID,
      publicKey: new Uint8Array(Buffer.from(credential.publicKey, 'base64')),
      counter: credential.counter,
    },
    requireUserVerification: true,
  });
  if (!result.verified) throw authenticationDenied();
  return { credential, newCounter: result.authenticationInfo.newCounter };
}
