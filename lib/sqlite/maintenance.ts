/** Keeps expiry-sweep work independent of its HTTP, cron, or CLI trigger. */
import type { SweepResult } from '@/lib/sqlite/sweep';

import { errorClassOf } from '@/utils';
import { cacheHasExpiredRows, cacheSweepExpired } from '@/lib/cache';
import { hasExpiredRows, sweepExpired } from '@/lib/rate-limit/store';

export interface MaintenanceSweepResult {
  /**
   * `degraded` when a store could not be swept. Containment is not the same as
   * success: the cache half is isolated so a corrupt `cache.db` cannot roll back
   * the limiter deletions, but reporting the run as `ok` afterwards told the
   * scheduler — and any alert built on it — that maintenance had completed.
   */
  status: 'ok' | 'degraded';
  durationMs: number;
  removed: Record<string, unknown>;
  /**
   * True when a backlog is known to remain, AND when a failed sweep means the
   * backlog is unknown. Reporting `false` for "could not measure" is the shape
   * that lets reclamation stop while monitoring stays quiet.
   */
  hasMore: boolean;
}

/** What a contained failure returns, so the caller can tell it from a clean run. */
interface ContainedSweep extends SweepResult {
  error?: string;
}

export async function runMaintenanceSweep(
  startedAt = Date.now()
): Promise<MaintenanceSweepResult> {
  const limiter = await sweepExpired(startedAt);
  const cache = await sweepCacheContained(startedAt);

  return {
    status: cache.error ? 'degraded' : 'ok',
    durationMs: Date.now() - startedAt,
    removed: { ...limiter, cache },
    // `hasMore` is why the ceiling is reported rather than hidden: a run that
    // removed exactly its ceiling is otherwise indistinguishable from one that
    // finished, and a growing backlog would stay invisible.
    //
    // Each database is then probed once more, because a per-table `hasMore`
    // only reports the table that was swept last, not the whole store.
    //
    // The probe reuses `startedAt` as its cutoff, deliberately, so it asks "is
    // anything that was ALREADY expired when this run began still here?".
    // Probing with a fresh `Date.now()` would instead report every row that
    // expired during the run, which under continuous traffic is always some row
    // — the signal would be permanently true and therefore worthless.
    hasMore:
      limiter.rateLimit.hasMore ||
      cache.hasMore ||
      // A cache sweep that threw leaves an UNKNOWN backlog, which must read as
      // "work may remain" rather than as "nothing to do".
      cache.error !== undefined ||
      hasExpiredRows(startedAt) ||
      cacheBacklogContained(startedAt),
  };
}

async function sweepCacheContained(startedAt: number): Promise<ContainedSweep> {
  try {
    return await cacheSweepExpired(startedAt);
  } catch (error) {
    const errorClass = errorClassOf(error);
    console.error(
      JSON.stringify({ msg: 'maintenance.cacheSweep failed', errorClass })
    );
    // Surfaced in the RESULT, not only in the log: the scheduler reports what
    // this returns, and a log line nothing reads is not a signal.
    return { removed: 0, hasMore: true, error: errorClass };
  }
}

function cacheBacklogContained(startedAt: number): boolean {
  try {
    return cacheHasExpiredRows(startedAt);
  } catch {
    return false;
  }
}
