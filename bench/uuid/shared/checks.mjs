// Format-compatibility and monotonicity assertions. Mirrors bench/sqlite's
// shared/correctness.mjs: every check returns { name, pass, detail, critical },
// gets printed PASS/FAIL, and a failing critical check fails the run loudly
// (non-zero process exit code) instead of only printing. Unlike
// correctness.mjs — where `critical` defaults to false because some checks
// there are diagnostic-only — every check in this file is safety-relevant, so
// it defaults to true here.

import { validID } from '@/utils';

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

  const buckets = new Map();
  for (const id of ids) {
    const key = msBucketKey(id);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(id);
    else buckets.set(key, [id]);
  }

  let maxBucketSize = 0;
  let violatingBuckets = 0;
  let totalInversions = 0;
  let firstViolation = null;

  for (const [key, bucket] of buckets) {
    maxBucketSize = Math.max(maxBucketSize, bucket.length);
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

  return {
    size,
    bucketCount: buckets.size,
    maxBucketSize,
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
  ];

  return { results, trials, maxBucketOverall };
}
