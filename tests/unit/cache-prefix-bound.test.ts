/**
 * Prefix-range deletion for `cacheDeletePrefix` (R-6).
 *
 * Exercises the PRODUCTION bound function and the PRODUCTION SQL together,
 * against a real SQLite database. Both previous attempts at this bound shipped
 * with a test that constructed the bound itself, so neither could ever have
 * caught its own defect:
 *
 * - `prefix + U+FFFF` missed every supplementary character, because the column
 *   collates by UTF-8 bytes and U+FFFF (EF BF BF) sorts below them.
 * - `prefix + U+10FFFF` still missed keys equal to the bound or extending past
 *   it, because the bound is EXCLUSIVE.
 *
 * A third mistake is avoided here deliberately: asserting the range in
 * JavaScript. SQLite compares TEXT by UTF-8 bytes (code point order) while JS
 * `<` compares UTF-16 code units, and they disagree for supplementary
 * characters. A JS mirror of the predicate reports `"￿￿" < "\u{10000}"`
 * as false where SQLite reports true — so the SQL has to be run for real.
 *
 * `prefixUpperBound` lives in its own driver-free module so this file can import
 * it. The SQL half runs in a child process — under Bun, against the production
 * `bun:sqlite` driver — so a file handle held open by a failing case cannot leak
 * into the rest of the suite. (The child used to run under Node because
 * `better-sqlite3` could not load under Bun; the driver swap removed that
 * constraint, not the child.)
 *
 * Local: no database server, no network.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { prefixUpperBound } from '@/lib/cache/prefix';

const CACHE = 'lib/cache/index.ts';
const CHILD = 'tests/fixtures/_cache-prefix-child.cjs';
const MAX = String.fromCodePoint(0x10_ff_ff);

function extract(name: string): string {
  const source = readFileSync(CACHE, 'utf8');
  // eslint-disable-next-line security/detect-non-literal-regexp -- name is a literal at every call site
  const match = source.match(new RegExp(`const ${name} = \`([^\`]*)\``));
  if (!match?.[1]) throw new Error(`could not extract ${name} from ${CACHE}`);
  return match[1];
}

function extractDdl(): string {
  const source = readFileSync(CACHE, 'utf8');
  return source
    .matchAll(/db\.exec\(\s*`([^`]*)`/g)
    .map((m) => `${m[1] ?? ''};`)
    .toArray()
    .join('\n');
}

/** Suffixes that must all remain inside the range for any prefix. */
const SUFFIXES = [
  '',
  'a',
  'tail',
  '\u{FFFF}',
  '\u{FFFF}tail',
  '\u{1F600}',
  '\u{1F600}tail',
  MAX,
  `${MAX}tail`,
  `${MAX}${MAX}`,
];

/** Prefixes covering ASCII, former GLOB/LIKE metacharacters, and boundaries. */
const PREFIXES = [
  'p:',
  'p*x:',
  'p?x:',
  'p[x:',
  'p_x:',
  'p%x:',
  `emoji:\u{1F600}`,
  'ends-with-ffff:\u{FFFF}',
  `high:${MAX}`,
  MAX,
];

/** Keys that must SURVIVE: they do not start with the prefix under test. */
const OUTSIDERS = ['zzz-unrelated', 'p9:x', 'p;x', 'q:x'];

const cases = PREFIXES.map((prefix) => ({
  prefix,
  upper: prefixUpperBound(prefix),
  keys: [...SUFFIXES.map((s) => prefix + s), ...OUTSIDERS],
}));

const proc = Bun.spawn(
  [
    'bun',
    CHILD,
    JSON.stringify({
      ddl: extractDdl(),
      deletePrefix: extract('SQL_DELETE_PREFIX'),
      deleteFrom: extract('SQL_DELETE_FROM'),
      cases,
    }),
  ],
  { stdout: 'pipe', stderr: 'pipe' }
);
const [stdout, stderr] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
]);
const exitCode = await proc.exited;

test('the child ran successfully', () => {
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
});

const outcome = JSON.parse(stdout.trim()) as {
  cases: { prefix: string; survivors: string[] }[];
};

for (const [index, result] of outcome.cases.entries()) {
  const source = cases[index];

  test(`every key starting with ${JSON.stringify(source?.prefix)} is deleted`, () => {
    const shouldBeGone = new Set(
      SUFFIXES.map((s) => (source?.prefix ?? '') + s)
    );
    const wronglyKept = result.survivors.filter((k) => shouldBeGone.has(k));
    expect(wronglyKept).toEqual([]);
  });

  test(`unrelated keys survive ${JSON.stringify(source?.prefix)}`, () => {
    // `MAX` as a prefix legitimately deletes keys that sort at or after it, so
    // only the outsiders that genuinely do not start with it are expected back.
    const expected = OUTSIDERS.filter(
      (k) => !k.startsWith(source?.prefix ?? '')
    );
    const survivingOutsiders = result.survivors.filter((k) =>
      OUTSIDERS.includes(k)
    );
    const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    expect(survivingOutsiders.toSorted(byCodePoint)).toEqual(
      expected.toSorted(byCodePoint)
    );
  });
}

test('the successor never grows the prefix in code points', () => {
  // Appending a character was the defect in both earlier attempts. A correct
  // lexicographic successor is never longer, counted in CODE POINTS — UTF-16
  // length can grow when U+FFFF carries to U+10000.
  for (const prefix of PREFIXES) {
    const upper = prefixUpperBound(prefix);
    if (upper === null) continue;
    expect([...upper].length).toBeLessThanOrEqual([...prefix].length);
  }
});

test('an all-maximum prefix has no successor', () => {
  expect(prefixUpperBound(MAX)).toBeNull();
  expect(prefixUpperBound(MAX + MAX)).toBeNull();
});

test('the successor never lands on a surrogate code point', () => {
  const upper = prefixUpperBound('\u{D7FF}');
  const point = upper?.codePointAt(0) ?? 0;
  expect(point < 0xd8_00 || point > 0xdf_ff).toBe(true);
});
