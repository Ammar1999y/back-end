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
import { errorClassOf } from './utils';
import {
  bunVersionVerdict,
  portVerdict,
  sqliteVersionVerdict,
} from './utils/startup';

/**
 * The three modes this application recognises.
 *
 * Nothing sets this for us — `bun server.ts` is the whole command. Every
 * production-only guard in this codebase is an exact string comparison against
 * `'production'`: the Better Auth secret floor, the Turnstile secret
 * requirement, the absolute-SQLITE_DIR rule, HSTS. So `NODE_ENV=prodution`
 * disables all four at once while the server boots and serves traffic
 * (reproduced), and an unset value selects the same posture.
 *
 * An unrecognised value is therefore fatal, and fatal HERE, before the modules
 * that read it exist. Asserted in `tests/process/startup-gates.test.ts`.
 */
const VALID_NODE_ENV = new Set(['development', 'test', 'production']);

/** The WAL-reset floor; the reason travels with `sqliteVersionVerdict`. */
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
 * The gate DECISIONS live in `utils/startup.ts`, as pure functions.
 *
 * What is left here is the wiring: read the value, ask for a verdict, `fail` on
 * a refusal. `assertBunVersion` and `assertSqliteVersion` read the running Bun
 * and the SQLite compiled into it, so a spawned child cannot vary either input
 * and neither had a single assertion; the verdicts are asserted in
 * `tests/unit/startup-gates-logic.test.ts` and the exit codes in
 * `tests/process/startup-gates.test.ts`.
 *
 * Importing `./utils/startup` does not breach the no-application-imports rule at
 * the top of this file, for the same reason importing `./package.json` does
 * not: it is a leaf with no environment reads and no module of its own to
 * evaluate.
 */
function requirePort(): number {
  const verdict = portVerdict(process.env.PORT);
  if (!verdict.ok) fail(verdict.reason);
  return verdict.port;
}

function assertBunVersion(): void {
  const verdict = bunVersionVerdict(bunVersion, packageManifest.packageManager);
  if (!verdict.ok) fail(verdict.reason);
  if (verdict.warning) console.warn(verdict.warning);
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

  const verdict = sqliteVersionVerdict(version, MIN_SQLITE_VERSION);
  if (!verdict.ok) fail(verdict.reason);
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
const { startSchedule } = await import('./lib/schedule');
const { acquireWriterLock } = await import('./lib/sqlite/writer-lock');
const { SQLITE_DIR } = await import('./lib/env.server');
const { createShutdown, SHUTDOWN_POLICY, shutdownTimeoutMs } =
  await import('./lib/shutdown');

// One instance per SQLITE_DIR, and it has to be claimed BEFORE `startSchedule`
// below: the two scheduled sweeps are registered per process and neither is safe
// to run twice against the same rows, so this lock is what elects their single
// owner. See both functions' own notes.
const writerLock = acquireWriterLock(SQLITE_DIR);

/** Keeps the global request ceiling explicit for route and shutdown coordination. */
const IDLE_TIMEOUT_SECONDS = 60;

/** The orchestrator's stop grace period must exceed this value. */
const SHUTDOWN_TIMEOUT_MS = shutdownTimeoutMs({
  idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
  maxRouteTimeoutSeconds: MAX_ROUTE_TIMEOUT_SECONDS,
});

// Half-sent requests can hold graceful stop open, so force-close after the grace.
async function stopServer(): Promise<void> {
  const graceful = app.stop();
  const timedOut = Symbol('graceful-stop-timeout');
  const timer = Bun.sleep(SHUTDOWN_POLICY.gracefulStopMs).then(() => timedOut);

  if ((await Promise.race([graceful, timer])) !== timedOut) return;

  console.error(
    JSON.stringify({
      msg: 'graceful stop timed out, closing active connections',
      graceMs: SHUTDOWN_POLICY.gracefulStopMs,
    })
  );
  await app.stop(true);
}

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
      // The effective shutdown timing, for the deployment's stop grace period.
      shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
      gracefulStopMs: SHUTDOWN_POLICY.gracefulStopMs,
    })
  );
});

const schedule = startSchedule();

/**
 * The sequence itself lives in `lib/shutdown.ts`, where a unit test drives it;
 * this is only the wiring to the real stop, sweeps, queue and stores.
 */
const shutdown = createShutdown(
  {
    stopServer,
    stopSweeps: schedule.stopAndDrain,
    drainAfterResponse,
    pendingAfterResponse,
    closeStores,
    exit: (code) => process.exit(code),
    log: (line) => console.log(JSON.stringify(line)),
    error: (line) => console.error(JSON.stringify(line)),
  },
  { shutdownMs: SHUTDOWN_TIMEOUT_MS }
);

const closeState = { done: false };
// One store's failure must not strand the others, but it must not be reported as
// a clean stop either: every close is attempted, then the failures are raised
// together for the coordinator's exit code.
async function closeStores(): Promise<void> {
  if (closeState.done) return;
  closeState.done = true;
  const failures = [
    await closeStore('postgres', closeDatabase),
    await closeStore('rate-limit', closeRateLimitStore),
    await closeStore('cache', closeCacheStore),
    // Keep ownership until every protected store has closed.
    await closeStore('writer-lock', writerLock.release),
  ].filter((failure) => failure !== null);

  if (failures.length > 0)
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `stores left open: ${failures.map((failure) => failure.store).join(', ')}`
    );
}

async function closeStore(
  name: string,
  close: () => void | Promise<void>
): Promise<{ store: string; error: unknown } | null> {
  try {
    await close();
    return null;
  } catch (error) {
    console.error(
      JSON.stringify({
        msg: 'store close failed',
        store: name,
        errorClass: errorClassOf(error),
      })
    );
    return { store: name, error };
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    void shutdown(signal);
  });

// Both sync and async escaped faults must use the store-draining shutdown path.
for (const event of ['unhandledRejection', 'uncaughtException'] as const)
  process.on(event, (error: unknown) => {
    console.error(
      JSON.stringify({
        msg: 'unhandled fault',
        event,
        errorClass: errorClassOf(error),
      })
    );
    void shutdown(event, 1);
  });
