# Elysia migration review — pass summary

Short form. The full per-finding report is
[`reports/elysia-migration-review-response.md`](elysia-migration-review-response.md).

> **Superseded in part.** An external verification pass found eight defects in
> this work, six of them real — including a broken
> `bun install --frozen-lockfile` and a Better Auth `baseURL` that never got the
> canonical origin. See
> [`elysia-migration-verification-response.md`](elysia-migration-verification-response.md)
> for the corrections and the current state.

**All gates green** — `bun run lint`, `bun run format:check`, `bun run test` (60
pass / 0 fail), `bun scripts/find-unused-files.ts`, `bun run smoke` (6/6).

> **CORRECTION.** `bun install --frozen-lockfile` was NOT among the gates run,
> and it was failing. Fixed; it is now green too.

---

## Fixed in code

Findings 1–10, 12–18, 21, 22 (helper), 24–28. Structural core:

- **`server.ts`** is a bootstrap only. It validates `NODE_ENV`, `PORT`,
  `Bun.version` and `sqlite_version()` **before** importing anything
  application-side, then dynamic-imports the app. SIGTERM drain plus a bounded
  forced shutdown.
- **`app.ts`** is the app, exported, with no socket. **`routes.ts`** is the
  route table as data, framework-free. `preAuth` and `body` are **required
  fields** — omitting either is a compile error.
- Body policy `none | json | multipart`; admission checks run **before**
  parsing; multipart is lazy behind `readFormData()`; `maxRequestBodySize` is 8
  MiB.
- Manifest-driven **405 + `Allow`**, **308** trailing-slash redirect,
  route-aware `OPTIONS`, and the response policy re-applied in `mapResponse` —
  route headers were beating the global hook.
- SQLite driver tracks prepared statements, finalizes them, then `close(true)`;
  `busy_timeout` is set before `journal_mode`.
- `GET /openapi.json` — 25 paths, 16 with request bodies, generated from Zod. No
  new dependency.

## Verified — and three claims that did NOT reproduce

- **Finding 5's `SQLITE_BUSY`.** `journal_mode = WAL` succeeded in 14 ms while
  another live process held an uncommitted `BEGIN EXCLUSIVE`, with and without a
  `busy_timeout`. The ordering fix was applied anyway (it is free); the failure
  mode is recorded as unreproduced.
- **A subagent claimed a bogus HTTP method crashes the process.** It does not —
  the connection is closed and the server keeps serving. Not reported as a
  finding.
- **A subagent claimed a HEAD `Content-Length` defect.** It is the
  `curl -X HEAD` gotcha; `curl -I` is clean.

## Disagreements with the review

- **11** — no code defect exists. Only a stale _comment_ named the
  `better-sqlite3` spelling. Corrected.
- **21** — `group()` / `guard()` does not produce a type error either, so it
  does not fix the stated problem. Required fields do.
- **24** — `@elysia/openapi` is compatible, but its Zod path reads schemas
  attached to routes, and every route registers with `parse: 'none'`. Used the
  finding's own fallback.
- **26** — no `@elysia/server-timing` dependency; it is four lines against seams
  finding 25 required anyway.
- **17 is wrong about `@tanstack/react-table`.** I removed it, then caught the
  break: `types/data-table.ts:3` imports `ColumnSort` as a type, reachable from
  live server code. `tsc` passed only because `node_modules` was still populated
  — a fresh CI install would have failed. **Restored.**

## Measured decision — do NOT switch UUID

`bench/uuid/` is checked in and was run twice. `Bun.randomUUIDv7` is ~1.9×
faster interleaved and format-equal, but **monotonicity breaks at index 4096**
(its 12-bit sub-millisecond counter wraps). These are time-ordered primary keys
and the session list pages on a `(createdAt, id)` keyset cursor. Keep `uuid`.

## What needs you

Runbook §12 plus the final checklist: set `PUBLIC_URL`, delete
`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, **grace period > 15 s**, **proxy read
timeout > 120 s** (Cloudflare's free plan caps at 100 s — below the upload
ceiling), proxy body limit 8 MiB, and point the health check off the trailing
slash. Startup now _refuses to boot_ on a Bun minor other than 1.3.14.

Two out-of-scope finds: `utils/images/server.ts` is a divergent dead copy of the
SVG sanitiser (pick one), and three probe files — `log-serializer`,
`permission-schema`, `time-dst` — lack the `.test.ts` suffix, so **CI has never
run them**.

Note: `TODO.md` is gitignored, so the 13 `EM-*` items recorded there stay local
to your working copy.
