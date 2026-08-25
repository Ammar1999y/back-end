/**
 * The tier runner: `bun tests/helpers/run.ts <unit|integration|process> [args…]`.
 *
 * This is not a test runner — `bun test` still runs the tests. It exists for
 * three jobs a preload cannot do:
 *
 * 1. **Provision once, sequentially.** A preload runs per worker, and under
 *    `--isolate` per FILE, so `CREATE DATABASE` there means N processes racing to
 *    clone one template — which PostgreSQL refuses outright while any connection
 *    to the template is open.
 * 2. **Drop at the end, exactly once, whatever happened.** A preload's `afterAll`
 *    fires more than once per worker (measured on Bun 1.4.0) and never at all
 *    when a worker is killed, so a drop registered there is both premature and
 *    unreliable. Here it is a `finally` around the child process.
 * 3. **Make the selection honest.** `bun test <path>` is a filename FILTER, not a
 *    path: a test file outside the filter is skipped silently with exit 0, which
 *    is how `bun run test` came to run ten files while `ci.yml` believed it ran
 *    the suite. This runner fails when its tier matched nothing, and
 *    `tests/unit/harness-layout.test.ts` asserts every file under `tests/` lives
 *    in a tier some script runs.
 *
 * Every database it creates is named from a run token unique to this invocation,
 * so several agents can run the suite at once without truncating each other's
 * tables — the failure mode a worker-index name produces, and it looks like a
 * flaky assertion rather than a name collision.
 */
/* eslint-disable unicorn/no-process-exit -- CLI entry point: the exit code IS
   this tool's result contract, which is the case the rule excepts */
import { SQL } from 'bun';
import path from 'node:path';

import { loadTestEnv } from './env-file';
import { newRunToken } from './names';
import {
  adminUrl,
  createWorkerDatabases,
  dropWorkerDatabases,
  ensureTemplate,
  maxWorkers,
  reclaimStale,
} from './provision';

const REPO_ROOT = path.join(import.meta.dir, '..', '..');

interface Tier {
  /** Needs PostgreSQL, and therefore the database preload. */
  database: boolean;
  /** Extra `bun test` flags. */
  flags: readonly string[];
  /** How many worker databases to provision. */
  workers: 'auto' | 1;
  /**
   * `development` for the database tiers: it is what makes `/api/dev/sign-up`
   * reachable (the real seeding path), what lets `lib/captcha.ts` accept a token
   * against Cloudflare's published test secret, and what matches the branch a
   * developer's own process takes. `bun test` forces `NODE_ENV=test` unless the
   * process environment says otherwise — an env FILE cannot override it
   * (measured), so it has to be passed here.
   */
  nodeEnv: string;
}

const TIERS: Record<string, Tier> = {
  /**
   * `--isolate` on the unit tier and nowhere else. It gives each file a fresh
   * module registry, which is the only thing that contains a `mock.module` — the
   * mocks live here, and `mock.restore()` does not undo one (measured on Bun
   * 1.4.0). It costs a preload run per file, which is free without a database and
   * would be a clone per file with one.
   */
  unit: { database: false, flags: ['--isolate'], workers: 1, nodeEnv: 'test' },
  /**
   * `--parallel` for wall-clock, `--no-isolate` so the preload — and therefore
   * the database handshake — runs once per worker instead of once per file.
   *
   * No `--concurrent` and no `--max-concurrency`: tests inside one file share a
   * database and a rate-limit file, so running them concurrently makes every
   * counter assertion order-dependent. Parallelism belongs at the file level,
   * where each worker has its own state.
   */
  integration: {
    database: true,
    flags: ['--no-isolate'],
    workers: 'auto',
    nodeEnv: 'development',
  },
  /**
   * Serial. Every test here owns a real socket, a real child process or a real
   * file lock, and two of them competing for a port is a failure with nothing to
   * do with the assertion.
   */
  process: { database: true, flags: [], workers: 1, nodeEnv: 'development' },
};

const [tierName, ...forwarded] = process.argv.slice(2);
const tier = tierName ? TIERS[tierName] : undefined;
if (!tier || !tierName) {
  console.error(
    `usage: bun tests/helpers/run.ts <${Object.keys(TIERS).join('|')}> [name] [bun test flags…]`
  );
  process.exit(2);
}

/**
 * A forwarded NAME narrows the run to one file; forwarded FLAGS are passed on.
 *
 * They have to be told apart, and the reason is a real trap. `bun test` UNIONS
 * its positional filters, so appending the tier path next to a forwarded name
 * matched both — `run.ts integration retention-sweep` ran the whole tier, and
 * Bun's own echo showed why: `Args: … "retention-sweep" "tests/integration"`.
 * The narrower filter has to REPLACE the tier path, not sit beside it, and
 * `tests/<tier>/<name>` is still tier-scoped because it contains the tier path.
 *
 * This matters beyond convenience: with no way to run one file, a single file
 * that exhausts memory or hangs takes the whole tier down with it and there is
 * no way to bisect.
 */
const forwardedFlags = forwarded.filter((argument) => argument.startsWith('-'));
const forwardedNames = forwarded.filter(
  (argument) => !argument.startsWith('-')
);
if (forwardedNames.length > 1) {
  console.error(
    `expected at most one file name to narrow to, got: ${forwardedNames.join(', ')}`
  );
  process.exit(2);
}
const selection = forwardedNames[0]
  ? `tests/${tierName}/${forwardedNames[0]}`
  : `tests/${tierName}`;

loadTestEnv();

const runToken = newRunToken(
  Date.now(),
  Math.random().toString(36).slice(2, 8)
);

/**
 * Provisioning state, in one holder so `teardown` can run from a `finally` that
 * does not know how far `provision` got. A crashed provision must still drop the
 * databases it had already created.
 */
const run: { admin: SQL | null; created: string[] } = {
  admin: null,
  created: [],
};

async function provision(): Promise<string[]> {
  const admin = new SQL(adminUrl(), { max: 1 });
  run.admin = admin;

  const reclaimed = await reclaimStale(admin, Date.now());
  if (reclaimed.length > 0)
    console.log(`reclaimed ${reclaimed.length} abandoned harness database(s)`);

  await ensureTemplate(admin);

  const budget = await maxWorkers(admin);
  const requested =
    tier?.workers === 'auto' ? Number(process.env.TEST_WORKERS ?? 4) : 1;
  const workers = Math.max(1, Math.min(requested, budget));
  if (workers < requested)
    console.log(
      `capped at ${workers} worker(s): the server's max_connections leaves room for ${budget}`
    );

  return createWorkerDatabases(admin, runToken, workers);
}

async function teardown(): Promise<void> {
  const { admin, created } = run;
  if (!admin) return;
  if (created.length > 0) {
    const failed = await dropWorkerDatabases(admin, created);
    if (failed.length > 0)
      console.warn(
        `could not drop: ${failed.join(', ')} — \`bun run test:db:reset\` clears them`
      );
  }
  await admin.close();
  run.admin = null;
  run.created = [];
}

let exitCode = 1;
try {
  if (tier.database) run.created = await provision();

  const flags = [...tier.flags];
  if (tier.database) {
    if (run.created.length > 1) flags.push(`--parallel=${run.created.length}`);
    flags.push('--preload', './tests/helpers/preload-database.ts');
  }

  const child = Bun.spawn(
    ['bun', 'test', '--no-env-file', ...flags, ...forwardedFlags, selection],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NODE_ENV: tier.nodeEnv,
        ...(tier.database && { HARNESS_RUN_TOKEN: runToken }),
      },
      stdio: ['inherit', 'inherit', 'inherit'],
    }
  );

  // Ctrl-C must still reach the teardown below rather than orphaning N databases.
  const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));

  exitCode = await child.exited;
} finally {
  await teardown();
}

process.exit(exitCode);
