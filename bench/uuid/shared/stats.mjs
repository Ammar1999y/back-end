// Throughput statistics for pure CPU-bound generation calls, and median/min/max
// aggregation across repeated runs. Mirrors the shape of bench/sqlite's
// shared/stats.mjs (ops/sec, fmt helpers) and the repeat-aggregation approach
// in bench/sqlite's shared/main.mjs (median headline, min/max spread), adapted
// because a UUID generation call is nanoseconds, not milliseconds: there is no
// per-op percentile worth reporting (see shared/runner.mjs for why timing is
// whole-batch, not per-call).

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function summariseBatch(iterations, elapsedNs) {
  const elapsedSec = Number(elapsedNs) / 1e9;
  return {
    iterations,
    elapsedMs: Number(elapsedNs) / 1e6,
    opsPerSec: elapsedSec > 0 ? iterations / elapsedSec : 0,
    nsPerOp: iterations > 0 ? Number(elapsedNs) / iterations : 0,
  };
}

/** Aggregates independent repeats of the same scenario+implementation. */
export function aggregateRuns(runs) {
  const opsPerSecSamples = runs.map((r) => r.opsPerSec);
  const nsPerOpSamples = runs.map((r) => r.nsPerOp);
  return {
    iterations: runs[0].iterations,
    runs: runs.length,
    opsPerSecMedian: median(opsPerSecSamples),
    opsPerSecMin: Math.min(...opsPerSecSamples),
    opsPerSecMax: Math.max(...opsPerSecSamples),
    nsPerOpMedian: median(nsPerOpSamples),
    nsPerOpMin: Math.min(...nsPerOpSamples),
    nsPerOpMax: Math.max(...nsPerOpSamples),
    opsPerSecSamples,
    nsPerOpSamples,
  };
}

export function fmtOps(value) {
  return Math.round(value).toLocaleString('en-US');
}

export function fmtNs(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : '-';
}
