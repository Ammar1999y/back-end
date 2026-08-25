/** Real listener coverage for Elysia's hostname-offset path extraction. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { app } from '@/app';

import { HTTP_STATUS, MSG_PAGE_NOT_FOUND } from '@/utils/api-messages';

const state = { origin: '' };
const guardedPath = '/api/health/storage?deep=1';

beforeAll(() => {
  app.listen({ port: 0 });
  const server = app.server;
  if (!server) throw new Error('test listener did not start');
  state.origin = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await app.stop();
});

describe('Host-independent route extraction', () => {
  test.each(['x', 'abc', 'abcd', 'example.com'])(
    '/junk/api/... is 404 with Host %s',
    async (host) => {
      const response = await fetch(`${state.origin}/junk${guardedPath}`, {
        headers: { Host: host },
      });

      expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
      expect(await response.json()).toEqual({
        success: false,
        message: MSG_PAGE_NOT_FOUND,
        data: null,
      });
    }
  );

  test('normal route still resolves over the listener', async () => {
    const response = await fetch(`${state.origin}${guardedPath}`, {
      headers: { Host: 'example.com' },
    });

    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(await response.json()).toEqual({ status: 'unauthorized' });
  });

  test.each(['http', 'https'])(
    '%s app.handle requests keep normal routing',
    async (scheme) => {
      const response = await app.handle(
        new Request(`${scheme}://example.com${guardedPath}`)
      );

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      expect(await response.json()).toEqual({ status: 'unauthorized' });
    }
  );
});
