/** Keeps expiry-sweep work independent of its HTTP, cron, or CLI trigger. */
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
