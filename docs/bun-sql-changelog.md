# Bun.sql is more reliable

`v1.3.11` → `v1.4.0`

```js
const sql = new Bun.SQL({ prepare: false });
await sql`SELECT 1`; // now safe behind PgBouncer transaction pooling
```

- **PgBouncer transaction pooling**: with `prepare: false`, Bun now sends each query in a single round-trip instead of two, so PgBouncer can no longer split it across Postgres connections and return the wrong query's results. #27952
- **Docker startup windows**: when a pooled connection is accepted then closed before the handshake completes (as happens with Docker while a containerized database is still starting), Bun now retries with exponential backoff until `connectionTimeout` elapses instead of failing every waiting query. #32028

---

## Bun.sql

- Bun.sql: a result column named `""` (for example `select ''` on MySQL or MariaDB) no longer crashes the process. #38143
- Bun.sql (MySQL): JSON columns from MariaDB parse into objects via extended-type-info negotiation. #37130
- Bun.sql (MySQL): column-count and structure mismatches are asserted instead of silently dropping values. #36554
- Bun.sql (MySQL): prepared statements assigned `statement_id` 0 by the server are rejected instead of silently misbehaving. #33238
- Bun.sql (Postgres): fixed memory leaks in array-typed columns and failed connections.
- Bun.sql (Postgres): binary `NUMERIC` values smaller than 1e-8 decode correctly.
- Bun.sql (Postgres): queries exceeding the 65,535-parameter wire limit throw `ERR_POSTGRES_TOO_MANY_PARAMETERS`.
- Bun.sql (Postgres): multi-statement simple queries return the correct column names per result set.
- Bun.sql (MySQL) `SELECT` no longer silently returns zero rows against StarRocks, TiDB, and SingleStore.
- Bun.sql (MySQL) Memory usage stays flat across thousands of queries (column-name and prepared-statement buffers are now freed)
- Bun.sql (MySQL) `DATETIME`/`TIMESTAMP` round-trip as UTC.
- Bun.sql (MySQL) `YEAR` and computed `DECIMAL` columns decode correctly.
- Bun.sql (MySQL) BINARY/VARBINARY/BLOB return `Buffer` while binary-collated VARCHAR returns `string`
- Bun.sql (MySQL) `.raw()` no longer includes stray protocol bytes at the start of each value.
- Bun.sql (MySQL) A hang involving stored procedures and multi-statement queries has been fixed.
- Bun.sql (MySQL) Idle connections no longer hold the event loop open or spike CPU to 100% over TLS. #28005 #28633 #31212
- Bun.sql (pool & helpers) The `sql({...})` INSERT helper omits `undefined` so columns fall back to their `DEFAULT`
- Bun.sql (pool & helpers) Throwing inside `onconnect`/`onclose` no longer hangs the pool.
- Bun.sql (pool & helpers) `sql.close({ timeout: 0 })` resolves during a half-open handshake.
- Bun.sql (pool & helpers) New `ERR_*_CONNECTION_FAILED` codes distinguish "never connected" from "connection dropped". #25830
- Bun.sql (Postgres) could silently deliver one query's rows to a different query when a simple-protocol query ran concurrently with a not-yet-prepared parameterized query on the same connection. Simple-protocol queries include `.simple()`, parameter-less `sql.unsafe()`, and the `BEGIN`/`COMMIT`/`ROLLBACK` that `sql.begin()` issues. Bun was sending a redundant protocol message that pushed its reply queue out of step with the server. #32772
- **JSON serialization**: ~3x faster across IPC, `console.log('%j')`, Postgres/MySQL JSON columns, and Jest format specifiers. These paths now hit JavaScriptCore's SIMD-optimized FastStringifier instead of the slow path.
- **TLS**: Hostname matching is one implementation across `fetch()`, `WebSocket`, `Bun.connect`, `Bun.sql`, and `X509Certificate#checkHost`, aligned with `tls.checkServerIdentity`
- **Native memory**: edge cases involving bounds and lifetime checks in `Buffer` (concat, compare, indexOf/lastIndexOf/includes), `crypto.randomFill`, `TextDecoder.decode`, `Bun.udpSocket` send/sendMany, `node:zlib`, structured-clone deserialization (bun:jsc, node:v8, advanced IPC), `node:fs` path handling and Windows path normalization, generated native-class setters called with a foreign receiver, the `.npmrc` INI parser, and the Postgres and MySQL wire parsers have been fixed
- Bun.sql (Postgres): connection parameters are validated and reject null bytes with `ERR_INVALID_ARG_TYPE`.
- Bun.sql (Postgres): a synchronous validation error on an idle pooled connection no longer wedges the event loop keep-alive and prevents exit.
- Bun.sql (Postgres): backend message framing is validated.
- Bun.sql (Postgres): connection-failure messages are handled regardless of how they arrive across TCP reads.
- Bun.sql (MySQL): `caching_sha2_password` fast authentication against MySQL 8 now works instead of falling back to full authentication on every connect. #33179
- Bun.sql (MySQL): binary-protocol `NULL` on digit-named columns lands at the column's numeric name instead of index `0`. #32367
- Bun.sql (Postgres): `'infinity'::date/timestamp` values decode to `±Infinity` instead of invalid dates. #35121
- Bun.sql (Postgres): `DateStyle=ISO` is pinned on connect so a server default can't corrupt date parsing. #35112
- Bun.sql (Postgres): the wire-protocol parser enforces message-length frame boundaries and bounds `DataRow`/`RowDescription` reads. #35114 #34436
- Bun.sql (Postgres): out-of-range digit words are rejected when decoding binary `NUMERIC`. #34429
- Bun.sql's `connectionTimeout` now bounds the whole handshake. Before, it restarted on every packet. A Postgres server that sends a second authentication request now fails the connection with `ERR_POSTGRES_UNEXPECTED_MESSAGE`. #36308
- Bun.sql now honors `PGSSLMODE` from the environment. A URL `?sslmode=` still wins. `PGSSLMODE=require` against a server without TLS now fails. Before, it connected in plaintext. `?ssl=` and `?ssl-mode=` are accepted as spellings. `tls: { caFile }` enables verification like `ca`. #36840 #37669
- Bun.sql now decodes a Postgres `date`, `timestamp`, or `timestamptz` of `infinity` or `-infinity` as the number `Infinity` or `-Infinity`. Before, it was an invalid `Date`. Check for it before calling `Date` methods on the value. #35121
