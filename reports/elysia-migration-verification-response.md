# Response to the implementation verification

Pass completed 2026-08-20 against
[`reports/elysia-migration-implementation-verification.md`](elysia-migration-implementation-verification.md),
plus the ESLint question in
[`docs/next-config-eslint.md`](../docs/next-config-eslint.md).

**Adjudicated 2026-08-20 (second pass).** Every claim below was re-decided from
the repository by four independent read-only adjudicators, one per pair of
findings, each told that both this document and the verification report are
hypotheses and only the code is evidence. Their verdicts are recorded per claim;
where I acted on one, I re-measured it myself first. **Nine defects the
adjudication surfaced are fixed in §4** — three of them the direct class of a
finding that had only been fixed at its instance.

**Original result: six of the eight findings were real and fixed; two were
partly wrong.** That stands. What changed is the standard of proof, and three of
the eight are now recorded as fixed-at-the-instance-but-not-the-class.

Gates now, all run rather than assumed:

| Gate                                             | Result                               |
| ------------------------------------------------ | ------------------------------------ |
| `bun install --frozen-lockfile`                  | PASS (was **FAILING**)               |
| `bun run lint` (tsc + eslint)                    | PASS, and `--max-warnings 0`         |
| `bun run format:check`                           | PASS                                 |
| `bun run test`                                   | **150 pass / 0 fail across 9 files** |
| `bun scripts/find-unused-files.ts`               | PASS, negative-tested 4 ways         |
| `bun run smoke`, CI env, `PUBLIC_URL` only       | **7/7**                              |
| `bun run verify` (all 9 local gates)             | PASS                                 |
| `bun audit`, `actionlint`, `semgrep`, `gitleaks` | PASS                                 |

Two of those numbers moved in this pass and the movement is the point: the probe
suite went from 60 assertions across 6 files to **150 across 9**, because three
regression probes had never executed in CI; and smoke went from 6 to 7 checks,
because the OpenAPI contract now has a gate.

---

## 0. Verdict per claim, at a glance

| #   | Finding                             | Review was | Fix was                                        | Now                                     |
| --- | ----------------------------------- | ---------- | ---------------------------------------------- | --------------------------------------- |
| F1  | CI broken (lockfile)                | CONFIRMED  | CONFIRMED complete                             | Closed                                  |
| F2  | Canonical origin missed Better Auth | CONFIRMED  | CONFIRMED complete, class swept                | Closed                                  |
| F3  | Body parsed before admission        | CONFIRMED  | CONFIRMED complete — measured on a socket      | Closed, with one structural limit named |
| F4  | Shutdown not a reliable drain       | 2 of 3     | **INCOMPLETE** — bound + `unref` defects       | Fixed in §4.1, §4.2                     |
| F5  | Rollback report stale               | CONFIRMED  | **INCOMPLETE** — broke the tree at step 8      | Fixed in §4.6                           |
| F6  | OpenAPI inaccurate                  | CONFIRMED  | **INSTANCE ONLY** — no check, wrong `required` | Fixed in §4.3, §4.4, §4.5               |
| F7  | Manifest-driven behaviour           | CONFIRMED  | **INSTANCE ONLY** — `Allow`, OPTIONS, auth     | Fixed in §4.7, §4.8, §4.9               |
| F8  | Scanner does not prove registration | CONFIRMED  | **INSTANCE ONLY** — two holes open             | Fixed in §4.10                          |

"INSTANCE ONLY" is the honest label for three of them: the reported site was
fixed and the mechanism that produces the next one was not. That is the failure
CLAUDE.md's fix discipline names, and it is the main thing this pass corrects.

---

## 1. What I did

### F1 — CI was broken · **confirmed, fixed** · ADJUDICATED: CONFIRMED

Reproduced: `bun install --frozen-lockfile` exited with
`error: lockfile had changes, but lockfile is frozen`. `package.json` had
`@types/react` removed while `bun.lock:36` still declared it, so **both** CI
install jobs would have failed before reaching any other gate.

Regenerated the lockfile. Attribution matters here, so I checked it rather than
assuming: diffing my pre-pass backup against the regenerated file shows the
**only** change is the removal of `@types/react` — five lines. The lockfile was
otherwise current, so this was caused by my edit and by nothing else.

The report is right about the mechanism and right that "all gates green" was
false. A gate I did not run is not a gate that passes.

**Adjudication.** Confirmed on every count, and the attribution claim was tested
rather than taken on trust. The adjudicator could not diff against my backup (it
no longer exists), so it RECONSTRUCTED the pre-pass state — current
`package.json` plus `"@types/react": "^19"` re-added,
`bun install --lockfile-only` in an isolated copy — and got `removed=0 added=5`,
with the re-added key landing at **line 36**, exactly where the review cited it.
From that state `--frozen-lockfile` reproduces the reported error verbatim.
`@types/react` is absent from both files now, `csstype`'s only dependent went
with it, and both CI install jobs (`ci.yml:23`, `ci.yml:84`) do use
`--frozen-lockfile`; `security.yml` runs no install at all, so the review's
enumeration was complete. `bun install --frozen-lockfile` now exits 0 with
`no changes` and leaves the working tree byte-identical.

**One caveat worth recording:** `git diff bun.lock` is 45 insertions / 142
deletions, not five lines, because HEAD predates the whole Elysia migration.
That diff neither supports nor contradicts the attribution claim — different
baseline — and quoting it as if it did would be wrong in the other direction.

**Files:** `bun.lock`

### F2 — the canonical origin never reached Better Auth · **confirmed, fixed** · ADJUDICATED: CONFIRMED

The worst defect in the previous pass, and self-inflicted: I wrote in the report
that `lib/auth.ts` now takes `baseURL` from `PUBLIC_ORIGIN`, and never made the
change. `lib/auth.ts:85` kept reading `process.env.NEXT_PUBLIC_URL`.

Because the same pass renamed the variable to `PUBLIC_URL` (with
`NEXT_PUBLIC_URL` only as a legacy alias) and switched CI to the new name,
`baseURL` was **undefined** under the CI environment. Session cookies are signed
against that value.

Fixed and verified with only `PUBLIC_URL` set:

```
PUBLIC_ORIGIN        = http://localhost:3000
auth.options.baseURL = http://localhost:3000   match: true
```

**Adjudication.** Confirmed, and the class is swept clean. `lib/auth.ts:8`
imports `PUBLIC_ORIGIN`; `lib/auth.ts:94` is `baseURL: PUBLIC_ORIGIN`. A
complete `process.env.*` inventory of live code contains **zero** reads of
`PUBLIC_URL`, `NEXT_PUBLIC_URL` or `BETTER_AUTH_URL`. Exactly two consumers of
the app origin exist and both read the parsed value: `lib/auth.ts:94` and
`app.ts:89` (`CORS_POLICY.origin`). `trustedOrigins` is configured nowhere
(runtime print: `null`), `basePath` nowhere, the OpenAPI document declares no
`servers`, and the disabled Hono adapter imports `CORS_POLICY` rather than
re-deriving it. The runbook's alias rule was verified by execution, not by
reading: both names set to different values is a real boot failure (exit 1, no
port bound); the same value boots; `NEXT_PUBLIC_URL` alone still works as the
legacy alias.

**A trap the adjudicator found that this document should have named.** The
repo's own `.env` sets `NEXT_PUBLIC_URL`, and Bun auto-loads it, so a naive
local re-run of the verification has **both** names populated — and because the
`.env` value happens to equal the CI value, the assertion passes for the wrong
reason. That is precisely the contamination `reports/test-strategy.md` §10.10 B
warns about. The adjudicator proved suppression worked
(`bun --env-file=<empty>`) before trusting its own result. This document did not
previously say which it did; it should have.

**Files:** `lib/auth.ts`

### F3 — body parsed before in-handler admission · **confirmed, fixed properly** · ADJUDICATED: CONFIRMED

Reproduced by inspection and it is exactly as described: the OTP routes declare
`preAuth: 'none'` because they carry tighter per-identifier budgets, so their
only admission check is inside the handler — at
`app/api/auth/otp/send/handler.ts:50` — while `ctx.body` had already been parsed
by the adapter. Making only multipart lazy fixed the upload route and left this
class open.

The fix is the general one rather than another special case: **both** readers
are now lazy.

- `HandlerInput` has no `body` and no `formData`. It has
  `readJson(): Promise<unknown>` and `readFormData(): Promise<FormData | null>`,
  both memoised, both gated on the route's declared policy.
- `withBodyPolicy` replaces `attachBody` and is **synchronous** — it reads
  nothing. Nothing in the adapter layer touches a body stream.
- All 16 JSON handlers now read `requireJsonBody(await ctx.readJson())`.

The policy still decides what is readable at all, so a `json` route's
`readFormData()` returns null regardless of what the client sent. The client
cannot pick the parser; the handler picks the moment.

**Adjudication.** Confirmed, and this is the one finding whose fix was checked
on a real socket rather than by reading. With an instrumented `Request`
recording every read method, through the real `app.handle()`:

```
otp/send  (captcha reject)   status=403 bodyUsed=false reads=[]
otp/send  (limiter reject)   status=429 bodyUsed=false reads=[]     first 429 at request #60
sqlite-sweep (no token)      status=401 bodyUsed=false reads=[]
dev/sign-up (reads its body) status=422 bodyUsed=true  reads=[text]  <- the spy works
```

and on a real socket with a paced 2 MiB write, the rejection arrives after **128
KiB** — the client is still mid-write. `MAX_REQUEST_BODY_BYTES` was measured the
same way: 8 MiB − 1 accepted, 8 MiB + 1 rejected with `413` after 64 KiB of a
declared 12 MiB body. Memoisation was proven by running it, both readers, both
the valid and the malformed case, with no `Body has already been used`. The
class sweep found no mismatch in either direction across all 21 handlers, and
the "16" is exact: 16 `body: 'json'` route entries, 16 handler files calling
`requireJsonBody(await ctx.readJson())`.

**One limit on the claim, which this document previously blurred.** Only the
per-IP limiter can precede the parse. The per-DESTINATION quota
(`enforceOtpSendQuota`) is keyed on the destination, which does not exist until
the body is parsed — so it is necessarily after. That is structural, not a
defect, but "the handler picks the moment" reads as though every check now
precedes every read, and it does not.

**Files:** `lib/http/contract.ts`, `lib/http/request.ts`,
`lib/http/adapters/elysia.ts`, 16 × `app/api/**/handler.ts`

### F4 — shutdown was not a reliable drain · **two of three confirmed, fixed** · ADJUDICATED: INCOMPLETE — see §4.1, §4.2, §4.9

**The timeout mismatch is real and was the worst part.** A flat
`SHUTDOWN_TIMEOUT_MS = 15_000` against a route that grants itself 120 s means
the forced exit aborts precisely the long upload the per-route ceiling exists to
permit. The bound is now **derived**, and it is **logged at startup** as
`shutdownTimeoutMs` so the operator reads it rather than infers it.

**The keep-alive observation is real** — but the mechanism recorded for it was
wrong; see §4.9.

**The registration race did not reproduce, but the exposure is real for a
different reason** — see §3.

The drain is now a **settle loop**: it waits for the queue to be observably
empty for 50 ms rather than checking once. Verified against work enqueued 20 ms
after the drain started — `late task finished` printed before the drain returned
`true`.

**Adjudication.** The derivation is genuine — `MAX_ROUTE_TIMEOUT_SECONDS` is
recomputed from `ROUTES` in a separate process and matches the export — and the
settle loop is bounded and cannot be starved (driven adversarially at 49 ms, 10
ms and 500 ms intervals; it returns `false` at the deadline rather than
hanging). Exit 0 on a clean drain was measured end to end through the real
`server.ts`, including the idempotency guard under `SIGTERM, SIGTERM, SIGINT`.

**But the fix was incomplete in two ways, both now fixed:** the derivation
ignored the global 60 s ceiling (§4.1), and `forced.unref()` defeated the forced
shutdown in exactly the case it exists for (§4.2).

**Signal-delivery caveat, stated plainly.** On Windows a real signal cannot be
delivered to a spawned Bun child — `kill('SIGTERM')` produced exit 143 with the
handler never running. Every shutdown measurement in this pass used
`process.emit('SIGTERM')` inside the real `server.ts` process. That exercises
the handler and everything downstream; it does **not** exercise OS signal
delivery or Coolify's grace period. That gap is unclosed and is listed in §5.

**Files:** `server.ts`, `app.ts`, `lib/http/after-response.ts`,
`reports/coolify-deployment.md`

### F5 — the rollback report was stale · **confirmed, fixed** · ADJUDICATED: INCOMPLETE — see §4.6

All four specifics check out. `reports/next-migration.md` was written while the
Next source still existed and was never re-read after the deletion: it described
`next.config.js` as "retained in the same commented, banner-marked state", told
readers to uncomment files that no longer exist, and referenced
`buildHandlerInput` in five places — a function that does not exist. It also
stated the `formData` contract, which has since changed twice.

Corrected: tense and existence, the recreate-don't-uncomment instructions, the
current `buildRequestMeta` / `withBodyPolicy` shape, the current lazy-reader
contract, and a new subsection listing what Next.js would _not_ give back.

**Adjudication.** The four cited defects are genuinely gone —
`buildHandlerInput`, `attachBody`, `ctx.body` and `ctx.formData` have zero
occurrences in the file, every `uncomment` is now framed as history, and the
step-2 replacement adapter type-checks against the real modules. **But the
review's charge was that the document is unusable as a rollback procedure, and
fixing four lines did not settle that.** Following it broke the tree at step 8,
and it carried six stale `server.ts` pointers. Fixed in §4.6.

Also adjudicated: the `**CORRECTION.**` notes exist and are accurate — 6 in
`elysia-migration-review-response.md` (lines 17, 60, 181, 305, 369, 429) and 1
in `elysia-migration-review-summary.md`, each spot-checked against the code.

**Files:** `reports/next-migration.md`

### F6 — the OpenAPI document was inaccurate · **confirmed on every count, fixed** · ADJUDICATED: INSTANCE ONLY — see §4.3, §4.4, §4.5

Reproduced against the live document. Four defects, all real:

| Defect                                                                                                            | Fix                                                                      |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `DELETE /api/dash/users/:id/sessions` and `POST /api/dev/sign-up` declare `body: 'json'` but had no `requestBody` | Their schemas were module-private; both are now exported and wired       |
| Four Better Auth `operationId`s duplicated between GET and POST                                                   | A fresh operation object per method, with the method in the id           |
| Three handlers return `201`; the document said `200` only                                                         | `CREATED_ROUTES` drives the success status                               |
| Better Auth responses documented as this API's envelope                                                           | They are not — its own shapes, left unconstrained rather than fabricated |

Duplicate `operationId`s are not cosmetic: OpenAPI 3.1 §4.8.10 requires
uniqueness, so the document was invalid for every generator. Verified after: 26
paths, 18 request bodies, zero duplicate ids, `201` on exactly the three routes
that return it.

**Adjudication.** All four confirmed fixed, independently and twice — once by
importing the module and once by fetching `/openapi.json` from a booted server,
byte-identical. I reproduced the same numbers a third time myself: 26 paths, 37
operations, 18 request bodies, 0 duplicate operationIds, `201` on exactly the
three handlers that contain `HTTP_STATUS.CREATED` (verified against the
handlers, not against the constant). A manifest cross-check finds no route with
a body policy and no `requestBody`, and none with a spurious one.

**Three things the fix did not do, all now fixed:** it left the class open while
claiming a check that did not exist (§4.3), the `required` arrays were wrong in
nearly every body (§4.4), and 400/422 were undocumented (§4.5).

**Files:** `lib/http/openapi.ts`, `app/api/dash/users/[id]/sessions/handler.ts`,
`app/api/dev/sign-up/handler.ts`

### F7 — manifest-driven behaviour was incomplete · **first half confirmed and fixed; second half partly wrong** · ADJUDICATED: CONFIRMED, and see §4.7, §4.8, §4.9

**The `/openapi.json` half is entirely right.** Registering it directly on the
framework instance put it outside the table, so it silently had none of the
behaviour the table drives. Measured before: `POST` → 404 (not 405), `OPTIONS` →
404, trailing slash → 404.

It is now a `RouteDefinition` in `routes.ts` like everything else. Measured
after:

```
POST    /openapi.json  -> 405   Allow: GET, HEAD, OPTIONS
OPTIONS /openapi.json  -> 204
GET     /openapi.json/ -> 308   Location: /openapi.json
```

The general lesson is in the code comment: a route outside the table is
invisible to every check the table drives, including its own document.

**The auth-prefix half I fixed too, though I disagree with how the report framed
it** — see §3. `RoutePrefix` now carries the exact reachable sub-paths instead
of matching the whole prefix, and those paths come from the same allowlist
`lib/auth.ts` enforces, moved to a leaf module (`lib/auth/allowed-paths.ts`) so
enforcement and advertisement cannot drift.

Measured after, with every real auth path re-checked to be sure nothing broke:

```
path                 GET  POST PUT
get-session          200  405  405
sign-out             404  200  405
sign-in/email        400  400  405
passwordless/verify  404  403  405
not-a-path           404  404  404
```

**Adjudication.** Both halves confirmed by booting the real server and
measuring, and I reproduced the whole matrix in-process myself.
`OPTIONS /api/auth/not-a-path` is 404 now, not 204; `PUT` on the same path is
404, not `405 Allow: GET, POST`. Prefix-of-a-real-path (`/api/auth/sign-in`),
extends-a-real-path (`/api/auth/get-session/extra`) and the bare prefix are all
404 on every method. Real paths keep their 405 and their `Allow`. The
single-source claim holds: one definition in `lib/auth/allowed-paths.ts`, three
importers, no second copy. (`lib/http/route-manifest.ts` does not import it and
correctly should not — `createRouteLookup` takes prefixes as a parameter, so it
is the same constant injected, not a copy.)

One row differs from my table and it is not a contradiction: the adjudicator
measured `passwordless/verify POST` as 400 with no body and 403 with a JSON
body. My table said 403 without stating the request shape.

**Three residual defects the adjudication found, all now fixed:** `Allow`
over-advertised `HEAD` under `/api/auth` (§4.7), `OPTIONS` on a trailing-slash
URL answered 404 while every other method redirected (§4.8), and unknown
`/api/auth/*` paths reached Better Auth's plugins — which is a security finding,
not a tidy-up (§4.9).

**Also adjudicated, and worth recording as a correction to my own framing:**
`/openapi.json` was NOT the only route registered outside the manifest.
`@elysia/cors` registers `OPTIONS /` and `OPTIONS /*` catch-alls of its own
(`node_modules/@elysia/cors/dist/cjs/index.js:140`). The observable exposure is
closed — the `onRequest` gate runs before the plugin and 404s any OPTIONS the
manifest does not know, measured across seven paths — but "the set of paths the
server answers equals the set the manifest declares" is true in BEHAVIOUR and
false in REGISTRATION, and it holds because of hook ordering that nothing
asserts. That is now a required assertion in `reports/test-strategy.md` §10.11
E.

**Files:** `routes.ts`, `app.ts`, `lib/http/route-manifest.ts`,
`lib/http/openapi.ts`, `lib/auth.ts`, `lib/auth/allowed-paths.ts`

### F8 — the scanner did not prove registration · **confirmed, fixed and negative-tested** · ADJUDICATED: INSTANCE ONLY — see §4.10

Right, and it is the sharper version of the defect the scanner exists to catch:
a handler module could be imported by `routes.ts` and routed nowhere, and the
import-graph check would pass.

It now reads the route table as a table — every `import * as NS from '…'` mapped
to its module, every `handler: NS.METHOD` reference collected — and fails if any
HTTP method a handler module exports has no `ROUTES` entry. Static on purpose:
importing `routes.ts` would pull in the application, its env validation and
Better Auth, none of which CI configures for a file scan.

Negative-tested by deleting the `/api/dash/roles` entry:

```
1 unregistered handler(s):
  app/api/dash/roles/handler.ts exports GET but no routes.ts entry routes it
exit=1
```

**Adjudication.** The check does what this document says, the negative test
reproduces byte-identically, a sharper variant (deleting only the `PUT` of a
three-method module) also fires, and the scanner IS a CI gate at `ci.yml:44`.
`knip` is correctly NOT a gate — CI runs `bun scripts/find-unused-files.ts`
directly, not `bun run find:unused-files`, and knip still exits 1 with 86 unused
exports.

**But two holes were open and are now closed (§4.10).** The gate proved
_reference_, not _membership in `ROUTES`_, and it saw only `export const`.

**Files:** `scripts/find-unused-files.ts`

### ESLint — audited, and the answer is that nothing needs adding · ADJUDICATED: CONFIRMED

You asked me to check which rules Next.js was enforcing and add them.
`docs/next-config-eslint.md` names exactly three recommended sets. Audited rule
by rule:

- **`eslint-config-next/typescript`** was a wrapper around
  `plugin:@typescript-eslint/recommended`. `eslint.config.mjs:27` already
  spreads `...tseslintConfigs.recommended` — that _is_ the same config, and
  `eslint --print-config` confirms **39 active `@typescript-eslint/*` rules**.
  Nothing missing.
- **`@next/eslint-plugin-next`** contributes 21 rules. Every one requires JSX,
  an import from `next/*`, or a Pages-Router data-fetching export. There is no
  `.tsx` file, no `pages/` directory and no `next` import in this repository, so
  none of them has a reachable target. The single exception in kind is
  `no-assign-module-variable`, which is not JSX-bound — and nothing here assigns
  to `module`. (One local `const module = …` in the scanner was renamed anyway,
  so even the shadow is gone.)
- **`eslint-plugin-react` / `eslint-plugin-react-hooks` recommended** need React
  components to have anything to say.

Adding the plugins back would register 21+ rules that can never fire, which is
worse than absent: it reads as coverage. The full audit is written into the
header of `eslint.config.mjs`, together with exactly what to install and scope
**if** a front-end is ever added — so the next reader does not have to redo it.

**Verified independently:** `eslint --print-config app.ts` reports exactly
**39** active `@typescript-eslint/*` rules, **0** `@next/*` rules, and **0**
enabled `react*` rules (16 appear in the resolved config, all `off`). The claim
is exact.

**Files:** `eslint.config.mjs`, `scripts/find-unused-files.ts`

### Reports corrected

The previous pass's own reports asserted things that were false. Rather than
quietly editing them, every wrong claim now carries an inline `**CORRECTION.**`
note naming what was wrong: `reports/elysia-migration-review-response.md` (6
notes) and `reports/elysia-migration-review-summary.md`.
`reports/test-strategy.md` gained §10.10 — one required assertion per defect
that shipped, so each of these is caught by a test next time rather than by a
reviewer. It has now gained §10.11 for the same reason, from this pass.

`.prettierignore` now excludes `docs/next-config-eslint.md`,
`docs/llms-full.txt` and `prompt.md`: the first two are verbatim upstream copies
whose value is that they match their source, and the third is task input, not
project source. Without this, `format:check` — a CI gate — failed on files that
should not be rewritten.

---

## 2. What remains to be done

**Nothing from the verification report is outstanding**, and nothing from the
adjudication is outstanding in code. What remains is what needed you before,
plus four new items.

**Yours to measure** (`TODO.md`):

- **EM-1 — `idleTimeout` on the VPS.** Now triply load-bearing: the upload
  ceiling AND the global ceiling both set the shutdown bound (§4.1), so
  measuring them decides the deploy window. With the corrected derivation,
  dropping the upload route to 30 s gives a 75 s window, not 45 s — the 60 s
  global ceiling becomes the binding term.
- **EM-2 `precompile`**, **EM-3 single-binary build** (gated on `sharp` loading
  from a compiled binary).
- **EM-14 — bind scope on Linux.** One command (`ss -ltnp`). The startup log
  says `hostname: localhost` and the bind is actually `0.0.0.0` (measured on
  Windows); worth confirming on the target, because a loopback-only bind is the
  shape that makes the container unreachable through Traefik while looking
  healthy.

**Yours to decide:**

- **EM-11 — `utils/images/server.ts`**, a divergent dead copy of the SVG
  sanitiser. Both copies are security-relevant; pick one.
- **`/openapi.json` exposure** (runbook §12.6). Public by default — and it can
  now fail a deploy on purpose; see §4.3.
- **EM-6 — outgoing fetch logging and OpenTelemetry**, one decision with
  sanitisation as part of the work.
- **EM-15 — the Better Auth captcha plugin's substring matching.** Mitigated at
  our boundary (§4.9); whether to narrow the plugin's own endpoint list, and
  whether to raise it upstream, is yours.
- **EM-16 — `rateLimit.customRules` repeats the auth path strings**, so adding
  an allowed path without touching it silently selects the default limiter
  bucket.
- **EM-17 — `lib/http/adapters/hono.ts.disabled` is code nothing can verify.**
  It drifted; decide whether it gets a check or stops being described as working
  code.

**Coolify, runbook §12 and the final checklist** — the stop grace period must
exceed the `shutdownTimeoutMs` the startup log reports, currently **135 s**
(unchanged today, but now derived from both ceilings — §4.1). The rest stands:
set `PUBLIC_URL`, delete `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, proxy read
timeout above 120 s, proxy body limit 8 MiB, health check off the trailing
slash.

**Previously "outside this pass", now resolved:**

- ~~Three probe files lack the `.test.ts` suffix~~ — **fixed**, see §4.11. They
  are converted rather than renamed, because a bare rename would have been worse
  than leaving them out.
- `TODO.md` is gitignored (`.gitignore:13-14`), so the `EM-*` items live only in
  your working copy. Unchanged, and deliberate.

---

## 3. What I rejected, and why

### F4's registration race — could not reproduce; fixed the real exposure instead · ADJUDICATED: REBUTTAL STANDS, mechanism UNPROVEN

The report gives an observed ordering of `handler`, `stop`, `drain:true:0`,
`hook`, `task-start`, `task-end` — the post-response hook firing _after_ the
drain returned. I could not produce that. Two shapes, both instrumented:

```
handler -> hook -> task-start -> fetch-returned -> stop -> task-end -> drain:true:0
handler -> hook -> task-start -> headers:200    -> stop -> task-end -> drain:true:0
```

The hook fires before the client even sees response headers, so by the time
`app.stop()` resolves every hook has run. In the second shape I deliberately
avoided reading the response body to widen the window; it made no difference.

**But the conclusion is still right, for a different reason.** A request can
arrive, complete and enqueue work _while the drain is running_. A single
emptiness check would return before that work registered. That is a real hole
and the settle loop closes it.

**Adjudication.** The rebuttal stands: with a real listener the order was
`handler@57ms → task-start@58ms → fetch-headers@59ms → hook@59ms → stop-called@108ms → stop-resolved@113ms → task-end@472ms → drain@532ms`.
The reviewer's ordering did not occur. End to end through the real `server.ts`
shutdown the hook DOES fire after `stop` is called — so the reviewer's
structural concern is real in shape — but `app.stop()` only resolves after the
in-flight request completes, so the drain still saw the work. **Verdict:
UNPROVEN as stated**, and the settle loop is the correct mitigation either way.

**Correction to how I justified keeping it.** I wrote that a future maintainer
must not simplify the loop back to a `Promise.all` because "the listener hole is
still there". There is no listener hole — see §4.9. The loop should be kept, for
the narrower and correct reason: work can arrive on an already-established
keep-alive connection during the drain.

### F7's auth-prefix framing — the fix was right, the reasoning was not · ADJUDICATED: MY FRAMING UPHELD

The report says the broad prefix makes nonexistent `/api/auth/*` paths "return
`OPTIONS 204` and unsupported methods return 405 instead of remaining genuine
404s", implying the prefix should not be in the lookup.

That framing is wrong: the prefix genuinely _is_ registered for GET and POST, so
405 was a defensible answer to `PUT`. The actual defect is narrower and worse —
**the boundary and the handler disagreed.** `PUT /api/auth/zzz` answered
`405 Allow: GET, POST` while `GET /api/auth/zzz` answered `404`. The server told
a client the path existed under two methods and then denied it under both.

That is fixable exactly because Better Auth's reachable surface is a fixed
allowlist this codebase already owns, so the boundary can be exact rather than
approximate. Dropping the prefix from the lookup entirely — the literal reading
of the finding — would have been the wrong fix: every wrong-method request to a
_real_ auth path would have become a 404, losing the `Allow` header that made
the 405 boundary worth building.

**Adjudication.** Upheld. Real auth paths keep `405` with a correct `Allow`,
nonexistent ones are `404` on every method including `OPTIONS`, and the literal
reading of the finding would indeed have lost the `Allow` header. **And the
"boundary and handler disagree" framing turned out to be more productive than
either version of the finding** — following it one step further is what surfaced
§4.7 (the same disagreement in the method dimension) and §4.9 (the same
disagreement one layer down, where it is a security issue).

### F6's "materially inaccurate" — accepted, but the numbers were never wrong · ADJUDICATED: CONFIRMED, and beside the point

Every specific defect was real and is fixed. Worth separating for the record:
the report notes the "25 paths / 16 bodies" claim was reproducible, and it was.
The document was wrong about _content_, not about counts. Both matter;
conflating them would leave the impression the earlier figures were invented.

**Adjudication.** Correct on the counts, and the separation is fair. It is also
the least important thing about F6: the adjudication found the document was
still wrong about content in a way neither report had noticed — every `required`
array (§4.4). Defending the counts while the content stayed wrong is the shape
of answer this row should not have been.

### F8's "the current route table is complete" — agreed, and that is the point · ADJUDICATED: CONFIRMED, with the gate weaker than claimed

The report grants that the table is currently complete and calls the gate's
promise unmet for the future. Correct, and worth stating plainly: the value of a
gate is entirely in the case that has not happened yet. That is why I
negative-tested it by deliberately breaking the table rather than only
confirming it passes today.

**Adjudication.** The reasoning is right and the gate was weaker than the
sentence implied: it proved a textual reference, not membership in `ROUTES`, and
it saw only `export const`. One negative test passing is not the same as the
hole being closed — which is the same lesson this row is making, applied to
itself. Both holes are closed and four negative tests now cover them (§4.10).

### Nothing was rejected outright

All eight findings led to a change. The two disagreements above are about
mechanism and framing, not about whether to act.

---

## 4. Fixed in the adjudication pass

Nine defects, each found by adjudicating a claim rather than by re-reading the
finding. Three of them (§4.3, §4.7, §4.10) are the CLASS of a finding that had
been fixed only at its instance — the failure mode CLAUDE.md names, and the
reason this section exists.

### 4.1 `SHUTDOWN_TIMEOUT_MS` ignored the global ceiling — and the runbook told you to re-break it

`SHUTDOWN_TIMEOUT_MS` was `(MAX_ROUTE_TIMEOUT_SECONDS + 15) * 1000`. Every route
WITHOUT its own `timeoutSeconds` may still run for `IDLE_TIMEOUT_SECONDS` (60
s), so the per-route maximum is only the right answer while it happens to be the
larger of the two. It is today — 120 > 60 — by coincidence of the current table.

The defect is that `reports/coolify-deployment.md` §12.2 tells the operator the
lever for a shorter deploy window is the upload ceiling: _"a 30 s route ceiling
gives a 45 s deploy window"_. Taking that advice would have produced a 45 s
bound against a global ceiling still permitting 60 s requests — reintroducing
exactly the abort the derivation was built to prevent, through its own
documented fix.

Now `(Math.max(IDLE_TIMEOUT_SECONDS, MAX_ROUTE_TIMEOUT_SECONDS) + 15) * 1000`.
Unchanged today at 135 s, verified from the startup log. The runbook is
corrected in place, including the 45 s figure (it is 75 s), and
`reports/test-strategy.md` §10.10 G — which recorded the one-term invariant as
the thing to assert — is corrected too, with a note that asserting the one-term
form would have passed while the real invariant was violated.

**Files:** `server.ts`, `reports/coolify-deployment.md`,
`reports/test-strategy.md`

### 4.2 `forced.unref()` removed the forced-shutdown guarantee

The comment said _"a drain that hangs is exactly the case this exists for"_, and
`unref()` on the next line meant it did not. Measured on Bun 1.3.14: with the
listener closed, a hanging drain and no other ref'd handle, the unref'd timer
**never fired** — the process exited **0** with no `forced shutdown` line, and
the store closes never ran. With a ref'd handle present, or with `unref`
removed, it fires at the bound and exits 1.

`clearTimeout(forced)` on the clean path already prevents the timer from
delaying a fast shutdown, which is the only thing `unref` was buying. Removed.
Currently latent — `drainAfterResponse` always awaits a ref'd `Bun.sleep` —
which is why it survived review.

Also on the shutdown path: a drain that times out logs its pending count and
still exits 0. That is now an explicit, documented decision rather than a silent
fall-through — `app.stop()` has already resolved by then, so what is abandoned
is post-response work, today only access-log lines, and failing a routine
deploy's stop phase over a log line is the wrong trade. Recorded in the runbook
so it can be revisited when real post-response work exists.

**Files:** `server.ts`, `reports/coolify-deployment.md`

### 4.3 The OpenAPI consistency check was claimed and did not exist — F6's class

`lib/http/openapi.ts` said, above `REQUEST_BODIES`: _"A key that does not match
a manifest entry is reported by `openApiDocument`'s own consistency check rather
than silently ignored."_ There was no such check. Both halves of that sentence
were false.

Proven rather than asserted: calling `openApiDocument` with a synthetic
`POST /api/dash/widgets` declaring `body: 'json'` and no schema produced an
operation with **no `requestBody` and no error** — the exact defect F6 reported,
still fully reachable after F6 was "fixed". Adding the two missing schemas fixed
two routes and nothing about the next one.

`openApiConsistencyProblems(manifest)` is now real and exported, covering four
drift shapes: a `json` route with no schema; a schema on a route that is not
`json`; a `REQUEST_BODIES` or `CREATED_ROUTES` key matching no route; a
`BETTER_AUTH_BODIES` key outside the allowlist. `openApiDocument` **throws** on
any of them rather than serving a wrong contract, and `scripts/smoke.ts` — a CI
step — now asserts `GET /openapi.json` is 200, which makes the throw a gate.

Verified on all four shapes; the real table reports zero problems.

**Files:** `lib/http/openapi.ts`, `scripts/smoke.ts`,
`reports/coolify-deployment.md`

### 4.4 Every documented `required` array was wrong

The sharpest defect in this pass, and neither report noticed it. `toJsonSchema`
converts with `io: 'input'`, and on the installed `zod@4.4.3` that drops any key
whose field is a `z.preprocess` — the input type is `unknown`, which admits
`undefined` as far as the converter can tell. `emailSchema` and `passwordSchema`
are both preprocessed, so:

```
POST /api/dash/users                     props=7 required=0
POST /api/dash/users/me/change-password  props=2 required=0
POST /api/auth/otp/send                  every branch required only "channel"
```

while the runtime rejects `{}` with a 422. A client generated from that document
would omit `email` and `password` from sign-in and be rejected every time.

`io: 'output'` is not the fix and I checked before assuming: it marks `isActive`
and `phoneNumber` required for `createUserSchema`, which they are not in a
request — defaults are always present after parsing, never required before it.
The property shapes must stay on the input side.

`required` is now recomputed from the schema by asking each field the question
the document actually makes a claim about — does omitting this key fail? — which
is `safeParse(undefined)`, and gets defaults, optionals and
preprocessed-but-required fields all right at once. Unions recurse, because
`sendOtpSchema`, `verifyOtpSchema` and `resetPasswordSchema` are all
`ZodDiscriminatedUnion` and every branch was understated; branch order is taken
from `.options` with a length guard, so a converter that stops preserving it
leaves the understated version alone rather than attaching one branch's rules to
another's.

After: `createUserSchema` reports `[email, password, name, roleId]` — matching
the runtime exactly — and every OTP branch is complete.

**Files:** `lib/http/openapi.ts`

### 4.5 `400` and `422` were documented nowhere

`commonResponses` emitted `{200|201, 404, 405, 500}` plus `{429, 503}` for
`ip-limit` routes. `422` is the standard validation failure of every JSON route
(17 handler files) and `400` is what `requireJsonBody` throws on an absent or
malformed body — the mistake a client is most likely to make, and neither was in
the contract.

Both are derivable from the manifest, which is why they belong in
`commonResponses` and not in a per-route table: `400` from a non-`none` body
policy, `422` from that **or a path parameter** — every `:id` route validates it
and answers 422 on a malformed id, so this is not limited to body routes.

`401`, `403` and `409` remain undocumented. They are NOT derivable from the
manifest today; adding them needs a new manifest field, which is a design change
rather than a fix, and it is recorded in `reports/test-strategy.md` §10.11 C
rather than guessed at.

**Files:** `lib/http/openapi.ts`

### 4.6 The rollback report broke the tree at step 8 — F5's real charge

Step 8 said to delete `server.ts`, the Elysia adapter, `scripts/smoke.ts` and
the `elysia` dependencies. It did not mention `app.ts` — which is the ONLY
importer of `elysia`, `@elysia/cors` and `lib/http/adapters/elysia.ts`.
Following the procedure removed the dependencies and their adapter while leaving
the file that imports all three, so `bun run build` failed on three unresolvable
imports in a file the document never named. The string `app.ts` did not appear
anywhere in its 833 lines.

Six stale `server.ts` pointers went with it — the route table, the Better Auth
mount, the security-header hook, the CORS origin and the `TODO` marker were all
attributed to `server.ts`, which registers nothing. Plus a `.all('/api/auth/*')`
that does not exist, a present-tense `formData` contract, a phantom
`cleanEnvUrlToDomain`, a claim that `PUBLIC_URL` is exported from `lib/env.js`
(only `PUBLIC_ORIGIN` is), and an instruction to drop a `unicorn/no-empty-file`
override that was never there.

All corrected, in both `reports/next-migration.md` and its companion
`docs/framework-migration.md`, which had the identical `app.ts` omission and the
same phantom override. The cross-reference warning readers away from
framework-migration.md §5 is now marked as a historical record, since that
document has been corrected to agree.

**Files:** `reports/next-migration.md`, `docs/framework-migration.md`

### 4.7 `Allow` advertised `HEAD` where `HEAD` answers 404 — F7's class, method dimension

Measured: Elysia derives `HEAD` from a `GET` route in the table
(`HEAD /api/health/storage` → 200) but NOT from the Better Auth wildcard
(`HEAD /api/auth/get-session` → **404** while `GET` → 200). `allowHeader`
synthesised `HEAD` from `GET` unconditionally, so `PUT /api/auth/get-session`
answered `405 Allow: GET, POST, HEAD, OPTIONS` — naming a method the handler
rejects.

That is exactly the over-claiming boundary `RoutePrefix.paths` fixed in the PATH
dimension, surviving in the METHOD dimension. The decision moved to
`createRouteLookup`, which is the only place that knows which kind of
registration matched; `allowHeader` now only adds `OPTIONS`.

After: `/api/auth/*` advertises `GET, POST, OPTIONS`; table routes still
advertise `HEAD` alongside `GET`; POST-only routes still advertise
`POST, OPTIONS`. Verified against seven method-set shapes.

**Files:** `lib/http/route-manifest.ts`

### 4.8 `OPTIONS` on a trailing-slash URL answered 404 while every other method redirected

`GET /api/health/storage/` → 308, `POST` → 308, `OPTIONS` → **404**. The
route-aware OPTIONS gate runs in `onRequest`, before the router, and did no
slice-and-retry; the canonicalisation lived only in `onError`. One URL, two
answers, depending on method.

The redirect is now a named function used by both places. Verified: every method
on a real path's slash form returns 308 with the same `Location`, and every
method on an unknown slash form still returns 404 — the redirect never becomes a
path oracle.

**Files:** `app.ts`, `reports/coolify-deployment.md`

### 4.9 Unknown `/api/auth/*` paths reached Better Auth's plugins — a security fix

The adjudication reported two 404 contracts on one API: unknown `/api/auth/*`
paths came back as Better Auth's own bodyless 404 with no `Content-Type`, while
every other unknown path returned the envelope. Chasing why turned up something
worse.

Better Auth runs plugin `onRequest` handlers **ahead of its own hooks**, so the
`before` hook enforcing `BETTER_AUTH_ALLOWED_PATHS` was not first. The captcha
plugin matches its endpoint list with `pathname.includes(endpoint)` — read in
`node_modules/better-auth/dist/plugins/captcha/index.mjs`, not from memory — so
ANY path containing `sign-in/email` matched. Measured before the fix:

```
POST /api/auth/sign-in/email/extra  -> 400 Missing CAPTCHA response
POST /api/auth/sign-in/emailXYZ     -> 400 Missing CAPTCHA response
POST /api/auth/zz/sign-in/email/zz  -> 400 Missing CAPTCHA response
```

None of those paths exists. And with an `x-captcha-response` header the plugin
proceeds to `cloudflareTurnstile(...)` — an outbound siteverify call — for a
path this server does not serve. That is unauthenticated, attacker-triggerable
spend against the Turnstile quota from any URL shaped that way.

`app.ts` now checks the allowlist before calling `auth.handler` at all, using
the same constant. The `before` hook stays as defence in depth. Re-measured:
every one of those paths is a `404` with the envelope even with a token
supplied, real auth paths are byte-for-byte unchanged (200 / 200 / 400 captcha /
400 validation / 405 with the corrected `Allow`), `/api/auth/get-session/` now
308s, and the API has one 404 contract.

The plugin's own behaviour is upstream and is recorded as `TODO.md` EM-15.

**Files:** `app.ts`, `reports/coolify-deployment.md`, `TODO.md`

### 4.10 Two holes in the registration gate — F8's class

**A textual reference anywhere in `routes.ts` satisfied the gate.** The
`handler: NS.METHOD` regex ran over the whole file, so moving a real entry out
of `ROUTES` into an unexported, never-iterated const left the route genuinely
unregistered and the scanner still exited 0. Now the references are read only
from the `ROUTES` array literal, located by bracket counting; if the array
cannot be found the scanner reports that rather than silently checking nothing.

**Only `export const` was recognised.** `export function POST` and
`export { handler as POST }` were invisible — an unrouted endpoint alongside a
routed `export const GET` passed. Now all three declaration forms are matched,
and `export { … }` clauses are split by hand so the EXPORTED name is what
counts: `{ handler as GET }` is a GET export and `{ GET as legacyGet }` is not.

Negative-tested five ways, exit codes asserted: dead-const reference → 1,
`export async function POST` → 1, `export function PUT` → 1,
`export { h as DELETE }` → 1, `export { GET as legacyGet }` → **0** (the
precision case — a false positive here would train someone to disable the gate).
Clean tree → 0, and every touched file restored byte-identically.

**Also fixed:** `lefthook.yml` claimed `bun run verify` was "the same set as
pre-push and CI" and ran neither the probe suite nor this scanner. Both are
added — both need no environment, which is why CI's own steps for them carry no
`env:` block — and the comment now says plainly what CI has that the local hooks
do not (`bun run smoke`, which needs a full production-shaped environment).

**Files:** `scripts/find-unused-files.ts`, `lefthook.yml`

### 4.11 Three regression probes had never run in CI

`bun run test` reported "60 pass" across **6** files while the directory
holds 12. `log-serializer.ts`, `permission-schema.ts` and `time-dst.ts` were
CLI-style probes without the `.test.ts` suffix Bun's glob needs, so 90
assertions covering the log redaction boundary, the permission payload schemas
and the DST/calendar contract had never executed.

**Renaming them would have been worse than leaving them out**, and this is the
part worth recording: each ends with `process.exit(...)`, and an explicit exit
inside a test file ends the whole run — silently skipping every file after it.
So they are converted, not renamed: one `bun test` case per assertion, every
original `check(...)` call site unchanged, the tally and the exit removed.
Assertion counts preserved exactly (16, 22, 16).

`bun run test` is now **150 pass / 0 fail across 9 files**.

**Files:**
`scripts/probe/local/{log-serializer,permission-schema,time-dst}.test.ts`

### 4.12 Smaller corrections, each verified

- **`lib/http/adapters/hono.ts.disabled` called `attachBody`**, deleted by the
  F3 fix three changes earlier. `.ts.disabled` matches no tsconfig include, no
  lint glob and no test, so nothing caught it. `app.ts`'s `CORS_POLICY` was
  extracted as data specifically so this file could not drift again — and the
  body contract, the security-relevant half, drifted anyway. Fixed to the
  two-call split, with the reason the split matters written in. Whether it
  should be verifiable at all is `TODO.md` EM-17.
- **`lib/env.js` and `lib/http/security-headers.ts` both said `@elysia/cors`
  lives in `server.ts`.** It is `app.ts:195`. Corrected in both.
- **The access log claimed "one line per request".** It is not: `OPTIONS`
  produces none, because both OPTIONS answers short-circuit in an `onRequest`
  hook — the CORS plugin's 204 and the route-aware 404 — and `onAfterResponse`
  never fires for either. 404s, 405s and 308s DO appear. Measured, and the
  comment now says what is true. Preflight volume and OPTIONS-based path
  scanning are invisible in the access log; that is a known gap, not a claim.
- **`enqueueAfterResponse` has no caller.** The whole post-response queue, and
  the settle loop that F4 turns on, is insurance for a first caller that does
  not exist yet — `logRequest` is synchronous. Worth knowing before someone
  reasons about its behaviour under load; now stated at the function.
- **The runbook's startup-log sample showed `"hostname": "0.0.0.0"`.** The
  process prints `localhost`. The bind IS `0.0.0.0` (netstat shows `0.0.0.0:`
  and `[::]:` LISTENING, and the server answered on a non-loopback interface),
  so the sample was right about the socket and wrong about the log. Corrected,
  with the one-line Linux check recorded as `TODO.md` EM-14.
- **The runbook stated the 413 as if it were a normal response.** Measured: it
  is a bare transport reply with no body, no security headers, no envelope and
  no access-log line, and Bun's own `fetch` surfaces it as a closed socket
  rather than as a status. Anything asserting `status === 413` needs a raw
  socket.

---

## 5. UNPROVEN — and what would settle each

Recorded rather than resolved either way. None was upgraded to closed to tidy
the list.

**5.1 F4's registration race, as the reviewer stated it.** The ordering
`handler, stop, drain, hook` did not reproduce in three separate instrumented
runs, with and without reading the response body, in-process and through the
real `server.ts`. The hook fires before the client sees headers. **What would
settle it:** the reviewer's exact harness, or a handler that defers its
`onAfterResponse` registration across a macrotask boundary — if that ordering is
reachable at all, that is the shape that reaches it. The settle loop mitigates
it regardless, so this is a question about the report's accuracy, not about the
code.

**5.2 OS signal delivery.** Every shutdown measurement used
`process.emit('SIGTERM')` inside the real process, because Windows cannot
deliver a real signal to a spawned Bun child (`kill('SIGTERM')` → exit 143,
handler never ran). That exercises the handler and everything downstream; it
does not exercise signal delivery, Coolify's grace period, or what Bun does to
sockets on a real SIGTERM. **What would settle it:** the same probe on Linux,
which is also where `reports/test-strategy.md` §10.8 belongs.

**5.3 Forced shutdown against the real server.** §4.2 was reproduced on isolated
probes, not on `server.ts` itself, because that needs a ≥135 s hang. **What
would settle it:** a build with `SHUTDOWN_TIMEOUT_MS` temporarily lowered and a
deliberately hanging post-response task — cheap, and worth doing once alongside
§10.11 G.

**5.4 OpenAPI 3.1 conformance.** Structural checks pass — unique operationIds,
valid method keys, every Response Object has `description`, every
`requestBody.content` has a schema, every `{param}` has a matching parameter,
zero `$ref`s to resolve. No real 3.1 validator is available offline: the
installed `ajv` is 6.15.0 (draft-07), and installing
`@apidevtools/swagger-parser` or Spectral would change the tree. **What would
settle it:** one CI step running a 3.1 validator against the generated document.

**5.5 The Linux half of the CI environment.** `lefthook`'s Linux binary running
as `prepare`, `mise` resolving `semgrep`, and `setup-bun` reading
`packageManager` are unverified from here. **What would settle it:** one green
CI run — which is also the only thing that closes F1 end to end rather than by
reconstruction.

**5.6 `zod`'s union branch ordering.** §4.4's recursion assumes converted
`oneOf`/`anyOf` branches follow `.options` order. It holds on `zod@4.4.3` and is
guarded by a length check that falls back to leaving `required` alone. **What
would settle it:** an assertion pinned to the schemas, per
`reports/test-strategy.md` §10.11 B — or nothing, if the guard is judged
sufficient.
