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
   * Extra environment for the child, layered UNDER `NODE_ENV`.
   *
   * For configuration a test cannot set for itself because it is read at module
   * load — the two-factor method list is the case that needed it.
   */
  env?: Readonly<Record<string, string>>;
  /**
   * `development` for the database tiers: it is what makes `/api/dev/sign-up`
   * reachable (the real seeding path), what lets `lib/captcha.ts` accept a token
   * against Cloudflare's published test secret, and what matches the branch a
   * developer's own process takes. `bun test` forces `NODE_ENV=test` unless the
   * process environment says otherwise — an env FILE cannot override it
   * (measured), so it has to be passed here.
   */
  nodeEnv: string;
  /**
   * Run the tier once PER configuration, in one child each.
   *
   * The two-factor configuration is read at module load — the allow-list, and
   * therefore which paths exist at all, is derived from it — so a test cannot
   * change it and a single child can only ever exercise one deployment. That is
   * exactly how an empty method list came to remove enforcement from
   * `/sign-in/email` while `/passwordless/verify` kept refusing, with every
   * suite green: the suite proved ONE deployment works.
   */
  configurations?: readonly { name: string; env: Record<string, string> }[];
}

/**
 * The two-factor configuration both code tiers run under.
 *
 * Declared once and shared, because a tier that disagreed with another about
 * which methods exist would make the same assertion pass in one and fail in the
 * other for a reason no test names.
 *
 * Both OTP channels while account recovery stays on `email`, so the tier covers
 * BOTH sides of the recovery-overlap rule with one configuration: an `otp/sms`
 * enrolment is a different possession from an emailed recovery code and an
 * `otp/email` one is not. `sms` alone made the overlap unreachable — every
 * `otp/email` fixture was outside the enabled channel list, so the refusal it
 * asserted came from the method never being offered at all.
 */
const TWO_FACTOR_TEST_ENV: Readonly<Record<string, string>> = {
  NEXT_PUBLIC_ENABLED_2FA_METHODS: 'totp,backup_code,otp,passkey',
  NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS: 'email,sms',
};

const TIERS: Record<string, Tier> = {
  /**
   * `--isolate` on the unit tier and nowhere else. It gives each file a fresh
   * module registry, which is the only thing that contains a `mock.module` — the
   * mocks live here, and `mock.restore()` does not undo one (measured on Bun
   * 1.4.0). It costs a preload run per file, which is free without a database and
   * would be a clone per file with one.
   */
  unit: {
    database: false,
    flags: ['--isolate'],
    workers: 1,
    nodeEnv: 'test',
    // Same reason as the integration tier: read at module load, so it cannot be
    // set per test. The offered-method intersection has the enabled set as one
    // of its three terms, and with none configured every case is vacuously empty.
    env: TWO_FACTOR_TEST_ENV,
  },
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
    /**
     * Two-factor configuration is read at MODULE LOAD — the allow-list, and
     * therefore which Better Auth paths exist at all, is derived from it — so it
     * cannot be set per file or per test. It is declared here, in committed
     * code, rather than in the gitignored `.env.test`: the suite asserts the
     * behaviour of a configured deployment, and a machine-local file would let
     * that behaviour differ between developers.
     *
     * Existing tests are unaffected because a seeded user has
     * `two_factor_enabled = false`, so no challenge is issued for them.
     */
    env: TWO_FACTOR_TEST_ENV,
  },
  /**
   * Serial. Every test here owns a real socket, a real child process or a real
   * file lock, and two of them competing for a port is a failure with nothing to
   * do with the assertion.
   */
  process: { database: true, flags: [], workers: 1, nodeEnv: 'development' },
  /**
   * The configuration matrix. One child per row, serially, against one worker
   * database that each row resets.
   *
   * The rows are the SUPPORTED deployments, not a sample: an empty method list,
   * each method alone, and each OTP channel. `TWO_FACTOR_MATRIX` names the row
   * to the test file, which is what lets one file assert a different contract
   * per configuration rather than the intersection of all of them.
   */
  matrix: {
    database: true,
    flags: ['--no-isolate'],
    workers: 1,
    nodeEnv: 'development',
    // The outbox, not stubbed providers: this is the tier that runs every OTP
    // channel, so it is where the delivered text per channel and purpose is
    // asserted. The integration tier keeps the provider stubs, because several
    // of its files assert on the provider CALL itself.
    env: { OTP_DELIVERY: 'outbox' },
    configurations: [
      {
        name: 'disabled',
        env: {
          NEXT_PUBLIC_ENABLED_2FA_METHODS: '',
          NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS: '',
        },
      },
      {
        name: 'totp-only',
        env: {
          NEXT_PUBLIC_ENABLED_2FA_METHODS: 'totp',
          NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS: '',
        },
      },
      {
        name: 'backup-only',
        env: {
          NEXT_PUBLIC_ENABLED_2FA_METHODS: 'backup_code',
          NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS: '',
        },
      },
      {
        name: 'passkey-only',
        env: {
          NEXT_PUBLIC_ENABLED_2FA_METHODS: 'passkey',
          NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS: '',
        },
      },
      {
        name: 'otp-email',
        env: {
          NEXT_PUBLIC_ENABLED_2FA_METHODS: 'otp,totp',
          NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS: 'email',
        },
      },
      {
        name: 'otp-whatsapp',
        env: {
          NEXT_PUBLIC_ENABLED_2FA_METHODS: 'otp,totp',
          NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS: 'whatsapp',
        },
      },
    ],
  },
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

  // One child per configuration, or one child. A row is a whole `bun test`
  // process because the configuration is read at module load.
  const rows = tier.configurations ?? [{ name: '', env: {} }];
  exitCode = 0;
  for (const row of rows) {
    if (row.name) console.log(`\n── configuration: ${row.name} ──`);
    const child = Bun.spawn(
      ['bun', 'test', '--no-env-file', ...flags, ...forwardedFlags, selection],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          ...tier.env,
          ...row.env,
          ...(row.name && { TWO_FACTOR_MATRIX: row.name }),
          NODE_ENV: tier.nodeEnv,
          ...(tier.database && { HARNESS_RUN_TOKEN: runToken }),
        },
        stdio: ['inherit', 'inherit', 'inherit'],
      }
    );

    // Ctrl-C must still reach the teardown below rather than orphaning N
    // databases.
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
    process.on('SIGINT', forward('SIGINT'));
    process.on('SIGTERM', forward('SIGTERM'));

    const code = await child.exited;
    // Every row runs: stopping at the first failure hides which OTHER
    // configurations are broken, and that inventory is the whole point.
    if (code !== 0) exitCode = code;
  }
} finally {
  await teardown();
}

process.exit(exitCode);
