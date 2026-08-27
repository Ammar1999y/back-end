/* eslint-disable security/detect-non-literal-fs-filename -- fixed repository paths derived from this module */
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

/** Runs the real `bun run lint` with `file` present, and removes it after. */
async function lintWith(
  file: string,
  source: string
): Promise<{ exitCode: number | null; output: string }> {
  if (existsSync(file))
    throw new Error(`refusing to overwrite existing probe: ${file}`);
  writeFileSync(file, source, { flag: 'wx' });
  try {
    const child = Bun.spawn(['bun', 'run', 'lint'], {
      cwd: REPO_ROOT,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return {
      exitCode,
      output: `${stdout}
${stderr}`,
    };
  } finally {
    rmSync(file, { force: true });
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

test('a security/* warning makes bun run lint exit non-zero', async () => {
  if (existsSync(PROBE))
    throw new Error(`refusing to overwrite existing probe: ${PROBE}`);

  writeFileSync(PROBE, fixtureSource(), { flag: 'wx' });
  try {
    const child = Bun.spawn(['bun', 'run', 'lint'], {
      cwd: REPO_ROOT,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const output = `${stdout}\n${stderr}`;

    expect(exitCode).not.toBe(0);
    expect(output).toContain(path.basename(PROBE));
    expect(output).toMatch(
      /warning\s+Found non-literal argument to RegExp Constructor\s+security\/detect-non-literal-regexp/
    );
  } finally {
    rmSync(PROBE, { force: true });
  }
}, 300_000);

test('a floating promise on a security check makes bun run lint exit non-zero', async () => {
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
