// Percentiles, formatting and the event-loop lag sampler.
//
// Local to this benchmark rather than shared with bench/image or bench/uuid:
// each bench folder is self-contained by convention, so a run can be handed to
// someone with the folder alone.

/** Nearest-rank percentile over an UNSORTED array; sorts a copy. */
export function percentile(values, p) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
}

export function mean(values) {
  if (values.length === 0) return Number.NaN;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export const fmtMs = (ms) =>
  Number.isNaN(ms) ? '—' : ms >= 100 ? ms.toFixed(0) : ms.toFixed(2);

export const fmtMiB = (bytes) => (bytes / 1024 / 1024).toFixed(1);

/**
 * Samples the delay between scheduled ticks, which is what a blocked event loop
 * actually looks like from the outside.
 *
 * The metric that matters for this question is not how long a hash takes — it is
 * whether a hash in flight delays an unrelated request. `argon2` runs its work on
 * libuv's threadpool, so a single hash should NOT block the loop; this sampler is
 * what makes that a measurement rather than an assumption, and it is how
 * threadpool saturation (concurrency above UV_THREADPOOL_SIZE) shows up.
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
 * `process.memoryUsage.rss()` before/after misses the peak entirely: argon2
 * frees its 64 MiB per operation as it completes, so a measurement taken after
 * the last one finished reports a number that never existed while the work was
 * in flight. The peak is the whole question here.
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
