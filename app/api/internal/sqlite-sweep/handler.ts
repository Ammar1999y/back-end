/**
 * Expiry sweep, invoked by the Coolify scheduled task.
 *
 * An HTTP route rather than a CLI script: the scheduled task is a `curl`
 * against it, so it needs neither a TypeScript runner nor path-alias
 * resolution outside the server process — see reports/coolify-deployment.md.
 *
 * (The original reason was stronger still: under Next the SQLite driver was
 * `better-sqlite3`, which hard-panics under Bun, so `bun some-script.ts` was
 * not a runnable command at all. On Elysia the driver is `bun:sqlite` and a CLI
 * would now work, but the deployed scheduled task targets this URL — moving it
 * is a deployment change, not a code change.)
 *
 * The work itself lives in `lib/sqlite/maintenance.ts`, so the trigger can change
 * without the sweep changing. That module also records why an in-process cron
 * was considered and declined.
 *
 * This route declares `body: 'none'` in `routes.ts`, which is load-bearing: the
 * token below is checked against a request whose body was never read. It
 * previously ran after the adapter had already parsed whatever an unauthorised
 * caller sent.
 *
 * The body is `apiRaw`, not the standard envelope: the deployed task inspects
 * `hasMore` and `removed` at the top level.
 *
 * Not a correctness boundary: expiry is filtered on every read, so a delayed or
 * failed sweep can never make an expired row readable. It only reclaims disk.
 */
import type { Handler } from '@/lib/http/contract';

import { runMaintenanceSweep } from '@/lib/sqlite/maintenance';
import { maintenanceTokenMatches } from '@/lib/sqlite/maintenance-token';

import { HTTP_STATUS } from '@/utils/api-messages';
import { apiRaw } from '@/utils/api-response';

export const POST: Handler = async (ctx) => {
  if (!maintenanceTokenMatches(ctx.headers.get('x-maintenance-token')))
    return apiRaw({
      body: { error: 'unauthorized' },
      status: HTTP_STATUS.UNAUTHORIZED,
    });

  try {
    // NOTE for whoever wires the scheduled task: a backlog is still a SUCCESSFUL
    // sweep, so this returns HTTP 200 and `curl -f` will not flag it. The task
    // has to inspect the body. Returning a non-2xx here instead would conflate
    // "more work remains" with "the sweep failed", and would make the task's own
    // failure alerting useless.
    return apiRaw({ body: await runMaintenanceSweep() });
  } catch (error) {
    // The key spaces embed IPs and destinations, so only the class is reported —
    // the same boundary rule as lib/rate-limit/store-failure.ts.
    console.error(
      JSON.stringify({
        msg: 'sqlite sweep failed',
        errorClass: (error as { name?: string })?.name ?? 'Unknown',
      })
    );
    return apiRaw({
      body: { status: 'error' },
      status: HTTP_STATUS.INTERNAL_ERROR,
    });
  }
};
