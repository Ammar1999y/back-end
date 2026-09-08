import type { Tx } from '@/db';
import type { getAuditMeta } from '@/lib/audit';

import { and, eq } from 'drizzle-orm';

import { accounts, users } from '@/db/schema';
import { APIError } from 'better-auth/api';
import * as z from 'zod';
import { auditLog } from '@/lib/audit';

import {
  CUSTOM_AUTH_CODE,
  HTTP_STATUS,
  MSG_INVALID_CREDENTIALS,
} from '@/utils/api-messages';
import { markContactVerified } from '@/utils/otp';
import { emailSchema } from '@/utils/validation/rules';

import { lockEligibleAuthUser } from './user-eligibility';

export class GoogleIdentityDenied extends APIError {
  constructor(
    public readonly reason:
      | 'invalid_claims'
      | 'email_not_authoritative'
      | 'user_ineligible'
      | 'email_mismatch'
      | 'proof_revoked'
      | 'link_removed'
      | 'subject_collision'
      | 'link_failed'
  ) {
    super(HTTP_STATUS.UNAUTHORIZED, {
      code: CUSTOM_AUTH_CODE,
      message: MSG_INVALID_CREDENTIALS,
    });
  }
}

export const GOOGLE_ISSUER = 'https://accounts.google.com';

const identitySchema = z.object({
  sub: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[!-~]+$/),
  email: emailSchema,
  email_verified: z.literal(true),
  hd: z.unknown().optional(),
  amr: z.unknown().optional(),
});

export function googleIdentity(verifiedClaims: unknown) {
  const parsed = identitySchema.safeParse(verifiedClaims);
  if (!parsed.success) throw new GoogleIdentityDenied('invalid_claims');
  const claims = parsed.data;
  const domain = claims.email.split('@', 2)[1];
  const labels = typeof claims.hd === 'string' ? claims.hd.split('.') : [];
  const hostedDomain =
    typeof claims.hd === 'string' &&
    claims.hd.length <= 253 &&
    labels.length > 1 &&
    labels.every(
      (label) =>
        label.length <= 63 &&
        !label.startsWith('-') &&
        !label.endsWith('-') &&
        /^[a-z0-9-]+$/i.test(label)
    ) &&
    /^[a-z]{2,63}$/i.test(labels.at(-1) ?? '');
  if (domain !== 'gmail.com' && !hostedDomain)
    throw new GoogleIdentityDenied('email_not_authoritative');
  return {
    subject: claims.sub,
    email: claims.email,
    mfa:
      Array.isArray(claims.amr) &&
      claims.amr.every((value: unknown) => typeof value === 'string') &&
      claims.amr.includes('mfa'),
  };
}

export async function resolveGoogleIdentity(
  tx: Tx,
  identity: ReturnType<typeof googleIdentity>,
  startedAt: number,
  auditMeta: ReturnType<typeof getAuditMeta>
) {
  const [linked] = await tx
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.providerId, 'google'),
        eq(accounts.accountId, identity.subject)
      )
    );
  const user = await lockEligibleAuthUser(
    tx,
    linked ? eq(users.id, linked.userId) : eq(users.email, identity.email)
  );
  if (!user) throw new GoogleIdentityDenied('user_ineligible');
  if (user.email !== identity.email)
    throw new GoogleIdentityDenied('email_mismatch');
  if (user.authRevokedAt && user.authRevokedAt.getTime() >= startedAt)
    throw new GoogleIdentityDenied('proof_revoked');
  const existing = await tx
    .select()
    .from(accounts)
    .where(
      and(eq(accounts.providerId, 'google'), eq(accounts.userId, user.id))
    );
  // The initial link read precedes the user lock; a concurrent unlink must not turn this into a first login.
  if (linked && existing.length === 0)
    throw new GoogleIdentityDenied('link_removed');
  if (
    existing.some(
      (account) =>
        account.accountId !== identity.subject ||
        account.issuer !== GOOGLE_ISSUER
    )
  )
    throw new GoogleIdentityDenied('subject_collision');
  if (!linked && existing.length === 0) {
    const [account] = await tx
      .insert(accounts)
      .values({
        providerId: 'google',
        issuer: GOOGLE_ISSUER,
        accountId: identity.subject,
        userId: user.id,
      })
      .returning({ id: accounts.id });
    if (!account) throw new GoogleIdentityDenied('link_failed');
    await auditLog(tx, {
      userId: user.id,
      userEmail: user.email,
      action: 'INSERT',
      tableName: 'accounts',
      recordId: account.id,
      oldData: null,
      newData: { provider: 'google', identityLinked: true },
      meta: auditMeta,
    });
  }
  await markContactVerified(tx, {
    userId: user.id,
    channel: 'email',
    auditMeta,
    onMissing: () => {
      throw new GoogleIdentityDenied('user_ineligible');
    },
  });
  return user;
}
