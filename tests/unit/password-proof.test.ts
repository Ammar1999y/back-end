/**
 * `lib/auth/password-proof.ts` — the value that stands in for a password between
 * `lib/auth.ts`'s `before` hook and Better Auth's `password.verify`.
 *
 * The property under test is the FAILURE DIRECTION: every case asserting `false`
 * — a real plaintext, a replayed proof, another account's hash, an expired one —
 * is what stops an allow-listed path becoming a credential bypass.
 *
 * The multi-hash case is pepper rotation, whose failure would lock out exactly
 * the users least likely to be in a fixture.
 */
import { afterEach, expect, setSystemTime, test } from 'bun:test';

import {
  consumePasswordProof,
  mintPasswordProof,
} from '@/lib/auth/password-proof';

import { PASSWORD_MAX } from '@/utils/validation/constants';

/** Shaped like a real stored value, though nothing here parses it. */
const HASH_A = `$argon2id$v=19$m=65536,t=3,p=4$${'a'.repeat(22)}$${'b'.repeat(43)}`;
const HASH_B = `$argon2id$v=19$m=65536,t=3,p=4$${'c'.repeat(22)}$${'d'.repeat(43)}`;

/** The clock case below is the only one that moves it; restore it regardless. */
afterEach(() => {
  setSystemTime();
});

test('a freshly minted proof is accepted for the hash it was minted against', () => {
  const proof = mintPasswordProof([HASH_A]);
  expect(consumePasswordProof(HASH_A, proof)).toBe(true);
});

test('a proof is single-use, so a replay inside the same request fails', () => {
  const proof = mintPasswordProof([HASH_A]);
  expect(consumePasswordProof(HASH_A, proof)).toBe(true);
  expect(consumePasswordProof(HASH_A, proof)).toBe(false);
});

test('a proof presented against a different hash is rejected AND spent', () => {
  const proof = mintPasswordProof([HASH_A]);
  // The wrong-hash case must not leave the proof usable: a handler that read
  // the wrong account row does not get a second chance with the right one.
  expect(consumePasswordProof(HASH_B, proof)).toBe(false);
  expect(consumePasswordProof(HASH_A, proof)).toBe(false);
});

test('a real plaintext password reaching verify is rejected', () => {
  // The whole point. This is what a Better Auth path the before hook does not
  // compensate hands to `verify`, and what `async () => true` accepted.
  expect(consumePasswordProof(HASH_A, 'Correct-Horse-1!')).toBe(false);
  expect(consumePasswordProof(HASH_A, '')).toBe(false);
});

test('a proof minted for both sides of a pepper upgrade is accepted for either', () => {
  const upgraded = mintPasswordProof([HASH_A, HASH_B]);
  expect(consumePasswordProof(HASH_B, upgraded)).toBe(true);

  const original = mintPasswordProof([HASH_A, HASH_B]);
  expect(consumePasswordProof(HASH_A, original)).toBe(true);
});

test('an empty hash never matches, even against a proof minted for one', () => {
  // `password.verify` is only called with a stored hash, but a future caller
  // passing `''` must not find a proof minted from a filtered-empty list.
  const proof = mintPasswordProof(['', HASH_A]);
  expect(consumePasswordProof('', proof)).toBe(false);
});

test('minting with no usable hash throws rather than issuing a dead proof', () => {
  expect(() => mintPasswordProof([])).toThrow();
  expect(() => mintPasswordProof(['', ''])).toThrow();
});

test('a proof is longer than any password this application accepts', () => {
  // The second layer: `lib/auth.ts` rejects an inbound `password` over
  // PASSWORD_MAX on every allow-listed path, so no value that survives password
  // validation can be a proof. The module asserts this at load; asserting it
  // here is what fails the suite rather than the boot when the two drift.
  const proof = mintPasswordProof([HASH_A]);
  expect(proof.length).toBeGreaterThan(PASSWORD_MAX);
  expect(consumePasswordProof(HASH_A, proof)).toBe(true);
});

test('a proof stops being accepted once its TTL has passed', () => {
  const proof = mintPasswordProof([HASH_A]);
  // Past PROOF_TTL_MS (60s). A proof only has to survive the gap between the
  // before hook and the handler in one request, so anything on this scale is an
  // abandoned request, not a slow one.
  setSystemTime(new Date(Date.now() + 61_000));
  expect(consumePasswordProof(HASH_A, proof)).toBe(false);
});

test('proofs are unique per mint', () => {
  const proofs = new Set(
    Array.from({ length: 64 }, () => mintPasswordProof([HASH_A]))
  );
  expect(proofs.size).toBe(64);
});
