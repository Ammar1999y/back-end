/**
 * The PostgreSQL client: one pooled `Bun.SQL` connection pool for the process,
 * and the transaction helper that runs on it.
 *
 * The driver has to hold real TCP sessions: `FOR UPDATE` across statements,
 * `pg_advisory_xact_lock` and `SET LOCAL` throughout this codebase all assume a
 * transaction runs on one backend connection. A per-query HTTP driver breaks
 * every one of them silently (`reports/comment-evidence.md`).
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
 * No `statement_timeout`, deliberately: a ceiling below a real query's duration
 * turns a slow request into a failed one, and no query here has been profiled
 * against the target host. Add one only with a measured p99 for the slowest
 * legitimate query — the data-table routes under an `allowScanOnly` filter —
 * and set it well above that. Until then a runaway query holds one of
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
 * The readiness probe's own pool: one connection, with the deadline enforced
 * where the work happens. Racing a query on the application pool against a
 * sleep abandons the query without stopping it, and the abandoned probe then
 * delays the auth and dashboard queries it exists to report on.
 *
 * `statement_timeout` is scoped to this pool only: the standing decision not to
 * set one on the application pool stands until the slowest legitimate query has
 * been profiled against the target host. `select 1` needs no profiling.
 */
export const PROBE_TIMEOUT_MS = 2000;

const probeClient = new SQL(DATABASE_URL, {
  max: 1,
  connectionTimeout: Math.ceil(PROBE_TIMEOUT_MS / 1000),
  connection: { statement_timeout: String(PROBE_TIMEOUT_MS) },
});

/**
 * Single-flight on the QUERY, not on the caller's wait: the entry is cleared
 * only when PostgreSQL has answered or the driver has given up, so a hanging
 * peer costs one queued statement however often the public health route is
 * polled. A caller-side clear let each poll start another query behind the
 * abandoned one on this single connection.
 */
const probe: { inFlight: Promise<{ error: unknown } | null> | null } = {
  inFlight: null,
};

const probeTimedOut = Symbol('postgres-probe-timeout');

/**
 * True when PostgreSQL answered within `PROBE_TIMEOUT_MS`, false when it did
 * not answer in time. A refusal, an authentication or protocol error, or a
 * statement timeout is THROWN, so the caller can log its class: only the
 * response race is silent, because it says nothing about the database.
 *
 * The shared promise never rejects — it carries the failure as a value — so a
 * query that outlives every caller cannot become an unhandled rejection.
 */
export function pingDatabase(): Promise<boolean> {
  probe.inFlight ??= probeClient`select 1`
    .execute()
    .then(
      () => null,
      (error: unknown) => ({ error })
    )
    .finally(() => {
      probe.inFlight = null;
    });

  // Bounds the RESPONSE with the same constant the server-side deadline uses;
  // an unreachable host never reaches a statement, so the driver's own bounds
  // are the only thing this waits on and this race is the floor under them.
  return Promise.race([
    probe.inFlight,
    Bun.sleep(PROBE_TIMEOUT_MS).then(() => probeTimedOut),
  ]).then((raced) => {
    if (typeof raced === 'symbol') return false;
    if (raced === null) return true;
    throw raced.error;
  });
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
export async function closeDatabase(): Promise<void> {
  await Promise.all([client.close(), probeClient.close()]);
}
