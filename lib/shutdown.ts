import { errorClassOf } from '@/utils';

/**
 * The one place the shutdown timing lives. `server.ts` applies it, the startup
 * log reports it, and `tests/unit/shutdown-coordinator.test.ts` checks the
 * runbook's copy of it against these values.
 */
export const SHUTDOWN_POLICY = {
  /** Added on top of the longest request ceiling; the orchestrator's grace must exceed the total. */
  headroomSeconds: 15,
  /** How long `app.stop()` may wait on half-sent connections before `app.stop(true)`. */
  gracefulStopMs: 5000,
} as const;

export function shutdownTimeoutMs(input: {
  idleTimeoutSeconds: number;
  maxRouteTimeoutSeconds: number;
}): number {
  return (
    (Math.max(input.idleTimeoutSeconds, input.maxRouteTimeoutSeconds) +
      SHUTDOWN_POLICY.headroomSeconds) *
    1000
  );
}

export interface ShutdownDeps {
  /** Stops accepting requests and drains or closes the ones in flight. */
  stopServer: () => Promise<void>;
  /** Prevents further sweep firings and waits for a running one; true when idle. */
  stopSweeps: (timeoutMs: number) => Promise<boolean>;
  /** Waits for queued post-response work; true when the queue is observably empty. */
  drainAfterResponse: (timeoutMs: number) => Promise<boolean>;
  pendingAfterResponse: () => number;
  /** Attempts every store and rejects if any failed to close. */
  closeStores: () => Promise<void>;
  exit: (code: number) => void;
  log: (line: Record<string, unknown>) => void;
  error: (line: Record<string, unknown>) => void;
  now?: () => number;
}

/**
 * The shutdown coordinator, with its dependencies injected so the sequence can
 * be driven in a test without a socket or a signal.
 *
 * The contract: the stop is clean when both drains have POSITIVELY reported
 * quiescence and the stores have closed before the forced-exit deadline;
 * anything still unproven at the deadline is reported and the exit code is 1.
 * "Positively reported" is the drain's own proof, not the instant the work
 * ended — the after-response queue, for one, has to observe itself empty for
 * `AFTER_RESPONSE_SETTLE_MS` before it says so — so work that ends inside that
 * last interval is still a forced exit. Both drains are advisory — neither
 * cancels the work it waits for — so a timed-out drain means a callback may
 * still touch a store, and the stores are closed ONLY on that proof. The drains
 * share the whole budget rather than fixed slices or a reserved tail: a slice
 * sized from one task's nominal duration reported failed deployments for tasks
 * that merely ran long, and a reserved tail stopped observing work that went
 * idle inside it. A phase that faulted — the server stop, a store close — is
 * likewise never an exit 0, however far the sequence then gets.
 *
 * A fault that arrives while a shutdown is already running cannot restart the
 * sequence, but it must not be forgotten either: the highest exit code any call
 * asked for, or any phase failure raised, is the one the process ends with.
 */
export function createShutdown(
  deps: ShutdownDeps,
  timeouts: { shutdownMs: number }
): (signal: string, exitCode?: number) => Promise<void> {
  const now = deps.now ?? Date.now;
  const state = { started: false, exitCode: 0 };

  return async function shutdown(signal, exitCode = 0) {
    state.exitCode = Math.max(state.exitCode, exitCode);
    if (state.started) {
      deps.log({ msg: 'shutdown already in progress', signal, exitCode });
      return;
    }
    state.started = true;
    const startedAt = now();
    const deadline = startedAt + timeouts.shutdownMs;

    deps.log({ msg: 'server stopping', signal });

    // Once, whichever path gets there first: the timer when the loop is free, or
    // the sequence itself when a step held the loop past the deadline — a timer
    // cannot preempt synchronous work, and a continuation that then finds the
    // budget spent must not take the clean path on the strength of a check that
    // never ran.
    const forcedState = { done: false };
    const forceExit = () => {
      if (forcedState.done) return;
      forcedState.done = true;
      clearTimeout(forced);
      deps.error({
        msg: 'forced shutdown',
        signal,
        pendingAfterResponse: deps.pendingAfterResponse(),
      });
      deps.exit(1);
    };
    const forced = setTimeout(forceExit, timeouts.shutdownMs);

    const remaining = () => Math.max(0, deadline - now());
    const overdue = () => now() >= deadline;

    const quiesced = { sweeps: false, afterResponse: false };

    // Its own boundary: a faulted stop must not skip the drains, or the guard
    // below holds the stores open with nothing in flight and the forced exit
    // reports a crash a whole budget later. Continuing to the stores is safe on
    // this path because `Bun.Server.stop()` closes the listening socket when it
    // is CALLED — measured on Bun 1.4.0: a connection attempted while the
    // returned promise was still pending was refused — so a later rejection
    // never means the listener is still admitting requests. It does mean the
    // stop did not complete cleanly, so the exit code says so.
    try {
      await deps.stopServer();
    } catch (error) {
      state.exitCode = Math.max(state.exitCode, 1);
      deps.error({
        msg: 'server stop failed',
        errorClass: errorClassOf(error),
      });
    }

    try {
      quiesced.sweeps = await deps.stopSweeps(remaining());
      quiesced.afterResponse = await deps.drainAfterResponse(remaining());
      if (!quiesced.afterResponse)
        deps.error({
          msg: 'after-response drain timed out',
          pendingAfterResponse: deps.pendingAfterResponse(),
        });
    } catch (error) {
      deps.error({ msg: 'shutdown error', errorClass: errorClassOf(error) });
    }

    if (!quiesced.sweeps || !quiesced.afterResponse || overdue()) {
      deps.error({
        msg: 'stores left open for forced exit',
        signal,
        sweepsDrained: quiesced.sweeps,
        afterResponseDrained: quiesced.afterResponse,
        pendingAfterResponse: deps.pendingAfterResponse(),
        forcedInMs: remaining(),
      });
      if (overdue()) forceExit();
      return;
    }

    // `closeStores` attempts every store and reports the ones that failed; an
    // unclosed store is not the clean exit this contract promises.
    try {
      await deps.closeStores();
    } catch (error) {
      state.exitCode = Math.max(state.exitCode, 1);
      deps.error({
        msg: 'stores did not close cleanly',
        errorClass: errorClassOf(error),
      });
    }

    // The contract is "closed BEFORE the deadline"; a close that finished after
    // it is reported as the bound it exceeded, not as a clean stop.
    if (overdue()) {
      forceExit();
      return;
    }

    clearTimeout(forced);
    deps.log({ msg: 'server stopped', signal, exitCode: state.exitCode });
    deps.exit(state.exitCode);
  };
}
