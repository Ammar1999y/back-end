/**
 * Empties the limiter store between tests.
 *
 * For a suite whose SUBJECT is what a route does, not how often it may be
 * called: the media library's two upload routes share one per-user admission
 * budget (`UPLOAD_ADMISSION_SCOPE`, 40 a minute), and a file that drives every
 * upload path through one account spends that window on fixtures and then reads
 * its own 429s as failures of the thing under test. `tests/integration/media-folders.test.ts`
 * avoids the same trap by seeding its fixtures through the database, which a
 * suite about uploading cannot do.
 *
 * Never call this from a test that asserts a limit.
 */
import { getRateLimitStore } from '@/lib/rate-limit/store';

export function resetRateLimits(): void {
  getRateLimitStore().db.exec('delete from rate_limit');
}
