/**
 * `offeredMethods` — an option appears only when all three terms agree: the
 * deployment serves it, the user turned it on, and the user could complete it.
 * Each case removes exactly one term.
 *
 * It also decides ORDER and the default, which is why the assertions below are
 * on identities (`otp:email`) rather than method names: a name cannot tell one
 * OTP enrolment from the other, and those are different possessions.
 *
 * Tested as a pure function because the contact-kind rule needs a 2FA OTP
 * channel on email in one direction and on phone in the other, which no single
 * deployment configuration provides.
 */
import { describe, expect, test } from 'bun:test';
import type {
  EnrolledMethod,
  EnrollmentState,
  OfferedOption,
} from '@/lib/auth/two-factor-challenge';
import type { OtpChannel } from '@/utils/validation/otp';
import type { TwoFactorMethod } from '@/utils/validation/two-factor';

import { defaultOption, offeredMethods } from '@/lib/auth/two-factor-challenge';

import { ENABLED_TWO_FACTOR_METHODS } from '@/utils/validation/two-factor';

/** Everything capable, so a case only has to say what it takes away. */
const CAPABLE: EnrollmentState['capability'] = {
  totpVerified: true,
  backupCodesReady: true,
  hasPasskey: true,
  emailVerified: true,
  phoneVerified: true,
};

/** Mirrors the generated `contact_kind` column, so fixtures cannot contradict it. */
function enrol(
  method: TwoFactorMethod,
  channel: OtpChannel | null = null,
  isDefault = false
): EnrolledMethod {
  return {
    method,
    channel,
    contactKind: channel ? (channel === 'email' ? 'email' : 'phone') : null,
    isDefault,
  };
}

function state(
  intent: EnrollmentState['intent'],
  capability: Partial<EnrollmentState['capability']> = {}
): EnrollmentState {
  return {
    enabled: true,
    intent,
    capability: { ...CAPABLE, ...capability },
  };
}

const ids = (options: OfferedOption[]): string[] =>
  options.map((option) => option.id);

describe('the three terms of the intersection', () => {
  test('a method the user enrolled in and can complete is offered', () => {
    expect(ids(offeredMethods(state([enrol('totp')])))).toEqual(['totp']);
  });

  test('a method the user never enrolled in is not offered', () => {
    // The gap Better Auth leaves: it would offer OTP to every 2FA user whenever
    // the server has it configured, downgrading someone who chose TOTP only.
    expect(ids(offeredMethods(state([enrol('totp')])))).not.toContain('otp');
  });

  test('an enrolled method the user cannot complete is not offered', () => {
    // A stale intent row — the user deleted their last passkey. Offering it
    // would present a factor that cannot succeed, which is a lockout.
    expect(
      offeredMethods(state([enrol('passkey')], { hasPasskey: false }))
    ).toEqual([]);

    expect(
      offeredMethods(state([enrol('totp')], { totpVerified: false }))
    ).toEqual([]);

    // Backup codes generated but never acknowledged, acknowledged against a set
    // that has since been replaced, or acknowledged and then spent to zero —
    // `backupCodesReady` folds all three, and none of them is recovery material.
    expect(
      offeredMethods(state([enrol('backup_code')], { backupCodesReady: false }))
    ).toEqual([]);
  });

  test('a method the deployment does not serve is not offered', () => {
    const disabled = (
      ['totp', 'otp', 'backup_code', 'passkey'] as const
    ).filter((method) => !ENABLED_TWO_FACTOR_METHODS.includes(method));
    if (disabled.length === 0) return;

    for (const method of disabled)
      expect(
        offeredMethods(
          state([enrol(method, method === 'otp' ? 'email' : null)])
        )
      ).toEqual([]);
  });
});

describe('the contact-kind rule for a first factor that was itself a contact', () => {
  const otpByEmail = [enrol('otp', 'email')];
  const otpBySms = [enrol('otp', 'sms')];

  test('an OTP to the SAME kind the first factor proved is dropped', () => {
    // Signed in passwordless by email; the second factor would be another code
    // to that same mailbox. It proves nothing and costs a message.
    expect(offeredMethods(state(otpByEmail), 'email')).toEqual([]);
    expect(offeredMethods(state(otpBySms), 'phone')).toEqual([]);
  });

  test('an OTP to a DIFFERENT kind survives, because it is another possession', () => {
    // The case a method-name comparison would get wrong: signed in by email,
    // second factor by SMS. Dropping it would silently discard a real factor.
    expect(ids(offeredMethods(state(otpBySms), 'email'))).toEqual([
      'otp:phone',
    ]);
    expect(ids(offeredMethods(state(otpByEmail), 'phone'))).toEqual([
      'otp:email',
    ]);
  });

  test('two OTP enrolments are two options, and the exclusion drops only one', () => {
    // The whole reason the identity is not the method name. A user may hold an
    // OTP enrolment per contact kind; a passwordless login by email removes
    // exactly the email one.
    const both = state([enrol('otp', 'email'), enrol('otp', 'sms')]);
    expect(ids(offeredMethods(both))).toEqual(['otp:email', 'otp:phone']);
    expect(ids(offeredMethods(both, 'email'))).toEqual(['otp:phone']);
  });

  test('non-OTP methods are never dropped by the rule', () => {
    // They are not a contact at all, so no contact the first factor proved can
    // collide with them.
    expect(
      ids(offeredMethods(state([enrol('totp'), ...otpByEmail]), 'email'))
    ).toEqual(['totp']);
  });

  test('with no first-factor contact, every enrolled OTP channel survives', () => {
    // Password sign-in. A password is a knowledge factor, so an OTP to any
    // contact is a genuine second factor.
    expect(ids(offeredMethods(state(otpByEmail)))).toEqual(['otp:email']);
    expect(ids(offeredMethods(state(otpBySms)))).toEqual(['otp:phone']);
  });

  test('an OTP row with no channel is never offered', () => {
    // Unreachable through the CHECK constraint, and refused anyway: without a
    // destination there is nowhere to send.
    expect(offeredMethods(state([enrol('otp')]))).toEqual([]);
  });

  test('an OTP to an unverified contact is not offered', () => {
    expect(offeredMethods(state(otpBySms, { phoneVerified: false }))).toEqual(
      []
    );
  });
});

describe('order and the default', () => {
  test('the system priority is passkey, TOTP, OTP, then backup codes', () => {
    // Order is what a client renders and what the default falls back to, so a
    // set that came back in whatever order the database chose meant the user's
    // first prompt moved between requests.
    const everything = state([
      enrol('backup_code'),
      enrol('otp', 'sms'),
      enrol('totp'),
      enrol('passkey'),
    ]);
    expect(ids(offeredMethods(everything))).toEqual([
      'passkey',
      'totp',
      'otp:phone',
      'backup_code',
    ]);
  });

  test('a user default leads, whatever the system priority says', () => {
    const chosen = state([
      enrol('passkey'),
      enrol('totp'),
      enrol('otp', 'sms', true),
    ]);
    expect(ids(offeredMethods(chosen))).toEqual([
      'otp:phone',
      'passkey',
      'totp',
    ]);
    expect(defaultOption(offeredMethods(chosen))).toBe('otp:phone');
  });

  test('backup codes are never auto-routed to', () => {
    // A routine login must not spend recovery material. With nothing else left
    // the answer is "ask", not "use a backup code".
    const onlyRecovery = offeredMethods(state([enrol('backup_code')]));
    expect(ids(onlyRecovery)).toEqual(['backup_code']);
    expect(defaultOption(onlyRecovery)).toBeNull();

    const withTotp = offeredMethods(
      state([enrol('backup_code'), enrol('totp')])
    );
    expect(defaultOption(withTotp)).toBe('totp');
  });

  test('a user default on backup codes still does not auto-route', () => {
    const chosen = offeredMethods(
      state([enrol('backup_code', null, true), enrol('totp')])
    );
    expect(ids(chosen)).toEqual(['backup_code', 'totp']);
    expect(defaultOption(chosen)).toBe('totp');
  });
});
