/**
 * Six-digit OTPs use HMAC-SHA-256 under a dedicated versioned key. The online
 * attempt budget stops guessing; the key prevents database-only enumeration.
 * Argon2 added memory and row-lock time without improving either boundary.
 *
 * Envelope: `o1:<keyId>:<base64url mac>` so retained keys keep live codes valid
 * during rotation.
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
