// Merges two result files into a side-by-side table.
//   node compare.mjs results/bun-sqlite-suite-baseline.json results/better-sqlite3-suite-baseline.json
// Runs identically under `bun compare.mjs ...`.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

function load(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed.meta || !Array.isArray(parsed.rows))
    throw new Error(`${path} is not a suite result file`);
  return {
    path,
    meta: parsed.meta,
    byName: new Map(parsed.rows.map((r) => [r.name, r])),
  };
}

function pad(text, width, left = false) {
  const value = String(text);
  if (value.length >= width) return value.slice(0, width);
  return left ? value.padEnd(width) : value.padStart(width);
}

function ratioLabel(a, b) {
  if (!a || !b) return '-';
  if (a >= b) return `A ${(a / b).toFixed(2)}x`;
  return `B ${(b / a).toFixed(2)}x`;
}

const args = process.argv.slice(2);
const resultsDir = resolve(import.meta.dirname ?? '.', 'results');

let [pathA, pathB] = args;
if (!pathA || !pathB) {
  const files = readdirSync(resultsDir)
    .filter(
      (file) =>
        file.endsWith('.json') &&
        file.includes('-suite-') &&
        !file.includes('-only-')
    )
    .sort(
      (left, right) =>
        statSync(join(resultsDir, right)).mtimeMs -
        statSync(join(resultsDir, left)).mtimeMs
    );
  pathA = join(
    resultsDir,
    files.find((f) => f.startsWith('bun-sqlite-suite')) ?? ''
  );
  pathB = join(
    resultsDir,
    files.find((f) => f.startsWith('better-sqlite3-suite')) ?? ''
  );
}

if (!pathA || !pathB || pathA === resultsDir || pathB === resultsDir)
  throw new Error('could not find one full suite result for each driver');

const a = load(pathA);
const b = load(pathB);

const comparableFields = [
  'harnessVersion',
  'platform',
  'arch',
  'cpus',
  'profile',
  'tier',
];
const mismatches = comparableFields.filter(
  (key) =>
    a.meta[key] !== undefined &&
    b.meta[key] !== undefined &&
    a.meta[key] !== b.meta[key]
);
if (mismatches.length > 0)
  throw new Error(
    `results are not comparable; metadata differs: ${mismatches
      .map((key) => `${key} (${a.meta[key]} vs ${b.meta[key]})`)
      .join(', ')}`
  );
if (!a.meta.harnessVersion || !b.meta.harnessVersion)
  console.warn(
    'WARNING: legacy result lacks harnessVersion; verify both files came from the same harness revision.\n'
  );

console.log(
  `A = ${a.meta.driver} ${a.meta.driverVersion} on ${a.meta.runtime} ${a.meta.runtimeVersion} (sqlite ${a.meta.sqliteVersion})`
);
console.log(
  `B = ${b.meta.driver} ${b.meta.driverVersion} on ${b.meta.runtime} ${b.meta.runtimeVersion} (sqlite ${b.meta.sqliteVersion})`
);
console.log(
  `platform: ${a.meta.platform} ${a.meta.arch}, cpus=${a.meta.cpus}, profile=${a.meta.profile}\n`
);

const header =
  `${pad('workload', 34, true)}  ${pad('A ops/s', 11)}  ${pad('B ops/s', 11)}  ${pad('faster', 10)}  ` +
  `${pad('A p50', 8)}  ${pad('B p50', 8)}  ${pad('A p99', 8)}  ${pad('B p99', 8)}  ${pad('A max', 9)}  ${pad('B max', 9)}`;
console.log(header);
console.log('-'.repeat(header.length));

const names = [...new Set([...a.byName.keys(), ...b.byName.keys()])];
for (const name of names) {
  const ra = a.byName.get(name);
  const rb = b.byName.get(name);
  if (!ra || !rb) {
    console.warn(`skipping ${name}: missing from ${ra ? 'B' : 'A'}`);
    continue;
  }
  console.log(
    `${pad(name, 34, true)}  ${pad(Math.round(ra.opsPerSec).toLocaleString('en-US'), 11)}  ` +
      `${pad(Math.round(rb.opsPerSec).toLocaleString('en-US'), 11)}  ${pad(ratioLabel(ra.opsPerSec, rb.opsPerSec), 10)}  ` +
      `${pad(ra.p50.toFixed(3), 8)}  ${pad(rb.p50.toFixed(3), 8)}  ${pad(ra.p99.toFixed(3), 8)}  ${pad(rb.p99.toFixed(3), 8)}  ` +
      `${pad(ra.max.toFixed(1), 9)}  ${pad(rb.max.toFixed(1), 9)}`
  );
}

console.log(
  `\nA = ${a.meta.driver}, B = ${b.meta.driver}. "faster" names the winner on throughput.\n` +
    `Compare p50 and max together: a driver can win the median and lose badly on the tail.`
);
