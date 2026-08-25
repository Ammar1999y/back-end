/**
 * The PostgreSQL client: one pooled `Bun.SQL` connection pool for the process,
 * and the transaction helper that runs on it.
 *
 * This file used to hold `drizzle-orm/neon-http` and `db/ws.ts` held a second,
 * different Neon driver. That split was not a preference — `neon-http` sends one
 * HTTPS request per query, each its own implicit transaction with no session
 * continuity, so nothing session-scoped worked: no `FOR UPDATE` held across
 * statements, no `pg_advisory_xact_lock`, no `SET LOCAL`. `db/ws.ts` existed to
 * buy that back over a WebSocket, and paid for it by constructing and destroying
 * a whole connection pool per transaction.
 *
 * `bun:sql` pools real TCP sessions inside this long-lived process, so one
 * client serves both roles and a transaction is just a transaction on a reserved
 * connection. Measured on Bun 1.4.0 against PostgreSQL 18.6: every statement in
 * a `db.transaction()` block runs on one backend PID, and
 * `pg_advisory_xact_lock` is visible in `pg_locks` for that PID.
 */
import { SQL } from 'bun';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';

import { drizzle } from 'drizzle-orm/bun-sql';

import { DATABASE_URL } from '@/lib/env.server';

import { MAX_POOL_CONNECTIONS } from './limits';
import * as schema from './schema';

/**
 * Module-private on purpose: one pool per process, reachable only through `db`,
 * `withTransaction` and `closeDatabase`, so nothing can open a second one.
 *
 * No `statement_timeout`, and that is a standing decision rather than an
 * oversight.
 *
 * Setting it is one line — Bun's `connection` option passes PostgreSQL runtime
 * parameters, so `connection: { statement_timeout: '...' }` is all it takes. The
 * reason not to is that any value below a real query's duration converts a slow
 * request into a failed one, and no query here has been profiled against the
 * target host.
 *
 * What would justify adding it: a measured p99 for the slowest legitimate query
 * — realistically the data-table routes, which can run a sequential scan when a
 * `allowScanOnly` filter is used — with the ceiling set well above it. Until
 * then the exposure is bounded and known: a runaway query holds one of
 * `MAX_POOL_CONNECTIONS` until it finishes or the client disconnects.
 */
const client = new SQL(DATABASE_URL, { max: MAX_POOL_CONNECTIONS });

export const db = drizzle<typeof schema>({ client, schema });

/** A transaction handle. Named for the transaction, not for the driver. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Keeps transaction boundaries independent of the database driver at call sites. */
export function withTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
  config?: PgTransactionConfig
): Promise<T> {
  return db.transaction(fn, config);
}

/**
 * Closes the pool on shutdown.
 *
 * Unlike the SQLite stores, this always has something to close — the pool is
 * constructed at module load, and this module is only reachable from a process
 * that imported the application. `close()` waits for in-flight queries; the
 * shutdown path in `server.ts` is already bounded by its own forced-exit timer,
 * so this does not need a second timeout of its own.
 */
export function closeDatabase(): Promise<void> {
  return client.close();
}
