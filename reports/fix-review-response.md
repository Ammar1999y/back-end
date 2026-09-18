# Response to `reports/fix-review.md`

Every reported item was verified before being acted on. Seven were valid and are
fixed; one was not a defect and is settled below. This file records where I did
something other than what the review asked for, and why — it is not a summary of
the work.

## 0. `reports/audit-fixes.md` was not available

The task referenced it. It is not on disk and not in git history
(`git log --all --oneline -- reports/audit-fixes.md` returns nothing). The
starting point was `reports/fix-review.md` plus `git diff` against `8ab5c1a`.

Separately, `fix-review.md` is numbered **2, 3, 5, 6, 7, 8, 9, 10**. Items 1 and
4 are absent. If they were dropped as invalid, nothing here covers them; if they
were lost in transit, they were never reviewed. Worth confirming.

## 1. Item 5 — the review's own remediation would not have fixed item 5

> **Remediation:** Throw the invalid-code error from inside the verifier
> callback, so a replay is charged exactly like a wrong code.

It would not be. Everything a wrong code pays for lives **inside the library's
`verifyTOTP`**, not inside the transaction the callback opens:

- `beginAttempt(5)` — `node_modules/better-auth/dist/plugins/two-factor/verify-two-factor.mjs`;
- `assertTwoFactorNotLocked` and `recordTwoFactorFailure`
  (`failedVerificationCount` → `lockedUntil`) —
  `node_modules/better-auth/dist/plugins/two-factor/totp/index.mjs:184,200-202`.

`withTwoFactorChallengeTransaction` writes no counter at all. This application's
own per-challenge budget, `spendChallengeAttempt`, is called only by
`lib/auth/two-factor-otp.ts` and `lib/auth/two-factor-passkey.ts` — never by the
library's verifiers, which run their own. So moving the throw inside the callback
opens a transaction, writes nothing, and leaves the cost asymmetry the finding
describes exactly as it was.

**What was done instead.** A replay is delegated to the library as a code it
cannot accept (`SPENT_TOTP_CODE` in `lib/auth/two-factor.ts` — non-digits, and
`generateHOTP` emits decimal digits only at every step of every window). The
whole wrong-code path then runs: the challenge's five attempts, the account's ten
failures, and the library's own message. Replay and guess become identical in
status, message **and** cost.

**A consequence the review did not raise.** Charging replays means replays now
count toward the ten-failure account lockout. Four cases in
`tests/integration/two-factor-totp.test.ts` assumed that budget was clean and
started answering `429`; the file cleared it after one known offender. That
clearing is now an `afterEach`, and the invariant itself is asserted directly by
a new case, `a replay costs what a wrong code costs, not nothing`. The lockout is
not a new denial-of-service surface: reaching `/two-factor/verify-totp` needs a
challenge cookie, which follows a verified password, and ten wrong guesses have
always locked the account from the same position.

## 2. Item 2 — documented the order rather than doing expand/contract

The review offered both. I took the second, and the first is a worse trade here:

- No production data yet (`CLAUDE.md` §1), one instance, stop-first deploys
  (runbook §6). The window is an operator sequencing choice, not an availability
  property of the system.
- Expand/contract costs a release carrying two dead columns and a dual-read path,
  plus a second migration and a second review, to remove a window the runbook can
  close for free.
- `CLAUDE.md` §2 routes server-side requirements to `reports/coolify-deployment.md`.

Added **§13.4a** there, and a pointer from §1. It goes past what the review
named: the review cited `0014` and `0016`; I checked all seven. `0013`, `0017`,
`0018` and `0019` are additive and safe in either direction, `0015` must precede
`0016` because it is the hand-written backfill that carries the acknowledgement
across, and a container-only rollback of this release leaves the same failure
permanently — there is no down migration.

## 3. Item 10 — not a defect; resolved rather than deferred

The review could not determine whether musl classifies `Nl` and non-ASCII `Nd` as
alpha and asked for a run against `postgres:18-alpine` before merging. There is no
container runtime on this host either, so I settled it from musl's source.

`src/ctype/iswalpha.c` is a bitmap lookup into `src/ctype/alpha.h`. Evaluating
that bitmap:

- `U+2163` (Ⅳ, `Nl`), `U+3007` (〇, `Nl`) and `U+0661` (١, `Nd`) are **alpha**,
  as are every letter the test terms use. `U+1F600` is not, which is what keeps
  `ab😀` behaving the same as on glibc.
- Over the whole BMP, every code point `[\p{L}\p{Nl}\p{Nd}]` admits is alpha under
  musl **except** 121 recent Unicode additions (Arabic Extended-B, recent CJK
  ideographs, a few Latin/Cyrillic extensions). None appear in the test set.
- The locale half matters as much: the official image sets `LANG=en_US.utf8`, and
  musl's `__get_locale` stores the requested NAME even when it loads C.UTF-8
  behaviour, so `datctype` is not `C` and PostgreSQL uses `iswalpha` rather than
  `isalpha` on the first byte of a multibyte character. Under `C` every non-ASCII
  term would be unindexed and the tier would fail on `فلم` — which is the case to
  check on any variant that sets the locale differently.

So the tier passes on `postgres:18-alpine`. §15 requires the result to be
recorded, so it is, with the method and the residual.

I did **not** narrow the predicate to cover those 121 points. They are one libc
version's vintage, not a property of the class; refusing them would refuse them on
the glibc images too, and the risk — an authorized user searching a three-character
term built from them — is the case §15 already names and the tier already measures.

⚠️ **Flagging the limit:** this is derivation from musl's published tables and the
image's Dockerfile, not an observed run. The observed run is
`docker run --rm -e POSTGRES_PASSWORD=… postgres:18-alpine` plus
`bun tests/helpers/run.ts integration trigram-floor` pointed at it.

## 4. Item 8 — rejected the `.prettierignore` option

`git show HEAD:db/drizzle/meta/_journal.json` ends with a newline and every
snapshot through `0012` passes `prettier --check`. Ignoring the directory would
diverge from what is already committed. Formatted the two files instead;
`check:schema-drift` still reports `schema drift: none`, so drizzle-kit does not
rewrite them on a clean tree.

## 5. Item 7 — the typed registry alone was not sufficient

The review asked for two changes and only both together work. `satisfies`
narrows `keyof COMPONENT_SCHEMAS` to a literal union, which makes
`componentRef('User')` a compile error — but `User` still has to be referenced,
and the name is Better Auth's, which no type in this repository can check.
`libraryComponentRef` asserts it at load against
`BETTER_AUTH_OPENAPI.components.schemas`. `routes.ts` imports this module, so the
refusal is a boot refusal — the same answer the file already gives a document
that disagrees with the route table.

## 6. Two siblings swept beyond what was reported

`CLAUDE.md`'s fix discipline, not scope creep:

- **Item 3** is one flat-versus-ladder misclassification. The recovery route now
  publishes an integer with a minimum; `/two-factor/otp/send` published a bare
  integer for the same ladder, and now publishes the same shape.
- **Item 9** is load-time environment reads in modules that value-only consumers
  import. The preflight was one consumer. `db/schema.ts` was another — it built
  its `pgEnum`s from `utils/validation/otp.ts` and `utils/validation/two-factor.ts`,
  so `drizzle-kit generate` and the `check:schema-drift` gate depended on a valid
  `NEXT_PUBLIC_ENABLED_*` and printed the runtime's disabled notices. Fixed at the
  shared boundary: `utils/validation/enums.ts`, which has no imports and no
  environment reads. Both consumers now import from it.

## Verification

`bunx tsc --noEmit`, `bunx eslint . --max-warnings 0`, `bunx prettier --check .`,
`bun run find:unused-files` (scanner + knip) and `bun run check:schema-drift` all
pass. Test tiers, each run on its own: unit 1126/0, integration 731 pass 1 skip 0
fail, matrix 6/0, process 72 pass 2 skip 0 fail.

Not run: anything needing a container (see §3 above) or a live Coolify, R2 or
Cloudflare endpoint.
