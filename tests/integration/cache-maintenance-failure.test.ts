import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';

import { cacheSet, closeCacheStore } from '@/lib/cache';
import { CACHE_DB_PATH } from '@/lib/env.server';
import { runMaintenanceSweep } from '@/lib/sqlite/maintenance';

beforeAll(() => {
  cacheSet('expired', { value: true }, -1);
  closeCacheStore();
  const db = new Database(CACHE_DB_PATH);
  try {
    db.exec('DROP TABLE cache');
  } finally {
    db.close();
  }
});

afterAll(() => {
  closeCacheStore();
  rmSync(CACHE_DB_PATH, { force: true });
  rmSync(`${CACHE_DB_PATH}-wal`, { force: true });
  rmSync(`${CACHE_DB_PATH}-shm`, { force: true });
});

test('a corrupt cache reports degraded work with unknown backlog', async () => {
  const result = await runMaintenanceSweep();

  expect(result.status).toBe('degraded');
  expect(result.hasMore).toBe(true);
  expect(result.removed).toMatchObject({
    cache: { removed: 0, hasMore: true, error: 'SQLiteError' },
  });
});
