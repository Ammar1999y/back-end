# Coolify deployment: Next.js, `better-sqlite3`, local cache and rate limits

Updated: 2026-08-19

## Decisions this runbook assumes

Three previously open choices are settled, and the instructions below depend on
them. If any is revisited, the marked sections change with it.

| Decision              | Choice                                                                                        | Affects        |
| --------------------- | --------------------------------------------------------------------------------------------- | -------------- |
| Sweep execution model | **HTTP route** (`POST /api/internal/sqlite-sweep`), invoked by a Coolify Scheduled Task       | §9, §7, gate 3 |
| Power-loss RPO        | **`synchronous = NORMAL`** retained for the limiter database, including the daily OTP cap     | §4, gate 6     |
| Retained WAL ceiling  | **`journal_size_limit = 64 MiB`** accepted as the RETAINED size, with peak WAL monitored (§9) | §4, §9         |

One decision remains open: **`secure_delete`**. Both databases currently run
with it OFF, which means deleted rate-limit keys — raw IP addresses, email
addresses and phone numbers — stay recoverable in the database file after a
sweep. See gate 6.

This runbook targets one Coolify application on one VPS:

- Next.js 16.3.1 runs under Node 24, not Bun.
- Bun 1.3.14 remains package manager/build tool.
- Neon/PostgreSQL remains business database (`DATABASE_URL`).
- Local SQLite holds rate-limit state and, when adopted, disposable cache data.
- Cloudflare proxies public traffic to Coolify/Traefik.
- One steady-state application container runs one `next start` process.

Coolify supports Next.js through Nixpacks; current repository has no Dockerfile,
so instructions below use Nixpacks. A Dockerfile becomes preferable if exact Bun
or OS versions cannot be reproduced. See
[Coolify Next.js deployment](https://coolify.io/docs/applications/nextjs) and
[Nixpacks commands/configuration](https://coolify.io/docs/applications/build-packs/nixpacks).

## Production gates

Do not expose production traffic until these are resolved:

1. **OTP bypass is enabled in code.** `utils/config.ts` currently sets
   `OTP_AUTO_VERIFY = true`. `NEXT_PUBLIC_OTP_AUTO_VERIFY` does not control it.
   Change and test code; no Coolify variable can make current build verify OTPs.
2. **Cloudflare ingress is mandatory with current IP trust policy.** Code trusts
   `cf-connecting-ip` and `x-vercel-forwarded-for`, not Traefik's normal
   `x-forwarded-for`. Direct Coolify traffic makes IP-protected handlers
   return 503. Proxy DNS through Cloudflare and block direct origin access.
3. **Confirm the expiry sweep is scheduled.** The sweeper ships as a tracked
   HTTP route (`app/api/internal/sqlite-sweep/route.ts`) running in the Node
   runtime Next already uses; the earlier CLI script was removed because
   `better-sqlite3` cannot load under Bun. Configure exactly one scheduled task
   (§9), and confirm it authenticates — an unset `SQLITE_MAINTENANCE_TOKEN`
   makes it 401 forever and the databases grow unbounded.
4. **Choose deployment overlap policy.** Safe current default is stop-first
   deployment. Rolling deployments need version-skew handling and migration
   compatibility described below.
5. **Protect secrets used by `next build`.** Current build-time validation needs
   several production secrets. Enable Coolify's **Use Docker Build Secrets** and
   confirm BuildKit did not fall back to image build arguments. Otherwise stop:
   ordinary build arguments remain visible in image metadata/history.
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
- Record release commit, current Coolify environment, PostgreSQL migration
  version, and SQLite `user_version` before deployment.
- For Upstash cutover, use sequence in section 10.

## 2. Create Coolify application

Under **Configuration > General**:

| Field           | Value                                        |
| --------------- | -------------------------------------------- |
| Build Pack      | `Nixpacks`                                   |
| Base Directory  | `/`                                          |
| Static Site     | Off                                          |
| Ports Exposes   | `3000`                                       |
| Port Mappings   | Empty                                        |
| Install Command | `bun install --frozen-lockfile`              |
| Build Command   | `node node_modules/next/dist/bin/next build` |
| Start Command   | `node node_modules/next/dist/bin/next start` |

Explicit Node commands matter: `better-sqlite3` is a native Node N-API addon;
constructing it under Bun 1.3.14 hard-crashed in repository verification.
`next start` is the supported self-hosted production server and listens on
`0.0.0.0` by default; Coolify supplies `PORT`. See
[Next.js CLI](https://nextjs.org/docs/app/api-reference/cli/next) and
[Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting).

Set `NIXPACKS_NODE_VERSION=24` as build variable. This matches the repository's
`@types/node` major and the Node 24.12 verification environment;
`better-sqlite3` 13.0.3 requires Node `>=22`. Nixpacks only selects a Node
major, not an exact patch; see
[Coolify Node versioning](https://next.coolify.io/docs/applications/build-packs/nixpacks/node-versioning)
and
[`better-sqlite3` 13.0.3 package metadata](https://github.com/WiseLibs/better-sqlite3/blob/v13.0.3/package.json).

Check build log shows Bun 1.3.14, matching `packageManager` and `bun.lock`. If
Nixpacks supplies different Bun version, stop and choose one:

- add repository-owned Dockerfile pinning Node 24 and Bun 1.3.14; or
- deliberately validate and update package-manager pin/lockfile.

Do not accept unreviewed version drift. `better-sqlite3` 13.0.3 includes Linux
x64/arm64 glibc and musl prebuilds, so normal target needs no compiler or
`node-gyp`. Keep `better-sqlite3` in Next `serverExternalPackages`.

## 3. Configure environment

Coolify separates build and runtime flags. Current `next build` evaluates server
configuration, so validation secrets below must be available during both phases.
Before entering them, enable **Use Docker Build Secrets** in the application's
environment-variable settings. Inspect the build log and image history; abort if
the build host lacks BuildKit and Coolify falls back to `--build-arg`. Review
[Coolify environment-variable scopes and Docker build secrets](https://coolify.io/docs/knowledge-base/environment-variables).

### Required

| Variable                           | Scope           | Secret | Notes                                                                                                                                                                  |
| ---------------------------------- | --------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NIXPACKS_NODE_VERSION=24`         | Build           | No     | Major version only                                                                                                                                                     |
| `NEXT_PUBLIC_URL=https://<domain>` | Build + runtime | No     | Exact public origin; no path                                                                                                                                           |
| `DATABASE_URL`                     | Build + runtime | Yes    | Neon/PostgreSQL connection string                                                                                                                                      |
| `BETTER_AUTH_SECRET`               | Build + runtime | Yes    | At least 32 chars; no surrounding whitespace                                                                                                                           |
| `PASSWORD_PEPPER_ACTIVE_ID`        | Build + runtime | Yes    | Must name key in keyring                                                                                                                                               |
| `PASSWORD_PEPPER_KEYRING`          | Build + runtime | Yes    | Valid one-line JSON; retain old keys used by stored hashes                                                                                                             |
| `TURNSTILE_SECRET_KEY`             | Build + runtime | Yes    | Production Cloudflare secret                                                                                                                                           |
| `SQLITE_DIR=/app/data`             | Build + runtime | No     | Absolute, no default in prod. `next build` imports the env module, so the build needs it too (CI passes a placeholder).                                                |
| `SQLITE_MAINTENANCE_TOKEN`         | Runtime         | Yes    | Gates the sweep and deep-health routes; `openssl rand -hex 32`. Runtime only — deliberately NOT a build requirement, so the secret stays out of the build environment. |
| `NEXT_PUBLIC_ENABLED_OTP_CHANNELS` | Build + runtime | No     | Comma list: `email`, `sms`, `whatsapp`                                                                                                                                 |

`BETTER_AUTH_SECRETS` must be absent: project rejects it in production because
it would override `BETTER_AUTH_SECRET`.

`SQLITE_DIR` has **no production default** and must be absolute: the app refuses
to boot without it, and `next build` fails without it too.

`SQLITE_MAINTENANCE_TOKEN` behaves differently, and the difference matters
operationally: a missing token does **not** stop boot. The maintenance routes
fail closed (401) and `/api/health/storage` reports `maintenanceTokenSet: false`
and returns 503, so the container fails its health check rather than serving
with a sweep that can never run. That is deliberate: a defaulted `SQLITE_DIR`
would let an unmounted volume boot happily and write to the container layer,
where every redeploy silently resets the auth, API and daily OTP counters. Boot
validation still cannot prove a volume is mounted there — only the persistence
proof in §8 does.

### Optional/recommended

| Variable                        | Scope           | Notes                                      |
| ------------------------------- | --------------- | ------------------------------------------ |
| `NEXT_PUBLIC_BUSINESS_TIMEZONE` | Build + runtime | Valid IANA zone; defaults to `Asia/Riyadh` |
| `NEXT_TELEMETRY_DISABLED=1`     | Build + runtime | Disables Next.js telemetry                 |

`SQLITE_DIR` is **build + runtime**, as the Required table states. An earlier
revision of this section called it runtime-only; that was wrong and is corrected
here. `next build` imports `lib/env.server.ts`, which resolves the database
paths at module load, so the build fails without it. CI supplies a throwaway
`/tmp/ci-sqlite`; production must supply the real mount path in both scopes.

### Feature-dependent secrets

- Email OTP: `SMTP_USER`, `SMTP_PASS`, optional `SMTP_FROM`.
- SMS OTP: `DEEWAN_SMS_TOKEN`, `DEEWAN_SENDER_NAME`.
- WhatsApp OTP: `WHATSAPP_API_KEY`.
- R2 uploads: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
  `R2_PUBLIC_BUCKET`, `R2_PRIVATE_BUCKET`, `R2_PUBLIC_URL`.
- Rolling overlap only: stable `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` as a secret
  build variable, generated once with `openssl rand -base64 32` and retained in
  the deployment keyring. All overlapping builds must use the same value.

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
- Keep one steady-state replica and one Node process. No PM2 cluster, Docker
  Swarm replica increase, or second VPS against this volume.
- Do not persist `.next`; only `/app/data` belongs on this mount.

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
downtime but avoids two app versions sharing SQLite and avoids Next.js asset/
Server Function version skew. Current Coolify lists consistent/custom names as
settings that prevent rolling overlap in
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
- Next.js `deploymentId` or equivalent version-skew strategy is implemented;
- every overlapping build uses the same secret
  `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`;
- Next.js cache/tag coordination is designed for multiple instances;
- both containers mount same named volume on same host;
- no host port mapping exists;
- transition was load-tested.

Next.js documents missing assets, Server Function mismatches, and navigation
failures during multi-instance version skew in
[self-hosting guidance](https://nextjs.org/docs/app/guides/self-hosting#version-skew).

SQLite WAL supports same-host processes, but only one writer at a time. Use
SQLite 3.51.3 or newer as the conservative deployment floor for the WAL-reset
race. The fix was also backported to 3.50.7 and 3.44.6, so it is not accurate to
call every lower version vulnerable. Current `better-sqlite3` 13.0.3 reports
SQLite 3.53.4 in repository verification. See
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
also does not touch Neon/PostgreSQL or `cache.db`, and it reports status only —
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
node --version
bun --version
node -e 'const D=require("better-sqlite3");const d=new D(":memory:");console.log(d.prepare("select sqlite_version() as v").get());d.close()'
```

Expected: Node 24.x, Bun 1.3.14, SQLite at least 3.51.3. Any
`ERR_DLOPEN_FAILED`, native binding, missing environment, or read-only
filesystem error blocks release.

### Health and SQLite

```sh
test "$SQLITE_DIR" = /app/data
test -d /app/data
test -w /app/data
# The storage readiness route, not /api/auth/get-session: this is the check
# Coolify polls, and it is the one that fails on a bad volume or schema.
wget -qO- "http://127.0.0.1:${PORT:-3000}/api/health/storage"
ls -la /app/data
node - <<'NODE'
const Database = require('better-sqlite3');

if (process.env.SQLITE_DIR !== '/app/data') {
  throw new Error('SQLITE_DIR must be exactly /app/data');
}
const file = '/app/data/rate-limit.db';
const db = new Database(file, { readonly: true, fileMustExist: true });
try {
  console.log({
    file,
    sqliteVersion: db.prepare('select sqlite_version() as v').get().v,
    journalMode: db.pragma('journal_mode', { simple: true }),
    userVersion: db.pragma('user_version', { simple: true }),
    quickCheck: db.pragma('quick_check', { simple: true }),
    tables: db
      .prepare("select name from sqlite_schema where type='table' order by name")
      .all(),
  });
} finally {
  db.close();
}
NODE
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
node - <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const file = '/app/data/.coolify-volume-sentinel';

if (process.env.SQLITE_DIR !== '/app/data') {
  throw new Error('SQLITE_DIR must be exactly /app/data');
}
const value = crypto.randomUUID();
fs.writeFileSync(file, `${value}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
console.log(value);
NODE
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
`TODO.md`; Next 16.3.1 supports `instrumentation.register()` and skips it during
`phase-production-build`, so there is a correct place to put it.

### External smoke checks

- Public `/api/auth/get-session` response is exactly HTTP 200.
- HTTPS certificate valid through Cloudflare.
- Direct origin IP blocked on 80/443.
- Protected request through domain no longer logs `missing client ip headers`.
- Login/session and one non-delivery API flow work.
- Neon, Turnstile, R2, and enabled OTP provider egress work.
- Coolify shows one running app container after deployment completes.

## 9. Expiry sweep, monitoring, backup and restore

### Expiry sweep

**Unblocked.** The sweep is now a tracked HTTP route,
`app/api/internal/sqlite-sweep/route.ts`, invoked with `curl`. That shape was
forced by a runtime constraint, not chosen for style: `better-sqlite3`
hard-panics under Bun (`NAPI FATAL ERROR`) so `bun some-script.ts` is not
runnable here, and Node cannot execute this project's TypeScript with its path
aliases without a runner that is not a declared dependency. The route runs in
the one runtime already proven to work — Node, inside Next. (`scripts/` used to
be git-ignored too; it is tracked now, so packaging is no longer the obstacle.)

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
  node -e 'const D=require("better-sqlite3");const d=new D("/app/data/rate-limit.db");console.log(d.pragma("wal_checkpoint(TRUNCATE)"));d.close()'
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

- Back up Neon/PostgreSQL through Neon/provider policy.
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

For manual consistent snapshot, use `better-sqlite3` online backup API while app
runs; never copy live `.db` alone because committed data may still be in WAL.
Mount a restricted staging/backup filesystem outside `/app/data`, expose its
path as runtime-only `SQLITE_BACKUP_DIR`, and check host capacity first. The API
produces a standalone SQLite DB; see
[`Database#backup` for 13.0.3](https://github.com/WiseLibs/better-sqlite3/blob/v13.0.3/docs/api.md#backupdestination-options---promise)
and [SQLite Online Backup API](https://www.sqlite.org/backup.html).

```sh
node - <<'NODE'
const Database = require('better-sqlite3');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
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

  try {
    const db = new Database(source, { readonly: true, fileMustExist: true });
    try {
      await db.backup(partial);
    } finally {
      db.close();
    }

    const check = new Database(partial, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      if (check.pragma('quick_check', { simple: true }) !== 'ok') {
        throw new Error('SQLite backup quick_check failed');
      }
    } finally {
      check.close();
    }

    fs.chmodSync(partial, 0o600);
    fs.renameSync(partial, destination);
    console.log(destination);
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
NODE
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

## 11. Future `bun:sqlite` migration

Do not change runtime while app remains current Next.js deployment. Current
server and sweeper must use Node + `better-sqlite3`.

When server framework genuinely runs under Bun:

- swap driver only through `lib/sqlite/driver.ts`;
- remove `better-sqlite3`, its types, and Next `serverExternalPackages` entry;
- change start/scheduled commands to Bun only after tests pass;
- test existing volume copy, migrations, BLOB/null behavior, busy handling,
  crash recovery, backup/restore, and bundled SQLite version;
- retain same local-volume, single-host, WAL, replica, and backup constraints.

Bun documents WAL sidecars and `bun:sqlite` behavior in
[Bun SQLite documentation](https://bun.com/docs/runtime/sqlite). Driver change
does not make network filesystem or multi-host SQLite safe.

## Final checklist

- [ ] OTP auto-verify disabled and tested in code.
- [ ] Release committed, pushed, CI green.
- [ ] Nixpacks Node 24; Bun 1.3.14 verified.
- [ ] Node-only build/start commands configured.
- [ ] Required secrets scoped correctly; Docker build secrets verified with no
      BuildKit fallback or image-history exposure.
- [ ] Named volume mounted at `/app/data`; `SQLITE_DIR=/app/data`.
- [ ] One replica, one Node process.
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
- [ ] Neon and SQLite backup/RPO policies recorded and restore tested.
- [ ] Upstash rollback window completed, credentials revoked.
