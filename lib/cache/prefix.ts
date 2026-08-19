/**
 * Exclusive upper bound for a prefix range scan.
 *
 * Its own module, with no driver import, for two reasons: the logic is pure and
 * worth testing directly, and `bun test` cannot load `better-sqlite3` — so a
 * test importing `lib/cache/index.ts` would crash the runner. Keeping this here
 * lets the tests exercise the REAL function rather than a copy of its algorithm.
 *
 * ## Why a constant upper bound is wrong
 *
 * Two previous attempts appended a fixed character:
 *
 * - `prefix + U+FFFF` — wrong because the column collates BINARY (UTF-8 bytes),
 *   and U+FFFF encodes as `EF BF BF`, which is BELOW every supplementary
 *   character. `prefix + "😀"` (F0 9F 98 80) survived deletion.
 * - `prefix + U+10FFFF` — still wrong, for a subtler reason. The bound is
 *   EXCLUSIVE, so while it covers everything below it, the keys equal to
 *   `prefix + U+10FFFF` and anything sorting after it — `prefix + U+10FFFF + …`
 *   — are not `< bound` and survived.
 *
 * No appended character can be correct: whatever is appended, a key can contain
 * it and continue. The correct bound is the prefix's lexicographic SUCCESSOR,
 * which is shorter or equal in length, never longer.
 *
 * ## Why incrementing the last code point is correct here
 *
 * UTF-8 preserves code point order — for any scalar values a < b, the UTF-8
 * encoding of a sorts before that of b bytewise. So under BINARY collation the
 * successor of the last code point yields the correct exclusive bound.
 *
 * Surrogates (U+D800–U+DFFF) are skipped because they are not scalar values; a
 * lone surrogate does not survive the round trip into UTF-8 and would corrupt
 * the ordering the bound depends on.
 */

const MAX_CODE_POINT = 0x10_ff_ff;
const SURROGATE_START = 0xd8_00;
const SURROGATE_END = 0xdf_ff;

/**
 * Returns the exclusive upper bound, or `null` when no successor exists — which
 * happens only when every code point in the prefix is already the maximum. In
 * that case every key `>= prefix` starts with the prefix, so the caller drops
 * the upper bound instead of inventing one.
 */
export function prefixUpperBound(prefix: string): string | null {
  // Iterate by code point, not by UTF-16 unit, so a surrogate pair is treated as
  // the single character it represents.
  const points = [...prefix].map((char) => char.codePointAt(0) ?? 0);

  for (let i = points.length - 1; i >= 0; i--) {
    const current = points[i] ?? 0;
    if (current >= MAX_CODE_POINT) continue; // carry: drop it and try the one before

    let next = current + 1;
    if (next >= SURROGATE_START && next <= SURROGATE_END)
      next = SURROGATE_END + 1;

    return (
      points
        .slice(0, i)
        .map((point) => String.fromCodePoint(point))
        .join('') + String.fromCodePoint(next)
    );
  }

  return null;
}
