const ACTIVE_ID_ENV = 'PASSWORD_PEPPER_ACTIVE_ID';
const KEYRING_ENV = 'PASSWORD_PEPPER_KEYRING';

const PEPPER_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const BASE64URL_32_BYTES_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_PEPPER_KEYS = 8;
const MAX_POLICY_GENERATION = 2_147_483_647;

interface PasswordPepperMaterial {
  generation: number;
  secret: Buffer;
}

interface PasswordPepperConfiguration {
  activeId: string;
  keys: ReadonlyMap<string, PasswordPepperMaterial>;
}

export interface PasswordPepper {
  id: string;
  generation: number;
  secret: Buffer;
}

let cachedConfiguration: PasswordPepperConfiguration | undefined;

export class PasswordPepperConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordPepperConfigurationError';
  }
}

function configurationError(message: string): never {
  throw new PasswordPepperConfigurationError(
    `Invalid password pepper configuration: ${message}`
  );
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) configurationError(`${name} is required`);
  return value;
}

function decodePepperKey(id: string, encoded: unknown): Buffer {
  if (
    typeof encoded !== 'string' ||
    !BASE64URL_32_BYTES_PATTERN.test(encoded)
  ) {
    configurationError(
      `key "${id}" must be an unpadded base64url encoding of exactly 32 bytes`
    );
  }

  const decoded = Buffer.from(encoded, 'base64url');
  if (decoded.length !== 32 || decoded.toString('base64url') !== encoded) {
    configurationError(
      `key "${id}" must be an unpadded base64url encoding of exactly 32 bytes`
    );
  }

  return decoded;
}

function parsePepperMaterial(
  id: string,
  value: unknown
): PasswordPepperMaterial {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    configurationError(`key "${id}" must be a JSON object`);
  }

  const entry = value as Record<string, unknown>;
  const fields = Object.keys(entry);
  if (
    fields.length !== 2 ||
    !Object.hasOwn(entry, 'generation') ||
    !Object.hasOwn(entry, 'secret')
  ) {
    configurationError(
      `key "${id}" must contain only "generation" and "secret"`
    );
  }

  const generation = entry.generation;
  if (
    typeof generation !== 'number' ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    generation > MAX_POLICY_GENERATION
  ) {
    configurationError(
      `key "${id}" generation must be an integer between 1 and ${MAX_POLICY_GENERATION}`
    );
  }

  return {
    generation,
    secret: decodePepperKey(id, entry.secret),
  };
}

function parseConfiguration(): PasswordPepperConfiguration {
  const activeId = readRequiredEnv(ACTIVE_ID_ENV);
  if (!PEPPER_ID_PATTERN.test(activeId)) {
    configurationError(
      `${ACTIVE_ID_ENV} must match ${PEPPER_ID_PATTERN.source}`
    );
  }

  const encodedKeyring = readRequiredEnv(KEYRING_ENV);
  let rawKeyring: unknown;
  try {
    rawKeyring = JSON.parse(encodedKeyring);
  } catch {
    configurationError(`${KEYRING_ENV} must be a valid JSON object`);
  }

  if (
    typeof rawKeyring !== 'object' ||
    rawKeyring === null ||
    Array.isArray(rawKeyring)
  ) {
    configurationError(`${KEYRING_ENV} must be a JSON object`);
  }

  const entries = Object.entries(rawKeyring);
  if (entries.length === 0 || entries.length > MAX_PEPPER_KEYS) {
    configurationError(
      `${KEYRING_ENV} must contain between 1 and ${MAX_PEPPER_KEYS} keys`
    );
  }

  const keys = new Map<string, PasswordPepperMaterial>();
  const generations = new Map<number, string>();
  for (const [id, value] of entries) {
    if (!PEPPER_ID_PATTERN.test(id)) {
      configurationError(
        `key ID "${id}" must match ${PEPPER_ID_PATTERN.source}`
      );
    }

    const material = parsePepperMaterial(id, value);
    const generationOwner = generations.get(material.generation);
    if (generationOwner) {
      configurationError(
        `keys "${generationOwner}" and "${id}" cannot share generation ${material.generation}`
      );
    }

    generations.set(material.generation, id);
    keys.set(id, material);
  }

  if (!keys.has(activeId)) {
    configurationError(
      `${ACTIVE_ID_ENV} must identify a key present in ${KEYRING_ENV}`
    );
  }

  return { activeId, keys };
}

function getConfiguration(): PasswordPepperConfiguration {
  // eslint-disable-next-line unicorn/no-top-level-assignment-in-function -- memoized lazy singleton; the assignment IS the cache
  cachedConfiguration ??= parseConfiguration();
  return cachedConfiguration;
}

export function validatePasswordPepperConfiguration(): void {
  getConfiguration();
}

export function getActivePasswordPepper(): PasswordPepper {
  const configuration = getConfiguration();
  const material = configuration.keys.get(configuration.activeId);
  if (!material) {
    configurationError(
      `${ACTIVE_ID_ENV} must identify a key present in ${KEYRING_ENV}`
    );
  }
  return {
    id: configuration.activeId,
    ...material,
  };
}

export function getPasswordPepper(id: string): PasswordPepper {
  const material = getConfiguration().keys.get(id);
  if (!material) {
    configurationError(`no key is configured for stored key ID "${id}"`);
  }
  return { id, ...material };
}
