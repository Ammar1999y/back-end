/**
 * The one place this project generates identifiers.
 *
 * Three modules previously imported `v7` from `uuid` directly — `db/schema.ts`,
 * `lib/permissions/utils.ts` and `utils/index.ts` — so changing the
 * implementation meant changing it three times, and the real call count was
 * invisible. Everything now routes through here.
 *
 * A leaf module on purpose: it imports nothing from this project, so
 * `db/schema.ts` can use it without the import cycle that reaching into
 * `utils/index.ts` would create.
 *
 * On the implementation: `Bun.randomUUIDv7()` produces the same string format
 * and is a candidate replacement. It is NOT adopted on the strength of existing
 * — see `bench/uuid/` for the measurement and `TODO.md` for the decision. This
 * module is the seam that makes the swap a one-line change either way.
 */
import { v7 } from 'uuid';

/** A UUIDv7 string: time-ordered, and lexicographically sortable by creation. */
export type UuidV7 = string;

export function generateUuidV7(): UuidV7 {
  return v7();
}
