/**
 * Shared bearer check for the deep SQLite storage probe.
 */
import { timingSafeEqual } from 'node:crypto';

import { SQLITE_MAINTENANCE_TOKEN } from '@/lib/env.server';

/**
 * An unset configured token never matches. Treating it as "no auth required"
 * would open the deep probe on a deploy that forgot the variable.
 */
export function maintenanceTokenMatches(provided: string | null): boolean {
  const matched = compare(provided);

  if (!matched)
    console.error(
      JSON.stringify({
        msg: 'maintenance token rejected',
        reason: provided ? 'mismatch' : 'absent',
        configured: SQLITE_MAINTENANCE_TOKEN.length > 0,
      })
    );
  return matched;
}

function compare(provided: string | null): boolean {
  if (!provided || !SQLITE_MAINTENANCE_TOKEN) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(SQLITE_MAINTENANCE_TOKEN);
  // timingSafeEqual throws on a length mismatch, which would itself be an oracle.
  return a.length === b.length && timingSafeEqual(a, b);
}
