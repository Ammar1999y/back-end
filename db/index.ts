import '@/lib/env.server';

import { drizzle } from 'drizzle-orm/neon-http';

import { neon } from '@neondatabase/serverless';

import * as schema from './schema';

const sql = neon(process.env.DATABASE_URL!);
export const db = drizzle<typeof schema>(sql, { schema });
