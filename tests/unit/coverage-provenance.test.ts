/**
 * The coverage gate and the runner that stamps it, tested TOGETHER.
 *
 * Neither script is wrong on its own, which is why this file exists. The failure
 * was in their interaction: `stampCoverageProvenance` ran in the `finally` of
 * every tier and claimed `coverage/lcov.info` whenever the file existed, so CI's
 * order — integration `--coverage`, process, matrix, gate — left the sidecar
 * reading `tier: "matrix"` beside a report the integration tier had produced,
 * and `scripts/check-coverage.ts` refused it with "the report was produced by a
 * different tier". Every run of the job failed at the last step.
 *
 * Driven against a TEMPORARY coverage directory, never the repository's own:
 * these cases have to write a sidecar and a report, and doing that in
 * `coverage/` would destroy the state of whatever run produced it.
 *
 * Local: no database, no network, no port.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CoverageProvenance } from '../helpers/coverage';

import {
  coverageRequested,
  stampCoverageProvenance,
} from '../helpers/coverage';

const REPO_ROOT = path.join(import.meta.dir, '..', '..');
const GATE = path.join(REPO_ROOT, 'scripts', 'check-coverage.ts');

/**
 * An lcov report that clears every floor in `scripts/check-coverage.ts` —
 * `MINIMUMS.files` 150, `linesFound` 22 000, `functionsFound` 1400, and both
 * rates at 100%.
 *
 * Synthetic on purpose: the subject here is attribution, not the numbers, and a
 * copy of a real report would make this file fail whenever the floors moved.
 */
function writeReport(dir: string, prefix = 'synthetic'): string {
  const records: string[] = [];
  for (let index = 0; index < 160; index += 1)
    records.push(
      `SF:lib/${prefix}-${index}.ts`,
      'FNF:10',
      'FNH:10',
      'LF:150',
      'LH:150',
      'end_of_record'
    );
  const report = path.join(dir, 'lcov.info');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path from this process's own mkdtemp
  writeFileSync(report, `${records.join('\n')}\n`);
  return report;
}

function coverageDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'coverage-provenance-'));
}

async function runGate(report: string): Promise<{
  exitCode: number;
  output: string;
}> {
  const child = Bun.spawn(['bun', '--no-env-file', GATE, report], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: `${stdout}\n${stderr}` };
}

/** A moment safely before the report was written, whatever the filesystem's mtime resolution. */
const before = (): number => Date.now() - 5000;

describe('a run is only entitled to claim the report when it produced one', () => {
  test.each([
    ['--coverage', true],
    ['--coverage=true', true],
    ['--coverage-reporter=lcov', false],
    ['--reporter=junit', false],
  ])('%s counts as a coverage run: %p', (flag, expected) => {
    // `--coverage-reporter` is the trap: it names coverage without switching it
    // on, and `bunfig.toml` wins over it anyway. Nothing in bunfig enables
    // coverage, so the flag is the whole condition.
    expect(coverageRequested([flag])).toBe(expected);
  });

  test('a run without --coverage leaves an existing sidecar alone', async () => {
    const dir = coverageDir();
    writeReport(dir);
    await stampCoverageProvenance({
      coverageDir: dir,
      tier: 'integration',
      selection: 'tests/integration',
      flags: ['--coverage'],
      startedAt: before(),
    });

    await stampCoverageProvenance({
      coverageDir: dir,
      tier: 'process',
      selection: 'tests/process',
      flags: [],
      startedAt: Date.now(),
    });

    const stamp = (await Bun.file(
      path.join(dir, 'provenance.json')
    ).json()) as CoverageProvenance;
    expect(stamp.tier).toBe('integration');
  });

  test('a coverage run with no report on disk stamps nothing', async () => {
    const dir = coverageDir();
    await stampCoverageProvenance({
      coverageDir: dir,
      tier: 'integration',
      selection: 'tests/integration',
      flags: ['--coverage'],
      startedAt: before(),
    });

    expect(await Bun.file(path.join(dir, 'provenance.json')).exists()).toBe(
      false
    );
  });
});

describe("CI's tier order ends with a report the gate accepts", () => {
  test('coverage run, then two plain runs, then the gate', async () => {
    // The exact sequence of `.github/workflows/ci.yml`'s `tests` job. The gate
    // ran last and failed on every run of it.
    const dir = coverageDir();
    const report = writeReport(dir);

    await stampCoverageProvenance({
      coverageDir: dir,
      tier: 'integration',
      selection: 'tests/integration',
      flags: ['--reporter=junit', '--coverage'],
      startedAt: before(),
    });
    for (const tier of ['process', 'matrix'])
      await stampCoverageProvenance({
        coverageDir: dir,
        tier,
        selection: `tests/${tier}`,
        flags: [],
        startedAt: Date.now(),
      });

    const result = await runGate(report);

    expect(result.output).not.toContain('different tier');
    expect(result.output).toContain('coverage ok');
    expect(result.exitCode).toBe(0);
  }, 30_000);

  test('the gate refuses a report that replaced the one the run stamped', async () => {
    // Timestamps alone cannot see this: the sidecar stays valid for an hour, and
    // a direct `bun test --coverage`, or a restored `coverage/` directory,
    // rewrites the report in place inside that window. The stamp then attributes
    // one run's counters to another tier's floors, which is the whole claim this
    // gate makes.
    const dir = coverageDir();
    const report = writeReport(dir);
    await stampCoverageProvenance({
      coverageDir: dir,
      tier: 'integration',
      selection: 'tests/integration',
      flags: ['--coverage'],
      startedAt: before(),
    });

    // Different contents, the same floors cleared, written AFTER the stamp — so
    // every timestamp check still passes and only the digest disagrees.
    writeReport(dir, 'replacement');

    const result = await runGate(report);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('not the one the run stamped');
  }, 30_000);

  test('the gate still refuses a report another tier really did produce', async () => {
    // The negative control. Without it the case above passes just as well on a
    // gate that stopped checking provenance at all.
    const dir = coverageDir();
    const report = writeReport(dir);
    await stampCoverageProvenance({
      coverageDir: dir,
      tier: 'unit',
      selection: 'tests/unit',
      flags: ['--coverage'],
      startedAt: before(),
    });

    const result = await runGate(report);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('different tier');
  }, 30_000);
});
