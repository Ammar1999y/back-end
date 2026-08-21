// Shared numeric helpers. Same median/format shape as bench/uuid's stats.mjs —
// duplicated rather than imported across benchmark directories because each
// bench/* directory is self-contained by convention (bench/sqlite does the
// same), and a cross-bench import would make one benchmark's refactor break
// another's numbers.

export function median(values) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function fmtMs(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : '-';
}

export function fmtInt(value) {
  return Number.isFinite(value)
    ? Math.round(value).toLocaleString('en-US')
    : '-';
}

export function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function fmtDb(value) {
  if (value === Infinity) return 'identical';
  return Number.isFinite(value) ? `${value.toFixed(2)} dB` : '-';
}

export function fmtRatio(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return '-';
  return `${(a / b).toFixed(2)}x`;
}
