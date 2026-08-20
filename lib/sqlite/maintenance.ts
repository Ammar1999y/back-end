/**
 * The whole-deployment expiry sweep, as a plain function.
 *
 * Split out of the HTTP handler so the TRIGGER is a separate decision from the
 * work: an HTTP route (what the deployed Coolify scheduled task `curl`s today),
 * an in-process cron, or a CLI script can all call this and get the same result.
 * `lib/sqlite/sweep.ts` is the per-table batching primitive underneath; this is
 * the run across both stores.
 *
 * ON THE IN-PROCESS CRON, decided rather than left open: `@elysia/cron` would
 * remove an authenticated, internet-reachable maintenance endpoint from the
 * attack surface, along with `SQLITE_MAINTENANCE_TOKEN` and one gate of the
 * deployment runbook. It is NOT adopted now, for three reasons:
 *
 * 1. It is another Elysia coupling while the Elysia-versus-Hono question is
 *    open, and the trigger would have to be rewritten with the framework.
 * 2. The sweep must run as ONE job. That is a single-process assumption, and
 *    Elysia's `reusePort` defaulted to `true` until this pass — so the
 *    deployment could already have been running two processes with nothing to
 *    say so. The assumption is only sound now that `reusePort: false` makes a
 *    second process fail loudly.
 * 3. The specific defect that motivated it — the route parsing a supplied body
 *    before checking its token — is fixed at the source: that route declares
 *    `body: 'none'` in `routes.ts`, so the token is checked against a request
 *    whose body was never read.
 *
 * Recorded in TODO.md so the decision is revisitable with the cost of the split
 * already paid.
 */
import { cacheHasExpiredRows, cacheSweepExpired } from '@/lib/cache';
import { hasExpiredRows, sweepExpired } from '@/lib/rate-limit/store';

export interface MaintenanceSweepResult {
  status: 'ok';
  durationMs: number;
  removed: Record<string, unknown>;
  hasMore: boolean;
}

export async function runMaintenanceSweep(
  startedAt = Date.now()
): Promise<MaintenanceSweepResult> {
  const limiter = await sweepExpired(startedAt);
  const cache = await cacheSweepExpired(startedAt);

  return {
    status: 'ok',
    durationMs: Date.now() - startedAt,
    removed: { ...limiter, cache },
    // `hasMore` is why the ceiling is reported rather than hidden: a run that
    // removed exactly its ceiling is otherwise indistinguishable from one that
    // finished, and a growing backlog would stay invisible.
    //
    // Each database is then probed once more, because a per-table `hasMore`
    // only reports that THAT table hit its own ceiling. Both stores are probed,
    // not just the cache, or an `auth_rate_limit` backlog would be the one thing
    // that stayed invisible.
    //
    // The probe reuses `startedAt` as its cutoff, deliberately, so it asks "is
    // anything that was ALREADY expired when this run began still here?".
    // Probing with a fresh `Date.now()` would instead report every row that
    // expired during the run, which under continuous traffic is always some row
    // — the signal would be permanently true and therefore worthless.
    hasMore:
      limiter.rateLimit.hasMore ||
      limiter.auth.hasMore ||
      cache.hasMore ||
      hasExpiredRows(startedAt) ||
      cacheHasExpiredRows(startedAt),
  };
}
