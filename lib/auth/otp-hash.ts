/**
 * How a six-digit OTP is stored and checked: HMAC-SHA-256 under a dedicated
 * versioned server key, compared in constant time.
 *
 * **Why not the password KDF, which is what this replaced.** OTPs used to go
 * through `hashPassword` — Argon2id at 64 MiB, t=3, p=4, plus the password
 * pepper. A slow KDF exists to make offline enumeration of a high-entropy secret
 * expensive. It buys nothing here and costs a great deal:
 *
 * - **It buys nothing.** The guess space is 10^6 and online guessing is already
 *   capped hard (`OTP_MAX_VERIFY_ATTEMPTS` per cycle, `verifyAttemptDaily` per
 *   day, plus per-destination and per-IP limiters), so the attempt budget — not
 *   the hash cost — is what stops guessing. Against a stolen database the key is
 *   what stops the attacker, exactly as the pepper was; and even with the key,
 *   enumerating 10^6 candidates is trivial against ANY unkeyed-speed primitive
 *   while the code expires in `OTP_EXPIRY_MINUTES`. Argon2id changes neither
 *   case.
 * - **It cost measurably.** Argon2id charges its 64 MiB per CONCURRENT
 *   operation, and the limiters bound request RATE, not simultaneous working set.
 *   Measured (`bench/otp`, Bun 1.4.0, 8 cores, four runs): 4 concurrent
 *   operations held ~257 MiB above baseline and 10 or more held ~513 MiB — the
 *   same figure every run, plateauing at the libuv threadpool ceiling. Throughput
 *   did not scale with concurrency at all (12–22 ops/s from 1 to 32), so p99
 *   latency reached 0.8–1.4 s. HMAC-SHA-256 over the same runs: 0.02–0.2 ms and
 *   no measurable RSS delta.
 *
 *   Event-loop lag is NOT part of this argument, though an earlier draft said it
 *   was. argon2 runs on the threadpool, so lag stayed at 6–25 ms p99; a single
 *   589 ms observation did not reproduce across three further runs and was an
 *   outlier, not a finding.
 * - **It was also lock-hold time.** `processOtpVerify` calls `verifyOtpCode`
 *   inside `withTransaction`, after taking `FOR UPDATE` on both the user row and
 *   the proof row. So every verify held two row locks and one of ten pool
 *   connections across the whole hash — ~65 ms measured, per attempt. That is the
 *   same defect class as the OTP delivery that used to sit inside the same kind of
 *   transaction; this one just happened to be fixed by changing the primitive
 *   rather than by moving the call.
 *
 * **Not a fast UNKEYED hash.** A bare SHA-256 of a six-digit code is a 10^6
 * rainbow table. The key is what makes this safe, which is why it lives in its
 * own keyring with its own retirement rule (`./otp-key.ts`).
 *
 * Envelope: `o1:<keyId>:<base64url mac>`. The key id travels with the value so a
 * key can be rotated without invalidating codes already in flight.
 */
import crypto from 'node:crypto';

import { getActiveOtpKey, getOtpKey } from './otp-key';
import { verifyPassword } from './password';

const ENVELOPE_VERSION = 'o1';
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/** Unpadded base64url of a 32-byte SHA-256 output. */
const MAC_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The envelope the OTP hashes used to carry, when they went through
 * `hashPassword`. Recognised on the VERIFY path only — see `verifyOtpCode`.
 */
const LEGACY_PASSWORD_ENVELOPE = 'p1:';

function computeMac(code: string, secret: Buffer): Buffer {
  // NFKC, matching `normalizePassword`, so a code that survived a normalising
  // form field still matches. Codes are ASCII digits today, which makes this a
  // no-op — kept because the cost is nil and the alternative is a silent
  // mismatch the day a channel starts echoing a full-width digit.
  return crypto
    .createHmac('sha256', secret)
    .update(code.normalize('NFKC'), 'utf8')
    .digest();
}

export function hashOtpCode(code: string): string {
  const key = getActiveOtpKey();
  return `${ENVELOPE_VERSION}:${key.id}:${computeMac(code, key.secret).toString('base64url')}`;
}

/**
 * Constant-time comparison against the stored value.
 *
 * A malformed `o1:` value returns false rather than throwing. A stored value
 * that cannot be parsed is a failed verification, not a 500 — a corrupted row
 * must not become an error-shaped oracle.
 *
 * Two cases deliberately DO throw, because both mean an operator has to act and
 * neither is a wrong code: a key id the keyring no longer holds (below), and a
 * malformed legacy `p1:` envelope, which `verifyPassword` rejects with
 * `PasswordHashFormatError`. The second is unchanged from before this module
 * existed, when every OTP went through `verifyPassword`.
 *
 * `timingSafeEqual` throws on a length mismatch rather than returning false, so
 * the length is checked first. That check is not itself a leak: the MAC length is
 * fixed by SHA-256 and carries no secret.
 *
 * Accepts the legacy `p1:` Argon2id envelope so codes issued by the previous
 * build remain verifiable while they expire. That path is a deliberate,
 * time-bounded fallback — see `verifyOtpCode`'s note on removing it.
 */
export async function verifyOtpCode(
  code: string,
  stored: string
): Promise<boolean> {
  // In-flight codes from the previous build. Delete this branch — and this
  // import of `verifyPassword` — once no deployment can hold a code issued
  // before the cutover, i.e. anything past OTP_EXPIRY_MINUTES after the deploy.
  // Left in place because the alternative is every user mid-verification at
  // deploy time getting a rejection they cannot explain.
  if (stored.startsWith(LEGACY_PASSWORD_ENVELOPE))
    return verifyPassword({ password: code, hash: stored });

  const parts = stored.split(':');
  if (parts.length !== 3) return false;

  const [version, keyId, encoded] = parts;
  if (version !== ENVELOPE_VERSION) return false;
  if (!keyId || !encoded) return false;
  if (!KEY_ID_PATTERN.test(keyId) || !MAC_PATTERN.test(encoded)) return false;

  // A retired key is the one case that legitimately throws: it means an
  // operator removed a generation while codes issued under it were still live,
  // which is a configuration error an operator has to see, not a wrong code.
  const key = getOtpKey(keyId);

  const actual = Buffer.from(encoded, 'base64url');
  const expected = computeMac(code, key.secret);
  return (
    actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected)
  );
}
