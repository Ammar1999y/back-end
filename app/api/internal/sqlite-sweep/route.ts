/**
 * Expiry sweep, invoked by the Coolify scheduled task.
 *
 * An HTTP route rather than a CLI script, for two reasons that are not stylistic:
 *
 * The SQLite driver is `better-sqlite3`, which hard-panics under Bun
 * (`NAPI FATAL ERROR`), so `bun some-script.ts` is not a runnable command here;
 * and Node cannot execute this project's TypeScript with its path aliases
 * without a runner that is not a declared dependency. An HTTP route needs
 * neither.
 *
 * (`scripts/` used to be git-ignored as well, which ruled a CLI out entirely.
 * That is no longer true — it is tracked — so the remaining obstacle is the
 * runtime one above, not packaging.)
 *
 * This route runs in the one runtime that is already proven to work: Node, inside
 * Next. The scheduled task is a `curl` against it — see
 * reports/coolify-deployment.md.
 *
 * Not a correctness boundary: expiry is filtered on every read, so a delayed or
 * failed sweep can never make an expired row readable. It only reclaims disk.
 */
import { cacheHasExpiredRows, cacheSweepExpired } from '@/lib/cache';
import { hasExpiredRows, sweepExpired } from '@/lib/rate-limit/store';
import { maintenanceTokenMatches } from '@/lib/sqlite/maintenance-token';

import { HTTP_STATUS } from '@/utils/api-messages';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!maintenanceTokenMatches(request.headers.get('x-maintenance-token')))
    return Response.json(
      { error: 'unauthorized' },
      { status: HTTP_STATUS.UNAUTHORIZED }
    );

  const startedAt = Date.now();
  try {
    const limiter = await sweepExpired(startedAt);
    const cache = await cacheSweepExpired(startedAt);

    // `hasMore` is why the ceiling is reported rather than hidden: a run that
    // removed exactly its ceiling is otherwise indistinguishable from one that
    // finished, and a growing backlog would stay invisible.
    //
    // Each database is then probed once more, because a per-table `hasMore` only
    // reports that THAT table hit its own ceiling. Both stores are probed, not
    // just the cache, or an `auth_rate_limit` backlog would be the one thing that
    // stayed invisible.
    //
    // The probe reuses `startedAt` as its cutoff, deliberately, so it asks "is
    // anything that was ALREADY expired when this run began still here?". Probing
    // with a fresh `Date.now()` would instead report every row that expired
    // during the run, which under continuous traffic is always some row — the
    // signal would be permanently true and therefore worthless.
    //
    // NOTE for whoever wires the scheduled task: a backlog is still a SUCCESSFUL
    // sweep, so this returns HTTP 200 and `curl -f` will not flag it. The task
    // has to inspect the body. Returning a non-2xx here instead would conflate
    // "more work remains" with "the sweep failed", and would make the task's own
    // failure alerting useless.
    return Response.json({
      status: 'ok',
      durationMs: Date.now() - startedAt,
      removed: { ...limiter, cache },
      hasMore:
        limiter.rateLimit.hasMore ||
        limiter.auth.hasMore ||
        cache.hasMore ||
        hasExpiredRows(startedAt) ||
        cacheHasExpiredRows(startedAt),
    });
  } catch (error) {
    // The key spaces embed IPs and destinations, so only the class is reported —
    // the same boundary rule as lib/rate-limit/store-failure.ts.
    console.error(
      JSON.stringify({
        msg: 'sqlite sweep failed',
        errorClass: (error as { name?: string })?.name ?? 'Unknown',
      })
    );
    return Response.json(
      { status: 'error' },
      { status: HTTP_STATUS.INTERNAL_ERROR }
    );
  }
}
