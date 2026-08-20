// Entry point. `bun run.mjs [--flags]` from this directory (or
// `bun bench/uuid/run.mjs` from the repo root).
//
// Requires the Bun runtime: one of the two implementations under test is
// `Bun.randomUUIDv7`, which does not exist under Node, so unlike bench/sqlite
// there is no second per-runtime folder to run this from.
//
// See README.md for flags, sample output, and the numbers from the last
// recorded run.

import { arch, cpus, platform } from 'node:os';
import { resolve } from 'node:path';

import { runFormatChecks, runMonotonicityChecks } from './shared/checks.mjs';
import { GENERATORS } from './shared/generators.mjs';
import {
  printChecks,
  printHeader,
  printShareTable,
  printThroughputTable,
  saveJson,
} from './shared/report.mjs';
import { runInterleaved, runThroughput } from './shared/runner.mjs';
import { aggregateRuns, fmtOps } from './shared/stats.mjs';

const HARNESS_VERSION = 1;
const MODES = ['all', 'throughput', 'interleaved', 'format', 'monotonicity'];
const NUMERIC_FLAGS = ['iterations', 'repeat', 'burst', 'formatSample'];

function parseArgs(argv) {
  const args = {
    mode: 'all',
    iterations: 1_000_000,
    repeat: 5,
    burst: 500_000,
    formatSample: 50_000,
  };
  for (const raw of argv.slice(2)) {
    const [key, value] = raw.replace(/^--/, '').split('=');
    if (value === undefined) continue;
    args[key] = NUMERIC_FLAGS.includes(key) ? Number(value) : value;
  }
  return args;
}

function validateArgs(args) {
  if (!MODES.includes(args.mode))
    throw new Error(
      `unknown mode: ${args.mode} (expected ${MODES.join(' | ')})`
    );
  for (const key of NUMERIC_FLAGS) {
    if (!Number.isInteger(args[key]) || args[key] <= 0)
      throw new Error(`--${key} must be a positive integer`);
  }
}

function runRepeatedScenario(scenarioName, runOnce, args) {
  const rows = [];
  for (const generator of GENERATORS) {
    const runs = [];
    for (let r = 0; r < args.repeat; r++) {
      process.stdout.write(
        `  ${scenarioName}  ${generator.name.padEnd(20)} [${r + 1}/${args.repeat}] ... `
      );
      const result = runOnce(generator.generate, args.iterations);
      console.log(`${fmtOps(result.opsPerSec)} ops/sec`);
      runs.push(result);
    }
    rows.push({ generator: generator.name, ...aggregateRuns(runs) });
  }
  return rows;
}

function runFormatScenario(args) {
  return GENERATORS.flatMap((generator) =>
    runFormatChecks(generator.name, generator.generate, args.formatSample)
  );
}

function runMonotonicityScenario(args) {
  let results = [];
  const summaries = [];
  for (const generator of GENERATORS) {
    process.stdout.write(
      `  monotonicity  ${generator.name.padEnd(20)} ${args.repeat} burst(s) of ${args.burst.toLocaleString('en-US')} ... `
    );
    const outcome = runMonotonicityChecks(
      generator.name,
      generator.generate,
      args.burst,
      args.repeat
    );
    console.log(
      `largest bucket ${outcome.maxBucketOverall.toLocaleString('en-US')} ids`
    );
    results = results.concat(outcome.results);
    summaries.push({
      generator: generator.name,
      maxBucketOverall: outcome.maxBucketOverall,
      trials: outcome.trials,
    });
  }
  return { results, summaries };
}

async function main() {
  const args = parseArgs(process.argv);
  validateArgs(args);

  const uuidPackageVersion = GENERATORS.find(
    (g) => g.slug === 'uuid-pkg'
  ).version;
  const header = {
    harnessVersion: HARNESS_VERSION,
    runtime: 'bun',
    runtimeVersion: `${Bun.version} (${Bun.revision.slice(0, 9)})`,
    platform: platform(),
    arch: arch(),
    cpus: cpus().length,
    uuidPackageVersion,
    mode: args.mode,
    iterations: args.iterations,
    repeat: args.repeat,
    burst: args.burst,
    formatSample: args.formatSample,
    timestamp: new Date().toISOString(),
  };
  printHeader(header);

  const payload = { meta: header };
  let failedCritical = 0;

  if (args.mode === 'all' || args.mode === 'throughput') {
    console.log(
      `\nthroughput (tight loop): ${args.iterations.toLocaleString('en-US')} iterations x ${args.repeat} repeats per implementation`
    );
    payload.throughput = runRepeatedScenario(
      'throughput ',
      runThroughput,
      args
    );
    printThroughputTable(payload.throughput, '### throughput — tight loop');
  }

  if (args.mode === 'all' || args.mode === 'interleaved') {
    console.log(
      `\ninterleaved (build row + JSON.stringify): ${args.iterations.toLocaleString('en-US')} iterations x ${args.repeat} repeats per implementation`
    );
    payload.interleaved = runRepeatedScenario(
      'interleaved',
      runInterleaved,
      args
    );
    printThroughputTable(
      payload.interleaved,
      '### interleaved — realistic per-row work'
    );
  }

  if (payload.throughput && payload.interleaved)
    printShareTable(payload.throughput, payload.interleaved);

  if (args.mode === 'all' || args.mode === 'format') {
    console.log(
      `\nformat compatibility: ${args.formatSample.toLocaleString('en-US')} samples per implementation`
    );
    payload.format = runFormatScenario(args);
    failedCritical += printChecks('format compatibility', payload.format);
  }

  if (args.mode === 'all' || args.mode === 'monotonicity') {
    console.log(
      `\nmonotonicity: ${args.burst.toLocaleString('en-US')} ids/burst x ${args.repeat} burst(s) per implementation`
    );
    const { results, summaries } = runMonotonicityScenario(args);
    payload.monotonicity = { results, summaries };
    failedCritical += printChecks(
      'monotonicity within one millisecond',
      results
    );
  }

  saveJson(
    resolve(import.meta.dirname ?? '.', 'results', 'latest.json'),
    payload
  );

  if (failedCritical > 0) {
    console.log(`\n${failedCritical} CRITICAL check(s) FAILED.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll critical checks passed.');
  }
}

await main();
