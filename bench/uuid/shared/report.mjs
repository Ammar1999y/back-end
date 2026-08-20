// Console tables and JSON persistence. Same shape as bench/sqlite's
// shared/report.mjs (fixed-width padded columns, one header block, one
// saveJson per run); columns are adapted to ops/sec + ns/op + repeat spread
// since there are no per-op latency percentiles here (see shared/runner.mjs).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { fmtNs, fmtOps } from './stats.mjs';

function pad(text, width, align = 'right') {
  const value = String(text);
  if (value.length >= width) return value.slice(0, width);
  return align === 'left' ? value.padEnd(width) : value.padStart(width);
}

const THROUGHPUT_COLUMNS = [
  { key: 'generator', label: 'implementation', width: 18, align: 'left' },
  {
    key: 'opsPerSecMedian',
    label: 'ops/sec (median)',
    width: 17,
    render: (r) => fmtOps(r.opsPerSecMedian),
  },
  {
    key: 'opsPerSecMin',
    label: 'min',
    width: 12,
    render: (r) => fmtOps(r.opsPerSecMin),
  },
  {
    key: 'opsPerSecMax',
    label: 'max',
    width: 12,
    render: (r) => fmtOps(r.opsPerSecMax),
  },
  {
    key: 'nsPerOpMedian',
    label: 'ns/op (median)',
    width: 15,
    render: (r) => fmtNs(r.nsPerOpMedian),
  },
  {
    key: 'nsPerOpMin',
    label: 'ns/op min',
    width: 10,
    render: (r) => fmtNs(r.nsPerOpMin),
  },
  {
    key: 'nsPerOpMax',
    label: 'ns/op max',
    width: 10,
    render: (r) => fmtNs(r.nsPerOpMax),
  },
  { key: 'runs', label: 'runs', width: 5, render: (r) => String(r.runs) },
  {
    key: 'iterations',
    label: 'iterations',
    width: 11,
    render: (r) => fmtOps(r.iterations),
  },
];

export function printThroughputTable(rows, title) {
  if (title) console.log(`\n${title}`);
  const header = THROUGHPUT_COLUMNS.map((c) =>
    pad(c.label, c.width, c.align)
  ).join('  ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const row of rows) {
    console.log(
      THROUGHPUT_COLUMNS.map((c) =>
        pad(c.render ? c.render(row) : row[c.key], c.width, c.align)
      ).join('  ')
    );
  }
}

/**
 * "Share of a realistic operation": the id call's ns/op as a percentage of a
 * whole row-build-and-serialize operation's ns/op — what fraction of realistic
 * per-row work the generator itself accounts for, rather than the isolated-call
 * difference. The min–max column is the spread of the per-repeat ratios, and it
 * is printed rather than hidden because it is the only honest indicator of how
 * much of the headline is measurement noise (see run.mjs `runPerfScenarios`).
 */
export function printShareTable(shareRows) {
  console.log('\n### id-generation share of a realistic per-row operation');
  const columns = [
    { label: 'implementation', width: 18, align: 'left' },
    { label: 'tight-loop ns/op', width: 17 },
    { label: 'interleaved ns/op', width: 18 },
    { label: 'share (median)', width: 15 },
    { label: 'share min-max', width: 16 },
  ];
  const header = columns.map((c) => pad(c.label, c.width, c.align)).join('  ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const row of shareRows) {
    console.log(
      [
        pad(row.generator, columns[0].width, 'left'),
        pad(fmtNs(row.tightNsPerOpMedian), columns[1].width),
        pad(fmtNs(row.interleavedNsPerOpMedian), columns[2].width),
        pad(`${row.sharePctMedian.toFixed(1)}%`, columns[3].width),
        pad(
          `${row.sharePctMin.toFixed(1)}-${row.sharePctMax.toFixed(1)}%`,
          columns[4].width
        ),
      ].join('  ')
    );
  }
}

/**
 * Timestamp-fidelity table. Every column is a measurement rather than a
 * verdict — the one pass/fail the scenario owns ("never behind the wall clock")
 * is a check and prints with the others; see shared/checks.mjs for why the two
 * drift directions are not treated alike.
 */
export function printClockTable(summaries) {
  console.log('\n### embedded timestamp vs the wall clock');
  const columns = [
    { label: 'implementation', width: 18, align: 'left' },
    { label: 'ids/phase', width: 11, render: (s) => fmtOps(s.size) },
    {
      label: 'max ms behind',
      width: 14,
      render: (s) => String(Math.max(s.pairedMaxBehindMs, s.burstMaxBehindMs)),
    },
    {
      label: 'paired ms ahead',
      width: 16,
      render: (s) => String(s.pairedMaxAheadMs),
    },
    {
      label: 'burst ms borrowed',
      width: 18,
      render: (s) => `${s.burstBorrowedMs} (peak ${s.burstMaxAheadMs})`,
    },
    {
      label: 'ms ahead after idle',
      width: 20,
      render: (s) => `${s.settledDriftMs} (${s.settleMs} ms)`,
    },
  ];
  const header = columns.map((c) => pad(c.label, c.width, c.align)).join('  ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const summary of summaries) {
    console.log(
      columns
        .map((c) =>
          pad(
            c.render ? c.render(summary) : summary.generator,
            c.width,
            c.align
          )
        )
        .join('  ')
    );
  }
}

export function printChecks(title, results) {
  console.log(`\n### ${title}`);
  let failedCritical = 0;
  for (const r of results) {
    // A passing non-critical entry carries no verdict — it is a measurement
    // printed in check shape — so it says INFO rather than PASS.
    const status = r.pass
      ? r.critical
        ? 'PASS'
        : 'INFO'
      : r.critical
        ? 'FAIL (CRITICAL)'
        : 'FAIL';
    if (!r.pass && r.critical) failedCritical++;
    console.log(`${status.padEnd(16)} ${r.name.padEnd(58)} ${r.detail}`);
  }
  return failedCritical;
}

export function printHeader(meta) {
  console.log('='.repeat(96));
  console.log(`runtime         : ${meta.runtime} ${meta.runtimeVersion}`);
  console.log(
    `platform        : ${meta.platform} ${meta.arch}  cpus=${meta.cpus}`
  );
  console.log(`uuid package    : ${meta.uuidPackageVersion}`);
  console.log(`harness         : v${meta.harnessVersion}`);
  console.log(`mode            : ${meta.mode}`);
  console.log(`timestamp       : ${meta.timestamp}`);
  console.log('='.repeat(96));
}

export function saveJson(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`\nresults written: ${path}`);
}
