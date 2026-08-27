/**
 * A versioned keyring of 32-byte server secrets, read from two environment
 * variables and validated at first use.
 *
 * Extracted from `password-pepper.ts` when OTP hashing needed the same
 * structure: an active key id, a set of retained keys, generation ordering so a
 * consumer can tell "hashed under an older key" from "hashed under the current
 * one". Two copies of this validation would have been two copies of the rules
 * about base64url length, duplicate generations and key-count ceilings — and the
 * copies drift, which for key material means one of them quietly accepts
 * something the other rejects.
 *
 * Parameterised by env var NAMES rather than by pre-read values: the whole point
 * is to fail at load with a message naming the variable an operator has to fix.
 *
 * **No secret, and no slice of one, appears in any error message here.** Startup
 * logs are widely readable. Errors name the key ID — which is not secret, it is
 * stored in every hash envelope — and describe the rule that failed.
 */

/** Key IDs travel inside hash envelopes, so they must stay envelope-safe. */
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/** Unpadded base64url of exactly 32 bytes. */
const BASE64URL_32_BYTES_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/**
 * Retained-key ceiling. Every retained key is a key an attacker who obtains the
 * environment can use, so retention is a cost — the bound exists to make an
 * unbounded keyring impossible to configure by accident.
 */
const MAX_KEYS = 8;
const MAX_GENERATION = 2_147_483_647;

interface KeyMaterial {
  generation: number;
  secret: Buffer;
}

interface KeyringKey {
  id: string;
  generation: number;
  secret: Buffer;
}

interface KeyringConfiguration {
  activeId: string;
  keys: ReadonlyMap<string, KeyMaterial>;
}

/**
 * One error class for every keyring, distinguished by its message.
 *
 * Separate subclasses per keyring were considered and rejected: nothing catches
 * this by type — it is a fatal misconfiguration — and a `catch` that wanted to
 * would be catching "the deployment is wrong", which has one response.
 */
class KeyringConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyringConfigurationError';
  }
}

export interface KeyringSpec {
  /** Env var holding the active key ID. */
  activeIdEnv: string;
  /** Env var holding the JSON keyring. */
  keyringEnv: string;
  /** Human-readable name for error messages, e.g. `password pepper`. */
  label: string;
}

/**
 * A lazily-parsed keyring. `validate()` exists so `lib/env.server.ts` can force
 * the parse at startup instead of letting the first request discover the problem.
 */
export interface Keyring {
  validate: () => void;
  active: () => KeyringKey;
  byId: (id: string) => KeyringKey;
}

export function defineKeyring(spec: KeyringSpec): Keyring {
  const cache: { configuration: KeyringConfiguration | undefined } = {
    configuration: undefined,
  };

  function fail(message: string): never {
    throw new KeyringConfigurationError(
      `Invalid ${spec.label} configuration: ${message}`
    );
  }

  function readRequiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) fail(`${name} is required`);
    return value;
  }

  function decodeSecret(id: string, encoded: unknown): Buffer {
    if (
      typeof encoded !== 'string' ||
      !BASE64URL_32_BYTES_PATTERN.test(encoded)
    )
      fail(
        `key "${id}" must be an unpadded base64url encoding of exactly 32 bytes`
      );

    const decoded = Buffer.from(encoded, 'base64url');
    // Re-encoding and comparing, not just checking the length: base64url decoding
    // is lenient about a final character whose trailing bits are non-zero, so two
    // different strings can decode to one buffer. Without this, a key could be
    // written two ways, and only one of them would match the id recorded in
    // existing envelopes.
    if (decoded.length !== 32 || decoded.toString('base64url') !== encoded)
      fail(
        `key "${id}" must be an unpadded base64url encoding of exactly 32 bytes`
      );

    return decoded;
  }

  function parseMaterial(id: string, value: unknown): KeyMaterial {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      fail(`key "${id}" must be a JSON object`);

    const entry = value as Record<string, unknown>;
    const fields = Object.keys(entry);
    // Exactly these two, no extras: a typo'd field name (`generaton`) would
    // otherwise be silently ignored and the key would take a default it never
    // declared.
    if (
      fields.length !== 2 ||
      !Object.hasOwn(entry, 'generation') ||
      !Object.hasOwn(entry, 'secret')
    )
      fail(`key "${id}" must contain only "generation" and "secret"`);

    const { generation } = entry;
    if (
      typeof generation !== 'number' ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      generation > MAX_GENERATION
    )
      fail(
        `key "${id}" generation must be an integer between 1 and ${MAX_GENERATION}`
      );

    return { generation, secret: decodeSecret(id, entry.secret) };
  }

  function parseConfiguration(): KeyringConfiguration {
    const activeId = readRequiredEnv(spec.activeIdEnv);
    if (!KEY_ID_PATTERN.test(activeId))
      fail(`${spec.activeIdEnv} must match ${KEY_ID_PATTERN.source}`);

    const encodedKeyring = readRequiredEnv(spec.keyringEnv);
    let rawKeyring: unknown;
    try {
      rawKeyring = JSON.parse(encodedKeyring);
    } catch {
      fail(`${spec.keyringEnv} must be a valid JSON object`);
    }

    if (
      typeof rawKeyring !== 'object' ||
      rawKeyring === null ||
      Array.isArray(rawKeyring)
    )
      fail(`${spec.keyringEnv} must be a JSON object`);

    const entries = Object.entries(rawKeyring);
    if (entries.length === 0 || entries.length > MAX_KEYS)
      fail(`${spec.keyringEnv} must contain between 1 and ${MAX_KEYS} keys`);

    const keys = new Map<string, KeyMaterial>();
    const generations = new Map<number, string>();
    for (const [id, value] of entries) {
      if (!KEY_ID_PATTERN.test(id))
        fail(`key ID "${id}" must match ${KEY_ID_PATTERN.source}`);

      const material = parseMaterial(id, value);
      // Generation decides "is this hash stale", so two keys sharing one makes
      // that question unanswerable.
      const owner = generations.get(material.generation);
      if (owner)
        fail(
          `keys "${owner}" and "${id}" cannot share generation ${material.generation}`
        );

      generations.set(material.generation, id);
      keys.set(id, material);
    }

    if (!keys.has(activeId))
      fail(
        `${spec.activeIdEnv} must identify a key present in ${spec.keyringEnv}`
      );

    // The active key must own the HIGHEST generation, and this is the rule the
    // file was missing.
    //
    // `generation` has exactly one consumer and it reads the field as staleness:
    // `needsRehash: pepper.generation < activePepper.generation`
    // (`lib/auth/password.ts`). So with keys `{"1":{generation:1},

    const activeGeneration = keys.get(activeId)?.generation ?? 0;
    const newest = Math.max(
      ...keys.values().map((material) => material.generation)
    );
    if (activeGeneration < newest)
      fail(
        `${spec.activeIdEnv} names key "${activeId}" (generation ${activeGeneration}), ` +
          `but ${spec.keyringEnv} contains generation ${newest}. The active key must own the ` +
          'highest generation, or every hash written with the newer key is treated as ' +
          'current forever. Roll the keyring and the active id together.'
      );

    return { activeId, keys };
  }

  function getConfiguration(): KeyringConfiguration {
    cache.configuration ??= parseConfiguration();
    return cache.configuration;
  }

  return {
    validate() {
      getConfiguration();
    },

    active() {
      const configuration = getConfiguration();
      const material = configuration.keys.get(configuration.activeId);
      if (!material)
        fail(
          `${spec.activeIdEnv} must identify a key present in ${spec.keyringEnv}`
        );
      return { id: configuration.activeId, ...material };
    },

    byId(id: string) {
      const material = getConfiguration().keys.get(id);
      // The message that matters most in practice: it fires when a key is
      // RETIRED while values hashed under it are still live. Naming the id is
      // what turns that into a one-line fix.
      if (!material) fail(`no key is configured for stored key ID "${id}"`);
      return { id, ...material };
    },
  };
}
