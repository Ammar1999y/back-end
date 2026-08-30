/**
 * Regression tests for the SQL semantics the rate limiter and cache depend on.
 *
 * These exist because the fixes they cover were previously verified only by
 * throwaway routes that were deleted afterwards — so nothing in the repository
 * proved them and CI could not enforce them. Each assertion below corresponds to
 * a defect that was reproduced before it was fixed.
 *
 * ## Why a child process
 *
 * The assertions run in a child (`_sqlite-semantics-child.cjs`) and report back as
 * JSON. Several of them need a SECOND connection to the same file to reproduce a
 * cross-process race, and one runs the migration three times over; keeping that
 * out of the test process means a failure cannot leave open handles behind.
 *
 * The child runs under Bun against the production driver, `bun:sqlite`. It used
 * to run under Node against `better-sqlite3`, which cannot load under Bun at all
 * (`NAPI FATAL ERROR`) — the Elysia migration swapped the driver and removed that
 * constraint.
 *
 * ## Why the SQL is extracted rather than rewritten
 *
 * The child receives the production statements, read out of `lib/rate-limit/store.ts`
 * and `lib/cache/index.ts` at run time. A copy of the SQL in the test would drift
 * from the application silently and the test would keep passing against a
 * statement nobody runs. If an extraction fails, that is a hard failure below,
 * not a skipped test.
 *
 * Local: no database server, no network.
 */
/* eslint-disable security/detect-non-literal-fs-filename, security/detect-non-literal-regexp --
   paths and the pattern are module-scope constants in this file, never input */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const STORE = 'lib/rate-limit/store.ts';
const CACHE = 'lib/cache/index.ts';
const CHILD = 'tests/fixtures/_sqlite-semantics-child.cjs';

/** Pulls a `const NAME = \`...\`;` template literal out of a module's source. */
function extractSql(file: string, name: string): string {
  const source = readFileSync(file, 'utf8');
  const match = source.match(new RegExp(`const ${name} = \`([^\`]*)\``));
  if (!match?.[1])
    throw new Error(
      `could not extract ${name} from ${file}. If it was renamed, update this ` +
        'test rather than inlining a copy of the SQL.'
    );
  return match[1];
}

/** Collects the `db.exec(\`CREATE ...\`)` statements from a migration list. */
function extractDdl(file: string, table: string): string {
  const source = readFileSync(file, 'utf8');
  const statements = source
    .matchAll(/db\.exec\(\s*`([^`]*)`/g)
    .map((m) => m[1] ?? '')
    .filter((statement) => statement.includes(table))
    .toArray();
  if (statements.length === 0)
    throw new Error(`no DDL for ${table} found in ${file}`);
  return statements.map((s) => `${s};`).join('\n');
}

interface ChildResult {
  ok: boolean;
  results: { name: string; pass: boolean; detail: string }[];
}

async function runChild(): Promise<ChildResult> {
  const sql = {
    rateLimitDdl: extractDdl(STORE, 'rate_limit'),
    cacheDdl: extractDdl(CACHE, 'cache'),
    consume: extractSql(STORE, 'SQL_CONSUME'),
    sweepRateLimit: extractSql(STORE, 'SQL_SWEEP_RATE_LIMIT'),
    anyExpired: extractSql(STORE, 'SQL_ANY_EXPIRED'),
    deletePrefix: extractSql(CACHE, 'SQL_DELETE_PREFIX'),
  };

  const proc = Bun.spawn(['bun', CHILD, JSON.stringify(sql)], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  // A child that crashed after emitting some output would otherwise be read as
  // a pass. Both the exit code and the presence of output are required.
  if (exitCode !== 0)
    throw new Error(`child exited ${exitCode}. stderr: ${err}`);
  const trimmed = out.trim();
  if (!trimmed) throw new Error(`child produced no output. stderr: ${err}`);
  return JSON.parse(trimmed) as ChildResult;
}

const outcome = await runChild();

for (const result of outcome.results) {
  test(result.name, () => {
    expect(result.detail).toBeTruthy();
    expect(result.pass).toBe(true);
  });
}

test('every semantic assertion ran', () => {
  // Guards against a child that silently stopped early: a shrinking suite would
  // otherwise look like a passing one.
  expect(outcome.results.length).toBe(11);
});
