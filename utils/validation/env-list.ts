/**
 * Strict parses for an env var naming a closed set of values — a comma-separated
 * list, or a single value.
 *
 * `NEXT_PUBLIC_ENABLED_OTP_CHANNELS=emial` once filtered down to an empty list,
 * was read as "feature intentionally off", and shipped a silently broken OTP
 * system that passed every boot check. Duplicates and empty entries are refused
 * for the same reason.
 *
 * No imports, so `lib/env.server.ts` can adopt it without pulling the validation
 * tree (and jsdom) into the startup gate.
 */
interface EnvListSpec<T extends string> {
  name: string;
  allowed: readonly T[];
  /** What one entry is called in messages: `'channel'`, `'method'`. */
  noun: string;
  /** Completes "Leave the variable unset to ...". */
  unsetMeans: string;
}

/** The listed values in order, or `[]` when the variable is unset or blank. */
export function parseEnvEnumList<T extends string>(spec: EnvListSpec<T>): T[] {
  const raw = process.env[spec.name]?.trim();
  if (!raw) return [];

  const valid = spec.allowed.join(', ');
  const seen = new Set<string>();
  const parsed: T[] = [];

  for (const entry of raw.split(',')) {
    const value = entry.trim();
    if (!value)
      throw new Error(
        `${spec.name} contains an empty entry; write it as a comma-separated ` +
          `list of ${valid}.`
      );
    if (!(spec.allowed as readonly string[]).includes(value))
      throw new Error(
        `${spec.name} names an unknown ${spec.noun} "${value}". ` +
          `Valid values: ${valid}. Leave the variable unset to ${spec.unsetMeans}.`
      );
    if (seen.has(value))
      throw new Error(`${spec.name} lists "${value}" more than once.`);
    seen.add(value);
    parsed.push(value as T);
  }

  return parsed;
}
