/* eslint-disable unicorn/no-top-level-assignment-in-function --
   Dev probe: module-level fixture ids are assigned by `beforeAll` and read by the
   tests and by `afterAll` cleanup. Same shape, and same suppression, as the
   sibling probes. */
/**
 * ⚠️ DEV ONLY — DESTRUCTIVE — DISPOSABLE SERVICES ONLY ⚠️
 *
 * Writes to the real database in `.env` and calls the real `processOtpSend`,
 * which ATTEMPTS A REAL SMTP CONNECTION. Safe here only because this environment
 * has no `SMTP_USER`/`SMTP_PASS`, so delivery fails fast — which is precisely the
 * condition under test. Skips itself if SMTP is configured, rather than mailing a
 * probe address.
 *
 * Run: bun run probe:db
 *
 * ---
 *
 * The transaction boundary in `processOtpSend`: delivery runs AFTER the commit.
 *
 * This is the one assertion that distinguishes the new behaviour from the old,
 * and it is deliberately the *uncomfortable* half of the trade-off rather than the
 * comfortable one. Before the change, `sendOtp` ran inside `withTransaction`, so a
 * delivery failure rolled the session and the code back. Now it does not:
 *
 *  - `processOtpSend` still throws, so the caller and the client see the failure
 *  - the verification session row SURVIVES, with its attempt spent
 *  - the code row SURVIVES, and expires on its own
 *
 * If someone later "fixes" the burnt attempt by moving delivery back inside the
 * transaction, or by adding a compensating decrement, these assertions fail and
 * say why. The reasoning for accepting it is at the call site in `utils/otp.ts`.
 */
import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import {
  roles,
  users,
  verificationCodes,
  verificationSessions,
} from '@/db/schema';
import { afterAll, beforeAll, expect, test } from 'bun:test';

import { processOtpSend } from '@/utils/otp';

const STAMP = process.env.PROBE_STAMP ?? '900000004';
const EMAIL = `otp-boundary-${STAMP}@probe.test`;

/** Delivery must FAIL for this probe to mean anything. */
const SMTP_CONFIGURED = Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);

let userId = '';
let roleId = '';
let threw: unknown = null;

beforeAll(async () => {
  if (SMTP_CONFIGURED) return;

  const [role] = await db
    .insert(roles)
    .values({
      roleName: `otp-boundary-role-${STAMP}`,
      scope: 'standard',
      isActive: true,
    })
    .returning({ id: roles.id });
  roleId = role!.id;

  const [user] = await db
    .insert(users)
    .values({
      name: 'OTP boundary probe',
      email: EMAIL,
      roleId,
      isActive: true,
    })
    .returning({ id: users.id });
  userId = user!.id;

  try {
    await processOtpSend({
      userId,
      identifier: EMAIL,
      channel: 'email',
      purpose: 'verify_contact',
      sendTo: EMAIL,
      entityName: 'البريد الإلكتروني',
    });
  } catch (error) {
    threw = error;
  }
});

afterAll(async () => {
  if (!userId) return;
  await db
    .delete(verificationSessions)
    .where(eq(verificationSessions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(roles).where(eq(roles.id, roleId));
});

const proofRow = async () => {
  const rows = await db
    .select({
      id: verificationSessions.id,
      attemptNumber: verificationSessions.attemptNumber,
    })
    .from(verificationSessions)
    .where(
      and(
        eq(verificationSessions.userId, userId),
        eq(verificationSessions.purpose, 'verify_contact')
      )
    );
  return rows[0] ?? null;
};

test.skipIf(SMTP_CONFIGURED)(
  'delivery failure still surfaces to the caller',
  () => {
    expect(threw).not.toBeNull();
  }
);

test.skipIf(SMTP_CONFIGURED)(
  'the verification session is COMMITTED despite the delivery failure',
  async () => {
    // The behavioural change. Under the old ordering this row did not exist.
    const row = await proofRow();
    expect(row).not.toBeNull();
    expect(row?.attemptNumber).toBe(1);
  }
);

test.skipIf(SMTP_CONFIGURED)(
  'the code row is COMMITTED too, and is a MAC envelope not an Argon2id hash',
  async () => {
    const row = await proofRow();
    const codes = await db
      .select({ code: verificationCodes.code })
      .from(verificationCodes)
      .where(eq(verificationCodes.sessionId, row!.id));

    expect(codes).toHaveLength(1);
    // Ties the two changes together: the row that survived the commit boundary
    // also proves the send path writes the new `o1:` envelope, not `p1:`.
    expect(codes[0]?.code).toStartWith('o1:');
  }
);
