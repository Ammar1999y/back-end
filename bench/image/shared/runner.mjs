// Measurement loops. Unlike bench/uuid, where one call is nanoseconds and the
// whole batch has to be timed at once, an image pipeline is milliseconds to
// seconds — so every call is timed individually and reduced to median/min/max,
// the same shape bench/sqlite uses.
//
// Two things are sampled alongside wall time because for this application they
// decide the question as much as speed does:
//
// - **Event-loop delay.** Both libraries claim to work off the JavaScript
//   thread. If either does not, an upload does not just take longer — it stalls
//   every other request in the process, and this deployment runs ONE process
//   (`reusePort: false`, see the runbook). A number here is the difference
//   between "slow endpoint" and "slow server".
// - **Resident memory.** `MAX_IMAGE_PIXELS` is 25 MP, which is ~100 MB of RGBA
//   per concurrent decode. The VPS is small and `sharp`/libvips keeps its own
//   caches, so peak RSS is a capacity question, not a curiosity.

import { median } from './stats.mjs';

const LAG_SAMPLE_INTERVAL_MS = 5;

/**
 * Samples how late a fixed-interval timer actually fires. Anything the JS
 * thread does synchronously shows up here as a spike.
 */
export function startLagSampler(intervalMs = LAG_SAMPLE_INTERVAL_MS) {
  const samples = [];
  let previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    samples.push(Math.max(0, now - previous - intervalMs));
    previous = now;
  }, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      return {
        count: samples.length,
        maxMs: samples.length ? Math.max(...samples) : 0,
        medianMs: samples.length ? median(samples) : 0,
      };
    },
  };
}

/** Peak RSS observed while `fn` runs, sampled on the same cadence as lag. */
export async function withPeakRss(fn) {
  const before = process.memoryUsage.rss();
  let peak = before;
  const timer = setInterval(() => {
    const rss = process.memoryUsage.rss();
    if (rss > peak) peak = rss;
  }, LAG_SAMPLE_INTERVAL_MS);
  try {
    const value = await fn();
    return { value, rssBefore: before, rssPeak: peak, rssDelta: peak - before };
  } finally {
    clearInterval(timer);
  }
}

/**
 * Runs `fn` `repeat` times, discarding the first run's timing as warm-up when
 * more than one repeat is asked for — the first call through either library
 * pays one-time costs (thread pool spin-up, codec tables) that are real but not
 * per-image.
 */
export async function timeRepeats(fn, repeat) {
  const durations = [];
  let last;
  for (let r = 0; r < repeat; r++) {
    const started = Bun.nanoseconds();
    last = await fn();
    const elapsedMs = (Bun.nanoseconds() - started) / 1e6;
    if (repeat === 1 || r > 0) durations.push(elapsedMs);
  }
  return {
    result: last,
    runs: durations.length,
    msMedian: median(durations),
    msMin: Math.min(...durations),
    msMax: Math.max(...durations),
    samples: durations,
  };
}

/**
 * `concurrency` copies of `fn` in flight at once, which is how the route is
 * actually reached: `MAX_FILES_PER_REQUEST` is 1, so parallelism comes from
 * separate requests, not from a batch inside one.
 */
export async function timeConcurrent(fn, concurrency) {
  const lag = startLagSampler();
  const started = Bun.nanoseconds();
  const settled = await Promise.allSettled(
    Array.from({ length: concurrency }, (_, i) => fn(i))
  );
  const wallMs = (Bun.nanoseconds() - started) / 1e6;
  return {
    wallMs,
    perImageMs: wallMs / concurrency,
    failures: settled.filter((s) => s.status === 'rejected').length,
    firstError: settled.find((s) => s.status === 'rejected')?.reason,
    lag: lag.stop(),
  };
}
