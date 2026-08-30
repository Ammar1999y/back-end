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
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Floors, a few points under the measured rate so ordinary variation between
 * runs does not flap while a real collapse fails.
 *
 * Measured on the integration tier — from THIS gate's own numbers: 60.02% of
 * lines and 73.51% of functions across 115 files, 14,716 lines and 853
 * functions. They do not match the `text` reporter's `All files` row on the same
 * run: that row and these totals are computed differently, and the summed lcov
 * counters are what this file asserts, so they are what the floors are set from.
 * Do not copy a number out of the job log into here.
 *
 * RAISE these as the rate rises; never lower one to make a red run green — that
 * is the move this file exists to make visible.
 */
const FLOORS = { lines: 0.54, functions: 0.68 } as const;

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
 * `files === 0` was the only guard, and a suite cut to a single test still
 * clears it. These are the same measurement as the rates above, with the same
 * margin: a real deletion moves them by far more than run-to-run variation does.
 */
const MINIMUMS = {
  files: 100,
  linesFound: 13_000,
  functionsFound: 750,
} as const;

const DEFAULT_REPORT = path.join('coverage', 'lcov.info');

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
