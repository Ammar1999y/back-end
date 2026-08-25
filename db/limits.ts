/**
 * Pool ceiling, in its own module because two very different callers need it.
 *
 * `db/index.ts` constructs the pool from it. The test harness sizes `bun test
 * --parallel` against it, since N worker processes each construct that pool and
 * the total must stay under the server's `max_connections` — and importing
 * `db/index.ts` for a number would construct a pool as a side effect.
 *
 * It is load-bearing rather than decorative. `withTransaction` reserves one
 * connection for the whole block, so this is the number of concurrent
 * transactions the process supports before callers queue behind Bun's
 * `connectionTimeout` (30 s) rather than a throughput knob.
 *
 * Nothing may hold a transaction open across a network call to a third party.
 * `processOtpSend` used to, and ten concurrent sends against a hanging SMTP
 * server exhausted this pool and stalled every other transactional path;
 * delivery now runs after the commit (see `utils/otp.ts`).
 *
 * 10 is Bun's own default, restated here because it has to be read against the
 * server's `max_connections` — one process must not be able to exhaust it, and a
 * second process (a migration run, a test worker) needs headroom.
 */
export const MAX_POOL_CONNECTIONS = 10;
