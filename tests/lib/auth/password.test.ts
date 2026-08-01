import { describe, expect, test } from 'bun:test';

import '@/tests/helpers/env';

import { hashPassword, verifyPassword } from '@/lib/auth/password';

describe('Argon2 password hashing', () => {
  test('creates an Argon2id PHC hash and verifies it', async () => {
    const password = 'CorrectHorseBatteryStaple!';
    const hash = await hashPassword(password);

    expect(hash).toMatch(
      /^p1:[A-Za-z0-9_-]{1,32}:\$argon2id\$v=19\$m=65536,p=4,t=3\$[^$]+\$[^$]+$/
    );
    expect(await verifyPassword({ hash, password })).toBe(true);
    expect(await verifyPassword({ hash, password: 'incorrect-password' })).toBe(
      false
    );
  });

  test('uses a random salt for every hash', async () => {
    const password = 'RepeatedPassword!';
    const [first, second] = await Promise.all([
      hashPassword(password),
      hashPassword(password),
    ]);

    expect(first).not.toBe(second);
  });

  test('preserves Better Auth NFKC normalization', async () => {
    const hash = await hashPassword('\u212BngstromPassword!');

    expect(
      await verifyPassword({ hash, password: '\u00C5ngstromPassword!' })
    ).toBe(true);
  });

  test('rejects malformed and legacy hashes', async () => {
    expect(await verifyPassword({ hash: '', password: 'password' })).toBe(
      false
    );
    expect(
      await verifyPassword({
        hash: 'salt:legacy-scrypt-key',
        password: 'password',
      })
    ).toBe(false);
  });
});
