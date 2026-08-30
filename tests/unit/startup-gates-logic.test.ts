/**
 * The decisions behind `server.ts`'s boot gates.
 *
 * Two of the four could not be observed at all before this file.
 * `assertBunVersion` compares the RUNNING Bun against the pin in
 * `package.json`, and `assertSqliteVersion` reads the version compiled into the
 * Bun binary — a spawned child can vary neither, so the process tier could only
 * ever watch them pass. Deleting the `fail(...)` from either branch left the
 * whole suite green, which is precisely how a fail-closed guard regresses to
 * fail-open unnoticed.
 *
 * `utils/startup.ts` holds the decision and `server.ts` holds one line of wiring
 * per gate. What is asserted here is the decision; what the spawned cases in
 * `tests/process/startup-gates.test.ts` assert is that a refusal really ends the
 * process non-zero, for the two gates a child CAN drive.
 *
 * The pin is read from the real `package.json` rather than restated, so the two
 * cannot agree with each other and disagree with the deployment.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  atLeastVersion,
  bunVersionVerdict,
  DEFAULT_PORT,
  parseVersionParts,
  portVerdict,
  sqliteVersionVerdict,
} from '@/utils/startup';

const REPO_ROOT = path.join(import.meta.dir, '..', '..');

/** The floor `server.ts` passes to `sqliteVersionVerdict`. */
const SQLITE_FLOOR = [3, 51, 3] as const;

function declaredPackageManager(): string {
  const manifest: unknown = JSON.parse(
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fixed path derived from this module
    readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')
  );
  const declared = (manifest as { packageManager?: unknown }).packageManager;
  if (typeof declared !== 'string')
    throw new TypeError('package.json has no string `packageManager`');
  return declared;
}

describe('the Bun version floor', () => {
  const pin = declaredPackageManager();
  const pinned = pin.replace('bun@', '');

  test('the repository declares a pin this gate can parse', () => {
    // `bun@1.4` or `bun@^1.4.0` is not a looser requirement — it is a server
    // that refuses to start, because an unparsed pin is not the same as no pin.
    expect(pin).toMatch(/^bun@\d+\.\d+\.\d+$/);
    expect(bunVersionVerdict(pinned, pin)).toEqual({ ok: true });
  });

  test('the Bun actually running satisfies the pin', () => {
    // The gate that runs on every boot, run here against the same two inputs.
    expect(bunVersionVerdict(Bun.version, pin).ok).toBe(true);
  });

  test.each([
    ['one patch below', '1.3.9', 'bun@1.4.0'],
    ['one minor below', '1.3.99', 'bun@1.4.0'],
    ['one major below', '0.9.9', 'bun@1.4.0'],
  ])('%s is REFUSED', (_label, running, declared) => {
    const verdict = bunVersionVerdict(running, declared);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? '' : verdict.reason).toInclude('older than the tested');
  });

  test.each([
    ['exactly the pin', '1.4.0'],
    ['a newer patch', '1.4.1'],
    ['a newer minor', '1.5.0'],
    ['a newer major', '2.0.0'],
    ['a canary above the pin', '1.4.1-canary.20260101'],
  ])('%s is ADMITTED', (_label, running) => {
    expect(bunVersionVerdict(running, 'bun@1.4.0').ok).toBe(true);
  });

  test('anything above the pin warns rather than passing silently', () => {
    // Newer is untested, not known-broken: refusing it would turn a routine
    // image bump into an outage, so the drift is logged instead of hidden.
    const verdict = bunVersionVerdict('1.5.0', 'bun@1.4.0');
    expect(verdict).toMatchObject({ ok: true });
    expect(verdict.ok ? verdict.warning : '').toInclude(
      'bun version ahead of the tested pin'
    );
    expect(bunVersionVerdict('1.4.0', 'bun@1.4.0')).toEqual({ ok: true });
  });

  test.each([
    ['a range', 'bun@^1.4.0'],
    ['a two-part pin', 'bun@1.4'],
    ['another manager', 'pnpm@10.8.1'],
    ['empty', ''],
  ])('a %s pin is fatal, not "no pin"', (_label, declared) => {
    const verdict = bunVersionVerdict('1.4.0', declared);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? '' : verdict.reason).toInclude('packageManager');
  });

  test('a running version that cannot be compared is fatal', () => {
    const verdict = bunVersionVerdict('unknown', 'bun@1.4.0');
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? '' : verdict.reason).toInclude('not major.minor.patch');
  });
});

describe('the SQLite version floor', () => {
  test('the SQLite compiled into this Bun satisfies the floor', () => {
    // Same probe `assertSqliteVersion` runs, against the same floor.
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
    const db = new Database(':memory:');
    const version =
      db.prepare<{ v: string }, []>('SELECT sqlite_version() AS v').get()?.v ??
      '';
    db.close(true);

    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(sqliteVersionVerdict(version, SQLITE_FLOOR).ok).toBe(true);
  });

  test.each([
    ['one patch below', '3.51.2'],
    ['one minor below', '3.50.99'],
    ['one major below', '2.99.99'],
  ])('%s is REFUSED', (_label, version) => {
    const verdict = sqliteVersionVerdict(version, SQLITE_FLOOR);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? '' : verdict.reason).toInclude('WAL-reset race');
  });

  test.each([
    ['exactly the floor', '3.51.3'],
    ['a newer patch', '3.51.4'],
    ['a newer minor', '3.52.0'],
  ])('%s is ADMITTED', (_label, version) => {
    expect(sqliteVersionVerdict(version, SQLITE_FLOOR)).toEqual({ ok: true });
  });

  test('an unparseable version is refused rather than waved through', () => {
    // `''` is what the probe returns when the probe itself went wrong, and a
    // comparison it cannot make must not read as "at or above the floor".
    for (const version of ['', 'unknown', '3.51'])
      expect(sqliteVersionVerdict(version, SQLITE_FLOOR).ok).toBe(false);
  });
});

describe('PORT', () => {
  test.each([
    ['absent', undefined],
    ['empty', ''],
    ['whitespace', ' '.repeat(3)],
  ])('%s means the default, not a rejection', (_label, raw) => {
    // An orchestrator that declares `PORT` with no value means "you choose".
    // This case used to be a spawned child, which bound 3000 for real — so it
    // failed with `EADDRINUSE` on any machine running `bun run dev`, for a
    // reason unrelated to the gate.
    expect(portVerdict(raw)).toEqual({ ok: true, port: DEFAULT_PORT });
  });

  test.each([
    ['zero', '0'],
    ['over range', '70000'],
    ['trailing text', '3000abc'],
    ['fractional', '3000.5'],
    ['negative', '-1'],
    ['hex', '0x1F90'],
  ])('%s is refused', (_label, raw) => {
    expect(portVerdict(raw).ok).toBe(false);
  });

  test('a valid port is taken verbatim, trimmed', () => {
    expect(portVerdict('8080')).toEqual({ ok: true, port: 8080 });
    expect(portVerdict(' 8080 ')).toEqual({ ok: true, port: 8080 });
    expect(portVerdict('1')).toEqual({ ok: true, port: 1 });
    expect(portVerdict('65535')).toEqual({ ok: true, port: 65_535 });
  });
});

describe('the comparison primitives', () => {
  test('atLeastVersion compares field by field, not lexically', () => {
    // `'1.10.0' >= '1.9.0'` is false as strings, which is the bug this shape
    // exists to avoid.
    expect(atLeastVersion([1, 10, 0], [1, 9, 0])).toBe(true);
    expect(atLeastVersion([1, 9, 0], [1, 10, 0])).toBe(false);
    expect(atLeastVersion([1, 4, 0], [1, 4, 0])).toBe(true);
  });

  test('a missing component reads as zero', () => {
    expect(atLeastVersion([3, 51], [3, 51, 3])).toBe(false);
    expect(atLeastVersion([3, 52], [3, 51, 3])).toBe(true);
  });

  test('parseVersionParts drops a prerelease tail and rejects the rest', () => {
    expect(parseVersionParts('1.4.1-canary.20260101')).toEqual([1, 4, 1]);
    expect(parseVersionParts('  1.4.0  ')).toEqual([1, 4, 0]);
    expect(parseVersionParts('1.4')).toBeNull();
    expect(parseVersionParts('v1.4.0')).toBeNull();
    expect(parseVersionParts('')).toBeNull();
  });
});
