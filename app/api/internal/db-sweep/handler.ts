/**
 * PostgreSQL retention sweep, invoked by a Coolify scheduled task.
 *
 * Deliberately a SECOND endpoint rather than more work inside
 * `/api/internal/sqlite-sweep`: that one reclaims disk from rows that expire in
 * minutes and wants to run often, this one is retention over days and performs
 * network I/O. One schedule cannot serve both cadences, and one response cannot
 * report an R2 outage without making the limiter sweep look broken.
 *
 * Same shape as its sibling in every other respect — the same maintenance token,
 * `body: 'none'` in `routes.ts` so the token is checked against a request whose
 * body was never read, and `apiRaw` rather than the standard envelope because the
 * scheduled task inspects `hasMore` and `removed` at the top level.
 */
import type { Handler } from '@/lib/http/contract';

import { runDatabaseSweep } from '@/db/maintenance';
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
    // A backlog is still a SUCCESSFUL sweep, so this returns 200 and `curl -f`
    // will not flag it — the task has to inspect the body. Same contract as the
    // SQLite sweep: a non-2xx here would conflate "more work remains" with "the
    // sweep failed" and make the task's own failure alerting useless.
    return apiRaw({ body: await runDatabaseSweep() });
  } catch (error) {
    // Class only. R2 keys embed sanitised filenames and a driver error can quote
    // a query — the same boundary rule as lib/rate-limit/store-failure.ts.
    console.error(
      JSON.stringify({
        msg: 'database sweep failed',
        errorClass: (error as { name?: string })?.name ?? 'Unknown',
      })
    );
    return apiRaw({
      body: { status: 'error' },
      status: HTTP_STATUS.INTERNAL_ERROR,
    });
  }
};
