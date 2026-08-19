// Latency statistics. Samples are nanoseconds as BigInt, converted to ms floats.

export function summarise(
  samplesNs,
  elapsedNs,
  errors,
  successfulOps = samplesNs.length
) {
  const n = samplesNs.length;
  const elapsedMs = Number(elapsedNs) / 1e6;
  if (n === 0) {
    return {
      ops: successfulOps,
      opsPerSec: 0,
      elapsedMs,
      p50: 0,
      p95: 0,
      p99: 0,
      max: 0,
      mean: 0,
      errors,
    };
  }
  const ms = new Float64Array(n);
  for (let i = 0; i < n; i++) ms[i] = Number(samplesNs[i]) / 1e6;
  ms.sort();
  const at = (q) => ms[Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1))];
  let sum = 0;
  for (let i = 0; i < n; i++) sum += ms[i];
  const elapsedSec = Number(elapsedNs) / 1e9;
  return {
    ops: successfulOps,
    opsPerSec: elapsedSec > 0 ? successfulOps / elapsedSec : 0,
    elapsedMs,
    mean: sum / n,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: ms[n - 1],
    errors,
  };
}

export function isBusyError(error) {
  const code = error && error.code;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT' || code === 5)
    return true;
  const message = String((error && error.message) || '');
  return (
    message.includes('SQLITE_BUSY') || message.includes('database is locked')
  );
}

export function fmt(value, digits = 3) {
  return Number.isFinite(value) ? value.toFixed(digits) : '-';
}

export function fmtOps(value) {
  return Math.round(value).toLocaleString('en-US');
}
