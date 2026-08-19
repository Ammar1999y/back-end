/**
 * Shared bearer check for the two SQLite maintenance surfaces: the expiry sweep
 * and the deep storage check.
 *
 * One implementation rather than one per route. Both routes previously carried an
 * identical copy, and a constant-time comparison is exactly the kind of code where
 * two copies drift — one gains a length guard or an unset-token check the other
 * does not, and the weaker of the two is then the real security boundary.
 */
import { timingSafeEqual } from 'node:crypto';

import { SQLITE_MAINTENANCE_TOKEN } from '@/lib/env.server';

/**
 * An unset configured token never matches. Treating it as "no auth required"
 * would open both routes on a deploy that forgot the variable, so this fails
 * closed; `/api/health/storage` reports `maintenanceTokenSet` so the omission is
 * visible rather than silent.
 */
export function maintenanceTokenMatches(provided: string | null): boolean {
  if (!provided || !SQLITE_MAINTENANCE_TOKEN) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(SQLITE_MAINTENANCE_TOKEN);
  // timingSafeEqual throws on a length mismatch, which would itself be an oracle.
  return a.length === b.length && timingSafeEqual(a, b);
}
