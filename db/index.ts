import { drizzle } from 'drizzle-orm/neon-http';

import { neon } from '@neondatabase/serverless';
import { DATABASE_URL } from '@/lib/env.server';

import * as schema from './schema';

const sql = neon(DATABASE_URL);
export const db = drizzle<typeof schema>(sql, { schema });
