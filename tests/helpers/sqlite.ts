/**
 * Resetting the local SQLite state between tests.
 *
 * **Sweeping is not a reset.** The sweep removes only EXPIRED rows, and a
 * fixed-window counter inside its window is not expired — so a file that
 * exhausted an OTP budget leaves a row that denies the next file's first
 * assertion with no error, just an unexpected 429. Deleting the file is the only
 * reset.
 *
 * `--isolate` is not a substitute either: it resets the JavaScript global and the
 * module registry, not the filesystem. It does, however, mean the store
 * singletons are gone — which is why `close…Store()` has to run before the
 * unlink, or the deleted file keeps being written through an open handle.
 */
import { existsSync, rmSync } from 'node:fs';

import { closeCacheStore } from '@/lib/cache';
import { CACHE_DB_PATH, RATE_LIMIT_DB_PATH } from '@/lib/env.server';
import { closeRateLimitStore } from '@/lib/rate-limit/store';

/** WAL leaves two sidecars; removing only the main file leaves committed rows. */
function unlinkDatabase(file: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const target = `${file}${suffix}`;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path derived from SQLITE_DIR, which the preload set to a temp directory
    if (existsSync(target)) rmSync(target, { force: true });
  }
}

/**
 * Closes both stores and deletes their files, so the next store call re-opens
 * against an empty database and re-runs the real migrations.
 *
 * Call it in `beforeEach` of any file that asserts limiter or cache behaviour.
 * Calling it in `beforeAll` only is enough for a file whose tests use distinct
 * keys, and wrong for one that counts.
 */
export function resetSqliteStores(): void {
  closeRateLimitStore();
  closeCacheStore();
  unlinkDatabase(RATE_LIMIT_DB_PATH);
  unlinkDatabase(CACHE_DB_PATH);
}
