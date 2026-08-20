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

import {
  runClockChecks,
  runFormatChecks,
  runMonotonicityChecks,
} from './shared/checks.mjs';
import { GENERATORS } from './shared/generators.mjs';
import {
  printChecks,
  printClockTable,
  printHeader,
  printShareTable,
  printThroughputTable,
  saveJson,
} from './shared/report.mjs';
import { runInterleaved, runThroughput } from './shared/runner.mjs';
import { aggregateRuns, fmtOps, median } from './shared/stats.mjs';

// v2 added the `clock` scenario and per-millisecond bucket-capacity reporting,
// both of which exist because Bun 1.4.0 changed how counter exhaustion is
// handled (see shared/checks.mjs `runClockChecks`). Results written by v1 do not
// contain those fields.
const HARNESS_VERSION = 2;
const MODES = [
  'all',
  'throughput',
  'interleaved',
  'format',
  'monotonicity',
  'clock',
];
const NUMERIC_FLAGS = [
  'iterations',
  'repeat',
  'burst',
  'formatSample',
  'clockSample',
];

function parseArgs(argv) {
  const args = {
    mode: 'all',
    iterations: 1_000_000,
    // 9, not 5: measured spread between repeats on this machine is 20–30%, and
    // a 5-sample median moved by more than the difference the run is meant to
    // report.
    repeat: 9,
    burst: 500_000,
    formatSample: 50_000,
    clockSample: 3_000_000,
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

const PERF_SCENARIOS = [
  {
    key: 'throughput',
    label: 'throughput ',
    title: '### throughput — tight loop',
    banner: (args) =>
      `throughput (tight loop): ${args.iterations.toLocaleString('en-US')} iterations x ${args.repeat} repeats per implementation`,
    run: runThroughput,
  },
  {
    key: 'interleaved',
    label: 'interleaved',
    title: '### interleaved — realistic per-row work',
    banner: (args) =>
      `interleaved (build row + JSON.stringify): ${args.iterations.toLocaleString('en-US')} iterations x ${args.repeat} repeats per implementation`,
    run: runInterleaved,
  },
];

/**
 * Every timed measurement in one interleaved pass: repeat is the outer loop,
 * then scenario, then implementation — tight(uuid), tight(bun), row(uuid),
 * row(bun), and around again.
 *
 * This is not cosmetic. On this machine the same scenario varies by 20–30%
 * between repeats (thermal, background load). Running one implementation's
 * repeats consecutively puts that drift entirely on whichever side went first,
 * and running one scenario to completion before the other does the same to the
 * tight-loop-vs-row ratio — a bias no number of repeats removes, because it is
 * systematic rather than noise. It was visible: consecutive ordering produced a
 * "share of a realistic operation" of 86% for `uuid.v7` in one run and 58% in
 * the next, from a quantity that cannot really move that far.
 *
 * The share is therefore computed per repeat, from the two measurements taken
 * next to each other in that repeat, and only then reduced to a median.
 */
function runPerfScenarios(scenarios, args) {
  const samples = new Map(
    scenarios.map((s) => [s.key, new Map(GENERATORS.map((g) => [g.name, []]))])
  );

  for (const scenario of scenarios) console.log(`\n${scenario.banner(args)}`);

  for (let r = 0; r < args.repeat; r++) {
    for (const scenario of scenarios) {
      for (const generator of GENERATORS) {
        process.stdout.write(
          `  ${scenario.label}  ${generator.name.padEnd(20)} [${r + 1}/${args.repeat}] ... `
        );
        const result = scenario.run(generator.generate, args.iterations);
        console.log(`${fmtOps(result.opsPerSec)} ops/sec`);
        samples.get(scenario.key).get(generator.name).push(result);
      }
    }
  }

  const rows = {};
  for (const scenario of scenarios) {
    rows[scenario.key] = GENERATORS.map((generator) => ({
      generator: generator.name,
      ...aggregateRuns(samples.get(scenario.key).get(generator.name)),
    }));
  }

  const throughput = samples.get('throughput');
  const interleaved = samples.get('interleaved');
  const share =
    throughput && interleaved
      ? GENERATORS.map((generator) => {
          const tight = throughput.get(generator.name);
          const row = interleaved.get(generator.name);
          const ratios = tight.map(
            (t, i) => (t.nsPerOp / row[i].nsPerOp) * 100
          );
          return {
            generator: generator.name,
            tightNsPerOpMedian: median(tight.map((t) => t.nsPerOp)),
            interleavedNsPerOpMedian: median(row.map((t) => t.nsPerOp)),
            sharePctMedian: median(ratios),
            sharePctMin: Math.min(...ratios),
            sharePctMax: Math.max(...ratios),
          };
        })
      : null;

  return { rows, share };
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
      medianBucketOverall: outcome.medianBucketOverall,
      minBucketOverall: outcome.minBucketOverall,
      trials: outcome.trials,
    });
  }
  return { results, summaries };
}

async function runClockScenario(args) {
  let results = [];
  const summaries = [];
  for (const generator of GENERATORS) {
    process.stdout.write(
      `  clock         ${generator.name.padEnd(20)} ${args.clockSample.toLocaleString('en-US')} ids ... `
    );
    const outcome = await runClockChecks(
      generator.name,
      generator.generate,
      args.clockSample
    );
    console.log(
      `burst peak ${outcome.summary.burstMaxAheadMs} ms ahead, ${Math.max(outcome.summary.pairedMaxBehindMs, outcome.summary.burstMaxBehindMs)} ms behind`
    );
    results = results.concat(outcome.results);
    summaries.push(outcome.summary);
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
    clockSample: args.clockSample,
    timestamp: new Date().toISOString(),
  };
  printHeader(header);

  const payload = { meta: header };
  let failedCritical = 0;

  const perfScenarios = PERF_SCENARIOS.filter(
    (s) => args.mode === 'all' || args.mode === s.key
  );
  if (perfScenarios.length > 0) {
    const { rows, share } = runPerfScenarios(perfScenarios, args);
    for (const scenario of perfScenarios) {
      payload[scenario.key] = rows[scenario.key];
      printThroughputTable(rows[scenario.key], scenario.title);
    }
    if (share) {
      payload.share = share;
      printShareTable(share);
    }
  }

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

  if (args.mode === 'all' || args.mode === 'clock') {
    console.log(
      `\nclock fidelity: ${args.clockSample.toLocaleString('en-US')} ids per implementation`
    );
    const { results, summaries } = await runClockScenario(args);
    payload.clock = { results, summaries };
    printClockTable(summaries);
    failedCritical += printChecks(
      'embedded timestamp vs the wall clock',
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
