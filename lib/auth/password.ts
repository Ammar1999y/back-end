import * as argon2 from 'argon2';

import { getActivePasswordPepper, getPasswordPepper } from './password-pepper';

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
  hashLength: 32,
  version: 0x13,
} satisfies argon2.HashOptions;

const HASH_ENVELOPE_VERSION = 'p1';
const PEPPER_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const ARGON2ID_PREFIX = '$argon2id$';

interface ParsedPasswordHash {
  pepperId: string;
  phc: string;
}

export type PasswordVerificationResult =
  | { valid: false; needsRehash: false; costPaid: boolean }
  | {
      valid: true;
      needsRehash: boolean;
      costPaid: true;
      pepperId: string;
      activePepperId: string;
    };

class PasswordHashFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordHashFormatError';
  }
}

function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

function parsePasswordHash(hash: string): ParsedPasswordHash | null {
  if (!hash.startsWith(`${HASH_ENVELOPE_VERSION}:`)) {
    if (/^p\d+:/.test(hash)) {
      throw new PasswordHashFormatError(
        'Stored password hash uses an unsupported envelope version'
      );
    }
    return null;
  }

  const parts = hash.split(':');
  if (parts.length !== 3) {
    throw new PasswordHashFormatError(
      'Stored password hash has an invalid envelope'
    );
  }

  const [, pepperId, phc] = parts;
  if (
    pepperId === undefined ||
    phc === undefined ||
    !PEPPER_ID_PATTERN.test(pepperId) ||
    !phc.startsWith(ARGON2ID_PREFIX)
  ) {
    throw new PasswordHashFormatError(
      'Stored password hash has an invalid envelope'
    );
  }

  return { pepperId, phc };
}

export function assertPasswordHashEvaluable(hash: string): void {
  const parsed = parsePasswordHash(hash);
  if (!parsed)
    throw new PasswordHashFormatError('Stored password hash has no envelope');
  getPasswordPepper(parsed.pepperId);
}

export async function hashPassword(password: string): Promise<string> {
  const pepper = getActivePasswordPepper();
  const phc = await argon2.hash(normalizePassword(password), {
    ...ARGON2_OPTIONS,
    secret: pepper.secret,
  });
  return `${HASH_ENVELOPE_VERSION}:${pepper.id}:${phc}`;
}

/**
 * The single credential-verification entry point, and therefore the only place
 * that can decide what an UNEVALUATABLE stored hash means.
 *
 * Two of its steps throw rather than returning a result: `parsePasswordHash` on
 * a malformed or unsupported envelope, and `getPasswordPepper` on an envelope
 * naming a generation the current keyring no longer holds. Both are server-state
 * faults — an operator retiring a generation too early, or a
 * `PASSWORD_PEPPER_KEYRING` revert — and neither used to be converted anywhere:
 * they escaped Better Call as a **bodyless, content-type-less 500** while an
 * unknown email answered `401` with the JSON envelope. That difference was an
 * unauthenticated account-existence oracle, sharpest mid-rotation, when it also
 * revealed which addresses had not signed in since the rotation.
 *
 * They are converted here, not at the four `verifyLoginAttempt` call sites, for
 * the reason AGENTS.md gives: fix at a shared boundary. The result is a plain
 * `valid: false`, indistinguishable from a wrong password on every path, and the
 * fault reaches the operator through the log instead of through the response.
 *
 * `costPaid: false` is correct for both: no Argon2 work was done, so the caller
 * still owes the timing guard.
 */
export async function verifyPasswordDetailed({
  hash,
  password,
}: {
  hash: string;
  password: string;
}): Promise<PasswordVerificationResult> {
  let parsed: ParsedPasswordHash | null;
  let pepper: ReturnType<typeof getPasswordPepper>;
  try {
    parsed = parsePasswordHash(hash);
    if (!parsed) {
      return { valid: false, needsRehash: false, costPaid: false };
    }
    pepper = getPasswordPepper(parsed.pepperId);
  } catch (error) {
    console.error(
      JSON.stringify({
        msg: 'auth.password.hash unevaluatable',
        errorClass: error instanceof Error ? error.name : 'UnknownError',
        // The message names the envelope defect or the missing generation. It
        // carries no secret: `KeyringConfigurationError` reports the env var and
        // the rule, never a key, and `PasswordHashFormatError` reports the shape.
        detail: error instanceof Error ? error.message : null,
      })
    );
    return { valid: false, needsRehash: false, costPaid: false };
  }

  const valid = await argon2.verify(parsed.phc, normalizePassword(password), {
    secret: pepper.secret,
  });
  if (!valid) return { valid: false, needsRehash: false, costPaid: true };

  const activePepper = getActivePasswordPepper();
  return {
    valid: true,
    needsRehash: pepper.generation < activePepper.generation,
    costPaid: true,
    pepperId: pepper.id,
    activePepperId: activePepper.id,
  };
}

export async function verifyPassword({
  hash,
  password,
}: {
  hash: string;
  password: string;
}): Promise<boolean> {
  const result = await verifyPasswordDetailed({ hash, password });
  return result.valid;
}

export async function runPasswordTimingGuard(password: string): Promise<void> {
  const pepper = getActivePasswordPepper();
  await argon2.hash(normalizePassword(password), {
    ...ARGON2_OPTIONS,
    secret: pepper.secret,
  });
}
