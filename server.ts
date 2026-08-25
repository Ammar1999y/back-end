/* eslint-disable unicorn/no-process-exit -- this IS the process entry point: a
   rejected runtime must exit non-zero before anything serves, and a completed
   shutdown must end the process rather than throw into nothing. */
/**
 * Entry point: validate the runtime, then start the app.
 *
 * This file deliberately imports NOTHING from the application at module scope.
 * Static imports are hoisted and evaluated before any entry-point code runs, so
 * a `NODE_ENV` check written at the top of a file that imports `@/lib/auth`
 * would run AFTER `lib/env.server.ts` had already decided whether this was
 * production. The application is loaded by dynamic import, below the checks.
 *
 * `bun server.ts` is still the whole command — the split is internal, so no
 * deployment start command changes.
 */
import { version as bunVersion } from 'bun';
import { Database } from 'bun:sqlite';

import packageManifest from './package.json';

/**
 * The three modes this application recognises.
 *
 * `next start` used to set the runtime mode itself; `bun server.ts` does not.
 * Every production-only guard in this codebase is an exact string comparison
 * against `'production'` — the Better Auth secret floor, the Turnstile secret
 * requirement, the absolute-SQLITE_DIR rule, HSTS — so `NODE_ENV=prodution`
 * silently disabled all four at once while the server still booted and served
 * traffic. Reproduced. An unset value did the same thing, because the logger
 * reported the missing value as `development` and nothing else looked.
 *
 * So an unrecognised value is fatal, and it is fatal HERE, before the modules
 * that read it exist.
 */
const VALID_NODE_ENV = new Set(['development', 'test', 'production']);

/**
 * The tested Bun version, read from the one place it is written.
 *
 * This does not breach the rule at the top of the file: `package.json` is data,
 * not application code — importing it evaluates no module and reads no
 * environment. The literal `'1.4.0'` that used to sit here breached something
 * else, which is why it is gone: it was a third copy of the pin, alongside
 * `packageManager` and `scripts/require-bun.mjs`, and all three had to be
 * remembered together or the deployed runtime and the installed one silently
 * disagreed.
 *
 * `''` when the field is malformed — `assertBunVersion` treats that as fatal
 * rather than as "no pin", because an unparsed pin is not the same as no pin.
 */
const EXPECTED_BUN_VERSION =
  /^bun@(\d+\.\d+\.\d+)$/.exec(packageManifest.packageManager)?.[1] ?? '';

/** Leading `major.minor.patch`, ignoring any `-canary.…` tail. */
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)/;

/**
 * The conservative floor for the WAL-reset race — see the SQLite notice linked
 * from `reports/coolify-deployment.md` §6. `bun:sqlite` links SQLite into the
 * Bun binary, so this is a property of the deployed runtime rather than of a
 * pinned npm package, and nothing but an assertion can catch drift.
 */
const MIN_SQLITE_VERSION = [3, 51, 3] as const;

function fail(message: string): never {
  console.error(JSON.stringify({ msg: 'startup rejected', reason: message }));
  process.exit(1);
}

function requireNodeEnv(): string {
  const value = process.env.NODE_ENV;
  if (value === undefined || value === '')
    fail(
      'NODE_ENV is not set. Set it to exactly one of development, test, production ' +
        '— the production security guards are exact string comparisons and an unset ' +
        'value silently selects the development posture.'
    );
  if (!VALID_NODE_ENV.has(value))
    fail(
      `NODE_ENV must be exactly one of development, test, production. Received: "${value}".`
    );
  return value;
}

/**
 * A port, or nothing.
 *
 * `Number(process.env.PORT)` accepted `''` as 0, `'3000abc'` as NaN and
 * `'3000.5'` as a float. Bun then binds an ephemeral or clamped port while the
 * startup log reports the requested value — so the log lies to the operator
 * about where the server is.
 */
function requirePort(): number {
  const raw = process.env.PORT?.trim();
  if (!raw) return 3000;
  if (!/^\d+$/.test(raw))
    fail(`PORT must be a decimal integer. Received: "${raw}".`);
  const port = Number(raw);
  if (port < 1 || port > 65_535)
    fail(`PORT must be between 1 and 65535. Received: ${port}.`);
  return port;
}

/** `true` when `running` is at or above `floor`, compared field by field. */
function atLeast(running: number[], floor: number[]): boolean {
  for (const [index, value] of floor.entries()) {
    const actual = running[index] ?? 0;
    if (actual > value) return true;
    if (actual < value) return false;
  }
  return true;
}

/**
 * Refuses a Bun OLDER than the tested pin, and warns about anything newer.
 *
 * A FLOOR, not an equality check, and the difference is deliberate. BOTH
 * database drivers are compiled into the binary, so their transaction semantics
 * travel with the Bun version rather than with a lockfile entry. `bun:sqlite` is
 * the older reason. `bun:sql` is the sharper one: through 1.3.x a simple-protocol
 * query running concurrently with a not-yet-prepared parameterized query on the
 * same connection could deliver one query's rows to the other, and the `BEGIN`,
 * `COMMIT` and `ROLLBACK` that `db.transaction()` issues ARE simple-protocol
 * queries (Bun #32772, fixed in 1.4.0). Below the pin, every transaction in the
 * application is exposed to that — so below the pin is fatal.
 *
 * Above the pin is a warning. That is a deliberate relaxation of what this
 * function used to do, which was to refuse any differing MINOR in either
 * direction: a developer who had upgraded Bun could not boot the project, and an
 * image that moved forward turned a routine bump into an outage. Newer is
 * untested, not known-broken, and the whole install path
 * (`scripts/require-bun.mjs`) now treats the pin as a floor too — a boot check
 * that disagreed with the install check would just be a second, contradictory
 * policy. The drift is logged so the operator can read what is actually running
 * rather than infer it.
 */
function assertBunVersion(): void {
  if (!EXPECTED_BUN_VERSION)
    fail(
      `package.json declares packageManager "${packageManifest.packageManager}". ` +
        'It must read exactly bun@<major>.<minor>.<patch> — it is the only source ' +
        'for the tested runtime version, read here and by scripts/require-bun.mjs.'
    );

  if (bunVersion === EXPECTED_BUN_VERSION) return;

  const running = VERSION_PATTERN.exec(bunVersion);
  if (!running)
    fail(
      `Bun reports version "${bunVersion}", which is not major.minor.patch. ` +
        `The tested version is ${EXPECTED_BUN_VERSION} and this cannot be compared to it.`
    );

  const parts = [Number(running[1]), Number(running[2]), Number(running[3])];
  const floor = EXPECTED_BUN_VERSION.split('.').map(Number);

  if (!atLeast(parts, floor))
    fail(
      `Bun ${bunVersion} is older than the tested ${EXPECTED_BUN_VERSION}. ` +
        'Both database drivers are compiled into the runtime, so this is a ' +
        'transaction-correctness floor and not a preference — see Bun #32772. ' +
        `Upgrade the image, or run: bun run check:runtime`
    );

  console.warn(
    JSON.stringify({
      msg: 'bun version ahead of the tested pin',
      running: bunVersion,
      tested: EXPECTED_BUN_VERSION,
    })
  );
}

function assertSqliteVersion(): void {
  const db = new Database(':memory:');
  let version: string;
  try {
    const statement = db.prepare<{ v: string }, []>(
      'SELECT sqlite_version() AS v'
    );
    version = statement.get()?.v ?? '';
    statement.finalize();
  } finally {
    db.close(true);
  }

  const parts = version.split('.').map(Number);
  for (const [index, expected] of MIN_SQLITE_VERSION.entries()) {
    const actual = parts[index] ?? 0;
    if (actual > expected) return;
    if (actual < expected)
      fail(
        `SQLite ${version} is below the ${MIN_SQLITE_VERSION.join('.')} floor for the ` +
          'WAL-reset race. It ships with the Bun binary; change the image, not a package.'
      );
  }
}

const nodeEnv = requireNodeEnv();
const port = requirePort();
assertBunVersion();
assertSqliteVersion();

// Only now. Everything below this line reads a validated NODE_ENV.
const { app, MAX_REQUEST_BODY_BYTES, MAX_ROUTE_TIMEOUT_SECONDS } =
  await import('./app');
const { drainAfterResponse, pendingAfterResponse } =
  await import('./lib/http/after-response');
const { closeRateLimitStore } = await import('./lib/rate-limit/store');
const { closeCacheStore } = await import('./lib/cache');
const { closeDatabase } = await import('./db');

/** Keeps the global request ceiling explicit for route and shutdown coordination. */
const IDLE_TIMEOUT_SECONDS = 60;

/**
 * Covers the larger request ceiling, plus time for post-response work and store
 * shutdown. The orchestrator's grace period must exceed this value.
 */
const SHUTDOWN_TIMEOUT_MS =
  (Math.max(IDLE_TIMEOUT_SECONDS, MAX_ROUTE_TIMEOUT_SECONDS) + 15) * 1000;

const AFTER_RESPONSE_DRAIN_MS = 10_000;

app.listen({ port, idleTimeout: IDLE_TIMEOUT_SECONDS }, (server) => {
  console.log(
    JSON.stringify({
      msg: 'server started',
      // Report the bound port because the kernel may choose it.
      port: server.port,
      hostname: server.hostname,
      env: nodeEnv,
      bun: bunVersion,
      idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
      maxRouteTimeoutSeconds: MAX_ROUTE_TIMEOUT_SECONDS,
      maxRequestBodyBytes: MAX_REQUEST_BODY_BYTES,
      // Logs the effective value for deployment configuration.
      shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
    })
  );
});

const shutdownState = { started: false };

/** Drains in-flight requests on container signals before closing their stores. */
async function shutdown(signal: string): Promise<void> {
  if (shutdownState.started) return;
  shutdownState.started = true;

  console.log(JSON.stringify({ msg: 'server stopping', signal }));

  // Keep this timer referenced so a hung drain cannot appear successful.
  const forced = setTimeout(() => {
    console.error(
      JSON.stringify({
        msg: 'forced shutdown',
        signal,
        pendingAfterResponse: pendingAfterResponse(),
      })
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    await app.stop();
    const drained = await drainAfterResponse(AFTER_RESPONSE_DRAIN_MS);
    // Post-response loss is logged but does not turn a completed drain into a
    // failed deployment.
    if (!drained)
      console.error(
        JSON.stringify({
          msg: 'after-response drain timed out',
          pendingAfterResponse: pendingAfterResponse(),
        })
      );
  } catch (error) {
    console.error(
      JSON.stringify({
        msg: 'shutdown error',
        errorClass: (error as { name?: string })?.name ?? 'Unknown',
      })
    );
  } finally {
    // PostgreSQL may still wait for in-flight queries, so close it first.
    await closeStore('postgres', closeDatabase);
    await closeStore('rate-limit', closeRateLimitStore);
    await closeStore('cache', closeCacheStore);
  }

  clearTimeout(forced);
  console.log(JSON.stringify({ msg: 'server stopped', signal }));
  process.exit(0);
}

async function closeStore(
  name: string,
  close: () => void | Promise<void>
): Promise<void> {
  try {
    await close();
  } catch (error) {
    console.error(
      JSON.stringify({
        msg: 'store close failed',
        store: name,
        errorClass: (error as { name?: string })?.name ?? 'Unknown',
      })
    );
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    void shutdown(signal);
  });
