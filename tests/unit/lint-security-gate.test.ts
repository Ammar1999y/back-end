/** `bun run lint` must fail on warning-level security findings. */
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
const PROBE = path.join(REPO_ROOT, `security-lint-probe-${process.pid}.ts`);

function fixtureSource(): string {
  const fixture: unknown = JSON.parse(readFileSync(FIXTURE, 'utf8'));
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
