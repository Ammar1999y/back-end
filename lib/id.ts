/**
 * Central UUIDv7 seam kept dependency-free for schema imports. Generators may
 * advance embedded timestamps to preserve sort order, so callers must not treat
 * them as wall-clock creation times.
 */

/** A lexicographically sortable UUIDv7 string. */
export type UuidV7 = string;

export function generateUuidV7(): UuidV7 {
  return Bun.randomUUIDv7();
}
