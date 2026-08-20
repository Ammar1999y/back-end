// Format-compatibility and monotonicity assertions. Mirrors bench/sqlite's
// shared/correctness.mjs: every check returns { name, pass, detail, critical },
// gets printed PASS/FAIL, and a failing critical check fails the run loudly
// (non-zero process exit code) instead of only printing. Unlike
// correctness.mjs — where `critical` defaults to false because some checks
// there are diagnostic-only — every check in this file is safety-relevant, so
// it defaults to true here.

import { validID } from '@/utils';

import { median } from './stats.mjs';

function check(name, pass, detail, critical = true) {
  return { name, pass, detail, critical };
}

const HEX_DIGITS = new Set('0123456789abcdef');
const HYPHEN_POSITIONS = new Set([8, 13, 18, 23]);

/**
 * `UUID_V7_REGEX` in utils/index.ts is a private module const — only the
 * `validID` function that wraps it is exported. Exporting the regex itself
 * would mean editing application code, which this benchmark must not do.
 * `validID(id) === id` for a whitespace-free string is exactly "id matches
 * UUID_V7_REGEX" (validID only trims and tests), so it stands in for the
 * regex without copying its pattern.
 */
function matchesAppRegex(id) {
  return validID(id) === id;
}

function isLowercaseHexLayout(id) {
  if (id.length !== 36) return false;
  for (let pos = 0; pos < id.length; pos++) {
    const isHyphenPos = HYPHEN_POSITIONS.has(pos);
    const char = id[pos];
    if (isHyphenPos ? char !== '-' : !HEX_DIGITS.has(char)) return false;
  }
  return true;
}

function summarizeFailures(label, sampleSize, failures, detailFor) {
  return check(
    label,
    failures.length === 0,
    failures.length === 0
      ? `${sampleSize}/${sampleSize} passed`
      : `${failures.length}/${sampleSize} FAILED, e.g. ${detailFor(failures[0])}`
  );
}

/**
 * Runs all format assertions over `sampleSize` freshly generated ids from one
 * implementation: app-regex equivalence, exact length, lowercase-hex layout,
 * version nibble, and RFC 9562 variant bits. One bad id anywhere in the
 * sample fails its check, so a rare defect is not averaged away.
 */
export function runFormatChecks(generatorName, generate, sampleSize) {
  const appRegexFailures = [];
  const lengthFailures = [];
  const lowercaseFailures = [];
  const versionFailures = [];
  const variantFailures = [];

  for (let i = 0; i < sampleSize; i++) {
    const id = generate();

    if (!matchesAppRegex(id)) appRegexFailures.push(id);
    if (id.length !== 36) lengthFailures.push(id);
    if (!isLowercaseHexLayout(id)) lowercaseFailures.push(id);
    if (id[14] !== '7') versionFailures.push(id);

    // Variant nibble at index 19: top two bits must be `10` (hex digit
    // 8/9/a/b), the RFC 9562 (ex-4122) variant.
    const variantNibble = Number.parseInt(id[19] ?? '', 16);
    if (Number.isNaN(variantNibble) || (variantNibble & 0b1100) !== 0b1000)
      variantFailures.push(id);
  }

  return [
    summarizeFailures(
      `${generatorName}: matches app UUID_V7_REGEX (via validID)`,
      sampleSize,
      appRegexFailures,
      (id) => JSON.stringify(id)
    ),
    summarizeFailures(
      `${generatorName}: exactly 36 characters`,
      sampleSize,
      lengthFailures,
      (id) => `length ${id.length} for ${JSON.stringify(id)}`
    ),
    summarizeFailures(
      `${generatorName}: lowercase hex + hyphen layout`,
      sampleSize,
      lowercaseFailures,
      (id) => JSON.stringify(id)
    ),
    summarizeFailures(
      `${generatorName}: version nibble is 7`,
      sampleSize,
      versionFailures,
      (id) => `version char '${id[14]}' in ${JSON.stringify(id)}`
    ),
    summarizeFailures(
      `${generatorName}: variant bits are RFC 9562 compliant (10xx)`,
      sampleSize,
      variantFailures,
      (id) => `variant char '${id[19]}' in ${JSON.stringify(id)}`
    ),
  ];
}

/**
 * The 48-bit UUIDv7 timestamp occupies the first 12 hex digits: the whole
 * first hyphen-group (8 hex = 32 bits) plus the whole second hyphen-group (4
 * hex = 16 bits). Concatenating them (dropping the hyphen) gives a
 * millisecond-bucket key without parsing the value as a number.
 */
function msBucketKey(id) {
  return id.slice(0, 8) + id.slice(9, 13);
}

/** The same 48 bits as a number, for comparison against `Date.now()`. */
function msFromId(id) {
  return Number.parseInt(msBucketKey(id), 16);
}

/**
 * One burst: `size` ids generated back to back as fast as the runtime can, no
 * other work in the loop. Groups them by millisecond bucket in generation
 * order and checks, per bucket, whether that order is already strictly
 * increasing under plain string comparison — the order a `sort()` on a
 * text/char column, or a database index, would produce.
 */
function runMonotonicityBurst(generate, size) {
  const ids = new Array(size);
  for (let i = 0; i < size; i++) ids[i] = generate();

  const collisions = ids.length - new Set(ids).size;

  // Whole-sequence strict increase, across millisecond boundaries as well as
  // inside them. Per-bucket ordering alone cannot see a generator that keeps
  // each millisecond internally sorted but emits a timestamp lower than one it
  // already used — which is exactly what a counter-exhaustion strategy built on
  // borrowing future timestamps (Bun 1.4.0) could get wrong when the real clock
  // catches up.
  let globalInversions = 0;
  let firstGlobalViolation = null;
  for (let i = 1; i < ids.length; i++) {
    if (!(ids[i - 1] < ids[i])) {
      globalInversions++;
      firstGlobalViolation ??= { index: i, prev: ids[i - 1], curr: ids[i] };
    }
  }

  const buckets = new Map();
  for (const id of ids) {
    const key = msBucketKey(id);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(id);
    else buckets.set(key, [id]);
  }

  let maxBucketSize = 0;
  const bucketSizes = [];
  let violatingBuckets = 0;
  let totalInversions = 0;
  let firstViolation = null;

  for (const [key, bucket] of buckets) {
    maxBucketSize = Math.max(maxBucketSize, bucket.length);
    bucketSizes.push(bucket.length);
    let bucketHadViolation = false;
    for (let i = 1; i < bucket.length; i++) {
      if (!(bucket[i - 1] < bucket[i])) {
        totalInversions++;
        bucketHadViolation = true;
        firstViolation ??= {
          bucket: key,
          index: i,
          prev: bucket[i - 1],
          curr: bucket[i],
        };
      }
    }
    if (bucketHadViolation) violatingBuckets++;
  }

  // Cross-check against the other phrasing of the same property ("strictly
  // increasing when sorted as strings"): generation order for a bucket must
  // equal that bucket's own string-sorted order. A disagreement between the
  // two computations would mean this checker is broken, not the generator.
  let sortDisagreement = false;
  for (const bucket of buckets.values()) {
    const sorted = [...bucket].sort();
    for (let i = 0; i < bucket.length; i++) {
      if (bucket[i] !== sorted[i]) {
        sortDisagreement = true;
        break;
      }
    }
    if (sortDisagreement) break;
  }
  const monotonic = totalInversions === 0;
  // The two computations must always disagree with each other in the same
  // direction: monotonic (no inversions) implies no sort disagreement, and
  // vice versa. `monotonic === sortDisagreement` is true only when that
  // relationship breaks, i.e. the checker itself has a bug.
  if (monotonic === sortDisagreement) {
    throw new Error(
      'monotonicity checker disagreement: pairwise strict-increase and sort-order ' +
        'comparison produced different verdicts — the checker is broken, not the generator'
    );
  }

  // The first and last millisecond buckets of a burst are cut short by the
  // burst's own start and end, so they say nothing about how many ids one
  // millisecond can hold. Capacity stats use the interior buckets only.
  const interiorSizes = bucketSizes.slice(1, -1);

  return {
    size,
    bucketCount: buckets.size,
    maxBucketSize,
    medianBucketSize: interiorSizes.length ? median(interiorSizes) : 0,
    minBucketSize: interiorSizes.length ? Math.min(...interiorSizes) : 0,
    globalInversions,
    firstGlobalViolation,
    collisions,
    violatingBuckets,
    totalInversions,
    firstViolation,
    monotonic,
  };
}

/**
 * Runs `repeat` independent bursts of `size` ids for one implementation and
 * reduces them to the two properties the swap decision depends on: zero
 * full-string collisions, and strict same-millisecond ordering, in every
 * trial.
 */
export function runMonotonicityChecks(generatorName, generate, size, repeat) {
  const trials = [];
  for (let r = 0; r < repeat; r++)
    trials.push(runMonotonicityBurst(generate, size));

  const collisionsTotal = trials.reduce((sum, t) => sum + t.collisions, 0);
  const allMonotonic = trials.every((t) => t.monotonic);
  const maxBucketOverall = Math.max(...trials.map((t) => t.maxBucketSize));
  const worstTrial = trials.find((t) => !t.monotonic) ?? null;
  const totalBuckets = trials.reduce((sum, t) => sum + t.bucketCount, 0);
  const medianBucketOverall = median(trials.map((t) => t.medianBucketSize));
  const minBucketOverall = Math.min(...trials.map((t) => t.minBucketSize));

  const results = [
    check(
      `${generatorName}: zero full-string collisions across ${repeat} burst(s) of ${size}`,
      collisionsTotal === 0,
      `${collisionsTotal} collision(s) total (per trial: ${trials.map((t) => t.collisions).join(', ')})`
    ),
    check(
      `${generatorName}: strictly increasing within every millisecond bucket`,
      allMonotonic,
      allMonotonic
        ? `${totalBuckets} bucket(s) across ${repeat} trial(s), largest bucket ${maxBucketOverall} ids, 0 inversions`
        : `${worstTrial.totalInversions} inversion(s) in ${worstTrial.violatingBuckets}/${worstTrial.bucketCount} bucket(s) on the worst trial (largest bucket ${maxBucketOverall} ids); first violation ${JSON.stringify(worstTrial.firstViolation)}`
    ),
    check(
      `${generatorName}: strictly increasing across the whole burst`,
      trials.every((t) => t.globalInversions === 0),
      trials.every((t) => t.globalInversions === 0)
        ? `0 inversions in ${repeat * size} ids generated back to back`
        : `${trials.reduce((sum, t) => sum + t.globalInversions, 0)} inversion(s); first ${JSON.stringify(trials.find((t) => t.globalInversions > 0).firstGlobalViolation)}`
    ),
    // Reported, not asserted: how many ids one millisecond actually held. It is
    // what says whether "monotonic" was proven against a real per-millisecond
    // load or only against a bucket the implementation never had to fill.
    check(
      `${generatorName}: ids per millisecond bucket at max rate (reported)`,
      true,
      `largest ${maxBucketOverall}, median ${medianBucketOverall}, smallest ${minBucketOverall} (interior buckets only)`,
      false
    ),
  ];

  return {
    results,
    trials,
    maxBucketOverall,
    medianBucketOverall,
    minBucketOverall,
  };
}

const CLOCK_BEHIND_TOLERANCE_MS = 1;
const CLOCK_SETTLE_MS = 50;
const CLOCK_DRIFT_SAMPLE_EVERY = 1 << 16;

/**
 * Timestamp fidelity: does the 48-bit timestamp inside an id agree with the
 * wall clock at the moment it was generated?
 *
 * This scenario exists because of what Bun 1.4.0 changed. Through 1.3.x, a
 * `Bun.randomUUIDv7` burst that exhausted its 12-bit sub-millisecond counter
 * wrapped the counter and broke same-millisecond ordering. 1.4.0 instead
 * advances the embedded timestamp into the FUTURE and keeps the counter
 * increasing — monotonicity holds, and the cost moves here, where nothing was
 * measuring. The two directions are not equally serious:
 *
 * - **Ahead of the clock is a cosmetic cost.** Nothing in this application
 *   decodes the timestamp out of an id (`lib/id.ts`'s callers store it and
 *   compare it as an opaque string), and a keyset cursor on `(createdAt, id)`
 *   reads `createdAt` for the time and `id` only as a tie-break. Reported, not
 *   asserted.
 * - **Behind the clock would be a real defect**, and it is the assertion: an id
 *   whose timestamp predates a row inserted before it sorts ahead of that row,
 *   which is exactly the ordering guarantee these ids are chosen for. One
 *   millisecond of tolerance because the comparison is two separate clock
 *   reads, not one.
 *
 * It takes two phases, and the second is not redundant. Reading the clock
 * around every call is the only way to bound the behind-direction per id — but
 * those two `Date.now()` calls also cost more than the generation itself, which
 * holds the loop below the rate at which the counter is ever exhausted.
 * Measured: the paired phase alone reports ~1 ms of forward drift for
 * `Bun.randomUUIDv7`, while an uninstrumented burst of the same generator runs
 * hundreds of milliseconds ahead. A one-phase version of this scenario would
 * have reported "no drift" and been wrong about the only property it was added
 * for.
 */
export async function runClockChecks(generatorName, generate, size) {
  // Phase 1 — paired reads, one per id: the behind-direction bound.
  let pairedMaxAheadMs = 0;
  let pairedMaxBehindMs = 0;
  let aheadCount = 0;
  let firstBehind = null;

  for (let i = 0; i < size; i++) {
    const before = Date.now();
    const id = generate();
    const after = Date.now();
    const embedded = msFromId(id);

    // Each direction is measured against the clock read that makes it hardest
    // to claim: `after` for ahead, `before` for behind. A drift this reports
    // cannot be an artefact of the read happening on the wrong side of the call.
    const ahead = embedded - after;
    const behind = before - embedded;

    if (ahead > 0) aheadCount++;
    if (ahead > pairedMaxAheadMs) pairedMaxAheadMs = ahead;
    if (behind > pairedMaxBehindMs) {
      pairedMaxBehindMs = behind;
      firstBehind ??= { id, wallClockBefore: before, embedded };
    }
  }

  // Phase 2 — uninstrumented burst, clock read once every
  // CLOCK_DRIFT_SAMPLE_EVERY ids: the generator runs at its real top speed, so
  // counter exhaustion (and therefore drift) is reachable. Sparse sampling
  // means the peak between two samples is missed, which understates drift
  // rather than inventing it.
  let burstMaxAheadMs = 0;
  let burstMaxBehindMs = 0;
  const wallStart = Date.now();
  let firstEmbedded = 0;
  let lastEmbedded = 0;
  for (let i = 0; i < size; i++) {
    const id = generate();
    if (i === 0) firstEmbedded = msFromId(id);
    if (i === size - 1) lastEmbedded = msFromId(id);
    if ((i & (CLOCK_DRIFT_SAMPLE_EVERY - 1)) === 0) {
      const drift = msFromId(id) - Date.now();
      if (drift > burstMaxAheadMs) burstMaxAheadMs = drift;
      if (-drift > burstMaxBehindMs) burstMaxBehindMs = -drift;
    }
  }
  // Exact, unlike the sampled peak above: milliseconds the embedded clock
  // advanced beyond the ones that actually elapsed. Every one of them is a
  // timestamp borrowed from the future because a millisecond ran out of counter
  // space, so this is the quantity that decides whether drift happened at all —
  // a sampled peak can miss it, this cannot.
  const burstBorrowedMs = Math.max(
    0,
    lastEmbedded - firstEmbedded - (Date.now() - wallStart)
  );

  // Forward drift is only repaid by real time passing, so an idle gap is what
  // shows whether it was a transient of the burst or a debt carried past it.
  await Bun.sleep(CLOCK_SETTLE_MS);
  const settledDriftMs = msFromId(generate()) - Date.now();

  const maxBehindMs = Math.max(pairedMaxBehindMs, burstMaxBehindMs);
  const summary = {
    generator: generatorName,
    size,
    pairedMaxAheadMs,
    pairedMaxBehindMs,
    aheadCount,
    aheadShare: size > 0 ? aheadCount / size : 0,
    burstMaxAheadMs,
    burstMaxBehindMs,
    burstBorrowedMs,
    driftSampleEvery: CLOCK_DRIFT_SAMPLE_EVERY,
    settleMs: CLOCK_SETTLE_MS,
    settledDriftMs,
  };

  const results = [
    check(
      `${generatorName}: embedded timestamp never behind the wall clock (±${CLOCK_BEHIND_TOLERANCE_MS} ms)`,
      maxBehindMs <= CLOCK_BEHIND_TOLERANCE_MS,
      maxBehindMs <= CLOCK_BEHIND_TOLERANCE_MS
        ? `max ${maxBehindMs} ms behind over ${2 * size} ids (paired ${pairedMaxBehindMs}, burst ${burstMaxBehindMs})`
        : `max ${maxBehindMs} ms behind (paired ${pairedMaxBehindMs}, burst ${burstMaxBehindMs}), e.g. ${JSON.stringify(firstBehind)}`
    ),
    check(
      `${generatorName}: forward drift (reported)`,
      true,
      `paired ${pairedMaxAheadMs} ms max (${(summary.aheadShare * 100).toFixed(1)}% of ids ahead), uninstrumented burst ${burstMaxAheadMs} ms sampled peak / ${burstBorrowedMs} ms borrowed in total, ${settledDriftMs} ms still ahead after ${CLOCK_SETTLE_MS} ms idle`,
      false
    ),
  ];

  return { results, summary };
}
