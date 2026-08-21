# Coolify deployment: ElysiaJS, `bun:sqlite`, local cache and rate limits

Updated: 2026-08-20

> **Rewritten for the Elysia migration.** This runbook targeted Next.js 16.3.1
> under Node 24 with `better-sqlite3`. The application now runs on ElysiaJS
> under Bun with `bun:sqlite` — see
> [docs/framework-migration.md](../docs/framework-migration.md). Sections §2 and
> §3 are the ones that changed materially; the volume, sweep, monitoring and
> gate sections are unaffected because none of them depended on the framework.
>
> **Nothing in this runbook has been executed against a live Coolify instance
> since the migration.** Treat §2 and §3 as revised instructions, not as a
> verified deployment.

## Decisions this runbook assumes

Three previously open choices are settled, and the instructions below depend on
them. If any is revisited, the marked sections change with it.

| Decision              | Choice                                                                                            | Affects        |
| --------------------- | ------------------------------------------------------------------------------------------------- | -------------- |
| Sweep execution model | **HTTP route** (`POST /api/internal/sqlite-sweep`), invoked by a Coolify Scheduled Task           | §9, §7, gate 3 |
| Retention sweep       | **Second HTTP route** (`POST /api/internal/db-sweep`), daily; separate cadence and failure domain | §9             |
| Power-loss RPO        | **`synchronous = NORMAL`** retained for the limiter database, including the daily OTP cap         | §4, gate 6     |
| Retained WAL ceiling  | **`journal_size_limit = 64 MiB`** accepted as the RETAINED size, with peak WAL monitored (§9)     | §4, §9         |

One decision remains open: **`secure_delete`**. Both databases currently run
with it OFF, which means deleted rate-limit keys — raw IP addresses, email
addresses and phone numbers — stay recoverable in the database file after a
sweep. See gate 6.

This runbook targets one Coolify application on one VPS:

- ElysiaJS runs under Bun 1.4.0. There is no Node process any more — Bun is the
  runtime, the package manager and the TypeScript loader.
- PostgreSQL is the business database (`DATABASE_URL`), reached through Bun's
  built-in `bun:sql` client. **Neon is gone** — no `@neondatabase/serverless`,
  no HTTP-per-query driver, no second WebSocket driver for transactions. One
  pooled client lives in `db/index.ts` and `withTransaction` runs on it.
- Local SQLite holds rate-limit state and, when adopted, disposable cache data,
  through Bun's built-in `bun:sqlite`. No native addon, no prebuild, no
  `node-gyp`, and no Node major to pin.
- Cloudflare proxies public traffic to Coolify/Traefik.
- One steady-state application container runs one `bun server.ts` process.

Current repository has no Dockerfile, so instructions below use Nixpacks. A
Dockerfile becomes preferable if the exact Bun version cannot be reproduced —
and that risk is higher now than it was, because Bun is the runtime rather than
only the build tool. See
[Nixpacks commands/configuration](https://coolify.io/docs/applications/build-packs/nixpacks)
and [Deploy Elysia to production](https://elysiajs.com/patterns/deploy).

## Production gates

Do not expose production traffic until these are resolved:

1. **OTP bypass is enabled in code.** `utils/config.ts` currently sets
   `OTP_AUTO_VERIFY = true`. `NEXT_PUBLIC_OTP_AUTO_VERIFY` does not control it.
   Change and test code; no Coolify variable can make current build verify OTPs.
2. **Cloudflare ingress is mandatory with current IP trust policy.** Code trusts
   `cf-connecting-ip` and nothing else. `x-vercel-forwarded-for` was removed —
   there is no Vercel in this deployment and a trusted-header entry nothing sets
   is pure attack surface. Traefik's normal `x-forwarded-for` is deliberately
   NOT accepted: it is client-controllable whenever the origin is reachable
   directly. Direct Coolify traffic therefore makes IP-protected handlers
   return 503. Proxy DNS through Cloudflare and block direct origin access.

   In **development only** (`NODE_ENV=development`, now validated as an exact
   string at startup) the code falls back to a loopback identifier instead of
   503, so local work does not need a forged header. That branch cannot be
   reached in production — see `getClientIp` in `lib/audit.ts`.

   The header is still trusted on SYNTAX ALONE — nothing verifies the socket
   peer is Cloudflare/Traefik. That is deferred until the edge is final; every
   site carries a greppable `TODO(proxy-trust)` comment, and the resolution is
   in `reports/should-ignore.md` #63.

3. **Confirm the expiry sweep is scheduled.** The sweeper ships as a tracked
   HTTP route (`app/api/internal/sqlite-sweep/handler.ts`, registered in
   `server.ts`). Configure exactly one scheduled task (§9), and confirm it
   authenticates — an unset `SQLITE_MAINTENANCE_TOKEN` makes it 401 forever and
   the databases grow unbounded.
4. **Choose deployment overlap policy.** Safe current default is stop-first
   deployment. Rolling deployments need version-skew handling and migration
   compatibility described below.
5. **Confirm no secret is scoped to the build.** This gate inverted with the
   Elysia migration: the build stage is `tsc --noEmit`, which reads no
   environment, so every secret below is runtime-only. Re-scope any variable
   still marked "build + runtime" from the Next deployment — a build-scoped
   secret stays visible in image metadata/history unless BuildKit secrets are in
   use, and there is no longer any reason to take that risk.
6. **Decide `secure_delete`.** This is the one SQLite policy choice still open.
   Both databases run with `secure_delete=OFF`, so deleted rows keep their bytes
   in the file until those pages are reused — and the deleted bytes here are
   limiter KEYS, which embed raw IP addresses, email addresses and phone
   numbers. A raw-file probe confirmed a marker containing all three survived
   deletion plus a successful truncating checkpoint under `OFF`, and was absent
   under `FAST`. Either set `secure_delete=FAST` in
   [`applyPragmas`](../lib/sqlite/database.ts), or record retention of deleted
   identifiers as an accepted policy. Do not leave it undecided, because the
   default silently chooses retention. See `bench/sqlite/FINAL-REPORT.md` →
   "Open security decision: deleted sensitive keys". `synchronous = NORMAL` and
   the 64 MiB retained-journal limit are now decided; see the decisions table
   above.

Also decide rate-limit backup RPO. With no current off-host SQLite backup, host
loss resets daily OTP spend counter. If exact counter continuity is mandatory,
single-VPS SQLite is insufficient; use durable shared storage.

## 1. Prepare release

- Commit and push every runtime file. Coolify builds Git commit, not local
  working tree. Never commit `.env`, `data/`, `*.db`, `*-wal`, or `*-shm`.
- Run repository CI checks and production build before tagging release.
- Review PostgreSQL migrations separately. No safe automatic migration command
  is configured in Coolify; Coolify pre-deployment command runs in old
  container, not new release. Apply compatible migrations through controlled DB
  workflow.

  The command is now `bun run db:migrate`, and it applies BOTH phases: the
  generated migrations in `db/drizzle/` and then the hand-written SQL in
  `db/migrations/` (the `pg_trgm` extension and the GIN indexes). It replaced
  `drizzle-kit migrate`, which cannot connect at all without one of the four
  drivers it supports — and this project deliberately has none of them. The
  separate `bun run db:migrate:sql` is gone; there is one command. It needs only
  `DATABASE_URL`, not the application's other secrets, so it is safe to run from
  a maintenance shell.

- Record release commit, current Coolify environment, PostgreSQL migration
  version, and SQLite `user_version` before deployment.
- For Upstash cutover, use sequence in section 10.

## 2. Create Coolify application

Under **Configuration > General**:

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

`bun run build` is `tsc --noEmit`. There is no bundle: Bun executes the
TypeScript directly, so a type error is the only build-time failure the server
can still have, and running the compiler is what keeps the build stage from
being a no-op that always succeeds.

`bun run start` is `NODE_ENV=production bun server.ts`. Elysia binds `0.0.0.0`
by default and `server.ts` reads Coolify's `PORT`, defaulting to 3000.

**`NODE_ENV` matters more than it did.** Next set it automatically; Bun does
not. It is set inside the `start` script for exactly that reason — several
security behaviours key off it (`Strict-Transport-Security`, the production-only
env validation in `lib/env.server.ts`, the absolute-`SQLITE_DIR` requirement,
and the dev-only endpoints). If the start command is ever overridden in Coolify,
`NODE_ENV=production` must be carried over or the deployment silently runs with
development posture.

`NIXPACKS_NODE_VERSION` is no longer needed — nothing runs under Node. Remove it
if it is still set from the previous deployment.

Check the build log shows Bun 1.4.0, matching `packageManager` and `bun.lock`.
Bun is now the RUNTIME, so a version mismatch is no longer only a build concern:
`bun:sqlite` behaviour is tied to the Bun build. If Nixpacks supplies a
different Bun version, stop and either add a repository-owned Dockerfile pinning
Bun 1.4.0, or deliberately validate and update the pin and lockfile. Do not
accept unreviewed version drift.

## 3. Configure environment

Coolify separates build and runtime flags. The build stage is now only
`tsc --noEmit`, which reads no environment at all — so unlike the previous
`next build`, the secrets below are needed at RUNTIME ONLY. Scope them
accordingly; a value scoped "build + runtime" out of habit widens its exposure
for no benefit. The paragraph on Docker build secrets below therefore applies
only if you deliberately keep a build-time consumer. Before entering them,
enable **Use Docker Build Secrets** in the application's environment-variable
settings. Inspect the build log and image history; abort if the build host lacks
BuildKit and Coolify falls back to `--build-arg`. Review
[Coolify environment-variable scopes and Docker build secrets](https://coolify.io/docs/knowledge-base/environment-variables).

### Required

| Variable                           | Scope   | Secret | Notes                                                                                                                                                                                                                                                                                                             |
| ---------------------------------- | ------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV=production`              | Runtime | No     | **Now enforced.** `server.ts` refuses to boot unless this is exactly `development`, `test` or `production`. An absent or misspelt value is a non-zero exit with a `startup rejected` log line, not a silent development posture.                                                                                  |
| `PUBLIC_URL=https://<domain>`      | Runtime | No     | **Renamed** from `NEXT_PUBLIC_URL`, which still works as a legacy alias. Setting BOTH to different values is a boot failure. Must be an absolute origin — scheme required, no path, query, fragment or credentials, HTTPS in production — and is the single value used for both CORS and Better Auth's `baseURL`. |
| `DATABASE_URL`                     | Runtime | Yes    | PostgreSQL connection string, consumed by `bun:sql`. See §12.9 — the URL's `sslmode` wins over any `PGSSLMODE`, and the pool is opened LAZILY, so a wrong value is a first-request failure rather than a boot failure.                                                                                            |
| `BETTER_AUTH_SECRET`               | Runtime | Yes    | At least 32 chars; no surrounding whitespace                                                                                                                                                                                                                                                                      |
| `PASSWORD_PEPPER_ACTIVE_ID`        | Runtime | Yes    | Must name key in keyring                                                                                                                                                                                                                                                                                          |
| `PASSWORD_PEPPER_KEYRING`          | Runtime | Yes    | Valid one-line JSON; retain old keys used by stored hashes                                                                                                                                                                                                                                                        |
| `OTP_HMAC_ACTIVE_ID`               | Runtime | Yes    | Must name a key in `OTP_HMAC_KEYRING`. The OTP MAC keyring is SEPARATE from the password pepper on purpose — see the retirement note below.                                                                                                                                                                       |
| `OTP_HMAC_KEYRING`                 | Runtime | Yes    | Same one-line JSON shape as the pepper keyring: `{"<id>":{"generation":1,"secret":"<32 bytes, unpadded base64url>"}}`. Generate with `openssl rand -base64 32 \| tr '+/' '-_' \| tr -d '='`. A malformed value is a BOOT failure, not a first-request failure.                                                    |
| `TURNSTILE_SECRET_KEY`             | Runtime | Yes    | Production Cloudflare secret                                                                                                                                                                                                                                                                                      |
| `SQLITE_DIR=/app/data`             | Runtime | No     | Absolute, no default in prod                                                                                                                                                                                                                                                                                      |
| `SQLITE_MAINTENANCE_TOKEN`         | Runtime | Yes    | Gates the sweep and deep-health routes; `openssl rand -hex 32`                                                                                                                                                                                                                                                    |
| `NEXT_PUBLIC_ENABLED_OTP_CHANNELS` | Runtime | No     | Comma list: `email`, `sms`, `whatsapp`                                                                                                                                                                                                                                                                            |

Every row is runtime-only. Under Next these were build + runtime because
`next build` evaluated `lib/env.server.ts`; `tsc --noEmit` does not, so nothing
here belongs in the build environment any more. `NIXPACKS_NODE_VERSION` is gone
with the Node runtime.

`BETTER_AUTH_SECRETS` must be absent: project rejects it in production because
it would override `BETTER_AUTH_SECRET`.

`SQLITE_DIR` has **no production default** and must be absolute: the app refuses
to boot without it. The build no longer reads it.

`SQLITE_MAINTENANCE_TOKEN` behaves differently, and the difference matters
operationally: a missing token does **not** stop boot. The maintenance routes
fail closed (401) and `/api/health/storage` reports `maintenanceTokenSet: false`
and returns 503, so the container fails its health check rather than serving
with a sweep that can never run. That is deliberate: a defaulted `SQLITE_DIR`
would let an unmounted volume boot happily and write to the container layer,
where every redeploy silently resets the auth, API and daily OTP counters. Boot
validation still cannot prove a volume is mounted there — only the persistence
proof in §8 does.

#### Key retirement: the two keyrings have different rules

Both keyrings are parsed by `lib/auth/keyring.ts`, and in both a hash records the
id of the key that produced it. Removing a key whose id is still referenced makes
those values **unverifiable** — the lookup throws a configuration error, which
reaches the client as a 500, not as a failed login or a wrong code.

The horizons are not the same, and conflating them is what motivated splitting
them apart:

| Keyring                   | A key may be removed once…                                                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASSWORD_PEPPER_KEYRING` | every stored password hash has been rehashed under a newer generation. Users rehash on their next successful login, so this is **months**, and there is no event that tells you it is finished. |
| `OTP_HMAC_KEYRING`        | no unexpired OTP was issued under it. Codes live 10 minutes (`OTP_EXPIRY_MINUTES`), so **an hour of grace is ample**.                                                                           |

Add the new key with a higher `generation`, deploy, then remove the old one on
the horizon above. Never remove and add in one step.

### Optional/recommended

| Variable                        | Scope   | Notes                                             |
| ------------------------------- | ------- | ------------------------------------------------- |
| `NEXT_PUBLIC_BUSINESS_TIMEZONE` | Runtime | Valid IANA zone; defaults to `Asia/Riyadh`        |
| `PORT`                          | Runtime | Supplied by Coolify; `server.ts` defaults to 3000 |

`NEXT_TELEMETRY_DISABLED` is obsolete — there is no Next.js to opt out of.

`SQLITE_DIR` is **runtime-only**. It was build + runtime under Next, because
`next build` imported `lib/env.server.ts` and resolved the database paths at
module load. `tsc --noEmit` does not execute the module, so the build no longer
needs it. CI still supplies a throwaway `/tmp/ci-sqlite` — not for the build,
but for `bun run smoke`, which boots the real server.

### Feature-dependent secrets

- Email OTP: `SMTP_USER`, `SMTP_PASS`, optional `SMTP_FROM`.
- SMS OTP: `DEEWAN_SMS_TOKEN`, `DEEWAN_SENDER_NAME`.
- WhatsApp OTP: `WHATSAPP_API_KEY`.
- R2 uploads: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
  `R2_PUBLIC_BUCKET`, `R2_PRIVATE_BUCKET`, `R2_PUBLIC_URL`.
  `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` used to be listed here for rolling
  overlap. **Delete it if it is still set.** There are no Server Actions — there
  is no Next.js — and the value encrypts nothing. It was already unused before
  this runbook was written; it is listed now only so it gets removed rather than
  carried forward.

Use Coolify Normal view. Lock secrets. Enable **Literal** for any value
containing `$` so Coolify does not interpolate it. Never paste local `.env`
wholesale: it contains development settings and obsolete Upstash keys.
`NEXT_PUBLIC_*` values are public and may be embedded in browser bundle. After
build, verify none of the secret values appears in deployment logs or
`docker history --no-trunc <image>` output. Rotate any value that does.

## 4. Add persistent SQLite storage

Under **Configuration > Persistent Storage**, add:

| Field            | Value                      |
| ---------------- | -------------------------- |
| Type             | Named volume (recommended) |
| Name             | `sqlite-data`              |
| Destination Path | `/app/data`                |

Coolify prefixes actual named-volume name with resource identifier. A bind mount
is valid when host backup tooling needs fixed path, but destination remains
`/app/data`. Coolify documents both forms and container base path in
[Persistent Storage](https://coolify.io/docs/knowledge-base/persistent-storage).

Requirements:

- Volume must be on real local VPS disk. No NFS, CIFS, distributed volume, or
  second host. SQLite WAL requires same-host shared memory and does not work
  over network filesystem. See
  [SQLite WAL restrictions](https://www.sqlite.org/wal.html).
- Mount directory, not individual `.db` file. SQLite also creates `-wal` and
  `-shm` beside each database.
- Do not share production bind path with preview/staging applications.
- Keep one steady-state replica and one **Bun** process. No PM2 cluster, Docker
  Swarm replica increase, or second VPS against this volume. (The previous
  wording said "one Node process"; there is no Node process any more.)
- Only `/app/data` belongs on this mount. (`.next` no longer exists.)

  **This is now enforced rather than assumed.** Elysia defaults Bun's
  `reusePort` to `true`, which meant a second process would bind the SAME port
  and the kernel would split traffic between them — each with its own SQLite
  files, so the rate-limit counters silently halved with no error and no log.
  `app.ts` sets `reusePort: false`, so a second process now dies immediately
  with `EADDRINUSE` (verified). If a deploy starts failing with that error,
  something is starting two processes; that is the bug, not the setting.

Current paths:

```text
/app/data/rate-limit.db  locally durable rate limits and OTP global spend cap
/app/data/cache.db       disposable cache; currently has no call sites
```

Both paths share `SQLITE_DIR` but use separate SQLite files. Current code cannot
place cache on tmpfs without code change.

The rate-limit database uses WAL with `synchronous=NORMAL`. It is
process-crash-safe and provides local durability, but host/OS failure or power
loss can lose recent committed transactions. It is not a substitute for an
off-host backup or a durable shared store.

### Permissions check

After first container starts, open Coolify Terminal:

```sh
id
stat -c '%U:%G %a %n' /app/data
test -w /app/data
```

Directory must be writable by runtime UID because WAL creates sidecars there.
For bind mount, set host directory ownership to numeric UID shown by `id`. Do
not use `chmod 777`. Named volume normally avoids manual host-path permission
setup. Because the files contain identifiers, restrict the directory to the
runtime identity (`0700`) after verifying ownership; that directory mode also
protects newly created DB/WAL/SHM files. Verify existing sensitive files are not
group/world-readable. If the runtime identity cannot enforce those modes, stop
and fix ownership/startup umask before production.

## 5. Configure Cloudflare ingress

Current code assumes VPS is behind Cloudflare:

1. Add application domain in Coolify; do not publish host port.
2. Create proxied/orange-clouded Cloudflare DNS record for that domain.
3. Use Cloudflare **Full (strict)** TLS with valid Coolify origin certificate.
4. In **Rules > Transform Rules > Managed Transforms**, keep **Remove visitor IP
   headers** off. Current code needs `CF-Connecting-IP`.
5. In **Network > Pseudo IPv4**, use **Off** (preferred) or **Add Header**.
   Never use **Overwrite Headers**: it replaces `CF-Connecting-IP` for IPv6
   visitors and defeats the application's IPv6 `/64` grouping.
6. At VPS firewall, allow ports 80/443 from current Cloudflare IP ranges and
   trusted administration sources only; block other origin traffic. Cloudflare
   explicitly recommends blocking non-Cloudflare origin access in
   [Cloudflare IP-address guidance](https://developers.cloudflare.com/fundamentals/concepts/cloudflare-ip-addresses/).
7. Confirm external request reaches app with the original visitor address in
   `CF-Connecting-IP` for both IPv4 and IPv6 clients.

Cloudflare defines `CF-Connecting-IP` as visitor address sent from its edge to
origin. Header is trustworthy here only because direct origin traffic is
blocked. See
[Cloudflare request headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/)
and
[managed transforms](https://developers.cloudflare.com/rules/transform/managed-transforms/reference/),
[Pseudo IPv4](https://developers.cloudflare.com/network/pseudo-ipv4/), and
[Full (strict) TLS](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/).

If Cloudflare must be removed, stop deployment and change/test trust boundary
first. Do not merely add `x-forwarded-for`: clients can spoof it when origin or
untrusted proxy hops are reachable.

## 6. Enforce single instance and choose update mode

### Safe current default: stop-first

Enable **Consistent Container Names** (or configured custom container name) so
Coolify stops old container before starting replacement. This causes brief
downtime but avoids two app versions sharing SQLite. Current Coolify lists
consistent/custom names as settings that prevent rolling overlap in
[Rolling Updates](https://next.coolify.io/docs/applications/deployments/rolling-updates).

Keep:

- application replicas: `1`;
- process count: `1`;
- stop grace period: default 30 seconds unless measured request needs longer.

### Conditional rolling updates

Use default container naming and rolling overlap only after all are true:

- health check below represents readiness;
- old/new releases use backward-compatible PostgreSQL and SQLite schemas;
- no SQLite schema migration occurs while old process has prepared statements;
- both containers mount same named volume on same host;
- no host port mapping exists;
- transition was load-tested.

The Next-specific entries that used to be on this list — `deploymentId`, the
shared Server Actions encryption key, cache/tag coordination — are gone with the
framework. This is a JSON API with no client bundle and no server functions, so
version skew is now only about the two schemas and the shared SQLite file, which
are the entries that remain. That makes rolling updates easier to justify than
before; it does not make them verified.

SQLite WAL supports same-host processes, but only one writer at a time. Use
SQLite 3.51.3 or newer as the conservative deployment floor for the WAL-reset
race. The fix was also backported to 3.50.7 and 3.44.6, so it is not accurate to
call every lower version vulnerable. Verify the version the deployed Bun ships
with using the command in §8 — it is a property of the Bun build now, not of a
pinned npm package. See
[SQLite WAL-reset notice](https://www.sqlite.org/wal.html#the_wal_reset_bug).

## 7. Configure health check

A dedicated readiness route now exists: `GET /api/health/storage`
(`app/api/health/storage/route.ts`). Use it instead of the interim
`/api/auth/get-session` workaround.

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

It opens (and on first call migrates) `rate-limit.db`, then reads back its
PRAGMAs. It returns 200 `{"status":"ok"}` only when every one of these holds;
anything else is 503 with the failing field visible in `checks`:

| Check                 | Requires                                                       |
| --------------------- | -------------------------------------------------------------- |
| `journalModeWal`      | `journal_mode` is `wal`                                        |
| `schemaVersion`       | `user_version` equals the running build's schema version       |
| `busyTimeout`         | `busy_timeout` is exactly `2000` — the value, not merely "set" |
| `synchronousNormal`   | `synchronous` is `1` (`NORMAL`)                                |
| `maintenanceTokenSet` | in production, `SQLITE_MAINTENANCE_TOKEN` is non-empty         |

The last two are the ones worth understanding. `busyTimeout` and
`synchronousNormal` compare exact values because a database opened by something
other than `openDatabase` — an older build, or a manual `sqlite3` session that
rewrote a persistent pragma — can be perfectly usable yet not configured the way
the limiter's latency and durability assumptions require. `maintenanceTokenSet`
is not a storage property at all; it is where a deploy that forgot the token
becomes visible, because otherwise the scheduled sweep 401s forever and both
databases grow unbounded with nothing else to signal it.

So a container with a missing native binary, an unopenable or read-only volume,
a schema this build cannot use, or a missing maintenance token fails its check
instead of silently serving a degraded limiter.

Deliberately cheap enough to poll every 30s: PRAGMA reads only. It does **not**
run `quick_check` and does **not** write, because doing either on every poll
would put the health check itself in write-lock contention with the limiter. It
also does not touch PostgreSQL or `cache.db`, and it reports status only —
no paths, schema contents or row counts.

Note the cache gap that follows from that last point: a broken or unwritable
`cache.db` is NOT detected here. It would first surface as a 500 from the sweep
task. That is acceptable while the cache has no call sites; revisit when the
first one is added.

For manual diagnosis, the deep variant adds `quick_check` and a real write
probe. It requires the maintenance token and must never be the polled check:

```bash
curl -fsS -H "x-maintenance-token: $SQLITE_MAINTENANCE_TOKEN"   "http://127.0.0.1:3000/api/health/storage?deep=1"
# {"status":"ok","checks":{...,"quickCheck":true,"writable":true}}
```

**What it still cannot prove:** that `/app/data` is a mounted persistent volume.
SQLite creates the same path inside the container layer just as happily. Only
the persistence proof in §8 settles that.

Set the UI Return Code field to `200`, but do not rely on it for exact-code
matching. Current Coolify-generated Nixpacks health command uses `curl -f` with
`wget` fallback and decides health from command exit; it does not interpolate
`health_check_return_code`. The selected endpoint currently returns 200, and the
external smoke test below must assert that exact status. Verify this behavior
against the installed Coolify release; the
[current generator source](https://github.com/coollabsio/coolify/blob/v4.x/app/Jobs/ApplicationDeploymentJob.php#L3239-L3283)
is the reference used here.

Coolify UI health check requires `curl` or `wget` inside image. Confirm one
exists in Terminal. Coolify routes traffic only to passing instances and uses
checks during rolling updates; see
[Coolify health checks](https://coolify.io/docs/knowledge-base/health-checks).

## 8. First deploy and verification

Deploy manually first. Keep auto-deploy off until full checklist passes.

### Build/runtime

In deployment log and Terminal:

```sh
bun --version
bun -e 'const {Database}=require("bun:sqlite");const d=new Database(":memory:");console.log(d.query("select sqlite_version() as v").get());d.close(false)'
```

Expected: Bun 1.4.0, SQLite at least 3.51.3. A missing environment variable or
a read-only filesystem blocks release. There is no native addon left **on the
request path** — `bun:sqlite` replaced `better-sqlite3`, and as of 2026-08-21
`Bun.Image` replaced `sharp` in the upload pipeline, so nothing the server
imports at runtime does a `dlopen`. Two native addons still exist in the tree
and are worth knowing about: `argon2`, which the auth path loads on every
password verify, and `sharp`, which is now a **devDependency** kept only for
`bench/image/`. `bun install --frozen-lockfile` still installs both — dropping
`sharp` from the image would need `--production`, which cannot be used here
because the build step (`tsc --noEmit`) needs TypeScript from devDependencies.
So the win is that no request touches it, not that the bytes are gone.

The Bun version now determines the SQLite build, the WebP/PNG codecs and the
image resampler, so checking it matters more than it used to.

### Health and SQLite

```sh
test "$SQLITE_DIR" = /app/data
test -d /app/data
test -w /app/data
# The storage readiness route, not /api/auth/get-session: this is the check
# Coolify polls, and it is the one that fails on a bad volume or schema.
wget -qO- "http://127.0.0.1:${PORT:-3000}/api/health/storage"
ls -la /app/data
bun - <<'BUN'
const { Database } = require('bun:sqlite');

if (process.env.SQLITE_DIR !== '/app/data') {
  throw new Error('SQLITE_DIR must be exactly /app/data');
}
const file = '/app/data/rate-limit.db';
// readonly implies no create, so a missing file fails here rather than being
// silently created — the equivalent of better-sqlite3's fileMustExist.
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

Expected:

- readiness returns `{"status":"ok","checks":{...}}` with every check `true`;
- `rate-limit.db` exists; WAL/SHM may exist while connection is open;
- `journalMode` is `wal`;
- `userVersion` is `1`;
- `quickCheck` is `ok`;
- tables include `rate_limit` and `auth_rate_limit`.

`cache.db` may be absent because cache interface currently has no call sites.

### Persistence proof

Database counters cannot prove persistence: the health counter rolls over and a
new database can recreate the same key. Use a non-sensitive volume sentinel:

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

Record the value, redeploy the same release, then run:

```sh
test "$SQLITE_DIR" = /app/data
cat /app/data/.coolify-volume-sentinel
```

The exact value must survive. If it is missing or changed, stop: volume
destination and `SQLITE_DIR` disagree, or storage is not persistent. Repeat this
proof after changing storage, host, application UUID, or restore procedure.

**Keep the sentinel — do not delete it after the test.** An earlier revision
said to remove it. Retaining it is strictly better: the file costs nothing,
contains no sensitive data, and turns "is the volume still the same volume?"
into a one-command answer at any later date, including after an unrelated
redeploy that silently lost the mount. Record its value in the deployment notes
alongside the release commit.

Retaining it does not by itself detect a lost mount — nothing reads it
automatically yet. A startup check that verifies the sentinel, the exact path
and the driver in one place is the natural next step and is tracked in
`TODO.md`. The previous version of this paragraph pointed at Next's
`instrumentation.register()`; there is no Next.js. The correct place now is
`server.ts`, which already runs startup assertions (`NODE_ENV`, `PORT`,
`Bun.version`, `sqlite_version()`) before importing the application — add it
alongside those.

### External smoke checks

- Public `/api/auth/get-session` response is exactly HTTP 200.
- HTTPS certificate valid through Cloudflare.
- Direct origin IP blocked on 80/443.
- Protected request through domain no longer logs `missing client ip headers`.
- Login/session and one non-delivery API flow work.
- PostgreSQL is reachable from the container, and Turnstile, R2 and the
  enabled OTP provider egress work. PostgreSQL is listed FIRST and separately
  because nothing at boot proves it any more: `bun:sql` connects lazily, so an
  unreachable database passes the health check (which reads SQLite only) and
  fails on the first request that queries it.
- Coolify shows one running app container after deployment completes.

## 9. Expiry sweep, monitoring, backup and restore

### Expiry sweep

**Unblocked.** The sweep is now a tracked HTTP route,
`app/api/internal/sqlite-sweep/route.ts`, invoked with `curl`. That shape was
originally forced by a runtime constraint: `better-sqlite3` hard-panicked under
Bun, and Node could not execute this project's TypeScript with its path aliases
without an extra runner. Neither still holds — Bun runs both — but the route
stays, because the scheduled task below targets its URL and relocating it is a
deployment change rather than a code change.

Configure exactly one Coolify Scheduled Task:

| Field     | Value                                                                                                                   |
| --------- | ----------------------------------------------------------------------------------------------------------------------- |
| Name      | `sqlite-expiry-sweep`                                                                                                   |
| Command   | `curl -fsS -X POST -H "x-maintenance-token: $SQLITE_MAINTENANCE_TOKEN" http://127.0.0.1:3000/api/internal/sqlite-sweep` |
| Frequency | `0 * * * *`                                                                                                             |
| Timeout   | `60` seconds                                                                                                            |

`-f` is required: without it `curl` exits 0 on an HTTP 401 or 500, so a task
that never actually swept would be reported as successful.

`-f` is not sufficient, though. A run that hit its per-table ceiling is a
SUCCESSFUL sweep with work left over, so it returns HTTP 200 with
`"hasMore": true` in the body, which `curl -f` cannot see. To be alerted on a
growing backlog, use this command instead of the bare `curl` above:

```sh
out=$(curl -fsS -X POST -H "x-maintenance-token: $SQLITE_MAINTENANCE_TOKEN" \
  http://127.0.0.1:3000/api/internal/sqlite-sweep) \
  && echo "$out" \
  && ! echo "$out" | grep -q '"hasMore":true'
```

Three things it gets right, each of which a shorter version gets wrong:

- The `&&` chain fails the task on a `curl` failure, so transport and auth
  errors still surface.
- `echo "$out"` puts the body in the task history, so a failure is diagnosable
  without re-running it.
- It matches on `true` and inverts, rather than asserting `"hasMore":false`.
  **Do not use `grep -q '"hasMore":false'`** — the response nests a `hasMore`
  inside each of `removed.rateLimit`, `removed.auth` and `removed.cache`, so
  that pattern matches a nested `false` and reports success even when the
  top-level flag is `true`. Matching `true` is also robust in the other
  direction: any nested `true` implies the top-level one.

Treat sustained failures as the signal, not a single one. The flag is
deliberately conservative: it reports `true` whenever a final batch was exactly
full, even if that batch removed the last expired row.

Requires `SQLITE_MAINTENANCE_TOKEN` (see §3). The route rejects an unset or
mismatched token with 401 and compares in constant time.

### PostgreSQL retention sweep

A SECOND scheduled task, against `POST /api/internal/db-sweep`
(`app/api/internal/db-sweep/handler.ts`, work in `db/maintenance.ts`). Separate
from the sweep above rather than folded into it: that one reclaims disk from rows
that expire in minutes and runs hourly, this is retention over days and performs
network I/O to R2. One schedule cannot serve both cadences, and one response
cannot report an R2 outage without making the limiter sweep look broken.

| Field     | Value                                                   |
| --------- | ------------------------------------------------------- |
| Name      | `postgres-retention-sweep`                              |
| Command   | see below — same `hasMore` handling as the SQLite sweep |
| Frequency | `30 3 * * *` (daily, off-peak)                          |
| Timeout   | `180` seconds                                           |

```sh
out=$(curl -fsS -X POST -H "x-maintenance-token: $SQLITE_MAINTENANCE_TOKEN" \
  http://127.0.0.1:3000/api/internal/db-sweep) \
  && echo "$out" \
  && ! echo "$out" | grep -q '"hasMore":true'
```

Reuses `SQLITE_MAINTENANCE_TOKEN` — one operational secret for the whole
maintenance surface, and the edge block below already covers `/api/internal/*`,
so this route needs no separate rule.

**This one IS load-bearing, unlike the SQLite sweep.** Expired sessions, codes
and proof rows are filtered on every read, so delaying those only costs disk. But
nothing else in the codebase ever deletes a temporary upload: if this task is not
scheduled, R2 objects accumulate and are billed indefinitely. `hasMore` staying
`true` across runs while `removed.tempFiles.removed` stays `0` means R2 deletes
are failing — check the R2 credentials, not the database. The rows are left in
place deliberately in that state, so nothing is orphaned while it is broken.

What it does NOT touch, deliberately: `audit_logs` and user rows. Both decisions
are recorded on those tables in `db/schema.ts`.

### Block `/api/internal/*` at the edge

The token is the authentication boundary, and it holds. But the scheduled task
calls the route on `127.0.0.1` from inside the container, so the route never
needs to be reachable from the internet at all — and right now it is, through
the public domain, like any other route. Make the token the second line rather
than the only one.

Do this at Cloudflare, in **Rules > WAF > Custom rules**:

| Field  | Value            |
| ------ | ---------------- |
| Field  | URI Path         |
| Op     | starts with      |
| Value  | `/api/internal/` |
| Action | Block            |

Equivalently, in a Traefik router rule, exclude `PathPrefix(/api/internal/)`
from the public router.

Apply the same to `/api/health/storage?deep=1` if you can express the query
condition — but **the cheap variant must stay reachable**, because Coolify's
health check polls it. Since the deep variant is gated by the same token, this
one is a hardening nicety rather than a gap.

This is a Cloudflare/Traefik configuration change, not a code change; nothing in
the repository can enforce it. Verify after applying:

```sh
# from outside the VPS — expect a Cloudflare block, not a 401 from the app
curl -si https://<domain>/api/internal/sqlite-sweep -X POST | head -1
# from inside the container — expect 401 without a token, 200 with one
wget -qO- --server-response --post-data='' \
  "http://127.0.0.1:3000/api/internal/sqlite-sweep" 2>&1 | head -3
```

Use **Execute Now**, confirm one JSON success line, then verify task history.
The response shape is nested — each table reports its own `removed`/`hasMore`,
and the top-level `hasMore` is the roll-up plus a backlog probe of both
databases:

```json
{
  "status": "ok",
  "durationMs": 12,
  "removed": {
    "rateLimit": { "removed": 0, "hasMore": false },
    "auth": { "removed": 0, "hasMore": false },
    "cache": { "removed": 0, "hasMore": false }
  },
  "hasMore": false
}
```

Coolify uses server timezone for scheduled tasks; the hourly expression is
timezone independent. See
[Coolify cron syntax](https://next.coolify.io/docs/core/automation/cron-syntax).

Expiry checks occur on reads, so a missing sweep does not resurrect expired
data; it causes unbounded stale-row/disk growth. The sweep deletes in bounded
batches (500 rows per statement, at most 200 batches per table per run) and
yields to the event loop between them, so even a large backlog after a missed
run cannot hold the sole writer lock — or the Node event loop — long enough to
stall the limiter.

Do not schedule `VACUUM`, and never remove a `-wal` file by hand while the
database is open.

### Watch peak WAL size — `journal_size_limit` does not bound it

`journal_size_limit = 64 MiB` bounds the size a WAL is **truncated to when a
checkpoint completes**. It is not a ceiling on growth. While checkpointing is
blocked, the WAL grows without limit, and the two things that block it are a
long-lived read snapshot and writers that never leave a gap.

This is measured, not theoretical. With one connection holding an open read
snapshot the WAL reached **1.36 GB against the 64 MiB setting**, falling to zero
the moment a truncating checkpoint could run. Saturating write runs across two
and four processes reached 906 MB and 745 MB. The application itself never holds
a read transaction open — every read is a single statement — so the realistic
trigger here is sustained concurrent writes, which is also why this deployment
keeps one process.

Practical consequences for this deployment:

- Enable Coolify's **server disk usage** notification. It is the backstop that
  catches this regardless of cause.
- Include the sidecars when checking size, not just the `.db`:

  ```sh
  ls -la /app/data
  du -sh /app/data
  ```

- If `rate-limit.db-wal` is persistently large rather than briefly large, a
  checkpoint is being blocked. A truncating checkpoint reclaims it:

  ```sh
  bun -e 'const {Database}=require("bun:sqlite");const d=new Database("/app/data/rate-limit.db");console.log(d.query("PRAGMA wal_checkpoint(TRUNCATE)").get());d.close(false)'
  ```

  It takes the writer lock for its duration, so run it manually while
  investigating rather than adding it to the hourly task without measuring it
  first.

- Do not respond to a WAL disk problem by raising `busy_timeout`. That trades
  errors for longer synchronous event-loop stalls and adds no writer fairness.

Enable Coolify notifications for deployment failure, container status, server
disk usage, and scheduled-task failure. Supported events are listed in
[Coolify notifications](https://coolify.io/docs/knowledge-base/notifications/).

### Backup policy

Coolify instance backup does not include application volumes. Coolify managed
database backup is for database resources, not arbitrary app volume. See
[Coolify backup/restore scope](https://coolify.io/docs/knowledge-base/how-to/backup-restore-coolify)
and [managed database backups](https://coolify.io/docs/databases/backups).

- Back up PostgreSQL through whatever owns that server. If it is the managed
  provider's, theirs; if PostgreSQL is self-hosted on this or another VPS,
  that is now a backup you own and must schedule — the previous entry pointed
  at Neon's policy, which no longer applies by default.
- Never back up `cache.db`; rebuild it.
- Rate-limit data expires within one day, but loss resets paid OTP daily cap.
  Choose explicit RPO: no backup plus OTP shutdown after host loss, periodic
  online backup, or durable shared store.
- Treat `rate-limit.db`, its WAL/SHM sidecars, and every backup as sensitive:
  they contain raw IP-address, email-address, and phone-number rate-limit keys.
  Limit access to the runtime/backup identity, use restrictive file and backup
  permissions, encrypt backups at rest and in transit, and define a short
  retention/deletion policy consistent with the rate-limit window and legal
  requirements.

For manual consistent snapshot, use SQLite's online backup while app runs; never
copy live `.db` alone because committed data may still be in WAL. Mount a
restricted staging/backup filesystem outside `/app/data`, expose its path as
runtime-only `SQLITE_BACKUP_DIR`, and check host capacity first.

`VACUUM INTO`, not a driver backup call. `bun:sqlite` exposes no equivalent of
better-sqlite3's `Database#backup`, and `VACUUM INTO` is the SQLite-native
answer: it is read-only with respect to the source, safe against a live writer,
and produces a standalone, already-compacted database with no WAL to replay. It
refuses to overwrite an existing file, which is what makes the `.partial`
staging below safe. Verified on Bun 1.4.0 against a WAL database opened
read-only. See [VACUUM INTO](https://www.sqlite.org/lang_vacuum.html#vacuuminto)
and [SQLite Online Backup API](https://www.sqlite.org/backup.html).

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
// escaped by SQL rules: a single quote is doubled. The path is assembled from a
// deployment-configured directory and a UUID, never from input, but escaping it
// costs nothing and removes the question.
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

The script sets restrictive creation permissions before writing and cleans a
partial snapshot on failure. Copy the completed file off VPS over an encrypted
channel into encrypted storage, verify its checksum, then remove the staging
copy. A second volume on the same VPS is not a disaster backup.

### Restore

Restore only from verified standalone backup. Once the application is stopped,
its Coolify Terminal is unavailable; arrange SSH access to the host or a
reviewed one-shot maintenance container that mounts the exact same named volume
before starting. Resolve and record the exact volume/resource UUID—do not guess
by a partial Docker volume name.

1. Stop app and scheduled sweep; confirm no process holds volume.
2. Through the host/maintenance path, archive current `rate-limit.db`,
   `rate-limit.db-wal`, and `rate-limit.db-shm` together. Do not leave stale
   sidecars next to replacement.
3. Verify the backup with `quick_check`, place it as `/app/data/rate-limit.db`,
   and apply runtime UID ownership plus mode `0600`.
4. Do not restore cache database.
5. Start one app container, run health/`quick_check`, verify `user_version`,
   then reopen traffic.

Practice this on staging. For moving named volumes between hosts, follow
[Coolify application migration](https://coolify.io/docs/knowledge-base/how-to/migrate-apps-different-host).

## 10. Upstash cutover and rollback

No automatic counter migration exists. Upstash sliding-window keys and new
SQLite fixed-window rows are different contracts. First SQLite request starts
fresh counters.

Safe cutover:

1. Deploy/verify staging with its own volume.
2. Provision production volume and all non-Upstash variables.
3. Cut over just after 00:00 UTC, boundary used by fixed 86,400-second daily
   window, or pause paid OTP delivery for rest of current UTC day. This prevents
   two independent stores each granting full daily OTP budget.
4. Deploy new release and execute persistence/external smoke checks.
5. Keep Upstash database and credentials in secure rollback record for chosen
   rollback window, but remove `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN` from new container environment.
6. After rollback window and at least one full-day verification, revoke token
   and delete/cancel Upstash resource.

Rollback to pre-SQLite release needs old Upstash credentials re-added before old
container starts. Coolify rollback only works while prior image remains locally
available; see
[Coolify application rollbacks](https://coolify.io/docs/applications/#rollbacks).

Before any rollback:

- verify old release accepts current PostgreSQL and SQLite schema;
- remember Coolify image rollback does not reverse volume contents or DB schema;
- do not immediately reactivate an independent Upstash counter during the same
  rate-limit window: wait for the next UTC boundary or pause paid OTP delivery
  until then, otherwise users receive a second full daily budget;
- use stop-first transition;
- do not restore older SQLite backup merely to roll code back;
- re-run health, login/session, rate-limit persistence, and Cloudflare-header
  checks.

For releases adding SQLite migration, design backward-compatible expand/contract
change or accept downtime. Current `user_version` guard only checks when process
opens DB; already-open old process does not continuously re-check after new
container migrates it.

## 11. `bun:sqlite` migration — done, with one item outstanding

The driver swap happened with the Elysia migration. `lib/sqlite/driver.ts` is
still the only file that knows the driver; `better-sqlite3`, its types, the
`serverExternalPackages` entry and the `ignoreScripts` entry are removed.

Verified in the repository: migrations under `BEGIN IMMEDIATE`, PRAGMA readback,
the max-aware `RETURNING` upsert including its no-row denial,
`DELETE ... LIMIT`, BLOB/null behaviour, and the full probe suite against the
real driver.

**Outstanding before the first deploy on this driver, and NOT yet done:** run
the migration, busy-handling, crash-recovery and backup/restore checks against a
**copy of the live volume**, and record the SQLite version the deployed Bun
build ships (§8). Everything verified so far was against freshly created
databases on a developer machine.

Unchanged by the swap: the local-volume, single-host, WAL, single-replica and
backup constraints all still apply. Bun documents WAL sidecars and `bun:sqlite`
behaviour in [Bun SQLite documentation](https://bun.com/docs/runtime/sqlite). A
driver change does not make a network filesystem or multi-host SQLite safe.

## Final checklist

- [ ] OTP auto-verify disabled and tested in code.
- [ ] Release committed, pushed, CI green.
- [ ] Bun 1.4.0 verified in the build log, and the SQLite version it ships
      recorded (§8). No `NIXPACKS_NODE_VERSION` remains set.
- [ ] Build command `bun run build`, start command `bun run start`, and
      `NODE_ENV=production` present as a runtime variable.
- [ ] Every secret scoped **runtime-only**; nothing left scoped to the build
      from the previous Next deployment.
- [ ] Named volume mounted at `/app/data`; `SQLITE_DIR=/app/data`.
- [ ] One replica, one Bun process (`reusePort: false` now makes a second one
      fail with `EADDRINUSE` instead of silently splitting traffic — §12.1).
- [ ] Cloudflare proxied; Full (strict); visitor-IP removal off; Pseudo IPv4 not
      overwriting headers; direct origin blocked.
- [ ] Stop-first/rolling decision recorded.
- [ ] Health check passing and SQLite `quick_check=ok`.
- [ ] Persistence proven across redeploy, sentinel retained and its value
      recorded.
- [ ] `secure_delete` decided and recorded (the one remaining open choice);
      `synchronous = NORMAL` and the 64 MiB retained-journal limit accepted.
- [ ] Sweep scheduled as exactly one Coolify task using the backlog-aware
      command in §9, and manually executed once via **Execute Now**.
- [ ] `/api/internal/*` blocked at Cloudflare or in the Traefik router, so the
      maintenance token is the second line of defence rather than the only one.
- [ ] Disk/task/deploy notifications enabled, including server disk usage for
      peak WAL growth.
- [ ] PostgreSQL and SQLite backup/RPO policies recorded and restore tested.
- [ ] Upstash rollback window completed, credentials revoked.
- [ ] **§12 items applied**: `PUBLIC_URL` set (not only the legacy
      `NEXT_PUBLIC_URL`); `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` deleted; stop
      grace period longer than the `shutdownTimeoutMs` the startup log reports
      (135 s with the current route table); proxy read timeout above 120 s;
      proxy body limit set to 8 MiB; health check pointed at the canonical path
      without a trailing slash; `/openapi.json` exposure decided.

---

## 12. What changed on the server side in the migration-review pass

Added 2026-08-20. Everything in this section is a consequence of a code change,
not a restatement of the sections above. Corrections to instructions that were
already wrong are made in place in §§2–9 rather than repeated here.

### 12.1 Startup now refuses to boot on four conditions

`server.ts` validates the runtime BEFORE it imports the application. A rejected
runtime exits non-zero after printing one line: `{"msg":"startup rejected",…}`.
A container that restart-loops with that line is misconfigured, not crashing.

| Condition                                                           | Why it is fatal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV` absent, or not exactly `development`/`test`/`production` | Every production guard is an exact string comparison — the Better Auth secret floor, the Turnstile secret requirement, the absolute-`SQLITE_DIR` rule, HSTS. `NODE_ENV=prodution` previously disabled all four at once and still served traffic. Reproduced before the fix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `PORT` not a decimal integer in `1..65535`                          | `Number(PORT)` accepted `''` as 0 and `3000abc` as `NaN`; Bun then bound an ephemeral port while the log reported the requested one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Bun major/minor differs from the pinned `1.4.0`                     | BOTH database drivers are compiled into the Bun binary, so their transaction semantics travel with the runtime version. `bun:sqlite` is the old reason; `bun:sql` is the sharper one — through 1.3.x a simple-protocol query concurrent with a not-yet-prepared parameterized query on the same connection could return the WRONG query's rows, and the `BEGIN`/`COMMIT`/`ROLLBACK` that `withTransaction` issues are simple-protocol queries (Bun #32772, fixed in 1.4.0). A third reason was added 2026-08-20: primary keys now come from `Bun.randomUUIDv7()` (`lib/id.ts`), and through 1.3.x that call wrapped its sub-millisecond counter at 4,096 ids and broke the time ordering the session keyset cursor depends on — so a downgrade below the pin silently degrades id ordering as well as transactions. A PATCH difference is not fatal — it logs `bun patch version drift` and continues. |
| `sqlite_version()` below `3.51.3`                                   | The WAL-reset floor this runbook already required (§6). It was a manual log check; it is now an assertion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

**Operational consequence:** the manual "check the build log shows Bun 1.4.0"
step in §1 is now a backstop, not the control. If Nixpacks supplies Bun 1.4.x
the container will refuse to start. That is intended. To move the pin, update
`packageManager` in `package.json`, `bun.lock`, and `EXPECTED_BUN_VERSION` in
`server.ts` together, after re-running the suite.

The startup log line gained fields worth alerting on:

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

`port` is the BOUND port, not the requested one. They differ whenever the kernel
assigns one, and the requested value is the number that misleads.

**`hostname` reads `localhost` and that is NOT the bind scope.** An earlier
revision of this block showed `0.0.0.0` here, which is what the socket is bound
to but not what the field says. Measured: with no `hostname` passed to `listen`
(`server.ts` passes none, and Elysia forwards only what it is given), `netstat`
reports `0.0.0.0:<port>` and `[::]:<port>` LISTENING and the server answers on a
non-loopback interface — the value in the log is just what Bun reports for
`server.hostname`. So do not read this field as evidence of a loopback-only
bind, and do not "fix" it by passing `hostname: '0.0.0.0'` explicitly without
re-measuring. Confirmed on Windows; the one-line Linux check is
`ss -ltnp | grep <port>`, and it is worth running once on the VPS, because a
loopback-only bind is the shape that makes the container unreachable through the
proxy.

### 12.2 SIGTERM is now handled — set the grace period deliberately

Nothing previously responded to the SIGTERM that Coolify's stop-first deployment
sends. Elysia wires only `process.on('beforeExit')`, which is not a container
signal handler, so in-flight mutations, uploads and external calls were
terminated mid-flight. WAL keeps the database consistent; it does not finish an
application operation for the client, and an upload can reach R2 with no
matching row.

On `SIGTERM` or `SIGINT`, `server.ts` now:

1. logs `{"msg":"server stopping","signal":"SIGTERM"}`
2. calls `app.stop()` — **drains** in-flight requests rather than aborting them
   (measured: a request 300 ms into a 2 s handler completed with 200, and
   `stop()` resolved only after it did)
3. waits up to 10 s for queued post-response work (the access log and anything
   else enqueued through `lib/http/after-response.ts`)
4. closes the SQLite stores this process actually opened — it never opens one in
   order to close it
5. logs `{"msg":"server stopped",…}` and exits 0

A forced shutdown fires regardless, logging `{"msg":"forced shutdown",…}` with
the count of unfinished post-response work, and exits 1.

**The forced-shutdown bound is DERIVED, and it is currently 135 s.** It is
`MAX_ROUTE_TIMEOUT_SECONDS + 15`, where the first term is the longest ceiling
any route grants itself — 120 s on `POST /api/upload/image`. A flat 15 s bound
was wrong and is worth naming as a mistake rather than quietly correcting: it
would have aborted at 15 s exactly the long upload the per-route ceiling exists
to permit, so the drain was not a drain for the one route that needed it. The
number is logged at startup as `shutdownTimeoutMs`, so read it there rather than
inferring it here.

**What to configure:** Coolify's stop grace period must be **longer than
`shutdownTimeoutMs`** — so above 135 s with the current route table, not the
20–30 s an earlier revision of this section suggested. If the grace period is
shorter, the orchestrator kills the container mid-drain and the drain buys
nothing.

**If a 135-second deploy window is unacceptable — and it may well be — the lever
is the UPLOAD ceiling, not the shutdown bound.** Lowering `timeoutSeconds` on
that route in `routes.ts` lowers this number with it, because the bound is
derived. Lowering the bound directly would silently reintroduce the abort.
Decide this alongside the VPS measurement in `TODO.md` EM-1: if uploads actually
finish in 20 s on the target host, a 30 s route ceiling brings the window down
to **75 s** — the 60 s global ceiling then becomes the binding term, so getting
below that means lowering `IDLE_TIMEOUT_SECONDS` too, and both are measurements
you still owe. (An earlier revision of this paragraph said 45 s, which was the
bound before the global ceiling was included in the derivation; see the note
below.)

Two measured caveats, both of which the explicit `process.exit` covers. **The
first is a correction**: an earlier revision of this section said `app.stop()`
does not close the listening socket. It does.

- `app.stop()` **closes the listener** — a fresh connection is refused as soon
  as it resolves (re-measured on `elysia@1.4.29`, whose `stop()` delegates
  straight to `Bun.serve`'s, which Bun documents as preventing new connections
  from being accepted without cancelling in-flight requests). What survives is
  an ALREADY-ESTABLISHED keep-alive connection: a second request written on a
  socket opened before the stop is still served afterwards. During a stop-first
  deploy the proxy has already stopped routing, so this is not reachable from
  outside; the explicit exit is what stops those lingering connections holding
  the process past the grace period.
- Because existing connections survive, post-response work can still be queued
  while the drain is running. The drain therefore waits for the queue to be
  _observably empty for 50 ms_ rather than checking it once — a single check
  could return before a just-finished request registered its work.

**Two things about the bound and the exit code, both deliberate:**

- `shutdownTimeoutMs` is
  `max(IDLE_TIMEOUT_SECONDS, MAX_ROUTE_TIMEOUT_SECONDS) + 15`, not the per-route
  maximum alone. Both terms matter: every route without its own `timeoutSeconds`
  may still run for the 60 s global ceiling, so lowering the upload route to 30
  s — exactly what the paragraph above recommends — would otherwise have
  produced a 45 s bound against requests the server still permits to take 60 s.
  Taking that advice now yields a 75 s window, not 45 s. Read the number from
  the startup log rather than from here.
- A drain that times out logs `after-response drain timed out` with a pending
  count and still **exits 0**. That is a decision, not an oversight:
  `app.stop()` has already resolved by then, so every in-flight request
  completed, and what was abandoned is post-response work — today only
  access-log lines. Exiting non-zero would make a routine deploy's stop phase
  look like a crash to the orchestrator. If real post-response work is ever
  added (nothing calls `enqueueAfterResponse` yet), revisit this alongside it.

### 12.3 Request timeouts — and what the proxy must allow

There was previously no per-request ceiling at all under Node/Next. Elysia
inherits one from Bun and defaulted it to **30 seconds**, which was measured to
drop a 35-second request at 32.1 s with an empty reply and no error body — a
contract regression nobody chose.

Now set deliberately:

| Scope                    | Value | Where                                                                                     |
| ------------------------ | ----- | ----------------------------------------------------------------------------------------- |
| Server-wide              | 60 s  | `IDLE_TIMEOUT_SECONDS` in `server.ts`                                                     |
| `POST /api/upload/image` | 120 s | `timeoutSeconds` on that route in `routes.ts`, applied per request via `server.timeout()` |

**Neither number is measured on the target VPS** — see `TODO.md` EM-1. They are
deliberately generous ceilings, not targets.

**The image work inside that ceiling got 1.8x-3.7x cheaper on 2026-08-21**, when
the upload pipeline moved from `sharp` to `Bun.Image` (`bench/image/`). That
widens the margin under the existing 120 s; it does not change what to configure,
and it does not substitute for the VPS measurement EM-1 still owes. One number
did move in the other direction and belongs in capacity planning rather than
here: a 25 MP upload now costs ~230 MB of resident memory instead of ~145 MB.

**What to configure:** Cloudflare's proxy read timeout and Traefik's
`responseHeaderTimeout` must both exceed 120 s, or the edge will cut an upload
the application would have completed. Cloudflare's free-plan 100-second limit is
below the upload ceiling; if large uploads are expected, either raise it on a
paid plan or lower the application ceiling to match, deliberately.

### 12.4 Request body size limit — align the proxy

Bun accepted up to its **128 MiB** default before any per-file check could run,
so a 100 MB POST was buffered in full before rejection. `app.ts` now sets
`maxRequestBodySize` to **8 MiB** (`MAX_REQUEST_BODY_BYTES`), which returns
**413** at the transport layer. The per-file limit stays: it is per file, this
is per request.

Measured, and it matters to anything downstream that inspects the response: the
413 is a **bare transport reply** — `HTTP/1.1 413 Request Entity Too Large` with
no body, no `Cache-Control`, no CSP, no API envelope and no access-log line,
because the request never reaches Elysia at all. It arrives after roughly 64 KiB
of a declared 12 MiB body, so the rejection genuinely precedes buffering. Bun's
own `fetch` also surfaces it as a closed socket rather than as a 413; a raw
socket is needed to observe the status. Do not write a WAF rule or an uptime
check that expects this API's envelope or headers on a 413.

**What to configure:** set the Cloudflare and Traefik body limits to the same 8
MiB so a rejected upload is refused at the edge rather than after crossing it.
If the largest legitimate image ever grows, both the code constant and the two
proxy limits move together.

### 12.5 Two new HTTP behaviours the edge and any WAF will see

- **405 with `Allow`.** A known path called with an unregistered method now
  returns `405` and an `Allow` header instead of `404`. Anything matching on
  status codes — a WAF rule, an uptime check, a log alert — should expect it.
- **308 on the trailing-slash form, for every method including `OPTIONS`.**
  `GET /api/health/storage/` returns `308` with `Location: /api/health/storage`,
  restoring what the App Router did. Elysia had been serving both URLs with
  `200`, which split cache keys and security-rule matching. A health check
  pointed at the trailing-slash form will now see a redirect — point it at the
  canonical path. `OPTIONS` on the slash form used to answer `404` while every
  other method redirected, because the route-aware OPTIONS gate runs before the
  router and did not canonicalise; it redirects too now, so a browser preflight
  against a slash-form URL behaves like the request that follows it. An unknown
  path with a trailing slash is still a `404` rather than a redirect, on every
  method.
- **`Allow` no longer advertises `HEAD` under `/api/auth`.** Elysia derives
  `HEAD` from a `GET` route in the table but not from the Better Auth wildcard
  (measured: `HEAD /api/auth/get-session` answers `404` while `GET` answers
  `200`), so the 405 boundary was naming a method the handler rejects. `Allow`
  for those paths is now `GET, POST, OPTIONS`; table routes still advertise
  `HEAD` alongside `GET`.
- **Unknown `/api/auth/*` paths now answer this API's envelope, and stop before
  Better Auth.** They used to reach `auth.handler` and come back as Better
  Auth's own bodyless 404 with no `Content-Type` — two different 404 contracts
  on one API. `app.ts` now checks `BETTER_AUTH_ALLOWED_PATHS` before calling the
  handler at all.

  **This one is a security fix, not only a tidy-up.** Better Auth runs plugin
  `onRequest` handlers ahead of its own hooks, and through better-auth 1.6.26
  the captcha plugin matched its endpoint list with `pathname.includes(...)`.
  Measured before the fix: `POST /api/auth/zz/sign-in/email/zz` — an arbitrary
  nonexistent path that merely CONTAINS `sign-in/email` — answered
  `400 Missing CAPTCHA response`, and with an `x-captcha-response` header it
  would perform an outbound Turnstile siteverify for a path this server does not
  serve. That is unauthenticated, attacker-triggerable spend against the
  Turnstile quota from any URL shaped that way. Every such path now answers
  `404` with the envelope and makes no outbound call. Nothing to configure;
  recorded because it changes what the edge sees.

  **Updated for better-auth 1.7.1 (2026-08-21).** That plugin now strips the
  base path and compares endpoints EXACTLY (wildcards only when the configured
  entry contains `*`), so the substring match is gone upstream and the same
  request answers `404` even without the allowlist check — re-measured on 1.7.1.
  The allowlist check stays: the class it closes is "any plugin's `onRequest`
  runs before the hook", not that one plugin's matching rule. See
  `reports/better-auth-1.7-upgrade-review.md` §5.1. Still nothing to configure.

### 12.6 `/openapi.json` is a new public route

`GET /openapi.json` serves the generated API contract: paths, methods, path
parameters, request-body JSON Schema derived from the existing Zod schemas, and
the four Better Auth paths this deployment actually exposes. It contains no
secrets and no data — it is the shape of the API, which any client can infer
from use anyway.

**Decide whether to expose it.** If the front-end consumes it directly, leave it
open. If not, block it at Cloudflare the same way §9 blocks `/api/internal/*`;
it costs nothing to serve and nothing to block.

**It can now fail the deploy, deliberately.** `openApiDocument` throws when the
route table disagrees with the three hand-maintained maps behind it — a route
declaring `body: 'json'` with no schema, a stale key left by a rename, a
`CREATED_ROUTES` entry naming a path that no longer exists. The route then
answers 500, and `bun run smoke` asserts it answers 200, so CI stops the
release. That is the intended trade: a contract a generator consumes without
complaint and gets wrong is worse than one that is briefly unavailable. Two
routes shipped with a missing request body before this check existed. If a 500
here is ever the wrong answer for your deployment, block the route at the edge —
do not remove the check, which is the only thing standing between a rename and a
silently wrong contract.

### 12.7 The sweep endpoint stays — with one class of problem removed

No change to the scheduled task, `SQLITE_MAINTENANCE_TOKEN`, or gate 3. An
in-process cron was considered and **declined** — the reasoning is in the header
of `lib/sqlite/maintenance.ts` and in `TODO.md` EM-8.

One thing did change, and it removes the reason the move looked attractive: the
route previously parsed a caller-supplied body BEFORE checking the token. It now
declares `body: 'none'`, so an unauthenticated caller's body is never read at
all. The sweep logic also moved into a plain function (`runMaintenanceSweep`),
so switching the trigger later is a wiring change rather than a rewrite.

### 12.8 CI now gates on unreachable files and unregistered handlers

`bun run find:unused-files` exits non-zero on an unreachable file OR a handler
module that `routes.ts` does not import, and CI runs it. This is not a
server-side change; it is here because a failing CI step blocks a deploy and the
message is easy to misread. "Unregistered handler" means a `handler.ts` exists
under `app/api/` that no route table entry imports — the endpoint is dead code,
not broken configuration.

### 12.9 PostgreSQL is now `bun:sql`, and four things about it are operational

Added 2026-08-20. `db/index.ts` was `drizzle-orm/neon-http` and `db/ws.ts` was a
second, different Neon driver used only for transactions; both are gone, along
with `@neondatabase/serverless`. One pooled `Bun.SQL` client serves everything,
and `db/ws.ts` no longer exists.

**Nothing here has been run against Coolify.** It has been verified against a
local PostgreSQL 18.6 on Bun 1.4.0 — transactions on one backend PID, advisory
transaction locks, `FOR UPDATE`/`FOR SHARE`, `RETURNING`, savepoints, the
`pg_trgm` indexes, and the pool close.

**a. `DATABASE_URL` is no longer proven at boot.** `neon-http` was a `fetch`
wrapper and this is a real TCP pool — but Bun opens it LAZILY, on the first
query, which is what keeps CI's boot smoke test working without a database
(verified: an unreachable host constructs in ~1 ms and `close()` on a
never-connected pool resolves in under 1 ms). The consequence for a deploy is
that a wrong or unreachable `DATABASE_URL` is **not** a startup rejection and
**not** a health-check failure — `/api/health/storage` reads SQLite only. It is a
500 on the first request that queries PostgreSQL. Verify it explicitly during
first deploy (§8), and treat "container healthy" as saying nothing about the
database.

**b. `sslmode` belongs in the URL.** Bun 1.4 honours `PGSSLMODE` from the
environment, but a `?sslmode=` in the URL wins — so put it in the URL and the
environment cannot move it. `PGSSLMODE=require` against a server without TLS now
fails rather than silently connecting in plaintext, which is the correct
direction but will surface as a connection error rather than a downgrade. If
PostgreSQL is on the same host over the Docker network, decide `sslmode`
deliberately; if it is remote, it must be `require` or stricter.

**c. Pool size against `max_connections`.** `MAX_POOL_CONNECTIONS` in
`db/index.ts` is 10, and it is the number of concurrent TRANSACTIONS the process
supports, not a throughput knob — `withTransaction` reserves a connection for the
whole block, and `processOtpSend` holds one across the provider HTTP call
(`TODO.md` §2.1). Callers beyond 10 queue and then fail on Bun's 30 s
`connectionTimeout`. Confirm the server's `max_connections` leaves headroom for a
migration run and a `psql` session on top of the app's 10; measured locally, 12
concurrent queries opened exactly 10 backends.

**d. `prepare: true` is the default and is correct HERE only.** Bun creates named
prepared statements on the server. That is right against PostgreSQL directly, and
wrong behind a transaction-pooling proxy: PgBouncer in transaction mode can split
a two-round-trip query across backends. If a pooler is ever put in front of this
database, set `prepare: false` in `db/index.ts` — Bun 1.4 makes that safe by
sending each query in a single round trip — and do not leave it at the default.

**Shutdown now closes the pool.** `server.ts` closes PostgreSQL first, then the
two SQLite stores, because `close()` is the only one that can still be waiting on
something (it lets in-flight queries finish). This does not change the grace
period: the drain is still bounded by the derived `shutdownTimeoutMs` in the
startup log.

---

## 13. The test suite, and what it means for this server

Added 2026-08-20 alongside the rewritten `reports/test-strategy.md`. Nothing
here is a code change; it is what the suite requires — and forbids — on the
deployment side.

### 13.1 The suite never runs on this VPS

It is destructive by design: it truncates tables, creates and drops databases,
exhausts rate-limit budgets and inserts users and sessions. It runs on a
developer machine and in GitHub Actions, against databases that are disposable.

**Therefore, on this server:**

- **There is no test database.** Not a second database on the production
  PostgreSQL instance, not a second instance on the same box. Production
  credentials must be the only database credentials the app environment holds.
- **`TEST_DATABASE_URL` must never be set in the Coolify environment.** It is
  the variable the test harness reads, and its presence is the one thing that
  would let a destructive run resolve a target here. Treat it like a
  forbidden variable rather than an unused one — if it ever appears in the
  environment list, delete it and find out who added it.
- **`NODE_ENV` stays `production`.** The harness refuses to run when it is, which
  is a second line behind the first.

### 13.2 What may run against production: a read-only smoke set

Separate harness, separate command, and strictly read-only — health, the
migration version, `GET /openapi.json` answering 200, one known-good login. It
is kept separate from the test suite on purpose: the day a `DELETE` lands in a
suite that runs against production, the separation stops protecting everything
else too.

Not yet written. When it is, it gets its own Coolify scheduled task or
post-deploy step, and this section gets the command.

### 13.3 What changes in CI

- A new `test` job with a `postgres:18-alpine` service container. It affects
  nothing on this server, but the container's PostgreSQL major should be kept
  equal to the one running here — otherwise a fidelity gap is traded for a
  smaller one rather than closed. **If the server's PostgreSQL major is ever
  upgraded, update the CI service image in the same change.**
- The existing **Boot smoke test** step keeps `DATABASE_URL` pointing at the
  unreachable `db.example.com`. That is deliberate and load-bearing: it is the
  only check proving the pool still connects lazily (§12.9a). Do not "fix" it by
  giving it the service container.

### 13.4 Two gates the suite will make visible

- **Gate 1, OTP auto-verify.** `utils/config.ts` still has
  `OTP_AUTO_VERIFY = true`. The suite will carry that assertion as a
  deliberately-failing test, so it stays visible instead of being forgotten. It
  is still a code change, and still blocks production traffic.
- **The derived shutdown bound.** The suite asserts
  `SHUTDOWN_TIMEOUT_MS >= (max(IDLE_TIMEOUT_SECONDS, MAX_ROUTE_TIMEOUT_SECONDS) + 15) * 1000`
  rather than the number. So lowering the upload route's `timeoutSeconds` to
  shorten the deploy window (§12.2) will not silently invalidate it — but the
  grace period in Coolify must still be re-read from the startup log's
  `shutdownTimeoutMs` after any such change.
