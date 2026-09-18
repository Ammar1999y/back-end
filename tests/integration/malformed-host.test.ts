/**
 * A malformed `Host` header is a 404, not a 500.
 *
 * Bun does not validate `Host` before it builds `request.url`, so `Host: exa
 * mple.com`, `Host: [not-ipv6]` and an empty `Host` all arrive at `app.ts`'s
 * `onRequest` — where `new URL(request.url)` threw. That throw is not a
 * NOT_FOUND, so it fell to the generic branch of `onError`, which answered 500
 * and wrote one `unhandled server error` line per request: an unauthenticated
 * write into the channel operators watch, ahead of CORS, routing and every rate
 * limit. `URL.parse` returns `null` instead, and an unparseable host is
 * unroutable — which is what the hostname-length check beside it already
 * answers.
 *
 * Driven over a real socket, which is the whole point: `new Request(url)`
 * validates its own argument, so an in-process `app.handle` cannot construct
 * this request at all and would silently prove nothing.
 */
import { afterAll, describe, expect, test } from 'bun:test';

import { app } from '@/app';

import { HTTP_STATUS } from '@/utils/api-messages';

const server = Bun.serve({ port: 0, fetch: app.fetch });

/**
 * `Bun.Server['port']` is optional on the type — a unix-socket server has none.
 * Narrowed here rather than at the call site, where the flow analysis for a
 * module-scope binding does not reach.
 */
function boundPort(): number {
  const value = server.port;
  if (value === undefined)
    throw new Error('harness server did not bind a port');
  return value;
}

const port = boundPort();

afterAll(() => void server.stop(true));

/** The status line of a response to a hand-written request, bypassing `Request`. */
async function statusForHost(hostHeader: string): Promise<number> {
  const chunks: string[] = [];
  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      data: (_socket, data) => void chunks.push(new TextDecoder().decode(data)),
    },
  });

  socket.write(
    `GET /api/health/storage HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`
  );
  await Bun.sleep(250);
  socket.end();

  const statusLine = chunks.join('').split('\r\n', 1)[0] ?? '';
  return Number(statusLine.split(' ', 2)[1]);
}

describe('a Host header the URL parser rejects', () => {
  test.each([
    ['a space in the authority', 'exa mple.com'],
    ['a malformed bracket literal', '[not-ipv6]'],
    ['an empty value', ''],
    ['a tab in the authority', 'exa\tmple.com'],
  ])('%s answers 404, not 500', async (_label, hostHeader) => {
    expect(await statusForHost(hostHeader)).toBe(HTTP_STATUS.NOT_FOUND);
  });

  test('a hostname below the routable minimum is refused the same way', async () => {
    expect(await statusForHost('a')).toBe(HTTP_STATUS.NOT_FOUND);
  });

  // The control: without it, a hook that refused EVERY host would pass every
  // case above. 401 is this route's own answer to a request with no maintenance
  // token, so reaching it proves the pipeline ran rather than short-circuited.
  test('a well-formed Host still reaches the route table', async () => {
    expect(await statusForHost('app.example.com')).toBe(
      HTTP_STATUS.UNAUTHORIZED
    );
  });
});
