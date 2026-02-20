import { drizzle } from 'drizzle-orm/neon-serverless';

import { Pool } from '@neondatabase/serverless';

import * as schema from './schema';

export function WSDB() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle<typeof schema>(pool, { schema });
  return { db, pool };
}

export type WsTx = Parameters<
  Parameters<ReturnType<typeof WSDB>['db']['transaction']>[0]
>[0];

// To switch to a local DB later, replace the body of this function:
// const { db } = localDB();
// return db.transaction(fn);
export async function withTransaction<T>(
  fn: (tx: WsTx) => Promise<T>,
): Promise<T> {
  const { db, pool } = WSDB();
  try {
    return await db.transaction(fn);
  } finally {
    try {
      await pool.end();
    } catch {}
  }
}
