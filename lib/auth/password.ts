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

export async function hashPassword(password: string): Promise<string> {
  const pepper = getActivePasswordPepper();
  const phc = await argon2.hash(normalizePassword(password), {
    ...ARGON2_OPTIONS,
    secret: pepper.secret,
  });
  return `${HASH_ENVELOPE_VERSION}:${pepper.id}:${phc}`;
}

export async function verifyPasswordDetailed({
  hash,
  password,
}: {
  hash: string;
  password: string;
}): Promise<PasswordVerificationResult> {
  const parsed = parsePasswordHash(hash);
  if (!parsed) {
    return { valid: false, needsRehash: false, costPaid: false };
  }

  const pepper = getPasswordPepper(parsed.pepperId);
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
