# Coolify deployment: ElysiaJS, `bun:sql`, `bun:sqlite`

Updated: 2026-08-25

> **Nothing here has been executed against a live Coolify instance since the
> Elysia migration.** Treat it as revised instructions, not a verified
> deployment. The PostgreSQL and SQLite behaviour was verified locally
> (PostgreSQL 18.6 on Bun 1.4.0); the Coolify wiring was not.

## Topology

One Coolify application on one VPS:

- **Runtime:** Bun 1.4.0 — runtime, package manager and TypeScript loader. No
  Node process, no bundle, no `node-gyp`.
- **Business data:** PostgreSQL via `bun:sql`. One pooled client in
  `db/index.ts`; `withTransaction` runs on it.
- **Rate limits and cache:** local SQLite via `bun:sqlite` on a persistent
  volume.
- **Ingress:** Cloudflare → Coolify/Traefik.
- **Process model:** one container, one `bun server.ts` process.

No Dockerfile, so the build uses Nixpacks. Add a Dockerfile if the exact Bun
version cannot be reproduced — the risk matters more now that Bun is the
runtime, not just the build tool.
[Nixpacks configuration](https://coolify.io/docs/applications/build-packs/nixpacks) ·
[Deploy Elysia to production](https://elysiajs.com/patterns/deploy)

## Settled decisions

Instructions below depend on these. Revisiting one changes the marked sections.

| Decision             | Choice                                                        | Affects |
| -------------------- | ------------------------------------------------------------- | ------- |
| Expiry sweep         | In-process `Bun.cron`, every 15 minutes                       | §9      |
| Retention sweep      | In-process `Bun.cron`, daily                                  | §9      |
| Power-loss RPO       | `synchronous = NORMAL` on the limiter DB, incl. daily OTP cap | §4      |
| Retained WAL ceiling | `journal_size_limit = 64 MiB` retained size, peak monitored   | §4, §10 |
| Sweep trigger        | In-process `Bun.cron` (`lib/schedule.ts`)                     | §9      |

**The sweep-trigger decision was re-opened and reversed. Both sweeps now run
in-process on `Bun.cron` — see §9.** The original decision was taken against
`@elysia/cron`, whose load-bearing objection was "another Elysia coupling while
the Elysia-versus-Hono question is open"; `Bun.cron` is a **runtime** API that
survives a framework change untouched, and its single-process precondition was
already satisfied by `reusePort: false`. That deleted both `/api/internal/*`
routes and the whole maintenance attack surface behind them.
`SQLITE_MAINTENANCE_TOKEN` survives, guarding `?deep=1` alone, and now has a
32-character floor. The trade — losing the scheduled task's own failure alerting
— is paid by the structured per-run log described in §9.

## Open gates

Do not expose production traffic until these are resolved.

1. ~~**Pin `TZ=UTC` (§3).**~~ **CLOSED IN CODE — no host or database setting is
   required.** Kept here because it was the most severe gate in this runbook and
   an operator reading an older copy will look for it.

   The defect was `mode: 'string'` on all 25 `timestamptz` columns in
   `db/schema.ts`. `bun:sql` hands drizzle a `Date`, so string-mode's
   `typeof value === 'string'` early return never fired and the branch below it
   took the UTC wall clock and appended the **process-local** offset — naming a
   different instant from the one stored. Four abuse controls failed **open** as
   a result (login lockout, OTP verify block, OTP send block, resend cooldown),
   session-list pagination silently skipped rows, and Better Auth evaluated
   session expiry at the wrong instant.

   The columns now carry no `mode`, so the driver's `Date` reaches callers
   untouched and every comparison is on an absolute instant. Two consequences
   for deployment:

   - **`TZ` on the container no longer affects any security decision.** The one
     remaining host-zone-sensitive function (`formatDate`, `utils/index.ts`) has
     no caller; `utils/time.ts` declares `BUSINESS_TIMEZONE` explicitly for
     every calendar-day conversion. Setting `TZ=UTC` is still reasonable hygiene
     for log readability — it is no longer load-bearing.
   - **No PostgreSQL-side setting is required, on this host or any other.**
     Verified against the live database: `timestamptz` decodes to the same
     absolute instant under server `TimeZone` values `UTC`, `Asia/Riyadh`,
     `America/Sao_Paulo` and `+05:30`. The fix therefore survives a move to a
     managed host (Neon and similar) with no configuration to carry across.

   Regression cover: `tests/integration/timezone-auth-behavior.test.ts`. The
   integration job in `.github/workflows/ci.yml` runs it under
   `TZ: Asia/Riyadh` with `REQUIRE_NON_UTC_TZ: '1'`, and the suite's first test
   fails if either is missing — so a UTC runner cannot pass this class silently.

   Client-visible contract change that shipped with it: `createdAt` / `updatedAt`
   on the dashboard read endpoints and the `updatedAt` returned by
   `PUT /api/dash/permissions/:id` are now ISO-8601 UTC
   (`2026-08-21T12:02:00.000Z`) instead of PostgreSQL's rendering with a local
   offset (`2026-08-21 12:02:00.000+03`).

2. ~~**Path-prefix edge rules are bypassable.**~~ **CLOSED IN CODE.** Elysia
   1.4.29 finds the path by string arithmetic from a fixed offset of 11
   characters, not by URL parsing. With a hostname below 4 characters the real
   path-start slash sat below that offset and the router dispatched on a
   _suffix_ — measured over raw TCP: `Host: x` plus
   `POST /zz/api/internal/sqlite-sweep` reached the sweep handler while matching
   **none** of the `/api/internal/` prefix rules in §5, and the same trick gave
   every request a fresh per-IP limiter bucket, bypassing the 120/60 s admission
   gate on all 22 `ip-limit` routes.

   `app.ts` now refuses any request whose hostname is shorter than 4 characters,
   in `onRequest`, before anything reads the path. **Not** with
   `handler: { standardHostname: false }`, which the original finding suggested:
   offset 7 is correct only for the 7-character `http://` and lands on the second
   slash of `//` under `https://`, yielding `/example.com/api/…` — measured. The
   hostname floor is scheme-independent, and no real deployment approaches it
   (`localhost` is 9, an IPv4 literal is 7). Covered by
   `tests/process/host-routing.test.ts`.

   Step 6 of §5 — block non-Cloudflare origin traffic at the VPS firewall —
   remains correct, but it is defence in depth again rather than the control this
   depended on.

3. **`secure_delete` is undecided.** Both databases run `secure_delete=OFF`, so
   deleted rows keep their bytes until the pages are reused — and those bytes
   are limiter keys embedding raw IPs, emails and phone numbers. A raw-file
   probe confirmed a marker containing all three survived deletion plus a
   truncating checkpoint under `OFF`, and was absent under `FAST`. Either set
   `secure_delete=FAST` in [`applyPragmas`](../lib/sqlite/database.ts) or record
   retention as accepted policy. The default silently chooses retention.
   (`bench/sqlite/FINAL-REPORT.md` → "Open security decision".)
4. ~~**Schedule both sweeps, and generate `SQLITE_MAINTENANCE_TOKEN`
   properly.**~~ **MOSTLY CLOSED IN CODE.** Both sweeps run in-process now, so
   there is nothing to schedule and no unset-token failure mode that silently
   stops them (§9). The token guards `GET /api/health/storage?deep=1` alone.

   What remains yours: **use `openssl rand -hex 32` and nothing else.** The
   generated value is the entire control. A short token is now refused at boot —
   `lib/env.server.ts` requires at least 32 characters when the variable is set —
   and a failed attempt is logged (`maintenance token rejected`, with the reason
   class and never the value). The comparison short-circuits on length before its
   constant-time compare, which is exactly why the floor exists: the length is
   recoverable before any content guessing.

5. **Cloudflare ingress is mandatory.** The code trusts `cf-connecting-ip` and
   nothing else; Traefik's `x-forwarded-for` is deliberately not accepted
   because it is client-controllable whenever the origin is directly reachable.
   Direct Coolify traffic makes IP-protected handlers return 503. Proxy DNS
   through Cloudflare and block direct origin access (§5).

   The header is trusted on **syntax alone** — nothing verifies the socket peer
   is Cloudflare/Traefik. Deferred until the edge is final; sites carry a
   greppable `TODO(proxy-trust)`, resolution in `reports/should-ignore.md` #63.

6. **Choose deployment overlap policy** — stop-first is the safe default (§6).
7. **Confirm no secret is scoped to the build.** The build stage is
   `tsc --noEmit`, which reads no environment, so every secret is runtime-only.
   A build-scoped secret stays visible in image history unless BuildKit secrets
   are in use, for no benefit.
8. **Decide rate-limit backup RPO.** With no off-host SQLite backup, host loss
   resets the daily OTP spend counter. If exact continuity is mandatory,
   single-VPS SQLite is insufficient — use durable shared storage.
9. ~~**Decide whether readiness should cover PostgreSQL.**~~ **DECIDED AND
   CLOSED IN CODE: a bounded `SELECT 1` on the SHALLOW path** (§7). It asserted
   `ok` on SQLite alone, so an unreachable database kept the container in
   rotation while every login, dashboard route and OTP send failed.

   The choice between `?deep=1` and the shallow path went to shallow, because a
   readiness probe that cannot see the primary database is not a readiness probe
   — and the two costs `?deep=1` exists to separate are a structural scan and a
   write lock, neither of which `SELECT 1` on a pooled connection is. It carries
   a 2 s timeout so an unreachable host produces a 503 rather than a hang the
   orchestrator reads as a timeout. Reported as `checks.postgres`, by name, so a
   degraded body says WHICH store failed.

10. **Run the SQLite checks against a copy of the live volume.** Migration,
    busy-handling, crash-recovery and backup/restore have only been verified
    against freshly created databases on a developer machine.

**Resolved:** `utils/config.ts` now sets `OTP_AUTO_VERIFY = false`, so the OTP
bypass gate is closed. (`NEXT_PUBLIC_OTP_AUTO_VERIFY` is referenced only in a
comment; no code reads it.)

## 1. Prepare release

- Commit and push every runtime file. Coolify builds the Git commit, not the
  working tree. Never commit `.env`, `data/`, `*.db`, `*-wal`, `*-shm`.
- Run CI and `bun run build` before tagging.
- **Apply PostgreSQL migrations through a controlled workflow, not Coolify.**
  Coolify's pre-deployment command runs in the _old_ container. The command is
  `bun run db:migrate`, which applies both phases — generated migrations in
  `db/drizzle/`, then the hand-written SQL in `db/migrations/` (`pg_trgm` and
  the GIN indexes). It needs only `DATABASE_URL`, so it is safe to run from a
  maintenance shell.
- Before routing traffic, run `bun run preflight:credentials` with production
  `DATABASE_URL` and password-pepper variables. It fails if any credential uses
  a malformed envelope or a pepper ID missing from the deployed keyring.
- Image encoding admits one active job and four queued jobs per process. Benchmark
  on the VPS before increasing either limit; raising them is capacity tuning, not
  required deployment configuration.
- Record the release commit, Coolify environment, PostgreSQL migration version
  and SQLite `user_version`.
- For the Upstash cutover, follow §11.

If CI fails on `find:unused-files`, "unregistered handler" means a `handler.ts`
exists under `app/api/` that no `routes.ts` entry imports — dead code, not
broken configuration.

## 2. Create the Coolify application

**Configuration > General:**

| Field           | Value                           |
| --------------- | ------------------------------- |
| Build Pack      | `Nixpacks`                      |
| Base Directory  | `/`                             |
| Static Site     | Off                             |
| Ports Exposes   | `3000`                          |
| Port Mappings   | Empty                           |
| Install Command | `bun install --frozen-lockfile` |
| Build Command   | `bun run build`                 |
| Start Command   | `bun run start`                 |

`bun run build` is `bun scripts/build-openapi.ts && tsc --noEmit`. There is no
bundle. The script generates `build/openapi.json` from the **production-filtered**
route table, which is the only place a route table inconsistent with its request
schemas can be caught: that filter withholds `/api/dev/*`, and the mismatch it
created made `GET /openapi.json` return 500 for every authorised caller in
production while every development check passed. The artefact is served by
nothing — the runtime route reads it and still requires a live dashboard session
— so `build/` must never be exposed as a static directory.

`bun run start` is `NODE_ENV=production bun --bun server.ts`. **If the start
command is overridden in Coolify, `NODE_ENV=production` must be carried over** —
HSTS, the production env validation in `lib/env.server.ts`, the
absolute-`SQLITE_DIR` rule and the dev-only endpoint gates all key off it.

**Consider adding `--no-env-file`.** Bun auto-loads `.env` from the working
directory. Measured precedence is the safe direction — a real process variable
wins over a `.env` entry, under `NODE_ENV=production` too — so a stray file
cannot _override_ a Coolify-configured value. The residual risk is narrower and
real: it can **supply** a variable the platform deliberately left unset. The
obvious one is `SQLITE_MAINTENANCE_TOKEN` (gate 4), where a committed or
image-baked development value would silently become the production maintenance
secret. `PUBLIC_URL` fails loudly instead, because two disagreeing names are a
boot failure. One flag removes the input; §1's "never commit `.env`" is the
other half.

### Startup refuses to boot on five conditions

`server.ts` validates the runtime **before** importing the application. A
rejected runtime exits non-zero after one line: `{"msg":"startup rejected",…}`.
A container restart-looping with that line is misconfigured, not crashing.

| Condition                                                | Why fatal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV` not exactly `development`/`test`/`production` | Every production guard is an exact string comparison. `NODE_ENV=prodution` previously disabled the Better Auth secret floor, the Turnstile requirement, the absolute-`SQLITE_DIR` rule and HSTS at once, and still served traffic.                                                                                                                                                                                                                                                                                                     |
| `PORT` not a decimal integer in `1..65535`               | `Number(PORT)` accepted `''` as 0 and `3000abc` as `NaN`; Bun then bound an ephemeral port while the log reported the requested one.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Bun OLDER than the pinned `1.4.0`                        | Both DB drivers are compiled into the Bun binary. Through 1.3.x, a simple-protocol query concurrent with a not-yet-prepared parameterized one could return the **wrong query's rows** — and `withTransaction`'s `BEGIN`/`COMMIT`/`ROLLBACK` are simple-protocol (Bun #32772, fixed in 1.4.0). Also through 1.3.x, `Bun.randomUUIDv7()` wrapped its sub-millisecond counter at 4,096 ids, breaking the time ordering the session keyset cursor depends on. Bun NEWER than the pin boots and logs `bun version ahead of the tested pin`. |
| `packageManager` not `bun@<major>.<minor>.<patch>`       | It is the only source for the pin (below). A malformed field is treated as a missing runtime contract, not as "no pin".                                                                                                                                                                                                                                                                                                                                                                                                                |
| `sqlite_version()` below `3.51.3`                        | The WAL-reset floor (§6), now asserted rather than eyeballed in the build log.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

So the Bun version check is a **floor**, enforced rather than advisory: anything
below 1.4.0 refuses to start, anything above it boots with a warning line. It
used to reject a differing minor in either direction, which turned a forward
image bump into an outage; the floor is what the transaction defect actually
requires.

The pin now has exactly **one** home: `packageManager` in `package.json`.
`server.ts` parses it at startup and `scripts/require-bun.mjs` reads the same
field at install time, so moving the pin means editing that field and `bun.lock`
— there is no longer an `EXPECTED_BUN_VERSION` constant to keep in sync.

### The install command now runs a runtime guard

`bun install --frozen-lockfile` runs the root `preinstall` script, which is
`bun scripts/require-bun.mjs`. In the build container it enforces the same floor
as startup, so a Nixpacks image with an older Bun fails at **install** with an
actionable message instead of at container start.

Two things the operator must know about it:

- **It can reach the network.** If the image's Bun is older than the pin, the
  guard runs Bun's official installer to correct it. That is right on a
  developer machine and wrong in a build container, where the toolchain should
  come from the image. It is suppressed whenever `CI` is set — which GitHub
  Actions sets and **Coolify's Nixpacks build does not**. Set
  `BUN_GUARD_NO_AUTO_INSTALL=1` as a build-time variable so the build fails with
  instructions rather than mutating itself. Add it to the "Required" table if the
  build ever runs on an image whose Bun is not pinned.
- **It needs no Node.** The guard is plain `.mjs` but is invoked with `bun`, and
  it imports nothing from `node_modules` — it runs before the tree exists.
  `NIXPACKS_NODE_VERSION` stays absent (§3, "Must be absent").

### Startup log

```json
{
  "msg": "server started",
  "port": 3000,
  "hostname": "localhost",
  "env": "production",
  "bun": "1.4.0",
  "idleTimeoutSeconds": 60,
  "maxRouteTimeoutSeconds": 120,
  "maxRequestBodyBytes": 8388608,
  "shutdownTimeoutMs": 135000
}
```

Two fields mislead if read literally:

- **`port` is the bound port**, not the requested one. They differ whenever the
  kernel assigns one.
- **`hostname` reads `localhost` and is not the bind scope.** `server.ts` passes
  no hostname, so Bun binds `0.0.0.0` and `[::]` — the field is just what Bun
  reports for `server.hostname`. Do not "fix" it by passing
  `hostname: '0.0.0.0'`. Confirm the real bind once on the VPS with
  `ss -ltnp | grep <port>`, because a loopback-only bind is what makes the
  container unreachable through the proxy.

Read `shutdownTimeoutMs` from this log when setting the stop grace period (§6).

## 3. Configure environment

Every variable below is **runtime-only**. `tsc --noEmit` reads no environment,
so nothing belongs in the build scope. If you deliberately add a build-time
consumer, enable **Use Docker Build Secrets** first and abort if the build log
or image history shows Coolify fell back to `--build-arg`.
[Environment-variable scopes](https://coolify.io/docs/knowledge-base/environment-variables)

### Required

| Variable                           | Secret | Notes                                                                                                                                                                                                                                                        |
| ---------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV=production`              | No     | Enforced at boot — see §2.                                                                                                                                                                                                                                   |
| `TZ=UTC`                           | No     | Optional hygiene, not a control. It was load-bearing until the `timestamptz` columns dropped `mode: 'string'` (gate 1); no security decision reads the host zone now. Unrelated to `NEXT_PUBLIC_BUSINESS_TIMEZONE`, which is display only.                   |
| `PUBLIC_URL=https://<domain>`      | No     | Absolute origin: scheme required, no path/query/fragment/credentials, HTTPS in production. Used for both CORS and Better Auth's `baseURL`. `NEXT_PUBLIC_URL` is a legacy alias; setting both to different values is a boot failure.                          |
| `DATABASE_URL`                     | Yes    | PostgreSQL connection string for `bun:sql`. Put `sslmode` in the URL — see §3.1.                                                                                                                                                                             |
| `BETTER_AUTH_SECRET`               | Yes    | ≥32 chars, no surrounding whitespace.                                                                                                                                                                                                                        |
| `PASSWORD_PEPPER_ACTIVE_ID`        | Yes    | Must name a key in the keyring.                                                                                                                                                                                                                              |
| `PASSWORD_PEPPER_KEYRING`          | Yes    | One-line JSON; retain old keys still referenced by stored hashes.                                                                                                                                                                                            |
| `OTP_HMAC_ACTIVE_ID`               | Yes    | Must name a key in `OTP_HMAC_KEYRING`.                                                                                                                                                                                                                       |
| `OTP_HMAC_KEYRING`                 | Yes    | Same shape as the pepper keyring: `{"<id>":{"generation":1,"secret":"<32 bytes, unpadded base64url>"}}`. Generate with `openssl rand -base64 32 \| tr '+/' '-_' \| tr -d '='`. Malformed is a **boot** failure.                                              |
| `TURNSTILE_SECRET_KEY`             | Yes    | Production Cloudflare secret.                                                                                                                                                                                                                                |
| `SQLITE_DIR=/app/data`             | No     | Absolute; no production default — the app refuses to boot without it.                                                                                                                                                                                        |
| `SQLITE_MAINTENANCE_TOKEN`         | No     | Gates `GET /api/health/storage?deep=1` and nothing else. `openssl rand -hex 32`. **At least 32 characters when set** — a shorter value refuses to boot. Leave unset to disable the deep probe; every path fails closed. Failed attempts are logged by class. |
| `NEXT_PUBLIC_ENABLED_OTP_CHANNELS` | No     | Comma list: `email`, `sms`, `whatsapp`.                                                                                                                                                                                                                      |

A missing `SQLITE_MAINTENANCE_TOKEN` does **not** stop boot and does **not**
fail readiness. It gates the optional `?deep=1` probe alone, which answers 401
without it. Readiness stopped reporting `maintenanceTokenSet` when the token
became optional: leaving it unset is a supported configuration, so a check that
turned that into a 503 would have removed a healthy container from service for
following this table.

`SQLITE_DIR` is fatal at boot instead, because a defaulted value would let an
unmounted volume boot happily and write to the container layer, where every
redeploy silently resets the auth, API and daily OTP counters. Boot validation
still cannot prove the volume is mounted — only the persistence proof in §8 can.

### Optional

| Variable                        | Notes                                             |
| ------------------------------- | ------------------------------------------------- |
| `NEXT_PUBLIC_BUSINESS_TIMEZONE` | Valid IANA zone; defaults to `Asia/Riyadh`        |
| `PORT`                          | Supplied by Coolify; `server.ts` defaults to 3000 |

### Feature-dependent

- Email OTP: `SMTP_USER`, `SMTP_PASS`, optional `SMTP_FROM`
- SMS OTP: `DEEWAN_SMS_TOKEN`, `DEEWAN_SENDER_NAME`
- WhatsApp OTP: `WHATSAPP_API_KEY`
- R2 uploads: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
  `R2_PUBLIC_BUCKET`, `R2_PRIVATE_BUCKET`, `R2_PUBLIC_URL`

  **The first three are now REQUIRED in production and checked at module load.**
  R2 used to be the one env group with no boot-time validation at all —
  `lib/r2/client.ts` read every variable straight from `process.env` and none of
  them appeared in `lib/env.server.ts` — so a deploy missing them booted green,
  passed the health check, and failed on the first upload while the retention
  sweep silently deleted no R2 objects. The three BUCKET/URL variables stay
  feature-dependent: each is read at its point of use and raises an error naming
  itself, and a bucket that is configured but WRONG is a runtime fault no
  boot check can catch.

### Must be absent

| Variable                             | Why                                                                                                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TEST_DATABASE_URL`                  | The variable the destructive test harness resolves its target from. Treat as forbidden, not merely unused — if it appears, delete it and find out who added it.                  |
| `BETTER_AUTH_SECRETS`                | Rejected in production; it would override `BETTER_AUTH_SECRET`.                                                                                                                  |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | There are no Server Actions. Encrypts nothing.                                                                                                                                   |
| `NIXPACKS_NODE_VERSION`              | Nothing runs under Node. The application, every script and the install guard all run under Bun; the only Node in the repository is one benchmark harness that is never deployed. |
| `NEXT_TELEMETRY_DISABLED`            | No Next.js to opt out of.                                                                                                                                                        |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN`  | Superseded by local SQLite (§11).                                                                                                                                                |

Use Coolify Normal view, lock secrets, and enable **Literal** for any value
containing `$`. Never paste a local `.env` wholesale. After the build, confirm
no secret appears in the deployment log or `docker history --no-trunc <image>`;
rotate anything that does.

### 3.1 `bun:sql` operational notes

Verified locally against PostgreSQL 18.6 on Bun 1.4.0 — transactions on one
backend PID, advisory transaction locks, `FOR UPDATE`/`FOR SHARE`, `RETURNING`,
savepoints, the `pg_trgm` indexes, and the pool close. **Not verified against
Coolify.**

**a. `DATABASE_URL` is not proven at boot.** Bun opens the pool lazily, on the
first query (an unreachable host constructs in ~1 ms). So a wrong or unreachable
value is **not** a startup rejection and **not** a health-check failure —
`/api/health/storage` reads SQLite only. It is a 500 on the first request that
queries PostgreSQL. Verify explicitly during first deploy (§8), and treat
"container healthy" as saying nothing about the database.

**b. Put `sslmode` in the URL.** Bun honours `PGSSLMODE`, but `?sslmode=` in the
URL wins, so the environment cannot move it. `require` against a server without
TLS now fails rather than silently connecting in plaintext. Same-host over the
Docker network: decide deliberately. Remote: `require` or stricter.

**c. Pool size against `max_connections`.** `MAX_POOL_CONNECTIONS` in
`db/index.ts` is 10. That is the number of concurrent **transactions**, not a
throughput knob — `withTransaction` reserves a connection for the whole block,
and `processOtpSend` holds one across the provider HTTP call (`TODO.md` §2.1).
Callers beyond 10 queue, then fail on Bun's 30 s `connectionTimeout`. Confirm
the server's `max_connections` leaves headroom for a migration run and a `psql`
session on top of the app's 10.

**d. `prepare: true` is the default and is correct only here.** Bun creates
named prepared statements on the server, which is right against PostgreSQL
directly and wrong behind a transaction-pooling proxy — PgBouncer in transaction
mode can split a two-round-trip query across backends. If a pooler is ever put
in front of this database, set `prepare: false` in `db/index.ts`.

### 3.2 Key retirement — the two keyrings have different horizons

Both are parsed by `lib/auth/keyring.ts`, and in both a hash records the id of
the key that produced it. Removing a key whose id is still referenced makes
those values **unverifiable** — the lookup throws a configuration error that
reaches the client as a 500, not as a failed login or a wrong code.

| Keyring                   | A key may be removed once…                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASSWORD_PEPPER_KEYRING` | every stored hash has been rehashed under a newer generation. Users rehash on next successful login, so **months** — and no event tells you it is done. |
| `OTP_HMAC_KEYRING`        | no unexpired OTP was issued under it. Codes live 10 minutes (`OTP_EXPIRY_MINUTES`), so **an hour of grace is ample**.                                   |

Add the new key with a higher `generation`, deploy, then remove the old one on
the horizon above. Never remove and add in one step.

**Rolling a rotation back is where this bites, and neither failure is loud.**

- **Reverting `PASSWORD_PEPPER_KEYRING` to a version lacking the newest
  generation** makes every password hashed under it unverifiable. That does not
  surface as a failed login — it escapes sign-in as an **empty 500 with no
  `content-type`**, and because the throw happens inside the transaction the
  failed-attempt counter and the lockout audit row **roll back**, so those
  accounts have no working lockout and nothing to diagnose from. Mid-rotation it
  is also an account-existence oracle: 401 + JSON for an unknown address versus
  500 + empty body for an existing one whose hash predates the revert.
- **Reverting `PASSWORD_PEPPER_ACTIVE_ID` alone** — the common half-rollback — is
  accepted silently. Nothing checks that the active id owns the _highest_
  generation, and `generation` is read only as staleness, so `needsRehash`
  evaluates to `false` forever: boot succeeds, logins keep working, and every
  password set from then on is re-peppered with the **older** key with no error,
  no log and no startup failure. After an emergency rotation away from a leaked
  generation this quietly undoes it.

So a pepper rollback is a two-variable operation in both directions. Roll the
keyring and the active id together, and after any rotation confirm the active id
names the highest generation present.

## 4. Add persistent SQLite storage

**Configuration > Persistent Storage:**

| Field            | Value                      |
| ---------------- | -------------------------- |
| Type             | Named volume (recommended) |
| Name             | `sqlite-data`              |
| Destination Path | `/app/data`                |

Coolify prefixes the actual volume name with the resource identifier. A bind
mount is valid when host backup tooling needs a fixed path; the destination
stays `/app/data`.
[Persistent Storage](https://coolify.io/docs/knowledge-base/persistent-storage)

Requirements:

- **Real local VPS disk.** No NFS, CIFS, distributed volume or second host —
  SQLite WAL requires same-host shared memory.
  [WAL restrictions](https://www.sqlite.org/wal.html)
- **Mount the directory, not the `.db` file.** SQLite creates `-wal` and `-shm`
  beside each database.
- Do not share the path with preview/staging applications.
- One replica, one Bun process. No PM2 cluster, no Swarm replica increase, no
  second VPS against this volume. Elysia defaults Bun's `reusePort` to `true`,
  which would let a second process bind the same port and split traffic;
  `app.ts` sets `reusePort: false`, so a second process on this host dies with
  `EADDRINUSE`. A deploy failing that way is starting two processes; that is the
  bug, not the setting.

  **That guard covers a same-host double start and nothing else** — not a second
  container mounting the same volume, not a script or `psql`-equivalent opened by
  an operator, not a backup tool. Read the next section before doing any of
  those.

```text
/app/data/rate-limit.db  durable rate limits and OTP global spend cap
/app/data/cache.db       disposable cache; currently no call sites
```

The limiter database uses WAL with `synchronous=NORMAL`: process-crash-safe with
local durability, but host/OS failure or power loss can lose recently committed
transactions. Not a substitute for off-host backup or a durable shared store.

### A second writer on `rate-limit.db` is a full authentication outage

This is the operational rule that governs §10's checkpoint and backup commands,
and it is not obvious from either of them.

`bun:sqlite` is **synchronous**, so a contended statement blocks the whole event
loop — not one request. Measured: one external process holding `BEGIN IMMEDIATE`
for 4 s made a concurrent limiter call block for **2 282 ms** (the `busy_timeout`
ceiling) and then return `degraded`. `enforceRateLimit` turns `degraded` into
`503` on every fail-closed path, confirmed end to end:

```text
ip-limit route (dash/roles)  -> 503  Retry-After: 30
otp send                     -> 503  Retry-After: 30
health/storage               -> 503  {"status":"error"}
better-auth get-session      -> 500
```

So the failure is bimodal: for ~2.3 s per contended statement the process serves
**nothing at all**, and then sign-in, all five OTP surfaces and all 22 pre-auth
routes answer 503 — while the health check also 503s, so the orchestrator may
restart the container mid-incident. No attacker is involved; an operator action
is enough.

Practical rules that follow:

- Run `PRAGMA wal_checkpoint(TRUNCATE)` (§10) and the backup script (§10) during
  a maintenance window, not on a live deployment, and never on a schedule.
- Do not point a second container, a staging app, or a shell session's `sqlite3`
  at `/app/data` on a running deployment.
- **Scaling to more than one replica needs a decision, not a replica count.**
  Either give each replica its own `SQLITE_DIR` volume and accept that every
  limit becomes per-replica, or move the limiter to a shared store. Sharing one
  volume is the option that does not work: measured across 4 processes on one
  key with `limit: 200`, the counters were shared and **exact** (200 admitted,
  800 denied) — correct arithmetic, bought with exactly the writer contention
  above on every request.

Startup acquires an OS-backed ownership lock under `SQLITE_DIR`. A second
cooperating app process fails before serving traffic. External SQLite tools do
not honor this lock, so maintenance procedure still forbids them while live.

### Permissions check

After the first container start, in the Coolify Terminal:

```sh
id
stat -c '%U:%G %a %n' /app/data
test -w /app/data
```

The directory must be writable by the runtime UID, because WAL creates sidecars
there. For a bind mount, set host ownership to the numeric UID from `id` — never
`chmod 777`. Because the files hold raw identifiers, restrict the directory to
the runtime identity (`0700`) after verifying ownership; that mode also protects
newly created DB/WAL/SHM files. If the runtime identity cannot enforce it, fix
ownership or the startup umask before production.

## 5. Cloudflare ingress and edge rules

### Ingress

1. Add the domain in Coolify; do not publish a host port.
2. Create a **proxied** (orange-cloud) DNS record.
3. Use **Full (strict)** TLS with a valid Coolify origin certificate.
4. **Rules > Transform Rules > Managed Transforms:** keep _Remove visitor IP
   headers_ **off** — the code needs `CF-Connecting-IP`.
5. **Network > Pseudo IPv4:** _Off_ (preferred) or _Add Header_. Never
   _Overwrite Headers_ — it replaces `CF-Connecting-IP` for IPv6 visitors and
   defeats the application's IPv6 `/64` grouping.
6. At the VPS firewall, allow 80/443 from current Cloudflare ranges and trusted
   admin sources only; block everything else.
   [Cloudflare IP guidance](https://developers.cloudflare.com/fundamentals/concepts/cloudflare-ip-addresses/)
7. Confirm the original visitor address arrives in `CF-Connecting-IP` for both
   IPv4 and IPv6 clients.

The header is trustworthy **only because** direct origin traffic is blocked. If
Cloudflare is ever removed, stop and change the trust boundary first — do not
simply add `x-forwarded-for`, which clients can spoof whenever the origin or an
untrusted hop is reachable.

[Request headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/) ·
[Managed transforms](https://developers.cloudflare.com/rules/transform/managed-transforms/reference/) ·
[Pseudo IPv4](https://developers.cloudflare.com/network/pseudo-ipv4/) ·
[Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)

### Block `/api/internal/*`

**No route serves this prefix any more** — the two sweeps moved in-process (§9).
Keep the rule anyway: it costs nothing, and it means re-introducing a route under
this prefix cannot silently arrive internet-reachable.

**Rules > WAF > Custom rules:** URI Path _starts with_ `/api/internal/` →
**Block**. Equivalently, exclude `PathPrefix(/api/internal/)` from the public
Traefik router. Nothing in the repository can enforce this.

Verify:

```sh
# outside the VPS — expect a Cloudflare block, not the app's 404
curl -si https://<domain>/api/internal/sqlite-sweep -X POST | head -1
# inside the container — expect the app's own 404 envelope
wget -qO- --server-response --post-data='' \
  "http://127.0.0.1:3000/api/internal/sqlite-sweep" 2>&1 | head -3
```

Apply the same to `/api/health/storage?deep=1` if you can express the query
condition — but **the cheap variant must stay reachable** for the health check.
The deep variant is token-gated, so this is hardening, not a gap. It is now the
only surface `SQLITE_MAINTENANCE_TOKEN` guards.

Also block `/api/dev/` the same way. Both dev endpoints refuse outside
`NODE_ENV=development`, but they refuse _differently_: `/api/dev/email-test/fixed`
answers 404 (deliberately indistinguishable from an unrouted path), while
`/api/dev/sign-up` answers **403 with a distinctive body**, which is a positive
existence oracle for the route in production. Blocking the prefix costs nothing
and removes the divergence from the internet's view of it.

> **This whole section is prefix matching, and prefix matching is currently
> bypassable — see gate 2.** A crafted request with a ≤3-character `Host`
> reaches these handlers on a path that matches none of these rules. The
> firewall rule in step 6 above is what keeps that unreachable, so treat it as
> the primary control and these rules as the second line, not the reverse.

### Proxy limits that must match the application

| Setting                                                        | Must be             | Because                                                                                                                                                       |
| -------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare proxy read timeout, Traefik `responseHeaderTimeout` | **> 120 s**         | The upload route ceiling. Cloudflare's free-plan 100 s limit is _below_ it — raise it on a paid plan or lower the application ceiling deliberately.           |
| Cloudflare native upload ceiling                               | **Plan ceiling**    | This is not the application limit. The `max_upload` zone setting starts at 100 MB; an exact body-size WAF rule requires Enterprise.                           |
| Traefik `POST /api/upload/image` body limit                    | **1,114,112 bytes** | One 1 MiB file plus 64 KiB multipart overhead. The buffering middleware rejects an oversized request with 413 before forwarding it to Bun.                    |
| Bun/Elysia server-wide body limit                              | **8 MiB**           | `MAX_REQUEST_BODY_BYTES` remains the final origin-wide ceiling. It is broader than the upload contract and does not replace the upload-specific Traefik rule. |

Configure an upload-only Traefik router and attach this middleware through
Coolify's custom labels:

```text
traefik.http.middlewares.image-upload-body.buffering.maxRequestBodyBytes=1114112
```

Copy the generated host/TLS/service settings to a higher-priority router whose
rule adds the exact `/api/upload/image` path matcher. Attach `image-upload-body`
only to that router, and leave the generated catch-all router in place for every
other path.
Coolify controls the generated router/service names, so resolve them from the
deployment's labels or Traefik dashboard rather than copying a name from this
runbook. Verify the effective labels after every proxy configuration change.
[Traefik buffering](https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/buffering/) ·
[Coolify custom middleware](https://coolify.io/docs/knowledge-base/proxy/traefik/custom-middlewares/redirects)

Cloudflare still absorbs the public ingress and can add a path/IP rate rule for
`/api/upload/image`, subject to the zone's plan. Do not document or rely on an
8 MiB Cloudflare body limit: the zone-setting schema accepts values from 100 MB,
and `http.request.body.size` is Enterprise-only. On Enterprise, an exact-path
body-size block may duplicate the 1,114,112-byte bound at the edge; otherwise
Traefik is the first exact byte boundary. The VPS firewall must continue blocking
direct origin access either way.
[Cloudflare `max_upload` schema](https://developers.cloudflare.com/api/resources/zones/subresources/settings/methods/edit/) ·
[Cloudflare body-size field](https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/http.request.body.size/)

Request ceilings, for reference:

| Scope                    | Value | Where                                 |
| ------------------------ | ----- | ------------------------------------- |
| Server-wide idle timeout | 60 s  | `IDLE_TIMEOUT_SECONDS` in `server.ts` |
| `POST /api/upload/image` | 120 s | `timeoutSeconds` in `routes.ts`       |

**Neither number is measured on the target VPS** (`TODO.md` EM-1 — note that
`TODO.md` is gitignored and therefore absent from a fresh clone, so every
`TODO.md` reference in this runbook resolves only on a machine that already has
it) — they are deliberately generous ceilings.

Capacity planning for the upload route, all measured, none on the target host:

- A 25 MP upload costs **~230 MB resident** (up from ~145 MB when the pipeline
  moved from `sharp` to `Bun.Image`; the CPU work got 1.8–3.7× cheaper in the
  same change).
- **The encoder re-decodes the source once per measured ladder rung.** Binary
  search reduced the current path to at most seven measured rungs, but did not
  remove the repeated source decode or bound concurrent requests. A generated
  56,346-byte 5000×5000 PNG took **5.22 s and seven decodes** on the audit host;
  its output still missed the 0.2 MiB target. At 20 uploads per minute, one
  authenticated account can request roughly 104 encoder-seconds of work per
  wall minute. Re-measure both latency and peak RSS on the target VPS.
- An adversarial **SVG** is worse in kind: entity expansion is fully synchronous,
  so a 27 KB upload measured a **3.8 s freeze of the entire process** — every
  other in-flight request included, and the health check with them. Size the
  health check's 5 s timeout with that in mind (§7).

Both are code defects being fixed, not settings; they are here because they set
the floor on how much VPS this deployment needs and what a CPU alert will look
like before then.

The Traefik 1,114,112-byte limit is per **request**; the handler's 1 MiB per-file
limit still applies separately. The 64 KiB allowance is for the multipart
boundary and headers, not a second file. Test an exactly 1 MiB accepted file and
the first rejected request through the deployed domain before enabling the rule.

Traefik documents a 413 response when its buffering limit is exceeded. That
response is outside the API envelope because the request is not forwarded to
Elysia. Do not assume a direct Bun rejection has identical status/body behavior;
the real-listener Windows probe reset the client connection above 8 MiB. Production
verification must go through Cloudflare and Traefik, and must confirm that no R2
or database work occurs on rejection.

None of these byte limits fixes H4 by itself, and browser-side WebP/PNG
conversion is an optimization a direct API client simply skips. Three of the four
application-side bounds now exist in code: `MAX_IMAGE_PIXELS` (25 MP, from the
header), `MAX_IMAGE_EDGE` (16 383 px per side, WebP's own ceiling — a 1000x20000
PNG is 20 MP and 100 KiB, so it passed both the pixel cap and the 1 MiB file cap
and then failed in the encoder as a 500), and a hard cap on the encode ladder.

**Bounding CONCURRENT image work is the one that is deferred, and it is an
operational decision.** Measured on the development machine, per request, with
hand-built PNGs:

| Input                    | Source  | Wall clock | Encodes |
| ------------------------ | ------- | ---------- | ------- |
| 5000x5000 flat           | 84 KiB  | ~1.0 s     | 1       |
| 5000x5000 repeated-noise | 2.3 MiB | ~1.0 s     | 1       |
| 5000x5000 pure noise     | 3.0 MiB | ~6.6 s     | 6       |

Only the first is reachable through the route — the other two exceed the 1 MiB
per-file limit — so the reachable worst case measured here is ~1 s of CPU per
request, bounded further by the route's own 20-per-window per-USER limiter. Six
encodes is the ladder's ceiling (a binary search over 32 rungs), not a tail.

A one-job semaphore with a small bounded queue is the right shape IF the VPS
cannot absorb that. Sizing it needs a number this repository cannot produce:
concurrent 1 MiB uploads at the target vCPU count. Take that measurement on the
VPS before adding the semaphore — a queue depth guessed from a developer laptop
converts a CPU spike into a request timeout instead of preventing it.

### HTTP behaviours a WAF or uptime check will see

- **405 with `Allow`** on a known path called with an unregistered method, where
  it used to be 404.
- **308 on the trailing-slash form**, every method including `OPTIONS`:
  `GET /api/health/storage/` → `308` with `Location: /api/health/storage`. Point
  health checks and uptime monitors at the canonical path. An _unknown_ path
  with a trailing slash is still a 404.
- **`Allow` does not advertise `HEAD` under `/api/auth`** — Elysia derives `HEAD`
  from table `GET` routes but not from the Better Auth wildcard, so those paths
  advertise `GET, POST, OPTIONS`. Table routes still advertise `HEAD`.
- **Unknown `/api/auth/*` paths return this API's envelope** and stop before
  Better Auth reaches its plugins. Nothing to configure; it changes what the
  edge sees. (This also closes the class where a plugin's `onRequest` runs ahead
  of Better Auth's own hooks — see
  `reports/better-auth-1.7-upgrade-review.md` §5.1.)

### `/openapi.json` — now authenticated, and no longer a cost vector

**Both halves of this are closed in code.** The section is kept because the old
behaviour is what an operator reading an older runbook will expect to find.

What it was: `preAuth: 'none'`, rebuilt on every request — measured **9.11 ms per
request, ~96× the cost of a 404**, against 0.03–0.18 ms for every other
`preAuth: 'none'` route, with `cache-control: no-store` so nothing upstream
absorbed it. One unauthenticated client at modest concurrency saturated a core,
which on a single-process deployment is the whole server, with ~1 100× bandwidth
amplification from a ~90-byte GET. It also advertised every path, including both
`/api/dev/*` routes with `/api/dev/sign-up`'s full request schema.

What it is now:

- **`preAuth: 'ip-limit'`**, so it is behind the same 120/60 s admission gate as
  every other route.
- **Requires dashboard access** — a live session whose role grants `view` on at
  least one page. Authenticated is not sufficient: a role with every grant off is
  refused 403.
- **Built once per process and frozen.** A repeat request serves cached bytes.
- **`/api/dev/*` is filtered out of the document in production**
  (`toPublishedManifest`), so the document no longer undoes the decision
  `app/api/dev/email-test/fixed/handler.ts` makes deliberately — 404 rather than
  403, "indistinguishable from an unrouted path in every other mode".

A Cloudflare rate-limiting rule is still worth having, but it is hardening now
rather than the only control.

**The coupling that made this unsafe to do alone is also closed.**
`POST /api/upload/image` validated `?resource=` _before_ the session check, so an
unauthenticated caller got **400 for an unknown resource and 401 for a real page
name** — harmless only while the document published those names to anyone.
Closing the document without that would have turned the divergence into a working
enumeration oracle. The session check now runs first, so every anonymous request
to the upload route answers 401 with an identical body whatever `resource` says.
Asserted from both sides:
`tests/integration/upload-auth-gate.test.ts` and
`tests/integration/openapi-access.test.ts`.

**Where the contract-consistency gate went.** The boot smoke test used to fetch
this route and assert 200, which was the check that caught a route declaring
`body: 'json'` with no schema (two shipped that way before it existed). An
authenticated route cannot serve that purpose, so the gate moved to
`tests/unit/openapi-contract.test.ts` — no server, no database, fails on
`bun run test` instead of on a deploy. `scripts/smoke.ts` now asserts the access
boundary instead: anonymous must get 401 and no `"paths"` in the body.

## 6. Single instance, update mode and shutdown

### Stop-first (safe default)

Enable **Consistent Container Names** (or a custom container name) so Coolify
stops the old container before starting its replacement. Brief downtime, but no
two app versions sharing SQLite.
[Rolling Updates](https://next.coolify.io/docs/applications/deployments/rolling-updates)

Keep replicas at `1` and process count at `1`.

### Stop grace period

`server.ts` handles `SIGTERM`/`SIGINT` — Elysia only wires
`process.on('beforeExit')`, which is not a container signal handler, so without
this, in-flight mutations, uploads and external calls were killed mid-flight.
WAL keeps the _database_ consistent; it does not finish an _operation_ for the
client, and an upload can reach R2 with no matching row.

On signal:

1. logs `{"msg":"server stopping","signal":"SIGTERM"}`
2. `app.stop()` — **drains** in-flight requests rather than aborting them
   (measured: a request 300 ms into a 2 s handler completed with 200, and
   `stop()` resolved only afterwards)
3. waits up to 10 s for queued post-response work
   (`lib/http/after-response.ts`)
4. closes PostgreSQL first, then the SQLite stores this process actually opened
5. logs `{"msg":"server stopped",…}` and exits 0

**Set Coolify's stop grace period longer than the `shutdownTimeoutMs` in the
startup log — currently 135 s.** A shorter grace period means the orchestrator
kills the container mid-drain and the drain buys nothing.

The bound is **derived**:
`(max(IDLE_TIMEOUT_SECONDS, MAX_ROUTE_TIMEOUT_SECONDS) + 15) * 1000`. Both terms
matter — a route without its own `timeoutSeconds` may still run for the 60 s
global ceiling. **If a 135 s deploy window is unacceptable, the lever is the
route ceilings, not the bound.** Lowering the bound directly reintroduces the
abort. Note that ONE route sits at 120 s (`/api/upload/image`), and below 75 s
the 60 s global ceiling becomes binding — meaning `IDLE_TIMEOUT_SECONDS` too. Both
depend on the VPS measurement in `TODO.md` EM-1. The test suite asserts the
formula rather than the number, so changing a route ceiling will not silently
invalidate it — but re-read `shutdownTimeoutMs` from the startup log afterwards.

A drain that times out logs `after-response drain timed out` and still **exits
0** — `app.stop()` has already resolved, so every request completed and only
post-response work (today, access-log lines) was abandoned. Exiting non-zero
would make a routine deploy look like a crash. Revisit if real post-response
work is ever added; nothing calls `enqueueAfterResponse` yet.

### Two stop-phase hazards, both now closed in code

Both changed what a normal deploy looked like from the orchestrator's side. They
are recorded because the OLD symptom is what an operator reading an older runbook
will be looking for.

- **One half-sent request made the whole grace period elapse.** On Bun 1.4
  `server.stop()` stays pending on a connection that sent part of a request and
  stopped — reproduced: `stop()` still pending after 3 000 ms, while
  `stop(true)` resolved in 1 ms. A scanner, a client that died between headers, a
  cut health probe or one deliberately held socket was enough. The consequences
  compounded: the drain never started, the `finally` never ran, so the PostgreSQL
  pool and both SQLite stores were never closed, and the forced shutdown fired at
  the full `shutdownTimeoutMs` and exited **1** — a routine deploy reported as a
  crash, from a cause outside the application.

  `server.ts` now escalates: `app.stop()` under a 5 s grace period, then
  `app.stop(true)`. Well-behaved clients keep the drain semantics; a stalled
  socket no longer holds the deploy. The forced-shutdown timer also closes the
  stores before exiting, because `process.exit` does not run `finally`.
  `{"msg":"graceful stop timed out, closing active connections"}` is the tell
  that the escalation fired — informational, not a failure.
  Covered by `tests/process/shutdown-lifecycle.test.ts`.

- **An escaped async error killed the process outright.** Nothing registered
  `unhandledRejection` or `uncaughtException`, so one such error exited
  immediately: `shutdown()` never ran, the stores were not closed, and the only
  record was a raw multi-line stack trace on stdout rather than the single-line
  JSON every other failure path emits.

  Both events are registered now — both, not one: Bun 1.4 moved exceptions
  thrown in `node:fs`, `node:dns` and `crypto.pbkdf2` callbacks to
  `uncaughtException`, where an `unhandledRejection` handler no longer sees
  them, and this codebase uses all three. The process still ends, but through
  the same path a signal takes: `{"msg":"unhandled fault","event":…}` then the
  normal stop sequence, **exit 1** so the orchestrator restarts rather than
  treating it as a clean stop.

The one measured caveat that **is** handled: post-response work can still be
queued while the drain runs, so the drain waits for the queue to be _observably
empty for 50 ms_ rather than checking once.

### Rolling updates

Do not overlap releases that share `SQLITE_DIR`. Startup ownership rejects the
new process while the old process holds the directory. Use stop-first deployment
until SQLite state moves to a store designed for multi-process ownership.

SQLite WAL supports same-host processes but only one writer at a time. Use
**3.51.3 or newer** as the floor for the WAL-reset race (the fix was backported
to 3.50.7 and 3.44.6, so not every lower version is vulnerable). The version is
a property of the Bun build — check it with the command in §8.
[WAL-reset notice](https://www.sqlite.org/wal.html#the_wal_reset_bug)

## 7. Configure health check

| Field        | Value                 |
| ------------ | --------------------- |
| Enabled      | Yes                   |
| Scheme       | `http`                |
| Host         | `127.0.0.1`           |
| Port         | `3000`                |
| Method       | `GET`                 |
| Path         | `/api/health/storage` |
| Return code  | `200`                 |
| Interval     | `30s`                 |
| Timeout      | `5s`                  |
| Retries      | `5`                   |
| Start period | `30s`                 |

The route opens (and on first call migrates) `rate-limit.db`, then reads back
its PRAGMAs. It returns 200 `{"status":"ok"}` only when every check holds;
otherwise 503 with the failing field visible in `checks`:

| Check               | Requires                                                       |
| ------------------- | -------------------------------------------------------------- |
| `journalModeWal`    | `journal_mode` is `wal`                                        |
| `schemaVersion`     | `user_version` equals the running build's schema version       |
| `busyTimeout`       | `busy_timeout` is exactly `2000` — the value, not merely "set" |
| `synchronousNormal` | `synchronous` is `1` (`NORMAL`)                                |
| `postgres`          | a bounded `SELECT 1` answered within 2 s                       |

`busyTimeout` and `synchronousNormal` compare **exact values** because a
database opened by something other than `openDatabase` — an older build, or a
manual `sqlite3` session that rewrote a persistent pragma — can be perfectly
usable yet not configured the way the limiter's latency and durability
assumptions require.

Deliberately cheap enough to poll every 30 s: **PRAGMA reads plus one
`SELECT 1`.** It does not run `quick_check` and does not write to SQLite — either
would put the health check in write-lock contention with the limiter. It reports status only: no paths, schema
contents or row counts.

**PostgreSQL is checked now.** `checks.postgres` is a bounded `SELECT 1` on the
CHEAP path — not behind `?deep=1`, because a readiness probe that cannot see the
primary database is not a readiness probe, and `SELECT 1` on a pooled connection
is not comparable to the structural scan and write lock that variant exists to
separate. It carries a 2 s timeout, because the failure being tested is "does not
answer": without one, an unreachable host makes the poll hang until the
orchestrator's own deadline, which reads as a timeout rather than as a failure.

Previously every check here was against the rate-limit SQLite store, so an
unreachable database — a wrong `DATABASE_URL` after a rotation, the container not
yet up, the pool exhausted — still answered `200 {"status":"ok"}` and the
orchestrator kept routing traffic to a container on which every login, dashboard
route and OTP send failed. The lazy pool (§3.1a) meant nothing else forced it to
surface.

**Two blind spots remain.**

- **`cache.db` is never touched.** A broken or unwritable cache emits
  `maintenance.cacheSweep failed`, followed by `scheduled sweep degraded` (§9).
  Acceptable while the cache has no call sites; revisit when the first one is
  added.
- **A mounted volume is not proven.** SQLite creates the same path in the
  container layer just as happily. Only §8 settles that.

One interaction worth knowing when tuning the numbers above: the **5 s timeout**
is generous today, but a synchronous stall in the process — an adversarial SVG
upload measured 3.8 s (§5), or SQLite writer contention measured 2.3 s (§4) —
delays this poll along with everything else. With `Retries: 5` at a 30 s interval
a single stall cannot flip the container, which is the margin those settings buy.
Do not lower `Retries` without re-reading those two numbers.

For manual diagnosis, the deep variant adds `quick_check` and a write probe. It
requires the token and must never be the polled check:

```bash
curl -fsS -H "x-maintenance-token: $SQLITE_MAINTENANCE_TOKEN" \
  "http://127.0.0.1:3000/api/health/storage?deep=1"
# {"status":"ok","checks":{...,"quickCheck":true,"writable":true}}
```

Set the UI **Return code** to `200` but do not rely on it for exact matching:
Coolify's generated Nixpacks health command uses `curl -f` with a `wget`
fallback and decides health from the command exit — it does not interpolate
`health_check_return_code`. The external smoke test in §8 is what asserts the
exact status. Confirm `curl` or `wget` exists in the image.
[Health checks](https://coolify.io/docs/knowledge-base/health-checks) ·
[generator source](https://github.com/coollabsio/coolify/blob/v4.x/app/Jobs/ApplicationDeploymentJob.php#L3239-L3283)

## 8. First deploy and verification

Deploy manually. Keep auto-deploy off until the checklist passes.

### Runtime

```sh
bun --version
bun -e 'const {Database}=require("bun:sqlite");const d=new Database(":memory:");console.log(d.query("select sqlite_version() as v").get());d.close(false)'
```

Expect Bun 1.4.0 and SQLite ≥ 3.51.3. **Record the SQLite version** — it is a
property of the Bun build, as are the WebP/PNG codecs and the image resampler.

No native addon is on the request path: `bun:sqlite` replaced `better-sqlite3`
and `Bun.Image` replaced `sharp`. Two remain in the tree — `argon2`, loaded on
every password verify, and `sharp`, now a devDependency kept for `bench/image/`.
`--production` cannot drop it because the build step needs TypeScript from
devDependencies, so the win is that no request touches it, not that the bytes
are gone.

### Storage

```sh
test "$SQLITE_DIR" = /app/data
test -d /app/data
test -w /app/data
wget -qO- "http://127.0.0.1:${PORT:-3000}/api/health/storage"
ls -la /app/data
bun - <<'BUN'
const { Database } = require('bun:sqlite');

if (process.env.SQLITE_DIR !== '/app/data') {
  throw new Error('SQLITE_DIR must be exactly /app/data');
}
const file = '/app/data/rate-limit.db';
// readonly implies no create, so a missing file fails here rather than being
// silently created.
const db = new Database(file, { readonly: true });
const one = (sql) => Object.values(db.query(sql).get() ?? {})[0];
try {
  console.log({
    file,
    sqliteVersion: one('select sqlite_version() as v'),
    journalMode: one('PRAGMA journal_mode'),
    userVersion: one('PRAGMA user_version'),
    quickCheck: one('PRAGMA quick_check'),
    tables: db
      .query("select name from sqlite_schema where type='table' order by name")
      .all(),
  });
} finally {
  db.close(false);
}
BUN
```

Expected: readiness `{"status":"ok"}` with every check `true`; `journalMode`
`wal`; `userVersion` `1`; `quickCheck` `ok`; tables include `rate_limit` and
`auth_rate_limit`. WAL/SHM sidecars may exist while a connection is open.
`cache.db` may be absent — the cache has no call sites.

### Persistence proof

Database counters cannot prove persistence: the health counter rolls over and a
new database recreates the same keys. Use a sentinel file.

```sh
bun - <<'BUN'
const fs = require('node:fs');
const crypto = require('node:crypto');
const file = '/app/data/.coolify-volume-sentinel';

if (process.env.SQLITE_DIR !== '/app/data') {
  throw new Error('SQLITE_DIR must be exactly /app/data');
}
const value = crypto.randomUUID();
fs.writeFileSync(file, `${value}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
console.log(value);
BUN
```

Record the value, redeploy the same release, then:

```sh
test "$SQLITE_DIR" = /app/data
cat /app/data/.coolify-volume-sentinel
```

The exact value must survive. If it is missing or changed, stop: the volume
destination and `SQLITE_DIR` disagree, or storage is not persistent. Repeat
after changing storage, host, application UUID or the restore procedure.

**Keep the sentinel.** It costs nothing, holds nothing sensitive, and turns "is
this still the same volume?" into a one-command answer at any later date.
Record its value alongside the release commit.

Nothing reads it automatically yet. A startup check verifying the sentinel, the
exact path and the driver belongs in `server.ts` beside the existing assertions
(`NODE_ENV`, `PORT`, `Bun.version`, `sqlite_version()`) — tracked in `TODO.md`.

### External smoke checks

- **PostgreSQL is reachable from the container.** The health check proves this
  now — a bounded `SELECT 1` on the cheap path, reported as
  `checks.postgres` — where every check it performed used to be against the
  rate-limit SQLite store, so an unreachable database still answered
  `200 {"status":"ok"}` and the orchestrator kept routing traffic to a container
  on which every login, dashboard route and OTP send failed. Still worth a
  separate external check, because the health endpoint proves reachability from
  INSIDE the container only.
- Turnstile, R2 and the enabled OTP provider egress work.
- Public `/api/auth/get-session` returns exactly HTTP 200.
- `GET /openapi.json` returns **401** to an anonymous caller, with no `"paths"`
  in the body. It is authenticated now; a 200 here means the gate is off.
- HTTPS certificate valid through Cloudflare; direct origin IP blocked on
  80/443.
- A protected request through the domain no longer logs
  `missing client ip headers`.
- Login/session and one non-delivery API flow work.
- Coolify shows exactly one running app container.

## 9. Scheduled tasks

**There are none to configure, and any that exist must be DELETED.**

Both sweeps run inside the application process (`lib/schedule.ts`, on
`Bun.cron`). The two routes a Coolify scheduled task used to `curl` —
`POST /api/internal/sqlite-sweep` and `POST /api/internal/db-sweep` — no longer
exist; a task still pointing at either will 404 on every run.

### Migrating an existing deployment

1. Delete the `sqlite-expiry-sweep` and `postgres-retention-sweep` tasks in
   Coolify **before or with** the deploy that ships this. Leaving them costs
   nothing but a failing task every hour, and a failing task is exactly the
   alert you want to still mean something.
2. `SQLITE_MAINTENANCE_TOKEN` stays. It now guards one surface only,
   `GET /api/health/storage?deep=1`, and **must be at least 32 characters when
   set** — `lib/env.server.ts` refuses to boot otherwise. The floor exists
   because the comparison short-circuits on length before its constant-time
   compare (it must; `timingSafeEqual` throws on a length mismatch), so a short
   token leaks its own length before any content guessing. Leave the variable
   unset to disable the deep probe entirely; the routes fail closed either way.
3. The `/api/internal/*` edge rules in §5 now match nothing. Keep them — they
   cost nothing and re-adding such a route without them would be silent.

### Why in-process rather than a scheduled `curl`

The routes only ever existed as a trigger. Under Next the SQLite driver was
`better-sqlite3`, which hard-panics under Bun, so `bun some-script.ts` was not a
runnable command; on `bun:sqlite` that constraint is gone. Removing them removed
two `preAuth: 'none'` routes, an unmetered guessing surface against the
maintenance token, two paths from the public OpenAPI document, and the
`/api/internal/*` half of the path-prefix bypass in gate 2.

`Bun.cron` rather than `@elysiajs/cron`: it guarantees a job never overlaps
itself — both sweeps are bounded batch loops holding a writer lock, and a second
concurrent run is the contention that turns maintenance into an authentication
outage — it adds no dependency, and it keeps the sweep independent of the web
framework, which `lib/sqlite/maintenance.ts` states as its first line.

### The schedule

| Job                        | Expression     | Zone |
| -------------------------- | -------------- | ---- |
| `sqlite-expiry-sweep`      | `*/15 * * * *` | UTC  |
| `database-retention-sweep` | `30 3 * * *`   | UTC  |

Fifteen minutes, not hourly, and the arithmetic is below: 500 x 200 is 100 000
rows per table per run, so four runs an hour raises the removal ceiling from
~28 rows/second to ~111 without touching the batching or the writer lock it
protects.

The zone is passed explicitly. Bun 1.4 changed `Bun.cron` to interpret
expressions in **local** time (it was UTC before), and nothing pins this
container's zone — an inherited schedule would move with the host.

### Shutdown, and why one process is an invariant

`stop()` on a cron handle prevents future firings but does not cancel an active
callback. Shutdown stops both handles and drains active work within its common
deadline. If work cannot drain, forced process exit occurs without closing stores
under the callback. Keep Coolify stop grace above `shutdownTimeoutMs`.

**One app process is a scheduling invariant.** Startup ownership prevents a
second cooperating process from reaching scheduler registration. Scaling past
one replica requires per-replica stores or a shared store plus elected scheduler.

### What to alert on

The external scheduler's own failure alerting is what adopting this cost. The
replacement is the log stream. One line per run:

```
{"msg":"scheduled sweep completed","job":"sqlite-expiry-sweep","status":"ok","durationMs":12,"hasMore":false}
{"msg":"scheduled sweep degraded","job":"sqlite-expiry-sweep","status":"degraded","durationMs":12,"hasMore":true}
{"msg":"scheduled sweep failed","job":"database-retention-sweep","errorClass":"..."}
```

- **`scheduled sweep failed`** — alert on any occurrence.
- **`scheduled sweep degraded`** — alert on any occurrence. The job returned, but
  a store it was asked to sweep was not swept.
- **`hasMore: true` on consecutive runs of the same job** — alert. A single
  occurrence is not a signal: the flag trips whenever a final batch happened to
  be exactly full.
- **Absence of `scheduled sweep completed` for a job over its period** — alert.
  This is the case an external scheduler reported for free and an in-process one
  does not.

`maintenance schedule started` is logged once at boot with each job's next fire
time; it is the fastest confirmation that the deploy actually scheduled anything.

### Why `hasMore` matters, and the ceiling behind it

Expiry is checked on read, so a missed sweep does not resurrect expired data —
it causes unbounded stale-row and disk growth. Deletes run in bounded batches
(500 rows per statement, at most 200 batches per table per run) and yield to the
event loop between them, so even a large backlog cannot hold the sole writer
lock long enough to stall the limiter.

**Those bounds are also a throughput ceiling, and it is reachable.** 500 × 200 is
**100 000 rows per table per run** — measured: 400 000 expired rows needed four
runs, each returning `hasMore: true`. At `*/15` that caps removal at ~111
rows/second; sustained creation above that outruns the sweep permanently and the
backlog only grows. The end state is a full volume, at which point writes fail
and every fail-closed limiter answers 503 — the same total-authentication outage
as §4.

**If `hasMore` trips on consecutive runs, raise the frequency further** in
`lib/schedule.ts` (the sweep is cheap and idempotent) rather than waiting for the
disk alert.

A corrupt `cache.db` no longer fails the whole run: its half is contained, so the
limiter deletions still commit. The run then reports `status: "degraded"` and
logs `scheduled sweep degraded` (stderr) instead of `scheduled sweep completed`,
alongside a `maintenance.cacheSweep failed` line carrying the error class; the
result marks `hasMore: true` because a sweep that threw leaves an unknown backlog. Containment is not
success — reporting `ok` here told every alert built on the completion line that
maintenance had finished. A degraded run is the signal to **delete `cache.db`
and restart**, which is what its own module header says to do and why the two
databases are separate files.

### The retention sweep is the load-bearing one

Expired sessions, codes and proof rows are filtered on every read, so delaying
those only costs disk — but **nothing else in the codebase ever deletes a
temporary upload.** Unscheduled, R2 objects accumulate and are billed
indefinitely. `hasMore` staying `true` while `removed.tempFiles.removed` stays
`0` means R2 deletes are failing — check the R2 credentials, not the database.
Rows are deliberately left in place in that state, so nothing is orphaned while
it is broken.

It deliberately does not touch `audit_logs` or user rows; both decisions are
recorded on those tables in `db/schema.ts`.

Do not schedule `VACUUM`, and never remove a `-wal` file by hand while the
database is open.

## 10. Monitoring, backup and restore

Enable Coolify notifications for deployment failure, container status, **server
disk usage** and scheduled-task failure.
[Notifications](https://coolify.io/docs/knowledge-base/notifications/)

### Peak WAL size — `journal_size_limit` does not bound it

The 64 MiB setting bounds the size a WAL is **truncated to when a checkpoint
completes**. It is not a growth ceiling. While checkpointing is blocked the WAL
grows without limit, and the two things that block it are a long-lived read
snapshot and writers that never leave a gap.

Measured, not theoretical: with one connection holding an open read snapshot the
WAL reached **1.36 GB against the 64 MiB setting**, falling to zero the moment a
truncating checkpoint could run. Saturating writes across two and four processes
reached 906 MB and 745 MB. The application never holds a read transaction open —
every read is a single statement — so the realistic trigger here is sustained
concurrent writes, which is also why this deployment keeps one process.

- The **server disk usage** notification is the backstop, whatever the cause.
- Include the sidecars when checking size: `ls -la /app/data` and
  `du -sh /app/data`.
- If `rate-limit.db-wal` is _persistently_ rather than briefly large, a
  checkpoint is blocked. Reclaim it manually — but **this command takes the
  writer lock, and while it holds it the deployment answers 503 on sign-in,
  every OTP surface and all 22 pre-auth routes, and serves nothing at all for up
  to 2.3 s per contended statement (§4).** Run it in a maintenance window, never
  on a schedule and never as a reflex during an incident:

  ```sh
  bun -e 'const {Database}=require("bun:sqlite");const d=new Database("/app/data/rate-limit.db");console.log(d.query("PRAGMA wal_checkpoint(TRUNCATE)").get());d.close(false)'
  ```

- **Do not respond by raising `busy_timeout`.** That trades errors for longer
  synchronous event-loop stalls and adds no writer fairness.

### Backup policy

Coolify's instance backup does not include application volumes, and its managed
database backup is for database _resources_, not an arbitrary app volume.
[Backup/restore scope](https://coolify.io/docs/knowledge-base/how-to/backup-restore-coolify) ·
[Managed database backups](https://coolify.io/docs/databases/backups)

- **PostgreSQL:** back up through whatever owns that server. Self-hosted means
  this is a backup you own and must schedule.
- **`cache.db`:** never back up; rebuild it.
- **`rate-limit.db`:** data expires within a day, but loss resets the paid OTP
  daily cap. Choose an explicit RPO — no backup plus OTP shutdown after host
  loss, periodic online backup, or a durable shared store.
- **Treat the limiter database, its sidecars and every backup as sensitive.**
  They contain raw IP addresses, email addresses and phone numbers. Restrict to
  the runtime/backup identity, encrypt at rest and in transit, and set a short
  retention policy consistent with the rate-limit window and legal requirements.

Never copy a live `.db` alone — committed data may still be in the WAL, and a
file-level copy is a second writer's worth of trouble for none of the benefit
(§4). Mount a restricted staging filesystem **outside** `/app/data`, expose it as
runtime-only `SQLITE_BACKUP_DIR`, and check host capacity first.

Use `VACUUM INTO`, not a driver backup call: `bun:sqlite` has no equivalent of
better-sqlite3's `Database#backup`, and `VACUUM INTO` is read-only with respect
to the source, safe against a live writer, and produces a standalone compacted
database with no WAL to replay. It is a **reader**, so it does not trip the
writer contention in §4 — but it holds a read snapshot for its whole duration,
and a long-lived read snapshot is one of the two things that block checkpointing
and let the WAL grow without bound (measured at 1.36 GB above). On a large
database, watch `/app/data` size while it runs. It refuses to overwrite an existing file, which
is what makes the `.partial` staging safe. Verified on Bun 1.4.0 against a WAL
database opened read-only.
[VACUUM INTO](https://www.sqlite.org/lang_vacuum.html#vacuuminto)

```sh
bun - <<'BUN'
const { Database } = require('bun:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

process.umask(0o077);

const dir = process.env.SQLITE_DIR;
const backupDir = process.env.SQLITE_BACKUP_DIR;
if (dir !== '/app/data') throw new Error('SQLITE_DIR must be exactly /app/data');
if (!backupDir) throw new Error('SQLITE_BACKUP_DIR is required');

const dataReal = fs.realpathSync(dir);
const backupReal = fs.realpathSync(backupDir);
const relative = path.relative(dataReal, backupReal);
if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
  throw new Error('SQLITE_BACKUP_DIR must be outside /app/data');
}

const source = path.join(dir, 'rate-limit.db');
const sourceBytes = fs.statSync(source).size;
const stats = fs.statfsSync(backupReal);
const availableBytes = stats.bavail * stats.bsize;
const requiredBytes = Math.max(sourceBytes * 2, 128 * 1024 * 1024);
if (availableBytes < requiredBytes) {
  throw new Error(`insufficient backup space: need ${requiredBytes} bytes`);
}

const stamp = new Date().toISOString().replaceAll(':', '-');
const suffix = crypto.randomUUID();
const destination = path.join(backupReal, `rate-limit-backup-${stamp}-${suffix}.db`);
const partial = `${destination}.partial`;

// VACUUM INTO takes a string LITERAL, not a bound parameter, so the path is
// escaped by SQL rules: a single quote is doubled.
const sqlPath = (value) => `'${value.replaceAll("'", "''")}'`;

try {
  // readonly implies no create, so a missing source fails here rather than
  // silently producing a backup of an empty database.
  const db = new Database(source, { readonly: true });
  try {
    db.run(`VACUUM INTO ${sqlPath(partial)}`);
  } finally {
    db.close(false);
  }

  const check = new Database(partial, { readonly: true });
  try {
    const row = check.query('PRAGMA quick_check').get();
    if (Object.values(row ?? {})[0] !== 'ok') {
      throw new Error('SQLite backup quick_check failed');
    }
  } finally {
    check.close(false);
  }

  fs.chmodSync(partial, 0o600);
  fs.renameSync(partial, destination);
  console.log(destination);
} catch (error) {
  fs.rmSync(partial, { force: true });
  console.error(error);
  process.exitCode = 1;
}
BUN
```

Copy the completed file off the VPS over an encrypted channel into encrypted
storage, verify its checksum, then remove the staging copy. A second volume on
the same VPS is not a disaster backup.

### Restore

Restore only from a verified standalone backup. Once the application is stopped
its Coolify Terminal is unavailable, so arrange SSH access or a reviewed
one-shot maintenance container mounting the same named volume **before**
starting. Resolve and record the exact volume/resource UUID — do not guess from
a partial Docker volume name.

1. Stop the app; confirm no process holds the volume. There are no scheduled
   tasks to stop — the sweeps live in the app process, and stopping it drains
   them (§9).
2. Archive the current `rate-limit.db`, `-wal` and `-shm` **together**. Do not
   leave stale sidecars beside the replacement.
3. Verify the backup with `quick_check`, place it as `/app/data/rate-limit.db`,
   and apply runtime UID ownership plus mode `0600`.
4. Do not restore the cache database.
5. Start one container, run health and `quick_check`, verify `user_version`,
   then reopen traffic.

Practice on staging. For moving named volumes between hosts, follow
[Coolify application migration](https://coolify.io/docs/knowledge-base/how-to/migrate-apps-different-host).

## 11. Upstash cutover and rollback

No automatic counter migration exists — Upstash sliding-window keys and SQLite
fixed-window rows are different contracts, and the first SQLite request starts
fresh counters.

Cutover:

1. Deploy and verify staging with its own volume.
2. Provision the production volume and all non-Upstash variables.
3. **Cut over just after 00:00 UTC** — the boundary of the fixed 86,400-second
   daily window — or pause paid OTP delivery for the rest of the UTC day. This
   prevents two independent stores each granting a full daily OTP budget.
4. Deploy and run the persistence and external smoke checks (§8).
5. Keep the Upstash database and credentials in a secure rollback record, but
   remove `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` from the
   container environment.
6. After the rollback window and at least one full day of verification, revoke
   the token and delete the Upstash resource.

Rolling back to a pre-SQLite release needs the old Upstash credentials re-added
before the old container starts, and only works while the prior image is still
locally available.
[Rollbacks](https://coolify.io/docs/applications/#rollbacks)

Before any rollback:

- verify the old release accepts the current PostgreSQL and SQLite schemas;
- remember an image rollback reverses neither volume contents nor DB schema;
- do not reactivate an independent Upstash counter within the same rate-limit
  window — wait for the next UTC boundary or pause paid OTP delivery, otherwise
  users receive a second full daily budget;
- use a stop-first transition;
- do not restore an older SQLite backup merely to roll code back;
- re-run health, login/session, rate-limit persistence and Cloudflare-header
  checks.

For releases adding a SQLite migration, design a backward-compatible
expand/contract change or accept downtime. The `user_version` guard only checks
when a process opens the database; an already-open old process does not re-check
after a new container migrates it.

## 12. Testing constraints on this server

The test suite is destructive by design — it truncates tables, creates and drops
databases, exhausts rate-limit budgets and inserts users and sessions. It runs
on developer machines and in GitHub Actions, never here.

- **There is no test database.** Not a second database on the production
  instance, not a second instance on the same box. Production credentials must
  be the only database credentials the app environment holds.
- **`TEST_DATABASE_URL` must never be set** (§3, "Must be absent").
- **`NODE_ENV` stays `production`** — the harness refuses to run when it is,
  which is the second line behind the first.

A **read-only** smoke set may eventually run against production — health, the
migration version, `GET /openapi.json` with a session, one known-good login — as a separate
harness with a separate command. Not yet written; when it is, it gets its own
scheduled task or post-deploy step and this section gets the command.

Two CI details that touch this server:

- The `test` job uses a `postgres:18-alpine` service container. **If the
  server's PostgreSQL major is upgraded, update the CI image in the same
  change** — otherwise a fidelity gap is traded, not closed.
- The **Boot smoke test** deliberately points `DATABASE_URL` at the unreachable
  `db.example.com`. That is the only check proving the pool still connects
  lazily (§3.1a). Do not "fix" it by giving it the service container.
- **The integration job pins `TZ: Asia/Riyadh` and `REQUIRE_NON_UTC_TZ: '1'`**
  (`ci.yml`), and `timezone-auth-behavior.test.ts` fails if either is missing.
  Removing those two lines is what would make the timestamp class invisible to a
  green pipeline again.

## Final checklist

- [ ] Release committed, pushed, CI green.
- [ ] Bun 1.4.0 in the build log; SQLite version recorded (§8).
- [ ] Build `bun run build`, start `bun run start`, `NODE_ENV=production` set as
      a runtime variable; `--no-env-file` decided (§2).
- [ ] Every secret scoped **runtime-only**; nothing in the "Must be absent"
      table present, especially `TEST_DATABASE_URL`.
- [ ] `SQLITE_MAINTENANCE_TOKEN` generated with `openssl rand -hex 32`, or left
      unset. A configured value below 32 characters refuses to boot (gate 4).
- [ ] The `sqlite-expiry-sweep` and `postgres-retention-sweep` Coolify tasks
      **deleted** — both sweeps run in-process now and their routes are gone (§9).
- [ ] Log alerting configured on `scheduled sweep failed`, on
      `scheduled sweep degraded`, on `hasMore: true` across consecutive runs, and
      on a MISSING `scheduled sweep completed` for a job's period (§9).
- [ ] Escalation on a persistent `hasMore: true` understood — raise the cron
      frequency in `lib/schedule.ts` rather than waiting for the disk alert (§9).
- [ ] Pepper keyring and active id understood as a **two-variable** rollback
      (§3.2).
- [ ] Named volume at `/app/data`; `SQLITE_DIR=/app/data`; directory `0700`.
- [ ] One replica, one Bun process; no second writer on the volume, and the
      replica-scaling decision recorded if more than one is ever wanted (§4).
- [ ] Cloudflare proxied, Full (strict), visitor-IP removal off, Pseudo IPv4 not
      overwriting headers, **direct origin blocked at the VPS firewall** —
      defence in depth now that gate 2 is closed in code, and still the control
      that keeps `cf-connecting-ip` trustworthy.
- [ ] `/api/internal/*` and `/api/dev/*` blocked at Cloudflare or Traefik.
- [ ] `/openapi.json` optionally rate-limited at the edge — hardening now: the
      route is authenticated, `ip-limit`ed and built once (§5).
- [ ] Proxy read timeout > 120 s; upload-only Traefik buffering limit set to
      1,114,112 bytes and verified at both sides of the boundary; Cloudflare
      plan ceiling/body-size capability recorded separately (§5).
- [ ] Stop-first/rolling decision recorded; stop grace period **longer than the
      `shutdownTimeoutMs` in the startup log** (135 s today).
- [ ] Health check passing on the canonical path (no trailing slash);
      `quick_check=ok`; `Retries` left at 5.
- [ ] PostgreSQL reachability confirmed in the health body (`checks.postgres`),
      and verified once from OUTSIDE the container as well — the endpoint proves
      reachability from inside only.
- [ ] Persistence proven across a redeploy; sentinel retained and its value
      recorded.
- [ ] `secure_delete` decided and recorded.
- [ ] Disk, task and deploy notifications enabled.
- [ ] PostgreSQL and SQLite backup/RPO policies recorded; restore tested on
      staging.
- [ ] SQLite checks re-run against a copy of the live volume.
- [ ] Upstash rollback window completed, credentials revoked.
