/* eslint-disable unicorn/no-process-exit -- CLI entry point: the exit code IS
   this tool's result contract, which is the case the rule excepts */
/**
 * The coverage ratchet, over the AGGREGATE.
 *
 * `bunfig.toml`'s `coverageThreshold` cannot do this job, and that is measured
 * rather than assumed. On Bun 1.4.0 it is applied PER FILE: a project whose
 * aggregate function coverage is 50% fails `{ functions = 0.3 }` because ONE
 * file in it sits at 0%. This repository has files that legitimately sit at 0%
 * for a given tier — `utils/images/rgba.ts` is covered by the unit tier and not
 * by the integration one — so no per-file number can express "the suite must not
 * collapse". Two more traps in the same option, both measured on 1.4.0 against a
 * two-file project at 33% and 50% of lines with 100% of functions: the SINGULAR
 * key spelling (`{ line, function }`) is silently IGNORED — `{ line = 0.99 }`
 * exits 0 — and the plural object form's verdict does not follow from the values
 * it is given, which is worse than either. `{ lines = 0 }` exits 1 on that
 * project; `{ lines = 0.1, functions = 0.1 }` exits 0 while
 * `{ lines = 0.1, statements = 0.1 }` exits 1. Do not reach for it on the
 * strength of a single passing spelling.
 *
 * So the gate reads `coverage/lcov.info`, which is a stable machine-readable
 * format rather than a reporter's prose, and compares the summed totals —
 * against the rates in `FLOORS` AND the denominators in `MINIMUMS`, because a
 * ratio alone moves the wrong way when a test file is deleted. Before this, CI
 * computed coverage on the integration step, printed it to the job log and
 * asserted nothing — which is worse than having no gate, because a reader who
 * sees `--coverage` in a workflow stops looking for one.
 *
 * Usage: `bun scripts/check-coverage.ts [path/to/lcov.info]`
 *
 * The report has to come from the tier the floors were measured on and from the
 * run that just finished; `coverage/provenance.json`, written by
 * `tests/helpers/run.ts`, is what says so.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { reportDigest } from '../tests/helpers/coverage';

/**
 * Floors, a few points under the measured rate so ordinary variation between
 * runs does not flap while a real collapse fails.
 *
 * Measured on the integration tier — from THIS gate's own numbers, over three
 * runs: 71.65%–80.70% of lines and 75.76%–82.92% of functions across 181 files,
 * 25.2k–25.7k lines and 1.6k–1.7k functions. They do not match the `text`
 * reporter's `All files` row on the same run: that row and these totals are
 * computed differently, and the summed lcov counters are what this file
 * asserts, so they are what the floors are set from. Do not copy a number out
 * of the job log into here.
 *
 * Set under the WORST of those runs, not the best. The tier does not load an
 * identical set of files every time under `--coverage` — the three runs
 * executed 525, 554 and 579 tests — so a floor set against a good run flaps.
 *
 * RAISE these as the rate rises; never lower one to make a red run green — that
 * is the move this file exists to make visible.
 */
const FLOORS = { lines: 0.66, functions: 0.72 } as const;

/**
 * Floors on the DENOMINATOR, and they are what make the ratios above mean
 * anything.
 *
 * lcov records only the files a tier actually LOADED, so deleting a test file
 * removes its subject modules from the report entirely — numerator and
 * denominator together — and the ratio goes UP. Measured against this script:
 * two files at 50% of lines fail the line floor, and deleting the test that
 * exercised the uncovered one leaves one file at 100% and passes. A gate whose
 * stated purpose is "the suite must not collapse" was rewarding the collapse.
 *
 * `files === 0` alone is no guard at all: a suite cut to a single test clears
 * it. These are the same measurement as the rates above, with the same margin —
 * a real deletion moves them by far more than run-to-run variation does.
 */
const MINIMUMS = {
  files: 150,
  linesFound: 22_000,
  functionsFound: 1400,
} as const;

const DEFAULT_REPORT = path.join('coverage', 'lcov.info');

/**
 * The tier whose loaded files `FLOORS` and `MINIMUMS` were measured against.
 *
 * lcov records neither a tier nor a time, so this gate has no way to tell one
 * report from another: it accepted a five-day-old file from a DIFFERENT tier,
 * containing files the thresholds here do not describe, and reported `coverage
 * ok`. CI happens to order the steps so the right report is on disk; a local
 * run, a reordered job or a cached `coverage/` directory does not.
 * `tests/helpers/run.ts` writes the sidecar this reads.
 */
const EXPECTED_TIER = 'integration';

/**
 * How old a report may be and still describe THIS run.
 *
 * Generous on purpose — the integration tier plus the process tier run between
 * the stamp and this gate — and still far short of the five days that went
 * unnoticed.
 */
const MAX_REPORT_AGE_MS = 60 * 60 * 1000;

interface Provenance {
  tier?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
  digest?: unknown;
}

/**
 * Refuses a report this gate cannot attribute to a just-finished run of the
 * tier the thresholds describe. Never returns on a refusal.
 */
function assertProvenance(report: string): void {
  const sidecar = path.resolve(path.dirname(report), 'provenance.json');
  const reject = (reason: string, detail?: Record<string, unknown>): never => {
    console.error(
      JSON.stringify({
        msg: 'coverage report cannot be attributed to this run',
        reason,
        expectedTier: EXPECTED_TIER,
        sidecar,
        hint: `run: bun run test:${EXPECTED_TIER} -- --coverage`,
        ...detail,
      })
    );
    process.exit(1);
  };

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- derived from argv of a developer/CI-invoked script, not from a request
  if (!existsSync(sidecar)) reject('no provenance sidecar beside the report');

  let stamp: Provenance;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- same
    stamp = JSON.parse(readFileSync(sidecar, 'utf8')) as Provenance;
  } catch {
    return reject('the provenance sidecar is not readable JSON');
  }

  if (stamp.tier !== EXPECTED_TIER)
    reject('the report was produced by a different tier', {
      reportedTier: stamp.tier,
    });

  const finished =
    typeof stamp.finishedAt === 'string' ? Date.parse(stamp.finishedAt) : NaN;
  if (!Number.isFinite(finished))
    reject('the provenance sidecar carries no finish time');
  const ageMs = Date.now() - finished;
  if (ageMs < 0 || ageMs > MAX_REPORT_AGE_MS)
    reject('the report is not from this run', {
      finishedAt: stamp.finishedAt,
      ageMinutes: Math.round(ageMs / 60_000),
      maxAgeMinutes: MAX_REPORT_AGE_MS / 60_000,
    });

  const started =
    typeof stamp.startedAt === 'string' ? Date.parse(stamp.startedAt) : NaN;
  if (!Number.isFinite(started))
    reject('the provenance sidecar carries no start time');
  // A stamp whose run finished before it began describes no run at all, so
  // nothing below it can be trusted to order anything.
  if (started > finished)
    reject('the provenance sidecar finishes before it starts', {
      startedAt: stamp.startedAt,
      finishedAt: stamp.finishedAt,
    });

  // The REPORT's own timestamp, not only the sidecar's. A run that produced no
  // lcov — the tier invoked without `--coverage`, or the reporter list edited —
  // leaves a fresh stamp beside a stale file, which is the same hole one layer
  // in: a single-file integration run stamps but does not rewrite the report.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- derived from argv of a developer/CI-invoked script, not from a request
  const writtenAt = statSync(report).mtimeMs;
  if (writtenAt < started)
    reject('the report predates the run that stamped it', {
      reportWrittenAt: new Date(writtenAt).toISOString(),
      runStartedAt: stamp.startedAt,
      hint: 'the tier ran without --coverage, or bunfig stopped declaring the lcov reporter',
    });

  // And the report's CONTENTS, which is the only thing a timestamp cannot fake.
  // A later `bun test --coverage`, or a restored `coverage/` directory, replaces
  // the report in place while the sidecar stays valid for its whole age window;
  // the counters then read from one run are attributed to another tier's floors.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- same
  const actual = reportDigest(readFileSync(report));
  if (stamp.digest !== actual)
    reject('the report is not the one the run stamped', {
      stampedDigest: stamp.digest,
      reportDigest: actual,
      hint: 'coverage/lcov.info was replaced after the tier stamped it; re-run the tier',
    });
}

interface Totals {
  linesFound: number;
  linesHit: number;
  functionsFound: number;
  functionsHit: number;
  files: number;
}

/** The lcov tags this gate sums, and the counter each one feeds. */
const COUNTERS: Readonly<Record<string, keyof Omit<Totals, 'files'>>> = {
  LF: 'linesFound',
  LH: 'linesHit',
  FNF: 'functionsFound',
  FNH: 'functionsHit',
};

/**
 * Sums the four counters lcov records per file.
 *
 * `LF`/`LH` are lines found/hit and `FNF`/`FNH` functions found/hit. Anything
 * else in the record — `DA:` per-line hit counts, branch data — is deliberately
 * ignored: the summed totals are the only quantity this gate makes a claim
 * about.
 */
function readTotals(file: string): Totals {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path from argv of a developer/CI-invoked script, not from a request
  const report = readFileSync(file, 'utf8');
  const totals: Totals = {
    linesFound: 0,
    linesHit: 0,
    functionsFound: 0,
    functionsHit: 0,
    files: 0,
  };

  for (const line of report.split('\n')) {
    const [tag, rawValue] = line.trim().split(':', 2);
    if (tag === 'SF') {
      totals.files += 1;
      continue;
    }
    const field = tag === undefined ? undefined : COUNTERS[tag];
    if (!field) continue;
    const value = Number(rawValue);
    if (Number.isFinite(value)) totals[field] += value;
  }

  return totals;
}

const target = path.resolve(process.argv[2] ?? DEFAULT_REPORT);

// eslint-disable-next-line security/detect-non-literal-fs-filename -- same
if (!existsSync(target)) {
  // A missing report is a FAILURE, not a skip: the whole point is that the gate
  // cannot silently stop measuring. It means the tier ran without `--coverage`,
  // or `bunfig.toml` stopped declaring the `lcov` reporter.
  console.error(
    JSON.stringify({
      msg: 'coverage report missing',
      expected: target,
      hint: 'run: bun run test:integration -- --coverage',
    })
  );
  process.exit(1);
}

assertProvenance(target);

const totals = readTotals(target);

if (totals.files === 0 || totals.linesFound === 0) {
  console.error(
    JSON.stringify({ msg: 'coverage report has no records', report: target })
  );
  process.exit(1);
}

const rates = {
  lines: totals.linesHit / totals.linesFound,
  functions:
    totals.functionsFound === 0
      ? 1
      : totals.functionsHit / totals.functionsFound,
};

const belowRate = Object.entries(FLOORS).filter(
  ([metric, floor]) => rates[metric as keyof typeof FLOORS] < floor
);

const belowMinimum = Object.entries(MINIMUMS).filter(
  ([metric, minimum]) => totals[metric as keyof typeof MINIMUMS] < minimum
);

const failed = [...belowRate, ...belowMinimum];

const asPercent = (value: number) => `${(value * 100).toFixed(2)}%`;

console.log(
  JSON.stringify({
    msg:
      failed.length === 0
        ? 'coverage ok'
        : belowMinimum.length > 0
          ? 'coverage report shrank: the tier is measuring less than it did'
          : 'coverage below the floor',
    files: totals.files,
    filesMinimum: MINIMUMS.files,
    lines: asPercent(rates.lines),
    linesFloor: asPercent(FLOORS.lines),
    linesFound: totals.linesFound,
    linesFoundMinimum: MINIMUMS.linesFound,
    functions: asPercent(rates.functions),
    functionsFloor: asPercent(FLOORS.functions),
    functionsFound: totals.functionsFound,
    functionsFoundMinimum: MINIMUMS.functionsFound,
  })
);

if (failed.length > 0) process.exit(1);
