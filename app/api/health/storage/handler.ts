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
 *   back its PRAGMAs, and runs a bounded `SELECT 1` against PostgreSQL. Enough
 *   to catch a missing binary, an unopenable file, a wrong `journal_mode`, a
 *   schema version this build cannot use, or an unreachable primary database.
 *   Safe to poll.
 * - **Deep (`?deep=1`, token required).** Adds `quick_check` and a real write
 *   probe. Both take real work and a write lock, so they must not run on every
 *   poll — that would put the health check itself in contention with the limiter.
 *
 * The body reports status only: no paths, schema contents, or row counts. A health
 * endpoint is typically the least-authenticated surface in a deployment.
 *
 * The body is `apiRaw`, not the standard envelope: the deployed health check
 * reads `status` and `checks` at the top level, so wrapping it would break a
 * deployment rather than a client we control.
 *
 * What this CANNOT prove: that the volume is actually persistent. SQLite will
 * create the same path inside the container layer just as happily. Only surviving
 * a real redeploy proves that — see reports/coolify-deployment.md.
 */
import type { Handler } from '@/lib/http/contract';

import { pingDatabase } from '@/db';
import { errorClassOf } from '@/utils';
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
import { apiRaw } from '@/utils/api-response';

const PROBE_KEY = 'health:write-probe';

async function postgresReachable(): Promise<boolean> {
  try {
    return await pingDatabase();
  } catch (error) {
    // Driver errors can include connection details, so log only their class.
    console.error(
      JSON.stringify({
        msg: 'health.postgres unreachable',
        errorClass: errorClassOf(error),
      })
    );
    return false;
  }
}

export const GET: Handler = async (ctx) => {
  const deepRequested = ctx.query.get('deep') === '1';
  const deep =
    deepRequested &&
    maintenanceTokenMatches(ctx.headers.get('x-maintenance-token'));

  if (deepRequested && !deep)
    return apiRaw({
      body: { status: 'unauthorized' },
      status: HTTP_STATUS.UNAUTHORIZED,
    });

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
      postgres: await postgresReachable(),
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
        1,
        now + 1000,
        Number.MAX_SAFE_INTEGER
      );
      checks.writable = Boolean(written);
    }

    const ok = Object.values(checks).every(Boolean);
    return apiRaw({
      body: { status: ok ? 'ok' : 'degraded', checks },
      status: ok ? HTTP_STATUS.OK : HTTP_STATUS.SERVICE_UNAVAILABLE,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        msg: 'storage readiness failed',
        errorClass: errorClassOf(error),
      })
    );
    return apiRaw({
      body: { status: 'error' },
      status: HTTP_STATUS.SERVICE_UNAVAILABLE,
    });
  }
};
