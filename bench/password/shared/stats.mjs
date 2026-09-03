// Percentiles, formatting, and the event-loop lag and RSS samplers.
//
// A near-copy of bench/otp/shared/stats.mjs, and local for the reason stated
// there: each bench folder is self-contained by convention, so a run can be
// handed to someone with the folder alone.

/** Nearest-rank percentile over an UNSORTED array; sorts a copy. */
export function percentile(values, p) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
}

export const fmtMs = (ms) =>
  Number.isNaN(ms) ? '—' : ms >= 100 ? ms.toFixed(0) : ms.toFixed(2);

export const fmtMiB = (bytes) => (bytes / 1024 / 1024).toFixed(1);

/**
 * Samples the delay between scheduled ticks, which is what a blocked event loop
 * looks like from the outside.
 *
 * The question this bench has to answer is not how long a hash takes but whether
 * a hash in flight delays an unrelated request. Both candidates claim to work
 * off-thread — `argon2` on libuv's threadpool, `Bun.password` on a Bun worker —
 * so neither should move this number, and a candidate that does move it is
 * disqualified on stability regardless of its throughput.
 */
export function startLagSampler(intervalMs = 10) {
  const lags = [];
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    lags.push(Math.max(0, now - last - intervalMs));
    last = now;
  }, intervalMs);
  // Unref so a forgotten stop() cannot hold the process open.
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
      return lags;
    },
  };
}

/**
 * Peak RSS across a run, sampled rather than differenced at the ends.
 *
 * A before/after reading misses the peak entirely: 64 MiB is allocated and freed
 * per operation, so a measurement taken after the last one completed reports a
 * number that never existed while the work was in flight. The peak is the whole
 * question here, because it is what a concurrent burst costs the container.
 */
export function startRssSampler(intervalMs = 5) {
  let peak = process.memoryUsage.rss();
  const baseline = peak;
  const timer = setInterval(() => {
    const rss = process.memoryUsage.rss();
    if (rss > peak) peak = rss;
  }, intervalMs);
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
      const rss = process.memoryUsage.rss();
      if (rss > peak) peak = rss;
      return { baseline, peak, delta: peak - baseline };
    },
  };
}
