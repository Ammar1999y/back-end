import type { Tx } from '@/db';

import { sql } from 'drizzle-orm';

import { db } from '@/db';
import * as z from 'zod';

// Credential revocation uses this database clock; an application timestamp can admit a stale proof under skew.
export async function authenticationStartedAt(
  executor: Tx | typeof db = db
): Promise<number> {
  const rows = await executor.execute(
    sql`select floor(extract(epoch from clock_timestamp()) * 1000)::double precision as milliseconds`
  );
  return z.object({ milliseconds: z.number().int().safe() }).parse(rows[0])
    .milliseconds;
}
