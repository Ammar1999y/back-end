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

/** implementation-name -> aggregated row, for the share-of-realistic-op table. */
function byGenerator(rows) {
  return new Map(rows.map((r) => [r.generator, r]));
}

/**
 * "Share of a realistic operation": tight-loop ns/op as a percentage of
 * interleaved ns/op, per implementation. Answers what fraction of a row-insert
 * shaped operation the id call itself accounts for, rather than only the
 * isolated-call difference.
 */
export function printShareTable(throughputRows, interleavedRows) {
  const throughputByGen = byGenerator(throughputRows);
  const interleavedByGen = byGenerator(interleavedRows);
  console.log('\n### id-generation share of a realistic per-row operation');
  const columns = [
    { label: 'implementation', width: 18, align: 'left' },
    { label: 'tight-loop ns/op', width: 17 },
    { label: 'interleaved ns/op', width: 18 },
    { label: 'share of realistic op', width: 22 },
  ];
  const header = columns.map((c) => pad(c.label, c.width, c.align)).join('  ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const [name, throughput] of throughputByGen) {
    const interleaved = interleavedByGen.get(name);
    if (!interleaved) continue;
    const share = (throughput.nsPerOpMedian / interleaved.nsPerOpMedian) * 100;
    const cells = [
      pad(name, columns[0].width, 'left'),
      pad(fmtNs(throughput.nsPerOpMedian), columns[1].width),
      pad(fmtNs(interleaved.nsPerOpMedian), columns[2].width),
      pad(`${share.toFixed(1)}%`, columns[3].width),
    ];
    console.log(cells.join('  '));
  }
}

export function printChecks(title, results) {
  console.log(`\n### ${title}`);
  let failedCritical = 0;
  for (const r of results) {
    const status = r.pass ? 'PASS' : r.critical ? 'FAIL (CRITICAL)' : 'FAIL';
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
