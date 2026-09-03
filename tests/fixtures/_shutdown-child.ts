/* eslint-disable unicorn/no-process-exit -- this fixture IS a process entry
   point: its exit code is the assertion. */
import { app } from '@/app';
import { closeDatabase } from '@/db';
import { closeCacheStore } from '@/lib/cache';
import { closeRateLimitStore } from '@/lib/rate-limit/store';
import { SHUTDOWN_POLICY } from '@/lib/shutdown';

app.listen({ port: 0 });
const server = app.server;
if (!server) throw new Error('child listener did not start');
const { port } = server;
if (typeof port !== 'number')
  throw new Error('child listener bound no TCP port');

const mode = process.argv[2];

if (mode === 'half-sent') {
  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: { data() {}, error() {}, close() {} },
  });

  socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n');
}

const timedOut = Symbol('graceful-stop-timeout');
const raced = await Promise.race([
  app.stop(),
  Bun.sleep(SHUTDOWN_POLICY.gracefulStopMs).then(() => timedOut),
]);
if (raced === timedOut) {
  console.log(JSON.stringify({ msg: 'graceful stop timed out' }));
  await app.stop(true);
}

await closeDatabase();
closeRateLimitStore();
closeCacheStore();
console.log(JSON.stringify({ msg: 'all stores closed', mode }));
process.exit(0);
