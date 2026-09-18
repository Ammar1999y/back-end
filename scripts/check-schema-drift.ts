/**
 * Fail when `db/schema.ts` says something `db/drizzle/` does not: `bun run
 * check:schema-drift`.
 *
 * Migration generation is a manual step (`bun run db:generate`), and nothing
 * checked that it had been taken. The schema embeds runtime constants in CHECK
 * constraints, column widths, foreign-key behaviour and enum labels, so a
 * constant raised in TypeScript without a generated migration typechecks and
 * lints, and reaches a deployed database still enforcing the old rule, where a
 * request the code considers valid becomes a 500. The test template is migrated
 * from `db/drizzle/` too, so it disagrees the same way — which makes the tests a
 * detector only where one happens to exercise that constraint, and silent
 * everywhere else.
 *
 * The check is drizzle-kit's own diff, run against a COPY of the metadata so a
 * gate can never write into the repository: copy `db/drizzle/` to a scratch
 * directory, generate into it, and compare. Any new SQL file, or any change to
 * `meta/`, is drift.
 *
 * Runs in `lefthook.yml`'s pre-push gates and in CI's `verify` job. It needs no
 * database — `generate` reads the schema module and the snapshots, and never
 * connects.
 */
/* eslint-disable unicorn/no-process-exit -- CLI entry point: the exit code IS
   this tool's result contract, which is the case the rule excepts */
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import drizzleConfig from '../drizzle.config';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..');
/**
 * The folder to copy, from the config rather than spelled here: `out` is the one
 * generate-affecting key this script supplies itself, so a hand-written copy of
 * it is the one value the guard below cannot catch — the scratch would hold the
 * old folder's journal while `db:generate` wrote to the new one. `'drizzle'` is
 * drizzle-kit's own default when the key is absent.
 */
const DRIZZLE_DIR = path.resolve(REPO_ROOT, drizzleConfig.out ?? 'drizzle');

/** Every file under `dir`, relative and sorted, with its bytes. */
async function snapshotOf(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  /* eslint-disable-next-line security/detect-non-literal-fs-filename -- a
     scratch directory this script created, never a caller-supplied path */
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    files.set(
      path.relative(dir, absolute).replaceAll('\\', '/'),
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- walked from a fixed in-repo directory, not from input
      await readFile(absolute, 'utf8')
    );
  }
  return files;
}

/**
 * Every `drizzle.config.ts` key that changes what `generate` emits, mapped to
 * its CLI flag.
 *
 * `--config` and `--out` are mutually exclusive (drizzle-kit's
 * `assertCollisions`), so the scratch run has to restate the config on the
 * command line. Restating it by hand is how the gate and `db:generate` drift
 * apart — a `casing` or `breakpoints` entry added later would make them compute
 * different diffs, and the gate would then report drift `db:generate` cannot
 * remove, or miss drift it should catch. So the values come from the config
 * module, and an unforwarded key is refused below rather than silently ignored.
 */
const GENERATE_FLAGS = {
  dialect: '--dialect',
  schema: '--schema',
  driver: '--driver',
  casing: '--casing',
  breakpoints: '--breakpoints',
} as const;

/**
 * Config keys `generate` ignores — `prepareGenerateConfig` reads only `schema`,
 * `out`, `dialect`, `driver`, `casing`, `breakpoints` and `migrations.prefix`,
 * and `out` decides `DRIZZLE_DIR` above instead of a flag. Anything outside both
 * lists stops the check rather than being assumed harmless.
 */
const GENERATE_IRRELEVANT = new Set([
  'out',
  'dbCredentials',
  'verbose',
  'strict',
  'schemaFilter',
  'tablesFilter',
  'extensionsFilters',
  'entities',
  'introspect',
]);

const config: Record<string, unknown> = drizzleConfig;
const unforwarded = Object.keys(config).filter(
  (key) =>
    config[key] !== undefined &&
    !(key in GENERATE_FLAGS) &&
    !GENERATE_IRRELEVANT.has(key)
);
if (unforwarded.length > 0) {
  console.error(
    `drizzle.config.ts declares ${unforwarded.join(', ')}, which this check ` +
      'does not pass to its scratch `generate`. Add the flag to ' +
      '`GENERATE_FLAGS`, or list the key in `GENERATE_IRRELEVANT` if generate ' +
      'ignores it — otherwise this gate and `bun run db:generate` compute ' +
      'different diffs.'
  );
  process.exit(1);
}

/**
 * Under `node_modules/`, not the OS temp directory, for two reasons that both
 * bite: drizzle-kit resolves `--out` against `cwd`, and on Windows a temp
 * directory on another drive has no relative path to the repository — the
 * absolute one arrives doubled and generate writes nowhere, which reads as
 * "no drift". `node_modules/` is also the one writable place inside the
 * repository that neither git nor the unreachable-file scanner walks.
 *
 * Created rather than assumed: `bun install` does not make `node_modules/.cache`
 * — on this repository only a drizzle-kit run does, through jiti — so on a fresh
 * clone and in CI `mkdtemp` answered ENOENT before the `try` below could clean
 * anything up.
 */
const cacheDir = path.join(REPO_ROOT, 'node_modules', '.cache');
await mkdir(cacheDir, { recursive: true });
const scratch = await mkdtemp(path.join(cacheDir, 'schema-drift-'));

/**
 * The verdict is RETURNED, never exited from: `process.exit` inside the `try`
 * skips the `finally`, and every refusal below is the case where the scratch
 * directory most needs removing — it accumulated one per failed run.
 */
async function decide(): Promise<number> {
  await cp(DRIZZLE_DIR, scratch, { recursive: true });
  const before = await snapshotOf(scratch);

  // `--out` relative to `cwd`, not absolute: drizzle-kit resolves it against
  // the working directory, so an absolute Windows path arrives doubled.
  const generated = Bun.spawnSync(
    [
      'bunx',
      'drizzle-kit',
      'generate',
      ...Object.entries(GENERATE_FLAGS).flatMap(([key, flag]) =>
        config[key] === undefined ? [] : [flag, String(config[key])]
      ),
      '--out',
      path.relative(REPO_ROOT, scratch).replaceAll('\\', '/'),
    ],
    { cwd: REPO_ROOT, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
  );

  if (generated.exitCode !== 0) {
    console.error(
      'drizzle-kit generate failed, so drift could not be decided:\n' +
        generated.stdout.toString() +
        generated.stderr.toString()
    );
    return 1;
  }

  const after = await snapshotOf(scratch);
  const changed = [...after]
    .filter(([name, contents]) => before.get(name) !== contents)
    .map(([name]) => name);
  const removed = before
    .keys()
    .filter((name) => !after.has(name))
    .toArray();
  const drift = [...changed, ...removed].toSorted((a, b) =>
    a === b ? 0 : a < b ? -1 : 1
  );

  if (drift.length > 0) {
    console.error(
      'db/schema.ts and db/drizzle/ disagree. drizzle-kit would write:\n' +
        drift.map((name) => `  ${name}`).join('\n') +
        '\n\nRun `bun run db:generate`, review the SQL, and commit it with the ' +
        'schema change.'
    );
    return 1;
  }

  console.log('schema drift: none');
  return 0;
}

try {
  process.exitCode = await decide();
} finally {
  await rm(scratch, { force: true, recursive: true });
}
