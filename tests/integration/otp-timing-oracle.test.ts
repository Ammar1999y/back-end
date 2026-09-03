import { beforeAll, describe, expect, test } from 'bun:test';

import { app } from '@/app';

import { HTTP_STATUS } from '@/utils/api-messages';

import { resetTables } from '../helpers/database';
import { delayMail, settleDelivery } from '../helpers/mailbox';
import { baseHeaders, seedUser } from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

const PROVIDER_DELAY_MS = 3000;
const FLOOR_MS = 1500;
const SAMPLES = 4;

const state: { realEmail: string } = { realEmail: '' };

beforeAll(async () => {
  await resetTables();
  // Every sample below must be ADMITTED: a per-IP window another file spent
  // would turn a timing assertion into a 429.
  resetSqliteStores();
  const user = await seedUser();
  state.realEmail = user.email;
});

function send(email: string): Promise<Response> {
  return app.handle(
    new Request('http://localhost/api/auth/passwordless/send', {
      method: 'POST',
      headers: baseHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ channel: 'email', email }),
    })
  );
}

async function timeSend(email: string): Promise<number> {
  const started = performance.now();
  const response = await send(email);
  const elapsed = performance.now() - started;

  expect(response.status).toBe(HTTP_STATUS.OK);
  return elapsed;
}

describe('a slow provider', () => {
  test('does not push the real branch above the floor', async () => {
    delayMail(PROVIDER_DELAY_MS);

    const unknown: number[] = [];
    const known: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      unknown.push(await timeSend(`nobody-${i}@gmail.com`));
      known.push(await timeSend(state.realEmail));
    }

    // The floor still applies to both — that part was never broken.
    for (const elapsed of [...unknown, ...known])
      expect(elapsed).toBeGreaterThanOrEqual(FLOOR_MS - 50);

    // And the real branch must not exceed it by anything like the provider's
    // delay. The margin is deliberately loose: the assertion is that the
    // 3 000 ms does NOT appear, not that the two arms are equal to the
    // millisecond.
    const slowest = Math.max(...known);
    expect(slowest).toBeLessThan(FLOOR_MS + PROVIDER_DELAY_MS / 2);

    // The delivery did happen — it just happened after the response.
    await settleDelivery();
  }, 120_000);
});
