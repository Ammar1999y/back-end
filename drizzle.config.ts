import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit config for ONE command: `bun run db:generate`, which reads
 * `db/schema.ts` and writes SQL into `db/drizzle/`. It never connects.
 *
 * No `dbCredentials`, and no `DATABASE_URL` check, deliberately. Every
 * drizzle-kit command that would use them — `migrate`, `push`, `pull`,
 * `studio` — connects through `pg`, `postgres`, `@neondatabase/serverless` or
 * `@vercel/postgres`, and this project has none of them: the client is
 * `bun:sql`. So the credentials could not be used even if they were here, while
 * requiring the variable made `db:generate` fail for no reason in any
 * environment that has the schema but not the database. Migrations are applied
 * by `bun run db:migrate` (`scripts/migrate.ts`), which owns the connection.
 */
export default defineConfig({
  out: './db/drizzle',
  schema: './db/schema.ts',
  dialect: 'postgresql',
});
