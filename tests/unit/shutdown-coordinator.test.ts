/**
 * The shutdown coordinator, driven with injected dependencies and a budget of a
 * few hundred milliseconds.
 *
 * `server.ts` wires the same function to the real stop, sweeps, queue and
 * stores; this file is what ties the runbook's description of the sequence to
 * the code, and the last block checks the runbook's copy of the timing policy
 * against `SHUTDOWN_POLICY` itself.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  AFTER_RESPONSE_SETTLE_MS,
  drainAfterResponse,
  enqueueAfterResponse,
  pendingAfterResponse,
  runAfterResponse,
} from '@/lib/http/after-response';
import {
  createShutdown,
  SHUTDOWN_POLICY,
  shutdownTimeoutMs,
} from '@/lib/shutdown';

const BUDGET_MS = 400;

interface Harness {
  shutdown: (signal: string, exitCode?: number) => Promise<void>;
  exits: number[];
  logs: Record<string, unknown>[];
  errors: Record<string, unknown>[];
  calls: { closeStores: number; stopServer: number };
  sweepTimeouts: number[];
  drainTimeouts: number[];
  /** Resolves once `exit` has been called, or after the whole budget plus slack. */
  settled: () => Promise<void>;
}

function harness(
  overrides: {
    stopServer?: () => Promise<void>;
    stopSweeps?: (timeoutMs: number) => Promise<boolean>;
    drainAfterResponse?: (timeoutMs: number) => Promise<boolean>;
    closeStores?: () => Promise<void>;
  } = {}
): Harness {
  const exits: number[] = [];
  const logs: Record<string, unknown>[] = [];
  const errors: Record<string, unknown>[] = [];
  const calls = { closeStores: 0, stopServer: 0 };
  const sweepTimeouts: number[] = [];
  const drainTimeouts: number[] = [];
  const exited = Promise.withResolvers<void>();

  const shutdown = createShutdown(
    {
      stopServer: async () => {
        calls.stopServer += 1;
        await overrides.stopServer?.();
      },
      stopSweeps: async (timeoutMs) => {
        sweepTimeouts.push(timeoutMs);
        return overrides.stopSweeps ? overrides.stopSweeps(timeoutMs) : true;
      },
      drainAfterResponse: async (timeoutMs) => {
        drainTimeouts.push(timeoutMs);
        return overrides.drainAfterResponse
          ? overrides.drainAfterResponse(timeoutMs)
          : true;
      },
      pendingAfterResponse: () => 0,
      closeStores: async () => {
        calls.closeStores += 1;
        await overrides.closeStores?.();
      },
      exit: (code) => {
        exits.push(code);
        exited.resolve();
      },
      log: (line) => {
        logs.push(line);
      },
      error: (line) => {
        errors.push(line);
      },
    },
    { shutdownMs: BUDGET_MS }
  );

  return {
    shutdown,
    exits,
    logs,
    errors,
    calls,
    sweepTimeouts,
    drainTimeouts,
    settled: () =>
      Promise.race([exited.promise, Bun.sleep(BUDGET_MS + 200)]).then(() => {}),
  };
}

/** A drain that only reports empty once `finishAt` has passed, else times out. */
function taskFinishingAt(finishAt: number) {
  return async (timeoutMs: number): Promise<boolean> => {
    const remaining = finishAt - Date.now();
    if (remaining <= 0) return true;
    if (remaining > timeoutMs) {
      await Bun.sleep(timeoutMs);
      return false;
    }
    await Bun.sleep(remaining);
    return true;
  };
}

describe('the shutdown budget', () => {
  test('is the larger request ceiling plus the headroom', () => {
    expect(
      shutdownTimeoutMs({ idleTimeoutSeconds: 60, maxRouteTimeoutSeconds: 120 })
    ).toBe((120 + SHUTDOWN_POLICY.headroomSeconds) * 1000);
    expect(
      shutdownTimeoutMs({ idleTimeoutSeconds: 60, maxRouteTimeoutSeconds: 0 })
    ).toBe((60 + SHUTDOWN_POLICY.headroomSeconds) * 1000);
  });
});

describe('the shutdown coordinator', () => {
  test('a quiet process closes every store and exits with the requested code', async () => {
    const h = harness();
    await h.shutdown('SIGTERM');
    await h.settled();

    expect(h.exits).toEqual([0]);
    expect(h.calls.closeStores).toBe(1);
    expect(h.logs.map((l) => l.msg)).toEqual([
      'server stopping',
      'server stopped',
    ]);
    expect(h.errors).toEqual([]);
  });

  test('a fault exit code survives a clean drain', async () => {
    const h = harness();
    await h.shutdown('unhandledRejection', 1);
    await h.settled();

    expect(h.exits).toEqual([1]);
    expect(h.calls.closeStores).toBe(1);
  });

  test('a fault arriving DURING a signal shutdown still ends the process non-zero', async () => {
    // The sequence cannot restart, but the request must not be lost: a signal
    // started the stop with code 0, then an escaped error asked for 1 while the
    // server was still draining. The first version exited 0 here.
    const stop = Promise.withResolvers<void>();
    const h = harness({ stopServer: () => stop.promise });

    const first = h.shutdown('SIGTERM');
    const second = h.shutdown('uncaughtException', 1);
    stop.resolve();
    await Promise.all([first, second]);
    await h.settled();

    expect(h.exits).toEqual([1]);
    expect(h.calls.stopServer).toBe(1);
    expect(h.calls.closeStores).toBe(1);
    expect(h.logs.at(-1)).toMatchObject({ msg: 'server stopped', exitCode: 1 });
  });

  test('a task that finishes late but inside the budget still yields a clean stop', async () => {
    // Past any fixed slice a per-queue design would have given it. Before the
    // shared deadline this case left the stores open and reported a failed
    // deployment.
    const h = harness({
      drainAfterResponse: taskFinishingAt(Date.now() + BUDGET_MS * 0.6),
    });
    await h.shutdown('SIGTERM');
    await h.settled();

    expect(h.exits).toEqual([0]);
    expect(h.calls.closeStores).toBe(1);
    expect(h.errors.map((l) => l.msg)).toEqual([]);
  });

  test('a task that goes idle just before the forced exit still yields a clean stop', async () => {
    // The boundary the reserved-tail design got wrong: idle at 85% of the
    // budget, which a tail reserved for the store close never re-checked.
    const h = harness({
      drainAfterResponse: taskFinishingAt(Date.now() + BUDGET_MS * 0.85),
    });
    await h.shutdown('SIGTERM');
    await h.settled();

    expect(h.exits).toEqual([0]);
    expect(h.calls.closeStores).toBe(1);
  });

  test('the drains share one budget, in order: what the sweep spends is gone from the queue', async () => {
    const h = harness({
      stopSweeps: async () => {
        await Bun.sleep(100);
        return true;
      },
    });
    await h.shutdown('SIGTERM');
    await h.settled();

    const [sweep] = h.sweepTimeouts;
    const [drain] = h.drainTimeouts;
    expect(sweep).toBeLessThanOrEqual(BUDGET_MS);
    expect(sweep).toBeGreaterThan(BUDGET_MS - 60);
    expect(drain).toBeLessThanOrEqual((sweep ?? 0) - 90);
    expect(h.exits).toEqual([0]);
  });

  test('a task that never finishes leaves the stores open and hands the process to the forced exit', async () => {
    const h = harness({
      drainAfterResponse: taskFinishingAt(Date.now() + BUDGET_MS * 5),
    });
    await h.shutdown('SIGTERM');
    // Returned WITHOUT closing anything: the stores are untouched and the
    // timer decides. The drain gives up exactly at the deadline, so the forced
    // exit may already have fired by the time this line runs.
    expect(h.calls.closeStores).toBe(0);
    const reported = h.errors.map((l) => l.msg);
    expect(reported).toContain('after-response drain timed out');
    expect(reported).toContain('stores left open for forced exit');

    await h.settled();
    expect(h.exits).toEqual([1]);
    expect(h.calls.closeStores).toBe(0);
    expect(h.errors.map((l) => l.msg)).toContain('forced shutdown');
  });

  test('a sweep that never yields is reported the same way', async () => {
    const h = harness({
      stopSweeps: taskFinishingAt(Date.now() + BUDGET_MS * 5),
    });
    await h.shutdown('SIGTERM');
    await h.settled();

    expect(h.exits).toEqual([1]);
    expect(h.calls.closeStores).toBe(0);
    const left = h.errors.find(
      (l) => l.msg === 'stores left open for forced exit'
    );
    expect(left).toMatchObject({ sweepsDrained: false });
  });

  test('a faulted server stop is contained, drains and closes, and exits 1', async () => {
    // `Bun.Server.stop()` closes the listening socket at CALL time, so the
    // stores are still closed here rather than stranded under a listener that
    // is already down. What the fault does buy is the exit code: a stop that
    // did not complete cleanly is not reported to the orchestrator as one.
    const h = harness({
      stopServer: async () => {
        throw new TypeError('half-closed socket');
      },
    });
    await h.shutdown('SIGTERM');
    await h.settled();

    expect(h.exits).toEqual([1]);
    expect(h.calls.closeStores).toBe(1);
    expect(h.errors).toEqual([
      { msg: 'server stop failed', errorClass: 'TypeError' },
    ]);
    expect(h.logs.at(-1)).toMatchObject({ msg: 'server stopped', exitCode: 1 });
    expect(h.sweepTimeouts).toHaveLength(1);
    expect(h.drainTimeouts).toHaveLength(1);
  });

  test('a store that fails to close ends the process non-zero', async () => {
    // `server.ts` attempts every store and raises the failures together; the
    // coordinator must not call that a clean stop.
    const h = harness({
      closeStores: async () => {
        throw new AggregateError(
          [new Error('pool already destroyed')],
          'stores left open: postgres'
        );
      },
    });
    await h.shutdown('SIGTERM');
    await h.settled();

    expect(h.exits).toEqual([1]);
    expect(h.errors).toEqual([
      { msg: 'stores did not close cleanly', errorClass: 'AggregateError' },
    ]);
    expect(h.logs.at(-1)).toMatchObject({ msg: 'server stopped', exitCode: 1 });
  });

  test('a second signal during shutdown does not restart the sequence', async () => {
    const h = harness();
    await Promise.all([h.shutdown('SIGTERM'), h.shutdown('SIGINT')]);
    await h.settled();

    expect(h.exits).toEqual([0]);
    expect(h.calls.stopServer).toBe(1);
    expect(h.logs.filter((l) => l.msg === 'server stopping')).toHaveLength(1);
    expect(
      h.logs.filter((l) => l.msg === 'shutdown already in progress')
    ).toHaveLength(1);
  });
});

/**
 * The boundary, against the REAL after-response queue rather than a boolean
 * drain. `drainAfterResponse` reports empty only after it has observed the
 * queue empty for `AFTER_RESPONSE_SETTLE_MS`, so the last such interval before
 * the deadline is a forced exit even though the work itself ended in time. That
 * is the contract, and both sides of the line are pinned here.
 */
describe('the coordinator on the real after-response queue', () => {
  function realQueueHarness(budgetMs: number) {
    const events: { what: string; at: number }[] = [];
    const started = Date.now();
    const exited = Promise.withResolvers<void>();
    const shutdown = createShutdown(
      {
        stopServer: async () => {},
        stopSweeps: async () => true,
        drainAfterResponse,
        pendingAfterResponse,
        closeStores: async () => {
          events.push({ what: 'closeStores', at: Date.now() - started });
        },
        exit: (code) => {
          events.push({ what: `exit ${code}`, at: Date.now() - started });
          exited.resolve();
        },
        log: () => {},
        error: () => {},
      },
      { shutdownMs: budgetMs }
    );
    return {
      shutdown,
      events,
      settled: () =>
        Promise.race([exited.promise, Bun.sleep(budgetMs + 300)]).then(
          () => {}
        ),
    };
  }

  function enqueueTaskLasting(ms: number): void {
    const request = new Request('http://localhost/after-response-probe');
    enqueueAfterResponse(request, () => Bun.sleep(ms));
    runAfterResponse(request, {
      method: 'GET',
      path: '/after-response-probe',
      status: 200,
      durationMs: 0,
    });
  }

  test('work that ends a settle interval and more before the deadline is a clean stop', async () => {
    const budget = 400;
    const h = realQueueHarness(budget);
    enqueueTaskLasting(budget - AFTER_RESPONSE_SETTLE_MS * 4);

    await h.shutdown('SIGTERM');
    await h.settled();

    expect(h.events.map((e) => e.what)).toEqual(['closeStores', 'exit 0']);
  });

  test('work that ends inside the last settle interval is a forced exit, by contract', async () => {
    const budget = 400;
    const h = realQueueHarness(budget);
    enqueueTaskLasting(budget - Math.round(AFTER_RESPONSE_SETTLE_MS / 2));

    await h.shutdown('SIGTERM');
    await h.settled();

    // Forced, once, and the stores never touched: the drain could not finish
    // its settle observation inside the deadline, so it answered false rather
    // than reporting an empty set it had not proven.
    expect(h.events.map((e) => e.what)).toEqual(['exit 1']);
    // The queue had to finish draining by itself before another file runs.
    expect(await drainAfterResponse(AFTER_RESPONSE_SETTLE_MS * 10)).toBe(true);
  });

  test('an exhausted or sub-settle budget is never a proof, and is never overslept', async () => {
    // An empty set at the instant of asking is not the settle observation the
    // contract requires, and a budget too short for one is answered false
    // WITHOUT starting the observation — "up to timeoutMs" has to hold.
    for (const budget of [0, 1, 10, AFTER_RESPONSE_SETTLE_MS - 1]) {
      const started = performance.now();
      expect(await drainAfterResponse(budget)).toBe(false);
      expect(performance.now() - started).toBeLessThan(
        AFTER_RESPONSE_SETTLE_MS / 2
      );
    }
    expect(await drainAfterResponse(AFTER_RESPONSE_SETTLE_MS * 3)).toBe(true);
  });

  test('the deadline itself is exhausted: reaching it exactly is a forced exit, not a clean one', async () => {
    // Deterministic, with an injected clock: both drains proved quiescence at
    // t=0, the store close ends exactly at the deadline. "Closed BEFORE the
    // deadline" is half-open, so this is the bound exceeded.
    const budget = 100;
    const clock = { now: 0 };
    const events: string[] = [];
    const shutdown = createShutdown(
      {
        stopServer: async () => {},
        stopSweeps: async () => true,
        drainAfterResponse: async () => true,
        pendingAfterResponse: () => 0,
        closeStores: async () => {
          clock.now = budget;
          events.push('closeStores');
        },
        exit: (code) => {
          events.push(`exit ${code}`);
        },
        log: () => {},
        error: (line) => {
          events.push(String(line.msg));
        },
        now: () => clock.now,
      },
      { shutdownMs: budget }
    );

    await shutdown('SIGTERM');
    await Bun.sleep(budget + 50);

    expect(events).toEqual(['closeStores', 'forced shutdown', 'exit 1']);
  });

  test('a step that holds the event loop past the deadline cannot take the clean path', async () => {
    // A timer cannot preempt synchronous work, so the forced-exit callback is
    // still queued when the sequence resumes with its budget already spent. The
    // coordinator has to notice that itself.
    const budget = 50;
    const h = realQueueHarness(budget);
    const blockingSweeps = () => {
      const until = Date.now() + budget * 2;
      while (Date.now() < until) {
        // spin: the point is that nothing else runs
      }
      return Promise.resolve(true);
    };
    const shutdown = createShutdown(
      {
        stopServer: async () => {},
        stopSweeps: blockingSweeps,
        drainAfterResponse,
        pendingAfterResponse,
        closeStores: async () => {
          h.events.push({ what: 'closeStores', at: 0 });
        },
        exit: (code) => {
          h.events.push({ what: `exit ${code}`, at: 0 });
        },
        log: () => {},
        error: () => {},
      },
      { shutdownMs: budget }
    );

    await shutdown('SIGTERM');
    await Bun.sleep(budget);

    expect(h.events.map((e) => e.what)).toEqual(['exit 1']);
  });
});

/**
 * The runbook copies the policy's numbers for the operator. Copied numbers
 * drift, so every copy is read back here: the policy table rows and the startup
 * log example have to name the current values. Prose in the runbook refers to
 * the table by name rather than repeating the numbers, so there is no third
 * copy to check.
 */
describe('the runbook copy of the shutdown policy', () => {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fixed path relative to this file
  const runbook = readFileSync(
    path.join(import.meta.dir, '..', '..', 'reports', 'coolify-deployment.md'),
    'utf8'
  );

  function documentedValue(name: string): number {
    // eslint-disable-next-line security/detect-non-literal-regexp -- the name is a constant written in this file
    const row = new RegExp(String.raw`\|\s*\`${name}\`\s*\|\s*(\d+)\s*\|`).exec(
      runbook
    );
    if (!row?.[1])
      throw new Error(
        `reports/coolify-deployment.md has no policy row for ${name}`
      );
    return Number(row[1]);
  }

  test('the policy table names the current values', () => {
    expect(documentedValue('SHUTDOWN_POLICY.gracefulStopMs')).toBe(
      SHUTDOWN_POLICY.gracefulStopMs
    );
    expect(documentedValue('SHUTDOWN_POLICY.headroomSeconds')).toBe(
      SHUTDOWN_POLICY.headroomSeconds
    );
    expect(documentedValue('AFTER_RESPONSE_SETTLE_MS')).toBe(
      AFTER_RESPONSE_SETTLE_MS
    );
  });

  test('the startup-log example prints the same grace the server prints', () => {
    const example = /"gracefulStopMs":\s*(\d+)/.exec(runbook);
    expect(example?.[1]).toBeDefined();
    expect(Number(example?.[1])).toBe(SHUTDOWN_POLICY.gracefulStopMs);
  });

  test('the runbook prose carries no second copy of the grace', () => {
    // "5 s grace" and "5 s grace period" were the copies that drifted; the
    // prose now names the table row instead.
    expect(runbook).not.toMatch(/\b5 s grace/);
  });

  test('both documents state the budget formula symbolically, with its unit conversion', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fixed path relative to this file
    const strategy = readFileSync(
      path.join(import.meta.dir, '..', '..', 'reports', 'test-strategy.md'),
      'utf8'
    );
    const formula =
      '(max(IDLE_TIMEOUT_SECONDS, MAX_ROUTE_TIMEOUT_SECONDS) + SHUTDOWN_POLICY.headroomSeconds) * 1000';
    for (const document of [runbook, strategy]) {
      expect(document).toContain(formula);
      // The literal headroom operand is the copy that drifted; the policy name
      // is the only spelling allowed.
      expect(document).not.toMatch(/MAX_ROUTE_TIMEOUT_SECONDS\) \+ \d+\)/);
    }
  });
});
