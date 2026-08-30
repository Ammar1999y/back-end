import { runDatabaseSweep } from '@/db/maintenance';
import { errorClassOf } from '@/utils';
import { runMaintenanceSweep } from '@/lib/sqlite/maintenance';

// Infrastructure schedules must not move with host or business time zones.
const SCHEDULE_TIMEZONE = 'UTC';

interface SweepOutcome {
  status: 'ok' | 'degraded';
  hasMore: boolean;
  durationMs: number;
}

export interface ScheduledJob {
  readonly name: string;
  readonly expression: string;
  readonly run: () => Promise<SweepOutcome>;
}

const JOBS: readonly ScheduledJob[] = [
  {
    name: 'sqlite-expiry-sweep',
    expression: '*/15 * * * *',
    run: runMaintenanceSweep,
  },
  {
    name: 'database-retention-sweep',
    expression: '30 3 * * *',
    run: runDatabaseSweep,
  },
];

function logRun(name: string, outcome: SweepOutcome): void {
  // A degraded run is reported as a FAILURE event. It completed in the sense
  // that it returned, but a store it was asked to sweep was not swept, and an
  // alert built on `scheduled sweep completed` would have stayed quiet.
  const degraded = outcome.status === 'degraded';
  const line = JSON.stringify({
    msg: degraded ? 'scheduled sweep degraded' : 'scheduled sweep completed',
    job: name,
    status: outcome.status,
    durationMs: outcome.durationMs,
    hasMore: outcome.hasMore,
  });
  if (degraded) console.error(line);
  else console.log(line);
}

function logFailure(name: string, error: unknown): void {
  console.error(
    JSON.stringify({
      msg: 'scheduled sweep failed',
      job: name,
      errorClass: errorClassOf(error),
    })
  );
}

export interface ScheduleHandle {
  /**
   * Prevents further firings AND waits for a callback already running, up to
   * `timeoutMs`. Resolves `true` when nothing is still in flight.
   *
   * `CronJob.stop()` alone only prevents FUTURE callbacks. Shutdown then closed
   * the SQLite stores immediately, and a sweep mid-batch died with
   * `Statement has finalized` — a bounded batch loop yields between batches
   * precisely so it can be interrupted, which is what makes this window real
   * rather than theoretical.
   */
  stopAndDrain: (timeoutMs: number) => Promise<boolean>;
}

/**
 * Registration stays explicit so importing application modules cannot start
 * timers.
 *
 * **Both jobs are registered in EVERY process that calls this, and neither is
 * safe to run twice concurrently** — the retention sweep would have two passes
 * deleting the same rows. What keeps that to one owner today is not this
 * function: it is `acquireWriterLock(SQLITE_DIR)` in `server.ts`, which runs
 * BEFORE this and fails the second instance's startup outright. The two are a
 * pair, so a change to either has to account for the other; giving the jobs
 * their own election is the prerequisite for ever running N app processes
 * against one `SQLITE_DIR`.
 *
 * `jobs` is a parameter only so `tests/process/schedule-drain.test.ts` can drive
 * the drain with a job whose duration it controls. Production passes nothing.
 */
export function startSchedule(
  jobs: readonly ScheduledJob[] = JOBS
): ScheduleHandle {
  // Tracked so shutdown can wait for a run already in progress. `Bun.cron`
  // guarantees a job never overlaps ITSELF; it says nothing about a callback
  // still running when the process is asked to stop.
  const inFlight = new Set<Promise<void>>();

  const handles = jobs.map((job) =>
    Bun.cron(
      job.expression,
      () => {
        const run = (async () => {
          try {
            logRun(job.name, await job.run());
          } catch (error) {
            logFailure(job.name, error);
          }
        })();
        inFlight.add(run);
        // `Bun.cron` awaits what the callback returns, so returning `run` is
        // what keeps the no-overlap guarantee.
        return run.finally(() => inFlight.delete(run));
      },
      { tz: SCHEDULE_TIMEZONE }
    )
  );

  console.log(
    JSON.stringify({
      msg: 'maintenance schedule started',
      timezone: SCHEDULE_TIMEZONE,
      jobs: jobs.map((job) => ({
        name: job.name,
        expression: job.expression,
        nextRun:
          Bun.cron
            .parse(job.expression, undefined, { tz: SCHEDULE_TIMEZONE })
            ?.toISOString() ?? null,
      })),
    })
  );

  return {
    stopAndDrain: async (timeoutMs: number) => {
      for (const handle of handles) handle.stop();
      if (inFlight.size === 0) return true;

      console.log(
        JSON.stringify({
          msg: 'waiting for in-flight sweep',
          jobs: inFlight.size,
        })
      );
      const timedOut = Symbol('sweep-drain-timeout');
      const raced = await Promise.race([
        // A rejected run must not abandon the drain; each is already contained.
        Promise.all(inFlight).catch(() => {}),
        Bun.sleep(timeoutMs).then(() => timedOut),
      ]);
      if (raced === timedOut)
        console.error(
          JSON.stringify({
            msg: 'sweep drain timed out',
            jobs: inFlight.size,
            timeoutMs,
          })
        );
      return inFlight.size === 0;
    },
  };
}
