/**
 * Storage readiness, for the Coolify health check.
 *
 * Without this, a container whose volume failed to mount, whose native driver is
 * missing, or whose schema is wrong passes its health check and serves a silently
 * degraded limiter — the stores open lazily on the first limited request, so
 * nothing forces the failure to surface at startup.
 *
 * Two costs, deliberately separated:
 *
 * - **Cheap (default).** Opens the store (cached after the first call) and reads
 *   back its PRAGMAs. Enough to catch a missing binary, an unopenable file, a
 *   wrong `journal_mode`, or a schema version this build cannot use. Safe to poll.
 * - **Deep (`?deep=1`, token required).** Adds `quick_check` and a real write
 *   probe. Both take real work and a write lock, so they must not run on every
 *   poll — that would put the health check itself in contention with the limiter.
 *
 * The body reports status only: no paths, schema contents, or row counts. A health
 * endpoint is typically the least-authenticated surface in a deployment.
 *
 * What this CANNOT prove: that the volume is actually persistent. SQLite will
 * create the same path inside the container layer just as happily. Only surviving
 * a real redeploy proves that — see reports/coolify-deployment.md.
 */
import { SQLITE_MAINTENANCE_TOKEN } from '@/lib/env.server';
import {
  getRateLimitStore,
  RATE_LIMIT_SCHEMA_VERSION,
} from '@/lib/rate-limit/store';
import {
  BUSY_TIMEOUT_MS,
  describeDatabase,
  quickCheck,
  SYNCHRONOUS_VALUE,
} from '@/lib/sqlite/database';
import { maintenanceTokenMatches } from '@/lib/sqlite/maintenance-token';

import { HTTP_STATUS } from '@/utils/api-messages';

export const dynamic = 'force-dynamic';

const PROBE_KEY = 'health:write-probe';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const deepRequested = url.searchParams.get('deep') === '1';
  const deep =
    deepRequested &&
    maintenanceTokenMatches(request.headers.get('x-maintenance-token'));

  if (deepRequested && !deep)
    return Response.json(
      { status: 'unauthorized' },
      { status: HTTP_STATUS.UNAUTHORIZED }
    );

  try {
    const store = getRateLimitStore();
    const pragmas = describeDatabase(store.db);

    const checks: Record<string, boolean> = {
      journalModeWal: String(pragmas.journalMode).toLowerCase() === 'wal',
      schemaVersion: Number(pragmas.userVersion) === RATE_LIMIT_SCHEMA_VERSION,
      // Exact values, not "is it set". A database opened by something other than
      // `openDatabase` — an older build, a manual sqlite3 session that rewrote a
      // persistent pragma — can be perfectly usable yet not configured the way
      // the limiter's latency and durability assumptions require.
      busyTimeout: Number(pragmas.busyTimeout) === BUSY_TIMEOUT_MS,
      synchronousNormal:
        Number(pragmas.synchronous) === SYNCHRONOUS_VALUE['process-crash-safe'],
      // Not a storage property, but this is where a deploy that forgot the token
      // becomes visible: without it the scheduled sweep 401s forever and the
      // databases grow unbounded, with nothing else to signal it.
      maintenanceTokenSet:
        process.env.NODE_ENV !== 'production' ||
        SQLITE_MAINTENANCE_TOKEN.length > 0,
    };

    if (deep) {
      checks.quickCheck = quickCheck(store.db) === 'ok';
      // Proves the volume is writable NOW, not merely that it was at startup.
      // The probe row is given a one-second lifetime rather than being deleted
      // here: it is filtered out of every read immediately and the scheduled
      // sweep reclaims it, so an explicit delete would be a second write for no
      // additional guarantee.
      const now = Date.now();
      const written = store.consume.get<{ count: number }>(
        PROBE_KEY,
        now,
        now + 1000,
        Number.MAX_SAFE_INTEGER
      );
      checks.writable = Boolean(written);
    }

    const ok = Object.values(checks).every(Boolean);
    return Response.json(
      { status: ok ? 'ok' : 'degraded', checks },
      { status: ok ? HTTP_STATUS.OK : HTTP_STATUS.SERVICE_UNAVAILABLE }
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        msg: 'storage readiness failed',
        errorClass: (error as { name?: string })?.name ?? 'Unknown',
      })
    );
    return Response.json(
      { status: 'error' },
      { status: HTTP_STATUS.SERVICE_UNAVAILABLE }
    );
  }
}
