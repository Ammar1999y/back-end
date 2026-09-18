# Review of the audit fix change set

## 2 · Medium · Column drops and a new CHECK land while the previous release is still serving

- **Location:** `db/drizzle/0016_drop_backup_code_version.sql`; `db/drizzle/0014_file_transition_owner.sql:3`; runbook `reports/coolify-deployment.md:186-191` (migrations run from the old container's pre-deployment command or a maintenance shell) and `:972-980` (stop-first swap afterwards).
- **Evidence:** Between `db:migrate` and the container swap the HEAD build keeps serving against the new schema. HEAD reads the dropped columns in `lib/auth/two-factor-challenge.ts` (2 references), `lib/auth/recovery-second-factor.ts` (2) and `lib/auth/two-factor-enrolment.ts` (8): every 2FA challenge, enrolment and recovery request fails with PostgreSQL `42703`. HEAD `lib/media/visibility.ts:221,264,310` clears `transition` without `transition_id`, which violates `chk_files_transition_owner` (`23514`) after the stale object was already deleted, leaving the row at `cleanup` until the sweep. Runbook §13.4 (`:1843`) is the precedent for stating migration order and compatibility; the new runbook text says nothing about this release.
- **Impact:** Deploy-window outage of every second-factor flow for the still-running release, proportional to how long the operator waits between migrate and swap.
- **Remediation:** Expand/contract: keep `backup_codes_version` and `backup_codes_acknowledged_version` for one release and drop them in the next, or document in the runbook that this release requires migrate-then-swap with no serving gap. Add the new CHECK only once no old code can write the marker alone.

## 3 · Medium · The recovery second-factor send still publishes `nextAllowedIn: const 30`

- **Location:** `lib/http/openapi.ts:1120-1126` (`OTP_SENT_SCHEMA`, comment at `:1122` says "these three surfaces answer identically") and `:1504`, which maps `POST /api/auth/forgot-password/second-factor/send` to that schema.
- **Evidence:** That handler returns the row's real value (`app/api/auth/forgot-password/second-factor/send/handler.ts:97-109`) from `processOtpSend` with `purpose: 'two_factor'`, which `FLAT_RESEND_PURPOSES` (`utils/otp.ts:74-78`) excludes, so the server answers 30, 60, 120, 240 while the document promises the constant 30. A generated client or response validator rejects the second and every later send.
- **Impact:** Deterministic contract failure on the recovery path, the same class as C-015 and C-020 the change set set out to fix; three of four consumers of the schema were swept.
- **Remediation:** Map the recovery route to an integer schema with a minimum (as `lib/auth/two-factor-otp.ts:149` publishes for the 2FA send), and correct the comment.

## 5 · Low · A replayed TOTP is refused outside the attempt budget and lockout

- **Location:** `lib/auth/two-factor.ts:330-336`; `lib/auth/totp-replay.ts:119-122`.
- **Evidence:** `reserved === 'replayed'` throws 401 before `runPluginVerifier`, so `withTwoFactorChallengeTransaction` never opens: the per-challenge attempt counter and the library's `failedVerificationCount`/`lockedUntil` do not advance, and the response returns without the verifier and counter write a wrong code pays for. `totp-replay.ts` states both outcomes must be indistinguishable; status and message are, cost and counters are not. The reservation also runs before the library's lockout check, which the code accepts as spending one period.
- **Impact:** A holder of an observed code learns the capture was genuine and can probe replays without approaching the lockout. Bounded by the per-IP pre-auth limit.
- **Remediation:** Throw the invalid-code error from inside the verifier callback, so a replay is charged exactly like a wrong code.

## 6 · Low · The backup-code acknowledgement field is documented under its old name

- **Location:** `docs/two-factor-flow.md:252,254,256` (`version`); `utils/validation/two-factor.ts:220` ("The handler parses `version` alone").
- **Evidence:** The body field is `setId` (`twoFactorBackupAcknowledgeSchema`, `lib/auth/two-factor-enrolment.ts` acknowledge handler). A client written from the behaviour document sends `version` and receives 422.
- **Remediation:** Rename in both places.

## 7 · Low · `componentRef('User')` names a component the project does not define

- **Location:** `lib/http/openapi.ts:2182`; `COMPONENT_SCHEMAS` at `:1488-1495`; comment at `:1497`.
- **Evidence:** `COMPONENT_SCHEMAS` is `Record<string, JsonSchema>`, so `keyof` is `string` and the comment "The name is checked at build time" is not true for any call. `#/components/schemas/User` resolves only because Better Auth's generated document happens to define `User`; a library rename breaks both verifier responses silently until the `$ref` test runs.
- **Remediation:** Type the registry keys as a literal union (`satisfies Record<...>` or `as const`), and reference the library component explicitly from `BETTER_AUTH_OPENAPI.components.schemas`.

## 8 · Low · New Drizzle metadata fails the formatting gate

- **Location:** `db/drizzle/meta/_journal.json` (no trailing newline, see `git diff`); `db/drizzle/meta/0019_snapshot.json`.
- **Evidence:** `bunx prettier --check db/drizzle/meta/_journal.json db/drizzle/meta/0019_snapshot.json` reports both; the earlier snapshots pass. `lefthook.yml:54` runs `prettier --check .` in the pre-push `verify` group, so the push is refused as committed.
- **Remediation:** `bunx prettier --write` the two files, or add `db/drizzle/meta` to `.prettierignore` as a decision.

## 9 · Low · The rollout preflight now carries the runtime's module-load side effects

- **Location:** `scripts/check-two-factor-rollout.ts:25-28`.
- **Evidence:** Importing `utils/validation/otp` and `utils/validation/two-factor` reads the current `NEXT_PUBLIC_ENABLED_2FA_*` variables at import. Run with only `DATABASE_URL` set, the script printed `otp.disabled no channel configured` and `twoFactor.disabled no method configured` before doing anything, and a malformed current value throws before the proposal is examined. The script's purpose is to judge a proposed configuration, and the runbook describes it as needing only the database URL.
- **Remediation:** Move `parseEnumList` and the two allow-lists into a module with no load-time environment reads, or document that the preflight must run under the current runtime environment.

## 10 · Low · The trigram-floor tier test is calibrated on one C library and unverified on the CI image

- **Location:** `tests/integration/trigram-floor.test.ts`; `lib/data-table/parsers.ts` (`WORD_CHARACTER`, `BMP_MAX`); `.github/workflows/ci.yml` (`postgres:18-alpine`).
- **Evidence:** The strict assertion runs for every case, including `ⅣⅣⅣ`, `〇〇〇`, `١٢٣` and `東京都`, against the server's `iswalpha`/`iswdigit`. The class was measured on a 16-bit `wchar_t` build (the `BMP_MAX` comment), while CI runs musl. I am not sure musl classifies `Nl` and non-ASCII `Nd` as alpha; if it does not, the tier fails by design on the first CI run. I could not verify this here (no alpine PostgreSQL available).
- **Remediation:** Run the file once against `postgres:18-alpine` before merging, and record the result next to §15 of the runbook as that section itself requires.
