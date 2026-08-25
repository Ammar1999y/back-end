/**
 * Child runner for `cache-prefix-bound.test.ts`.
 *
 * Runs the REAL prefix-delete SQL against a real SQLite database, under Bun and
 * the production driver (`bun:sqlite`). A separate process so a Windows file
 * handle held open by a failed case cannot leak into the rest of the suite.
 *
 * It receives the bounds already computed by the production `prefixUpperBound`
 * in the parent, and the production SQL extracted from `lib/cache/index.ts`. So
 * neither the algorithm nor the statement is reimplemented here.
 *
 * Why this cannot be asserted in JavaScript alone: SQLite compares TEXT by UTF-8
 * bytes, i.e. by code point, while JavaScript's `<` compares UTF-16 code units.
 * They disagree for supplementary characters — `"￿￿" < "\u{10000}"` is
 * false in JS and true in SQLite. A JS-only mirror of the range predicate is
 * therefore not a faithful test, which is exactly the mistake this file exists to
 * avoid.
 *
 * Emits one JSON line: `{ cases: [{prefix, survivors}] }`.
 */
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const { Database } = require('bun:sqlite');

const input = JSON.parse(process.argv[2]);
const dir = mkdtempSync(path.join(tmpdir(), 'cache-prefix-'));
const cases = [];

try {
  for (const testCase of input.cases) {
    const db = new Database(path.join(dir, `c${cases.length}.db`), {
      create: true,
    });
    db.exec(input.ddl);

    const insert = db.prepare(
      'INSERT INTO cache (key, value, expires_at, created_at) VALUES (?, ?, ?, ?)'
    );
    for (const key of testCase.keys) insert.run(key, Buffer.from('v'), 9e15, 0);

    if (testCase.upper === null)
      db.prepare(input.deleteFrom).run(testCase.prefix);
    else db.prepare(input.deletePrefix).run(testCase.prefix, testCase.upper);

    cases.push({
      prefix: testCase.prefix,
      survivors: db
        .prepare('SELECT key FROM cache ORDER BY key')
        .all()
        .map((row) => row.key),
    });
    db.close(false);
  }
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may still hold the file; a leftover temp dir is not a result.
  }
}

process.stdout.write(JSON.stringify({ cases }));
