// import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// config({ path: '.env' });
const url = process.env.DATABASE_URL;
if (!url) throw new Error('Missing required server env var: DATABASE_URL');

export default defineConfig({
  out: './db/drizzle',
  schema: './db/schema.ts',
  dialect: 'postgresql',
  dbCredentials: { url },
});
