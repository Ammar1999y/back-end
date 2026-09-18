/* eslint-disable unicorn/no-process-exit -- this fixture IS a process entry
   point: its exit code is the assertion. */
import { app } from '@/app';
import { closeDatabase } from '@/db';
import { closeCacheStore } from '@/lib/cache';
import { closeRateLimitStore } from '@/lib/rate-limit/store';
import { stopServerGracefully } from '@/lib/shutdown';

app.get('/_slow', async () => {
  await Bun.sleep(SLOW_REQUEST_MS);
  return 'done';
});

app.listen({ port: 0 });
const server = app.server;
if (!server) throw new Error('child listener did not start');
const { port } = server;
if (typeof port !== 'number')
  throw new Error('child listener bound no TCP port');

/**
 * Longer than `SHUTDOWN_POLICY.gracefulStopMs`, so the stop below has to decide
 * between force-closing this request and waiting for it.
 */
const SLOW_REQUEST_MS = 8000;
const SLOW_REQUEST_BUDGET_MS = 30_000;

const mode = process.argv[2];

if (mode === 'half-sent') {
  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: { data() {}, error() {}, close() {} },
  });

  socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n');
}

/**
 * Started, deliberately NOT awaited: the request has to still be in flight when
 * the stop below runs, which is the whole case.
 */
async function slowRequest(): Promise<string> {
  try {
    const response = await fetch(`http://localhost:${port}/_slow`);
    return `status ${response.status}`;
  } catch (error) {
    return `rejected ${(error as Error).message}`;
  }
}

let inflight: Promise<string> | null = null;
if (mode === 'slow-request') {
  /* eslint-disable-next-line unicorn/prefer-top-level-await -- awaiting it here
     is the one thing this case must not do: the request has to be IN FLIGHT
     when the stop runs. It is awaited after the stop returns. */
  inflight = slowRequest();
  // Long enough for the request to be accepted and counted in flight.
  await Bun.sleep(300);
}

// The real `server.ts` stop, not a copy of it: this fixture used to hold its
// own `Promise.race`, which is why the five-second escalation could reset an
// in-flight request without a single test noticing.
await stopServerGracefully({
  budgetMs: SLOW_REQUEST_BUDGET_MS,
  stop: (closeActiveConnections) => app.stop(closeActiveConnections),
  pendingRequests: () => app.server?.pendingRequests ?? 0,
  error: (line) => console.log(JSON.stringify(line)),
});

if (inflight)
  console.log(JSON.stringify({ msg: 'inflight', outcome: await inflight }));

await closeDatabase();
closeRateLimitStore();
closeCacheStore();
console.log(JSON.stringify({ msg: 'all stores closed', mode }));
process.exit(0);
