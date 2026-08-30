/* eslint-disable security/detect-non-literal-fs-filename -- fixed repository paths derived from this module */
/**
 * The lint gate itself: does a `security/*` warning, and a floating promise on a
 * type-aware path, actually FAIL the check a developer and CI run?
 *
 * Two things here are deliberate and were not before.
 *
 * **ESLint is spawned directly, not `bun run lint`.** That script is
 * `tsc --noEmit && eslint .`, and `tsc` is `incremental`, so writing a probe into
 * the tree poisoned the shared `tsconfig.tsbuildinfo` with a filename that no
 * longer existed on the next run: `error TS6053: File '.../lib/floating-promise-
 * probe-9816.ts' not found`, which made `expect(exitCode).not.toBe(0)` pass for
 * entirely the wrong reason while the message assertion failed. `tsc` proves
 * shapes line up and has nothing to do with either rule; what these tests are
 * about is `eslint --max-warnings 0`. The `lint` script is pinned separately
 * below — by whole `&&` stage, not by substring — so "the gate exists and is
 * wired" stays asserted without running it.
 *
 * **The probes must still be written INSIDE the repository**, and that is not
 * incidental either: `eslint.config.mjs` scopes the type-aware block by
 * `files: ['lib/**\/*.ts', …]` with `projectService`, so a probe in an OS temp
 * directory would be linted without a program and `no-floating-promises` would
 * not run at all. That scoping IS part of what this asserts. The cost is a file
 * in the tree for the duration of the run — `.gitignore` carries both name
 * patterns as a backstop, and `removeProbe` below verifies the removal rather
 * than hoping for it (`rmSync` ignores `maxRetries` for a file, and a Windows
 * handle held by a just-exited grandchild left a 355-byte probe behind after a
 * green run).
 */
import { expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.join(import.meta.dir, '..', '..');
const FIXTURE = path.join(
  import.meta.dir,
  '..',
  'fixtures',
  '_security-warning.json'
);
const FLOATING_FIXTURE = path.join(
  import.meta.dir,
  '..',
  'fixtures',
  '_floating-promise.json'
);
const PROBE = path.join(REPO_ROOT, `security-lint-probe-${process.pid}.ts`);
const FLOATING_PROBE = path.join(
  REPO_ROOT,
  'lib',
  `floating-promise-probe-${process.pid}.ts`
);

/** The flags the gate depends on, asserted against `package.json` below. */
/**
 * The exact commands `lint` must run, as `&&`-joined stages.
 *
 * Substring matching was not enough, and the gap was the whole point of the
 * assertion: `toInclude('eslint .')` passes for
 * `tsc --noEmit && eslint . --max-warnings 0 || true`, for
 * `tsc --noEmit ; eslint . --max-warnings 0`, and for a script whose ESLint
 * invocation is commented out of a longer command — i.e. for exactly the edits
 * that disarm the gate. Whole stages plus a ban on `||` and `;` reject all
 * three.
 */
const REQUIRED_LINT_STAGES = [
  'tsc --noEmit',
  'eslint . --max-warnings 0',
] as const;

/**
 * Removes the probe and proves it is gone.
 *
 * A leaked probe is untracked, deliberately rule-violating source under `lib/`
 * that `git add -A` commits, after which everyone's `lint` gate fails on a file
 * they never wrote. `rmSync`'s `maxRetries` is documented as ignored unless
 * `recursive` is true, so the retry is explicit.
 */
function removeProbe(file: string): void {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(file, { force: true });
    } catch {
      // A Windows handle from the just-exited child; retried below.
    }
    if (!existsSync(file)) return;
    Bun.sleepSync(50);
  }
  throw new Error(`probe could not be removed and is now untracked: ${file}`);
}

/** Runs the real ESLint gate with `file` present, and removes it after. */
async function lintWith(
  file: string,
  source: string
): Promise<{ exitCode: number | null; output: string }> {
  if (existsSync(file))
    throw new Error(`refusing to overwrite existing probe: ${file}`);
  writeFileSync(file, source, { flag: 'wx' });
  try {
    const child = Bun.spawn(
      ['bunx', 'eslint', '.', '--max-warnings', '0', '--no-warn-ignored'],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, FORCE_COLOR: '0' },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, output: `${stdout}\n${stderr}` };
  } finally {
    removeProbe(file);
  }
}

function fixtureSource(file = FIXTURE): string {
  const fixture: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (
    typeof fixture !== 'object' ||
    fixture === null ||
    !('source' in fixture) ||
    typeof fixture.source !== 'string'
  )
    throw new Error('security warning fixture has no string source');
  return fixture.source;
}

test('the lint script still runs ESLint over the tree with no warning budget', () => {
  // What the two spawns below stand in for. `--max-warnings 0` is the whole
  // reason a `security/*` warning is a failure at all, and `eslint .` is what
  // makes it cover files no hook happened to stage.
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')
  );
  const lint = (manifest as { scripts?: Record<string, string> }).scripts?.lint;

  expect(lint).toBeString();
  const script = String(lint);

  // Nothing that lets a failing stage through, and nothing that comments one
  // out. `&&` is the only separator this script may use.
  expect(script).not.toInclude('||');
  expect(script).not.toInclude(';');
  expect(script).not.toInclude('#');

  const stages = script.split('&&').map((stage) => stage.trim());
  for (const stage of REQUIRED_LINT_STAGES) expect(stages).toContain(stage);
});

test('a security/* warning fails the lint gate', async () => {
  const { exitCode, output } = await lintWith(PROBE, fixtureSource());

  expect(exitCode).not.toBe(0);
  expect(output).toContain(path.basename(PROBE));
  expect(output).toMatch(
    /warning\s+Found non-literal argument to RegExp Constructor\s+security\/detect-non-literal-regexp/
  );
}, 300_000);

test('a floating promise on a security check fails the lint gate', async () => {
  // Inside `lib/`, because the type-aware block in `eslint.config.mjs` is scoped
  // by `files` — a probe in the repository root would be parsed without a
  // program and the rule would not run. That scoping IS part of what this
  // asserts: it is the difference between the rule existing and the rule
  // applying to the code that needs it.
  const { exitCode, output } = await lintWith(
    FLOATING_PROBE,
    fixtureSource(FLOATING_FIXTURE)
  );

  expect(exitCode).not.toBe(0);
  expect(output).toContain(path.basename(FLOATING_PROBE));
  expect(output).toContain('no-floating-promises');
}, 300_000);
