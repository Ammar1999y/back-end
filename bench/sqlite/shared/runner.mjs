// Measurement loop. Warms up, then records one latency sample per logical
// operation. Setup and beforeEach cost is never included in the samples.

import { isBusyError, summarise } from './stats.mjs';

const DEFAULT_ITERATIONS = 30_000;
const DEFAULT_WARMUP_RATIO = 0.1;

export function runWorkload(workload, db, options = {}) {
  // A workload that declares its own iteration count does so because each op is
  // expensive (a 100-row batch, a 50k-row sweep); a CLI default must not raise it.
  const iterations =
    workload.iterations ?? options.iterations ?? DEFAULT_ITERATIONS;
  const warmup =
    options.warmup ??
    Math.max(1, Math.floor(iterations * DEFAULT_WARMUP_RATIO));
  const ctx = { db, seed: options.seed ?? true };

  workload.setup?.(ctx);

  for (let i = 0; i < warmup; i++) {
    workload.beforeEach?.(ctx);
    try {
      workload.op(i, ctx);
    } catch (error) {
      if (!isBusyError(error)) throw error;
    }
  }

  let errors = 0;
  let busy = 0;
  const samples = new Array(iterations);
  let recorded = 0;
  let successful = 0;
  let measuredNs = 0n;

  for (let i = 0; i < iterations; i++) {
    workload.beforeEach?.(ctx);
    const t0 = process.hrtime.bigint();
    try {
      workload.op(i, ctx);
      const elapsed = process.hrtime.bigint() - t0;
      measuredNs += elapsed;
      samples[recorded++] = elapsed;
      successful++;
    } catch (error) {
      const elapsed = process.hrtime.bigint() - t0;
      measuredNs += elapsed;
      if (isBusyError(error)) {
        samples[recorded++] = elapsed;
        busy++;
        errors++;
      } else {
        throw error;
      }
    }
  }

  samples.length = recorded;

  return {
    name: workload.name,
    group: workload.group,
    unit: workload.unit,
    ...summarise(samples, measuredNs, errors, successful),
    busy,
  };
}

// Duration-bounded variant: every process runs for the same wall-clock window so
// concurrent results are directly comparable. onReady() is called once setup is
// finished and must block until every other process is also ready, otherwise
// slow seeding would stagger the start and inflate aggregate throughput.
export function runWorkloadForDuration(
  workload,
  db,
  { durationMs, onReady, seed = true }
) {
  const ctx = { db, seed };
  workload.setup?.(ctx);

  onReady?.();

  const samples = [];
  let errors = 0;
  let busy = 0;
  let i = 0;
  let successful = 0;
  const started = process.hrtime.bigint();
  const deadline = started + BigInt(durationMs) * 1_000_000n;

  for (;;) {
    const t0 = process.hrtime.bigint();
    if (t0 >= deadline) break;
    try {
      workload.op(i++, ctx);
      samples.push(process.hrtime.bigint() - t0);
      successful++;
    } catch (error) {
      samples.push(process.hrtime.bigint() - t0);
      errors++;
      if (isBusyError(error)) busy++;
      else throw error;
    }
  }

  const elapsed = process.hrtime.bigint() - started;
  return {
    name: workload.name,
    group: workload.group,
    unit: workload.unit,
    ...summarise(samples, elapsed, errors, successful),
    busy,
  };
}
