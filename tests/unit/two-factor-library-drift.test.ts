/**
 * The assumptions this deployment copied out of `better-auth`'s installed
 * source, asserted against that source.
 *
 * ⚠️ Every one of these is load-bearing and none of them is part of a published
 * API, so a patch release can change one without breaking a build. The failure
 * mode that makes this file worth its weight is silent: a control that stops
 * applying while every other test stays green.
 *
 * The assertions read the installed package rather than mock it. A mock would
 * only prove the copy matches itself.
 */
import { describe, expect, test } from 'bun:test';

import { passkey } from '@better-auth/passkey';
import { twoFactor } from 'better-auth/plugins/two-factor';
import {
  TWO_FACTOR_ALLOWED_ATTEMPTS,
  TWO_FACTOR_CHALLENGE_MAX_AGE_S,
} from '@/lib/auth/two-factor-challenge';

const PACKAGE_ROOT = new URL(
  '../../node_modules/better-auth/dist/',
  import.meta.url
);
const PASSKEY_ROOT = new URL(
  '../../node_modules/@better-auth/passkey/dist/',
  import.meta.url
);

async function source(root: URL, relative: string): Promise<string> {
  return Bun.file(new URL(relative, root)).text();
}

describe('the plugin shape `twoFactorAuth` reshapes', () => {
  test('exposes exactly one `hooks.after` entry, which we replace', async () => {
    // `lib/auth/two-factor.ts` destructures `hooks` off the plugin and installs
    // its own, because the plugin's own sign-in hook matches only the credential
    // paths while this deployment must issue the same challenge from
    // `/passwordless/verify`. A SECOND upstream hook would land in that discarded
    // binding and be silently dropped.
    const plugin = twoFactor({ twoFactorTable: 'twoFactorCredentials' });
    expect(plugin.hooks?.after).toHaveLength(1);
    expect(
      (plugin.hooks as { before?: unknown } | undefined)?.before
    ).toBeUndefined();
  });

  test('still exposes the three endpoints this deployment REMOVES', () => {
    // Enrolment, disable and backup-code generation are owned here
    // (`lib/auth/two-factor-enrolment.ts`) and deleted from the plugin's map. If
    // upstream renames one, the delete silently stops deleting and two endpoints
    // claim one path.
    const plugin = twoFactor({ twoFactorTable: 'twoFactorCredentials' });
    for (const name of [
      'enableTwoFactor',
      'disableTwoFactor',
      'generateBackupCodes',
    ])
      expect(Object.keys(plugin.endpoints)).toContain(name);
  });

  test('still exposes the two verifiers this deployment KEEPS', () => {
    const plugin = twoFactor({ twoFactorTable: 'twoFactorCredentials' });
    expect(plugin.endpoints.verifyTOTP?.path).toBe('/two-factor/verify-totp');
    expect(plugin.endpoints.verifyBackupCode?.path).toBe(
      '/two-factor/verify-backup-code'
    );
  });
});

describe('the private formats mirrored in two-factor-challenge.ts', () => {
  test('the challenge cookie is still named `two_factor`', async () => {
    const constants = await source(
      PACKAGE_ROOT,
      'plugins/two-factor/constant.mjs'
    );
    expect(constants).toContain('TWO_FACTOR_COOKIE_NAME = "two_factor"');
  });

  test('the attempt counter is still `2fa-attempts-<challenge>`', async () => {
    const verify = await source(
      PACKAGE_ROOT,
      'plugins/two-factor/verify-two-factor.mjs'
    );
    expect(verify).toContain('`2fa-attempts-${signedTwoFactorCookie}`');
  });

  test('the mode discriminator is still SESSION-first', async () => {
    // `resolveRequestSession` reproduces this order by calling the library's own
    // `getSessionFromCtx`. If the branch ever reads the cookie first, a caller
    // holding both would take a different branch there than here — which is how
    // an enrolment came to be treated as a sign-in and left an account 2FA-on
    // with no intent row.
    const verify = await source(
      PACKAGE_ROOT,
      'plugins/two-factor/verify-two-factor.mjs'
    );
    const sessionAt = verify.indexOf(
      'const session = await getSessionFromCtx(ctx)'
    );
    const cookieAt = verify.indexOf('signedTwoFactorCookie');
    expect(sessionAt).toBeGreaterThan(-1);
    expect(cookieAt).toBeGreaterThan(sessionAt);
  });

  test('both verifiers still pass `5` to beginAttempt', async () => {
    // The per-challenge budget is SHARED with the library's own counter row, so
    // a different allowance upstream would mean two authorities on one number.
    for (const file of [
      'plugins/two-factor/totp/index.mjs',
      'plugins/two-factor/backup-codes/index.mjs',
    ])
      expect(await source(PACKAGE_ROOT, file)).toContain('beginAttempt(5)');
    expect(TWO_FACTOR_ALLOWED_ATTEMPTS).toBe(5);
  });

  test('`beginAttempt` still parses the counter with bare `Number`', async () => {
    // The row is shared, and our writers only ever put digits in it. This is the
    // coupling: the day something writes an empty value, the library's parse
    // reads it as a FRESH budget while ours reads it as exhausted.
    const verify = await source(
      PACKAGE_ROOT,
      'plugins/two-factor/verify-two-factor.mjs'
    );
    expect(verify).toContain('Number(consumed.value)');
  });

  test('the cookie max-age option is still `twoFactorCookieMaxAge`', () => {
    const plugin = twoFactor({
      twoFactorTable: 'twoFactorCredentials',
      twoFactorCookieMaxAge: TWO_FACTOR_CHALLENGE_MAX_AGE_S,
    });
    expect(plugin.id).toBe('two-factor');
  });
});

describe('the passkey endpoints this deployment REMOVES from the plugin map', () => {
  test('still exist under the keys the destructure names', () => {
    // `passkeyManagement()` in `lib/auth/two-factor.ts` drops three endpoints
    // by key. The library's conflict check only logs and resolves by plugin
    // order, so a renamed key would silently put the plugin's `delete-passkey`
    // — or its unauthenticated sign-in — back on the router.
    const plugin = passkey();
    for (const key of [
      'deletePasskey',
      'generatePasskeyAuthenticationOptions',
      'verifyPasskeyAuthentication',
    ])
      expect(Object.keys(plugin.endpoints)).toContain(key);
  });
});

describe('the two verification defaults this deployment compensates for', () => {
  test('passkey REGISTRATION still hardcodes `requireUserVerification: false`', async () => {
    // The whole reason `registration.afterVerification` refuses a credential
    // whose signed UV bit is unset: `authenticatorSelection` is a client hint,
    // and this is the server's answer. If upstream ever tightens it, the gate
    // becomes belt-and-braces rather than the only control — which is worth
    // knowing, and is why this asserts the value rather than merely its presence.
    const source_ = await source(PASSKEY_ROOT, 'index.mjs');
    expect(source_).toContain('requireUserVerification: false');
  });

  test('the plugin resolves its own options through `getPlugin("two-factor")`', async () => {
    // `trustDeviceMaxAge` and the account-lockout config are read that way, so
    // the plugin id is part of the contract this deployment relies on.
    const verify = await source(
      PACKAGE_ROOT,
      'plugins/two-factor/verify-two-factor.mjs'
    );
    expect(verify).toContain('getPlugin("two-factor")');
  });
});
