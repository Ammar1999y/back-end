/**
 * `lib/cloudflare/purge.ts` with NEITHER variable set — the supported default,
 * and the state every deployment without a purge token lives in. See the
 * sibling file for why this is a file of its own.
 */
import { expect, test } from 'bun:test';

import { egressCallsTo } from '../helpers/egress';

delete process.env.CLOUDFLARE_ZONE_ID;
delete process.env.CLOUDFLARE_CACHE_PURGE_TOKEN;
const purge = await import('@/lib/cloudflare/purge');

test('purgeUrls is a no-op with nothing failed, and nothing leaves the process', async () => {
  expect(purge.CACHE_PURGE_CONFIGURED).toBe(false);
  // Nothing failed, deliberately: an unconfigured deployment has accepted edge
  // copies living out their lifetime, so no caller should hold a marker for it.
  expect(await purge.purgeUrls(['https://cdn.example.invalid/m/a'])).toEqual({
    attempted: 0,
    purged: 0,
    failed: [],
  });
  expect(egressCallsTo('api.cloudflare.com')).toEqual([]);
});
