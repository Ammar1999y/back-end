/**
 * The SQLite migration lock, under real concurrency.
 *
 * The `sqlite-semantics` child does `[runMigration(), runMigration(),
 * runMigration()]` — three SYNCHRONOUS calls in array-literal order, in one
 * process, one after another. That is not concurrency, and it builds its own
 * `Database`, PRAGMA sequence and `user_version` dance inline instead of calling
 * the production path, so a regression in `migrate()`'s `BEGIN IMMEDIATE`
 * strategy would not be caught at all.
 *
 * This is the genuine version: separate OS processes, started together, each
 * calling `getRateLimitStore()` against one file. The historically reproduced
 * failure was a loser of the race throwing `table rate_limit already exists`,
 * which is why the assertions below are on the failure CLASS and not only on the
 * final schema — a survivor count of one would satisfy a schema check.
 *
 * ## A live defect this suite reproduced, and what it means for these assertions
 *
 * On Windows with Bun 1.4.0, concurrent cold opens can fail at
 * `PRAGMA journal_mode = WAL`. Both `SQLITE_IOERR_TRUNCATE` and `SQLITE_BUSY`
 * have been reproduced there; the latter remains a test failure below.
 *
 * That is a real gap in `openDatabase`, not a test artefact, and these tests are
 * shaped so they cannot hide it:
 *
 * - The unconditional test allows the historically accepted
 *   `SQLITE_IOERR_TRUNCATE` failure and fails on any other class, so a new
 *   failure mode or migration-lock regression still turns it red.
 * - The strict "every process opens" test is `skipIf(win32)`, so Linux CI — the
 *   deployment target — enforces zero failures, and the local run says out loud
 *   that it did not.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RATE_LIMIT_SCHEMA_VERSION } from '@/lib/rate-limit/store';
import { BUSY_TIMEOUT_MS } from '@/lib/sqlite/database';

const CHILD = path.join(
  import.meta.dir,
  '..',
  'fixtures',
  '_sqlite-open-child.ts'
);

/** Enough to lose the race repeatedly; eight was what originally reproduced it. */
const RACERS = 8;

/**
 * The historical failure class accepted on win32. Other classes remain failures.
 */
const ACCEPTED_ON_WIN32 = 'SQLITE_IOERR_TRUNCATE';

const ON_WINDOWS = process.platform === 'win32';

interface ChildReport {
  pid: number;
  userVersion: number;
  journalMode: unknown;
  busyTimeout: number;
  consumed: number | null;
}

/** Holder rather than a bare `let`: the hooks below are functions. */
const scratch = { dir: '' };

beforeEach(() => {
  // A directory per case, not per file: contention over ONE file is the property,
  // so two cases sharing a directory would let the second one find the schema
  // already applied and assert nothing.
  scratch.dir = mkdtempSync(path.join(os.tmpdir(), 'sqlite-race-'));
});

afterEach(() => {
  rmSync(scratch.dir, { recursive: true, force: true });
});

async function raceOpens(count: number): Promise<{
  reports: ChildReport[];
  failures: { code: number; stderr: string }[];
}> {
  // Spawned inside one `Promise.all` rather than awaited one at a time, so the
  // process starts and the connection opens genuinely overlap.
  const children = Array.from({ length: count }, () =>
    Bun.spawn(['bun', '--no-env-file', CHILD], {
      cwd: path.join(import.meta.dir, '..', '..'),
      env: { ...process.env, SQLITE_DIR: scratch.dir },
      stdout: 'pipe',
      stderr: 'pipe',
    })
  );

  const settled = await Promise.all(
    children.map(async (child) => {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { out: out.trim(), err, code };
    })
  );

  const reports: ChildReport[] = [];
  const failures: { code: number; stderr: string }[] = [];
  for (const result of settled) {
    if (result.code === 0 && result.out)
      reports.push(JSON.parse(result.out) as ChildReport);
    else failures.push({ code: result.code, stderr: result.err });
  }
  return { reports, failures };
}

function firstLines(stderr: string): string {
  return stderr.split('\n').slice(0, 6).join(' | ').slice(0, 400);
}

describe('concurrent first-open of the rate-limit store', () => {
  test('no racing process fails inside the migration', async () => {
    const { failures } = await raceOpens(RACERS);

    // The regression this guards is `table rate_limit already exists` from a
    // loser of the `BEGIN IMMEDIATE` race. Every other class fails here too,
    // with the single exception documented at the top of this file — so a NEW
    // failure mode cannot arrive quietly under cover of the known one.
    // Gated on the platform, which the previous version forgot: without
    // `ON_WINDOWS` a genuine SQLITE_IOERR_TRUNCATE on Linux CI — the exact class
    // this file's header calls "a real gap in openDatabase, not a test artefact"
    // — was silently accepted on the deployment target.
    const unexpected = failures.filter(
      (failure) => !(ON_WINDOWS && failure.stderr.includes(ACCEPTED_ON_WIN32))
    );
    expect(
      unexpected.map((failure) => firstLines(failure.stderr)),
      'a racing process failed for a reason this suite does not accept'
    ).toEqual([]);
  }, 30_000);

  test.skipIf(ON_WINDOWS)(
    'every racing process opens successfully',
    async () => {
      // Skipped on win32 because concurrent `journal_mode = WAL` cold opens are
      // not reliable there (see the header). Linux CI enforces zero failures.
      const { reports, failures } = await raceOpens(RACERS);
      expect(
        failures.map((failure) => firstLines(failure.stderr)),
        'a racing process failed to open the store'
      ).toEqual([]);
      expect(reports.length).toBe(RACERS);
    },
    30_000
  );

  test('the schema is applied exactly once, and is usable', async () => {
    const { reports } = await raceOpens(RACERS);

    // Same platform gate, same reason: tolerating a lost racer everywhere would
    // accept on Linux the one failure only Windows has been shown to produce.
    expect(reports.length).toBeGreaterThanOrEqual(
      ON_WINDOWS ? RACERS - 1 : RACERS
    );

    for (const report of reports) {
      expect(report.userVersion).toBe(RATE_LIMIT_SCHEMA_VERSION);
      // A `consume` that returned a row proves the table AND its index exist,
      // which `user_version` alone does not: a half-applied migration would
      // leave the version set.
      expect(report.consumed).not.toBeNull();
    }

    // Each child consumes a key named after its own pid, so every one of them
    // must have been the first request in its own window. A count above 1 would
    // mean two children shared a key, or that a migration reset nothing.
    expect(reports.map((report) => report.consumed)).toEqual(
      reports.map(() => 1)
    );
  }, 30_000);

  test('the pragmas the production path sets survive the race', async () => {
    const { reports } = await raceOpens(RACERS);

    for (const report of reports) {
      expect(report.journalMode).toBe('wal');
      // Read-back only: it proves the final state, and says nothing about the
      // ORDER relative to `journal_mode = WAL`. The ordering property needs a
      // held lock and is asserted separately.
      expect(report.busyTimeout).toBe(BUSY_TIMEOUT_MS);
    }
  }, 30_000);
});
