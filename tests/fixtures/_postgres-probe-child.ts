/**
 * Subprocess body for `postgres-probe.test.ts`.
 *
 * `argv[2]` picks the peer: `silent` accepts every connection and never answers
 * a byte, `refusing` is a port nothing listens on. `DATABASE_URL` is pointed at
 * it BEFORE the application's database module loads, then `pingDatabase` is
 * driven the way the public health route does: once, in a concurrent burst,
 * repeatedly, and finally with a probe still outstanding when the pool closes.
 * The peer counts the connections it accepted, which is the only occupancy
 * measure the driver exposes from the outside.
 *
 * No `process.exit`: the process ends when nothing holds the event loop, so a
 * client handle the pool failed to close is what keeps the parent waiting.
 */

const mode = process.argv[2] === 'refusing' ? 'refusing' : 'silent';

const accepted = { total: 0, open: 0 };

const peer = Bun.listen({
  hostname: '127.0.0.1',
  port: 0,
  socket: {
    open() {
      accepted.total += 1;
      accepted.open += 1;
    },
    close() {
      accepted.open -= 1;
    },
    data() {},
    error() {},
  },
});
const port = peer.port;
// A refusing peer is the port this listener just proved free, released again.
if (mode === 'refusing') peer.stop(true);

process.env.DATABASE_URL = `postgres://probe:probe@127.0.0.1:${port}/probe`;

const { closeDatabase, pingDatabase, PROBE_TIMEOUT_MS } = await import('@/db');

function emit(msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ msg, ...extra }));
}

interface Outcome {
  /** `true`/`false` when the probe answered, or the class of what it threw. */
  result: boolean | string;
  ms: number;
}

async function probe(): Promise<Outcome> {
  const started = performance.now();
  try {
    const result = await pingDatabase();
    return { result, ms: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      result: error instanceof Error ? error.constructor.name : 'unknown',
      ms: Math.round(performance.now() - started),
    };
  }
}

async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return true;
    await Bun.sleep(10);
  }
  return predicate();
}

emit('peer listening', { mode, deadlineMs: PROBE_TIMEOUT_MS });

if (mode === 'refusing') {
  const outcome = await probe();
  emit('refused probe', { ...outcome });
  await closeDatabase();
  emit('closed');
} else {
  const single = await probe();
  emit('single probe', { ...single, accepted: accepted.total });

  const BURST = 5;
  const started = performance.now();
  const burst = await Promise.all(Array.from({ length: BURST }, () => probe()));
  emit('concurrent probes', {
    results: burst.map((outcome) => outcome.result),
    ms: Math.round(performance.now() - started),
    accepted: accepted.total,
  });

  for (let n = 1; n <= 3; n++) {
    const repeat = await probe();
    emit('sequential probe', { n, ...repeat, accepted: accepted.total });
  }

  // The case that matters for shutdown: a probe is STILL WAITING on the silent
  // peer when the pool is asked to close. Started, not awaited; the peer's
  // accept is what proves it is in flight. The driver answers the probe right
  // after a timed-out one from its own failed state without opening a socket,
  // so probes are issued until one is seen to connect.
  let outstanding: Promise<Outcome> | null = null;
  let inFlight = false;
  for (let attempt = 0; !inFlight && attempt < 4; attempt++) {
    const before = accepted.total;
    const started = probe();
    inFlight = await waitFor(() => accepted.total > before, 300);
    if (inFlight) outstanding = started;
    else await started;
  }
  const closeStarted = performance.now();
  await closeDatabase();
  const closeMs = Math.round(performance.now() - closeStarted);
  const settled = outstanding ? await outstanding : null;
  await waitFor(() => accepted.open === 0, 1000);
  emit('closed with a probe outstanding', {
    inFlight,
    closeMs,
    outstanding: settled,
    open: accepted.open,
  });

  peer.stop(true);
}

emit('done');
