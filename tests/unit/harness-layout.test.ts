/**
 * The guard that closes the selection hole for good.
 *
 * `bun test <path>` treats its positional arguments as filename FILTERS, not
 * paths. Measured: with `bun test scripts/probe/local`, a failing test file
 * outside that directory was skipped and the run still exited 0 — so `bun run
 * test`, `ci.yml:34` and `lefthook.yml:57` all reported success while a whole
 * directory of tests had never executed. `bunfig.toml`'s `root` fixes the bare
 * `bun test` case; this fixes the case the tier scripts create, where a file in
 * `tests/` that is in no tier is silently in no run.
 *
 * Two more traps this covers, both from the strategy's own list:
 *
 * - A non-test file under a tier directory would be imported by nothing. The rule
 *   is that everything under `tests/` is either matched by the test glob or lives
 *   in `helpers/` or `fixtures/`.
 * - A `_`-prefixed child script is never matched by the glob, which is the point —
 *   `bun test` executing a CLI-style probe that calls `process.exit()` ends the
 *   whole run and silently skips every file after it. They belong in `fixtures/`.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { stripComments } from '@/scripts/strip-comments';

const TESTS_ROOT = path.join(import.meta.dir, '..');

/** The directories `tests/helpers/run.ts` knows how to run. */
const TIERS = ['unit', 'integration', 'process'] as const;

/** Directories that hold code the tiers import rather than tests. */
const SUPPORT = ['helpers', 'fixtures'] as const;

function readFile(rel: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path this file produced by walking its own directory
  return readFileSync(path.join(TESTS_ROOT, rel), 'utf8');
}

/**
 * Source with comments removed, which is what the detectors below must match
 * against.
 *
 * `stripComments` is reused from `scripts/strip-comments.ts` — `find-unused-files.ts`
 * already imports it for exactly this reason, and writing a second stripper here
 * would be the duplicate that module's own header warns about. Its scanner
 * handles the two cases a regex gets wrong: `//` inside a string literal is not a
 * comment, and a quote inside a comment does not open a string.
 *
 * Without it the guard detector matched its own trigger words inside prose. A
 * file whose only mention of `resetTables()` was a comment saying it is NOT
 * called counted as guarded.
 */
function readCode(rel: string): string {
  return stripComments(readFile(rel));
}

/**
 * Every way this codebase reaches the raw Drizzle client.
 *
 * Three spellings, because the first version of this matched only
 * `from '@/db'` and let two real ones through:
 *
 * - `from '@/db/index'` — the same module by its explicit path.
 * - `await import('@/db')` — already idiomatic in this suite
 *   (`tests/integration/harness.test.ts` uses it in three places), which makes it
 *   the bypass most likely to be written by accident rather than deliberately.
 *
 * Both quote styles are accepted even though prettier enforces single quotes:
 * the gate should not depend on a formatter having run.
 */
const IMPORTS_DB = /(?:from|import)\s*\(?\s*['"]@\/db(?:\/index)?['"]/;

/** Reaching any of these means the ownership assertion runs before a write. */
const REACHES_GUARD =
  /\b(?:resetTables|seedUser|signedInUser|assertHarnessDatabase)\s*\(/;

function walk(dir: string, base = ''): string[] {
  const out: string[] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fixed path relative to this file
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = base ? `${base}/${entry}` : entry;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- same
    if (statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push(rel);
  }
  return out;
}

const everyFile = walk(TESTS_ROOT);

/** What `bun test` will actually pick up. */
function isTestFile(rel: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) || /_(test|spec)_/.test(rel);
}

describe('tests/ layout', () => {
  test('every file is in a tier or in a support directory', () => {
    const stray = everyFile.filter((rel) => {
      const top = rel.split('/', 1)[0] ?? '';
      return (
        !TIERS.includes(top as (typeof TIERS)[number]) &&
        !SUPPORT.includes(top as (typeof SUPPORT)[number])
      );
    });
    expect(stray).toEqual([]);
  });

  test('every test file is inside a tier a script runs', () => {
    const orphaned = everyFile.filter(
      (rel) =>
        isTestFile(rel) &&
        !TIERS.includes((rel.split('/', 1)[0] ?? '') as (typeof TIERS)[number])
    );
    expect(orphaned).toEqual([]);
  });

  test('no tier directory holds a file the test glob will not match', () => {
    const unmatched = everyFile.filter(
      (rel) =>
        TIERS.includes(
          (rel.split('/', 1)[0] ?? '') as (typeof TIERS)[number]
        ) && !isTestFile(rel)
    );
    expect(unmatched).toEqual([]);
  });

  test('every support file that is not a helper is `_`-prefixed', () => {
    // `fixtures/` holds child scripts a test spawns. A file there without the
    // underscore reads as a test that never runs.
    const wrong = everyFile.filter(
      (rel) =>
        rel.startsWith('fixtures/') && !path.basename(rel).startsWith('_')
    );
    expect(wrong).toEqual([]);
  });

  /**
   * The enforcement half of `assertHarnessDatabase()`.
   *
   * That guard is called by `resetTables` and `seedUser`, so any test reaching a
   * database THROUGH a helper is protected — which is every test today. What it
   * does not protect is a test that writes with a bare `db.insert(...)` or
   * `db.execute(...)`, and "write only through the helpers" as an unwritten
   * convention is not enforcement.
   *
   * So the rule is scoped to exactly that hazard: **a file that imports `@/db`
   * directly must also reach the guard.** A file that only uses the helpers is
   * guarded by construction, and a file that touches no database at all —
   * `tests/process/sqlite-migration-race.test.ts` spawns SQLite children and
   * never opens PostgreSQL — is not in scope. An earlier version of this test
   * required the guard of every database-TIER file and flagged that one, which is
   * the difference between a tier and a capability.
   *
   * A wrapper around `db` was the alternative and is worse: tests would stop
   * using the real client, which is most of what an integration test is for.
   */
  test('every file that imports @/db directly reaches the ownership guard', () => {
    const unguarded = everyFile
      .filter((rel) => isTestFile(rel) && IMPORTS_DB.test(readCode(rel)))
      .filter((rel) => !REACHES_GUARD.test(readCode(rel)));

    expect(
      unguarded,
      'these files hold the real client and can write without asserting the harness owns the database'
    ).toEqual([]);
  });

  /**
   * The detector, asserted against synthetic sources.
   *
   * This is the part that was missing, and its absence is why three bypasses
   * shipped: the walk above only ever proved a VERDICT about the files that exist
   * today, never that the rule can distinguish a guarded file from an unguarded
   * one. A detector with no test of its own is a gate that reports "all clear"
   * for whatever it cannot see.
   *
   * Each case below was a real bypass before `stripComments` and the widened
   * import pattern landed.
   */
  describe('the guard detector itself', () => {
    const flagged = (source: string) => {
      const code = stripComments(source);
      return IMPORTS_DB.test(code) && !REACHES_GUARD.test(code);
    };

    const GUARDED = `import { db } from '@/db';
await resetTables();
await db.execute(q);`;

    const NO_DB = `import { app } from '@/app';
await app.handle(r);`;

    const DIRECT_UNGUARDED = `import { db } from '@/db';
await db.execute(q);`;

    const INDEX_PATH = `import { db } from '@/db/index';
await db.execute(q);`;

    const DYNAMIC = `const { db } = await import('@/db');
await db.execute(q);`;

    const DOUBLE_QUOTED = `import { db } from "@/db";
await db.execute(q);`;

    const GUARD_IN_LINE_COMMENT = `import { db } from '@/db';
// resetTables() is deliberately not called
await db.execute(q);`;

    const GUARD_IN_BLOCK_COMMENT = `import { db } from '@/db';
/* seedUser() belongs here */
await db.execute(q);`;

    const URL_WITH_SLASHES = `import { db } from '@/db';
const u = 'https://example.test';
await resetTables();`;

    test.each([
      ['a guarded file is not flagged', GUARDED, false],
      ['a file that never touches @/db is not flagged', NO_DB, false],
      ['an unguarded direct import IS flagged', DIRECT_UNGUARDED, true],
      ['the explicit /index path IS flagged', INDEX_PATH, true],
      ['a dynamic import IS flagged', DYNAMIC, true],
      [
        'double quotes are flagged, so the gate does not need prettier',
        DOUBLE_QUOTED,
        true,
      ],
      [
        'a guard named only in a line comment does not count',
        GUARD_IN_LINE_COMMENT,
        true,
      ],
      [
        'a guard named only in a block comment does not count',
        GUARD_IN_BLOCK_COMMENT,
        true,
      ],
      [
        'a URL containing // does not break the stripper',
        URL_WITH_SLASHES,
        false,
      ],
    ])('%s', (_label, source, expected) => {
      expect(flagged(source)).toBe(expected);
    });
  });

  test('each tier has at least one test file', () => {
    for (const tier of TIERS) {
      const count = everyFile.filter(
        (rel) => rel.startsWith(`${tier}/`) && isTestFile(rel)
      ).length;
      expect(
        count,
        `tier "${tier}" is empty, so its script would run nothing`
      ).toBeGreaterThan(0);
    }
  });
});
