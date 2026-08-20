// Measurement loops. Two-phase (warmup, then measured) like bench/sqlite's
// shared/runner.mjs, but timed once per whole batch instead of once per call.
//
// bench/sqlite samples one `process.hrtime.bigint()` pair per operation
// because a SQLite call is microseconds and percentile tails matter for a
// store with concurrent callers. A UUID generation call is tens to low
// hundreds of nanoseconds — the same order of magnitude as `hrtime.bigint()`
// itself — so per-call sampling would measure the timer, not the generator.
// Timing the whole loop keeps timer overhead a fixed one-time cost instead of
// a per-op one.

import { summariseBatch } from './stats.mjs';

const DEFAULT_WARMUP_RATIO = 0.1;

function warmupCount(iterations, warmupRatio) {
  return Math.max(1, Math.floor(iterations * warmupRatio));
}

/**
 * Tight loop: `iterations` calls to `generate()`, nothing else in the loop
 * body. Reports ops/sec and ns/op for the isolated generation cost.
 *
 * `lastSample` keeps the result of every call live (assigned, then read by
 * the caller) so a discarded return value is never a provable no-op an
 * optimizer could eliminate the call for.
 */
export function runThroughput(
  generate,
  iterations,
  warmupRatio = DEFAULT_WARMUP_RATIO
) {
  const warmup = warmupCount(iterations, warmupRatio);

  let last = '';
  for (let i = 0; i < warmup; i++) last = generate();

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) last = generate();
  const elapsedNs = process.hrtime.bigint() - t0;

  return { ...summariseBatch(iterations, elapsedNs), lastSample: last };
}

function buildAndSerialize(generate, i) {
  const row = {
    id: generate(),
    createdAt: Date.now(),
    kind: 'bench-row',
    seq: i,
  };
  return JSON.stringify(row);
}

/**
 * One generation call per iteration, interleaved with the small amount of
 * other work a real insert path also pays for: building the object literal
 * the id goes into, then `JSON.stringify`-ing it. That non-generation work is
 * byte-identical across implementations, so the gap between this scenario's
 * ns/op and runThroughput's ns/op is what the id call is worth inside a
 * realistic operation, not the isolated call.
 */
export function runInterleaved(
  generate,
  iterations,
  warmupRatio = DEFAULT_WARMUP_RATIO
) {
  const warmup = warmupCount(iterations, warmupRatio);

  let last = '';
  for (let i = 0; i < warmup; i++) last = buildAndSerialize(generate, i);

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) last = buildAndSerialize(generate, i);
  const elapsedNs = process.hrtime.bigint() - t0;

  return { ...summariseBatch(iterations, elapsedNs), lastSample: last };
}
