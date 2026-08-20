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
 * On the implementation: this was `v7()` from the `uuid` package until Bun
 * 1.4.0. `Bun.randomUUIDv7()` was held off specifically because its 12-bit
 * sub-millisecond counter WRAPPED at 4096 ids inside one millisecond and broke
 * strict ordering there — measured, every trial — and these ids are time-ordered
 * primary keys that a keyset cursor sorts on. 1.4.0 exhausts the counter and
 * then advances the embedded timestamp instead of wrapping, so ordering now
 * holds even at the rate that used to break it. Re-measured on 1.4.0:
 * `bench/uuid/`, and `TODO.md` EM-5 for the decision.
 *
 * The one behaviour the swap does introduce: sustaining more than ~4096
 * generations per millisecond makes the timestamp INSIDE the id run ahead of
 * the wall clock (measured ~330 ms ahead in a tight loop, repaid only as real
 * time passes). Harmless here because nothing decodes that timestamp — callers
 * treat the id as an opaque sortable string — so do not start reading a creation
 * time out of an id without revisiting this.
 */

/** A UUIDv7 string: time-ordered, and lexicographically sortable by creation. */
export type UuidV7 = string;

export function generateUuidV7(): UuidV7 {
  return Bun.randomUUIDv7();
}
