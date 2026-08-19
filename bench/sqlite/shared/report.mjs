// Console tables and JSON persistence.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { fmt, fmtOps } from './stats.mjs';

const COLUMNS = [
  { key: 'name', label: 'workload', width: 34, align: 'left' },
  {
    key: 'opsPerSec',
    label: 'ops/sec',
    width: 12,
    render: (r) => fmtOps(r.opsPerSec),
  },
  { key: 'mean', label: 'mean ms', width: 9, render: (r) => fmt(r.mean) },
  { key: 'p50', label: 'p50', width: 8, render: (r) => fmt(r.p50) },
  { key: 'p95', label: 'p95', width: 8, render: (r) => fmt(r.p95) },
  { key: 'p99', label: 'p99', width: 8, render: (r) => fmt(r.p99) },
  { key: 'max', label: 'max', width: 9, render: (r) => fmt(r.max, 2) },
  { key: 'busy', label: 'BUSY', width: 6, render: (r) => String(r.busy ?? 0) },
  {
    key: 'errors',
    label: 'errors',
    width: 6,
    render: (r) => String(r.errors ?? 0),
  },
  {
    key: 'spreadPct',
    label: 'spread%',
    width: 8,
    render: (r) => (r.runs > 1 ? fmt(r.spreadPct, 1) : '-'),
  },
  {
    key: 'status',
    label: 'status',
    width: 13,
    align: 'left',
    render: (r) => {
      const values = [];
      if (r.unsafe) values.push('UNSAFE');
      if (r.runs > 1 && (r.spreadPct > 25 || (r.p50SpreadPct ?? 0) > 25))
        values.push('NOISY');
      return values.join(',');
    },
  },
];

function pad(text, width, align) {
  const value = String(text);
  if (value.length >= width) return value.slice(0, width);
  return align === 'left' ? value.padEnd(width) : value.padStart(width);
}

export function printTable(rows, title) {
  if (title) console.log(`\n${title}`);
  const header = COLUMNS.map((c) => pad(c.label, c.width, c.align)).join('  ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const row of rows) {
    console.log(
      COLUMNS.map((c) =>
        pad(c.render ? c.render(row) : row[c.key], c.width, c.align)
      ).join('  ')
    );
  }
  for (const row of rows) {
    if (row.note) console.log(`  ${row.name}: ${row.note}`);
  }
}

export function printGrouped(rows) {
  const groups = new Map();
  for (const row of rows) {
    const group = row.group ?? 'other';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(row);
  }
  for (const [group, groupRows] of groups)
    printTable(groupRows, `### ${group}`);
}

export function saveJson(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`\nresults written: ${path}`);
}

export function printHeader(meta) {
  console.log('='.repeat(96));
  console.log(`driver          : ${meta.driver} ${meta.driverVersion}`);
  console.log(`runtime         : ${meta.runtime} ${meta.runtimeVersion}`);
  console.log(`sqlite          : ${meta.sqliteVersion}`);
  console.log(
    `platform        : ${meta.platform} ${meta.arch}  cpus=${meta.cpus}`
  );
  console.log(`pragma profile  : ${meta.profile}`);
  console.log(`harness        : v${meta.harnessVersion}`);
  if (meta.effectivePragmas) {
    console.log(`effective       : ${JSON.stringify(meta.effectivePragmas)}`);
  }
  console.log('='.repeat(96));
}
