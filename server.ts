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

/** Bun's own pin, so the expected version has exactly one home. */
const EXPECTED_BUN_VERSION = '1.3.14';

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

/**
 * Refuses a runtime whose Bun minor differs from the tested one.
 *
 * Minor, not patch: `bun:sqlite` is compiled into the binary, so transaction and
 * locking semantics travel with the Bun version rather than with a lockfile
 * entry — and that is a minor-version concern. A patch difference is logged
 * loudly instead of being fatal, because deployment images move on patch
 * releases routinely and refusing to boot for one would trade a real outage for
 * a theoretical drift.
 */
function assertBunVersion(): void {
  if (bunVersion === EXPECTED_BUN_VERSION) return;

  const [major, minor] = bunVersion.split('.', 2);
  const [expectedMajor, expectedMinor] = EXPECTED_BUN_VERSION.split('.', 2);

  if (major !== expectedMajor || minor !== expectedMinor)
    fail(
      `Bun ${bunVersion} does not match the tested ${EXPECTED_BUN_VERSION}. ` +
        'bun:sqlite is compiled into the runtime, so this changes database ' +
        'semantics. Pin the image, or update packageManager, bun.lock and ' +
        'EXPECTED_BUN_VERSION together after re-running the suite.'
    );

  console.warn(
    JSON.stringify({
      msg: 'bun patch version drift',
      running: bunVersion,
      expected: EXPECTED_BUN_VERSION,
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

/**
 * The server-wide request ceiling.
 *
 * Set explicitly rather than inherited: Elysia defaults `Bun.serve`'s
 * `idleTimeout` to 30 seconds and Node/Next had no per-request equivalent, so
 * the migration introduced a ceiling nobody chose. Measured on the pinned
 * versions: a 35-second handler had its connection dropped at 32.1 s with an
 * empty reply and no error body.
 *
 * 60 is a deliberate placeholder, not a measurement — the value that belongs
 * here depends on the target VPS, which is recorded in `TODO.md`. Routes that
 * legitimately outlast it raise their own ceiling per request; see
 * `routes.ts`.
 */
const IDLE_TIMEOUT_SECONDS = 60;

/**
 * How long a stop waits before it stops being polite.
 *
 * DERIVED from the longest a request may legitimately run, not a round number.
 * A forced exit below that ceiling is not a drain: it aborts precisely the long
 * request the timeout exists to permit — the upload route allows 120 s while a
 * flat 15 s bound would kill it at 15. The `+ 15 s` covers the post-response
 * queue and the store closes after the last request finishes.
 *
 * BOTH ceilings are in the max, and the second one is not decoration. Every route
 * that does not set its own `timeoutSeconds` may still run for
 * `IDLE_TIMEOUT_SECONDS`, so the per-route maximum alone is only the right answer
 * while it happens to be the larger of the two. It is today (120 > 60) — but the
 * runbook tells the operator that the lever for a shorter deploy window is the
 * upload ceiling, and taking that advice to 30 s would have produced a 45 s bound
 * against a global ceiling that still permits 60 s. That is the original defect
 * re-entering through the documented fix for it.
 *
 * The consequence is operational and belongs in the runbook: the orchestrator's
 * stop grace period must exceed this number, and it is logged at startup so the
 * operator can read it rather than infer it. Lowering EITHER ceiling lowers this
 * bound with it; lowering this bound directly silently reintroduces the abort.
 */
const SHUTDOWN_TIMEOUT_MS =
  (Math.max(IDLE_TIMEOUT_SECONDS, MAX_ROUTE_TIMEOUT_SECONDS) + 15) * 1000;

/** The post-response queue gets the tail of the window, not half of a guess. */
const AFTER_RESPONSE_DRAIN_MS = 10_000;

app.listen({ port, idleTimeout: IDLE_TIMEOUT_SECONDS }, (server) => {
  console.log(
    JSON.stringify({
      msg: 'server started',
      // The BOUND port, not the requested one. They differ whenever the kernel
      // assigns one, and the requested value is the number that misleads.
      port: server.port,
      hostname: server.hostname,
      env: nodeEnv,
      bun: bunVersion,
      idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
      maxRouteTimeoutSeconds: MAX_ROUTE_TIMEOUT_SECONDS,
      maxRequestBodyBytes: MAX_REQUEST_BODY_BYTES,
      // The operator has to set a stop grace period longer than this. Logged
      // rather than documented-only, because a runbook drifts and a log line
      // states what the running process will actually do.
      shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
    })
  );
});

/**
 * Shutdown.
 *
 * Elysia wires only `process.on('beforeExit')`, which is not a container signal
 * handler, so nothing here previously responded to the SIGTERM that Coolify's
 * stop-first deployment sends: in-flight mutations, uploads and external calls
 * were terminated mid-flight. WAL keeps the database consistent; it does not
 * finish an application operation for the client, and an upload can reach R2
 * with no matching row.
 *
 * `app.stop()` — no argument — DRAINS in-flight requests. `app.stop(true)`
 * aborts them, which is the wrong default for a stop-first deploy. Measured on
 * the pinned versions: a request 300 ms into a 2 s handler completed with 200,
 * and `stop()` resolved only after it did.
 *
 * One measured caveat, which is why the explicit `process.exit(0)` below is not
 * optional. An earlier revision of this comment had the mechanism wrong and it is
 * worth stating the correction rather than quietly editing it, because the wrong
 * version argued for a different fix: `stop()` DOES close the listening socket —
 * a new connection is refused immediately after it resolves (re-measured on
 * `elysia@1.4.29`, whose `stop()` is a thin delegate to `Bun.serve`'s, and Bun
 * documents `stop()` as "prevent new connections from being accepted … does not
 * cancel in-flight requests").
 *
 * What survives is an ALREADY-ESTABLISHED keep-alive connection: a second request
 * written on a socket opened before the stop was still served after it resolved.
 * So requests can still arrive during the drain, which is what the settle loop in
 * `lib/http/after-response.ts` exists for — but they arrive on existing
 * connections, not through a still-open listener. The explicit exit remains, both
 * because those connections would otherwise hold the process past the grace
 * period and because it makes the outcome the same on any platform. Measured on
 * Windows; not re-measured on the Linux target.
 */
/**
 * Held on an object so the guard can be set from inside the handler without
 * assigning a module-level binding from a function.
 */
const shutdownState = { started: false };

async function shutdown(signal: string): Promise<void> {
  if (shutdownState.started) return;
  shutdownState.started = true;

  console.log(JSON.stringify({ msg: 'server stopping', signal }));

  // Bounded, and armed before the drain rather than after: a drain that hangs is
  // exactly the case this exists for.
  //
  // NOT `unref`'d, and that was a real defect rather than a style choice. An
  // unref'd timer does not hold the event loop open, so in the one shape this
  // timer exists for — `app.stop()` has resolved, the listener is closed, and
  // something after it never settles — there was no ref'd handle left and the
  // process exited **0** with no `forced shutdown` line and the store closes
  // below never run. Reproduced. `clearTimeout` on the clean path already stops
  // this from delaying a fast shutdown, which is the only thing `unref` was
  // buying.
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
    // Logged, and DELIBERATELY still an exit 0 — the one place this file treats
    // abandoned work as non-fatal. A timed-out drain means the access log lost
    // some lines, not that a request or a transaction was dropped: `app.stop()`
    // has already resolved, so every in-flight request completed. Exiting
    // non-zero here would make a routine deploy's stop phase look like a crash to
    // the orchestrator for the sake of a log line. The count is on the line so it
    // is visible if that trade ever stops being the right one — see
    // reports/coolify-deployment.md §12.2.
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
    // Close only what this process actually opened — neither helper creates a
    // database file in order to close it.
    closeStore('rate-limit', closeRateLimitStore);
    closeStore('cache', closeCacheStore);
  }

  clearTimeout(forced);
  console.log(JSON.stringify({ msg: 'server stopped', signal }));
  process.exit(0);
}

function closeStore(name: string, close: () => void): void {
  try {
    close();
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
