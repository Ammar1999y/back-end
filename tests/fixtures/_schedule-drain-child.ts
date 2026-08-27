/**
 * Subprocess body for `schedule-drain.test.ts`.
 *
 * Registers ONE job on the real `startSchedule`, waits for `Bun.cron` to fire it
 * for real, and then stops the schedule while that callback is still running —
 * which is the only window `stopAndDrain` exists for and the only way to reach
 * it. Emits one JSON line per event so the parent asserts on ORDER, not on
 * timing.
 *
 * `argv[2]` picks which branch is exercised: `drain` gives the job less time
 * than the deadline, `timeout` gives it more.
 */
/* eslint-disable unicorn/no-process-exit -- this fixture IS a process entry
   point: its stdout and exit code are the assertion. */
import { startSchedule } from '@/lib/schedule';

const mode = process.argv[2] === 'timeout' ? 'timeout' : 'drain';
const JOB_MS = mode === 'timeout' ? 5000 : 300;
const DRAIN_MS = mode === 'timeout' ? 300 : 5000;

function emit(msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ msg, ...extra }));
}

const started = Promise.withResolvers<void>();

const schedule = startSchedule([
  {
    name: 'drain-probe',
    expression: '* * * * *',
    run: async () => {
      emit('probe started');
      started.resolve();
      await Bun.sleep(JOB_MS);
      emit('probe finished');
      return { status: 'ok', hasMore: false, durationMs: JOB_MS };
    },
  },
]);

// Up to one minute: `Bun.cron` fires on the next boundary and offers no way to
// trigger a job by hand.
await started.promise;

const drained = await schedule.stopAndDrain(DRAIN_MS);
emit('drain returned', { mode, drained });

// Deliberately AFTER the drain, mirroring `server.ts`: a store closed while a
// sweep is mid-batch is what the drain exists to prevent, and only the order of
// these two lines can show it.
emit('stores closed');
process.exit(0);
