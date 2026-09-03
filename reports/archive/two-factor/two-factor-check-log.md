# Two-factor check log

Baseline: working tree against `HEAD` (`25c7d4f`). 31 tracked files modified, 31 untracked (from `git diff --stat HEAD` and `git ls-files --others --exclude-standard`); the diff of every changed file was read, not the document's description of it. Library claims were checked against the installed `better-auth@1.7.2`, `@better-auth/core@1.7.2`, `@better-auth/passkey@1.7.2`, `@simplewebauthn/server@13.3.3`.

Cross-references between entries are written in words, not ids, so each id below appears once.

---

## fail-closed empty set and the refusal paths — F3, F29, F2 — started and finished

F3 — Problem real (the pre-change branch returned `null`, kept the session and wrote a downgrade row; the passkey suite asserted it). Safety half landed and closes it: `issueTwoFactorChallenge` withdraws the first-factor session through the shared helper and returns `refused`; `/sign-in/email` (after hook) and `/passwordless/verify` both raise 403 `TWO_FACTOR_UNAVAILABLE`; the audit row carries `twoFactorRefused`, `reason: 'two_factor_unavailable'`, `sessionAbandoned: true`, `oldData.loginSuccess: true`; the passkey suite asserts the 403 and that `get-session` on the returned cookies is `null`. Missing from what this finding's Fix asks for, and not named under any later step: the two causes still share one branch. One audit reason and one user message ("no method available, contact support") fire both for possession exclusion (a passwordless user whose only method is OTP to the contact they just proved, who has a working password route) and for capability loss. The passwordless routing message is step 6; the per-cause audit reason is in nobody's step, and it is what the preflight and any alerting depend on.

F29 — Problem real: `handleAdminEdit` forces the changed contact's verified flag `false`, `offeredMethods` reads that flag, `markContactVerified` (passwordless verify) flips it back for any unverified contact, and nothing in the edit touches `two_factor_methods`. Property 1 landed through the shared refusal — correct. Property 3 landed: `contactChangeStrandsTwoFactor` runs inside the edit transaction through `tx`, before the UPDATE, once per changed contact kind, and refuses 409 with a message naming the reset; tests cover the refusal with no write and the allowed case when TOTP survives (phone variant only; the email variant is the same code path but untested). Properties 2a and 2b not implemented (steps 2 and 5), expected; approach sound. Note for the post-step-0 paragraph: with property 3 in place the "denial of service until an operator resets" outcome is no longer reachable through the admin edit for a last-factor victim; the chain that remains is exactly 2a's — a victim who also holds TOTP, phone repointed, attacker verifies the new number through `/api/auth/passwordless/send` plus `/passwordless/verify`, and the stale `otp` row is offered beside TOTP at the attacker's number.

F2 — Problem real in both modes. Mode A: the predicate returns `false` when TOTP survives exclusion, no proof of TOTP is taken, and a later password sign-in offers email OTP (a password first factor passes no exclusion). Mode B: the landed predicate short-circuits on `state.intent.length === 0`, not on the unexcluded offered set being empty, so intent rows whose capability is gone (last passkey deleted, TOTP credential cleared by the plugin's disable) still refuse recovery permanently. Liveness half landed and correct: `readEnrollment` takes an executor and both in-transaction callers pass `tx`. Everything else not implemented (step 4); the recovery-grant approach is sound. The interim comment in the reset handler ("checked inside the proof transaction so the decision and the write cannot separate") is now largely true — `processOtpVerify` locks the user row FOR UPDATE before the read — except against writers that do not lock the user row (`/two-factor/methods/disable`, the TOTP after hook, backup-code acknowledgement).

## device trust and the plugin verifier body policy — F5, F17, F23, F28 — started and finished

F5 — correct.

F17 — correct.

F23 — Not implemented (step 6). Problem real: the loop deletes nothing (`grantDeviceTrust` writes only `trusted_devices`; the plugin's own trust path is forced off), and `WHERE value = userId` leaves the `2fa-attempts-*` companions behind (the `2fa-proven-*` markers too, harmlessly — they carry a session id and die with the session). Conflict inside the document: this finding still lists "does not delete `passkeys`" as a gap, while the rotation decision says methods are never reset on a rotation. The passkey clause should be struck before step 6 adds it.

F28 — Fix correct (`desc(lastUsedAt)`; sequential `uniquePhone`). Conflict with the Step 1 test table: it says ordering "is asserted through the settings-list shape"; no test asserts order — the only list assertion is a length of one.

## attempt budget and the passkey ceremony — F12, F13, F22 — started and finished

F12 — Landed protocol matches the library's `beginAttempt` (consume, no write-back, caller invokes one of `recordFailure` / `restore`); the digits-only parse closes the empty-value hole; the verify quota now runs before the spend; the seven stub cases are present and pass. Conflict with the protocol as documented on the function itself ("anything that produced no verdict restores"): `verifyForSignIn` calls `recordFailure()` for every throw out of `processOtpVerify`, including no-verdict exits — no proof row (404), no live code (400), proof-row block (429), a database fault — and never calls `restore()`. Fails toward exhausting the challenge, so not a bypass; a user who submits before pressing send spends one of five attempts on a non-guess.

F13 — correct.

F22 — correct.

## enrol-versus-sign-in discriminator and target scope — N3, F30, F15 — started and finished

N3 — Correct for the two OTP endpoints (`send` now resolves the challenge; the stale-cookie test constructs the window and passes). Conflict: a third site with the same shape is in no dual-mode inventory anywhere in the document. The TOTP after hook in `lib/auth/two-factor.ts` branches on `readChallengeCookie` (cookie present and signed) while the library's `verifyTwoFactor` branches session-first. A live session plus a stale challenge cookie is an enrolment confirmation to the library and a sign-in to the hook, so the intent row is not written and other sessions are not revoked. Two constructions inside the same ten-minute window the stale-cookie test builds: a shared browser where another user's abandoned challenge cookie is present at a first enrolment leaves the enrolling user 2FA-on with an empty offered set and refused at the next login; a trusted-device skip (no new challenge, old cookie intact) followed by adding TOTP leaves a verified secret that is never offered.

F30 — correct.

F15 — Not implemented (step 6). Problem real: `LIVE_SESSION_PATHS` omits the four dual-mode paths; `sessionUser` checks neither `is_active` nor `deleted_at`; `enrolmentTarget` filters `deleted_at` only. Approach fine, with one constraint: the discriminator must be "a real session resolved" (the library's order), not "no challenge cookie" — see the after-hook note above.

## challenge binding and the routing surface — F1, F16, F18, F21, N5 — started and finished

F1 — Not implemented (step 3). Problem real: the challenge row holds the user id only; `resolveTwoFactorChallenge` recomputes `offeredMethods(state)` with no exclusion; the plugin's TOTP and backup-code verifiers read only their credential row; no before-hook check exists (`TRUST_DEVICE_STRIPPED_PATHS` only rewrites two fields). Companion-record approach sound. Carry one constraint into step 3: the before hook's sign-in-mode test must be "no session resolves", matching `verifyTwoFactor`, not "challenge cookie present".

F16 — Not implemented (step 3). Problem real: `completeTwoFactorChallenge` calls `createSession(challenge.user.id)` with no second argument; `withdrawFirstFactorSession` passes `skipDontRememberMe = true`; the dispatcher merges the before hook's returned body with `defuReplaceArrays`, so a client `rememberMe` does reach the handler. Approach fine.

F18 — Not implemented (step 3). Problem real: `readEnrollment` has no ORDER BY, no priority, no default. Approach fine.

F21 — Not implemented (step 3). Problem real. Partial movement in this tree: `SESSION_METHOD_BY_PATH` now labels the two plugin verify paths; custom OTP and passkey completions still log `unknown`; a TOTP or backup completion after a passwordless first factor is still labelled `password+…`; the enrolment-mode TOTP session rotation is logged as a login. The comment above `session.create.after` in `lib/auth.ts` ("the only session-creating paths this deployment serves are `/sign-in/email` and `/passwordless/verify`") is now false.

N5 — Not implemented (step 3). Problem real: `ux_two_factor_methods_user_method (user_id, method)` in schema and migration 0006; `recordMethodIntent`'s `onConflictDoUpdate` target moves with it.

## recovery grant and the possession policy — F11, N1, N4 — started and finished

F11 — Not implemented (step 4). Problem real: `enforceOtpVerifyQuota` keys `two_factor` on the shared `otp.verify.dest.{kind}`; `/api/auth/otp/verify` is public. Approach fine.

N1 — Not implemented (step 4). Problem real: enrolment-mode `/two-factor/otp/verify` needs a session only. The recorded fix ("add the enrolment paths to `PASSWORD_PROOF_PATHS`") is wrong as stated: that set is path-keyed and unconditional in `enforceTwoFactorPathPolicy`, and the same path serves sign-in with no session and no password, so listing it would 401 every OTP sign-in verification. Needs the mode discriminator or a split endpoint.

N4 — Nothing to check: the only refusal is the startup gate in `utils/validation/two-factor.ts`; no enrolment-time comparison exists. Replacing it with a warning on actual overlap is step 4; fine.

## owned enrolment lifecycle — F4, F6, F7, F8, F9, F10, N2 — started and finished

F4 — Not implemented (step 5). Problem real: no writer of `method: 'passkey'`; both registration paths are in `LIVE_SESSION_PATHS` but not `PASSWORD_PROOF_PATHS`; `freshAge` is ten hours; the passkey suite still seeds intent and flag by SQL (`givePasskey`), which is expected until the owned enable routine exists. Conflict inside the document: this finding's Fix still says "Add `passkeys` to `revokeTwoFactorState`", which the rotation decision forbids.

F6 — Not implemented (step 5). Problem real: `/two-factor/methods/disable` deletes the intent row only, reads the enrolled list outside the transaction, and has no password proof.

F7 — Not implemented (step 5). Problem real: the plugin's `/two-factor/disable` is allow-listed and touches only the flag, the credential row, the caller's session and the plugin's trust cookie; `resolveTwoFactorChallenge` never checks `state.enabled`.

F8 — Not implemented (step 2). Problem real against the library source (`OTP_NOT_CONFIGURED` / `TOTP_NOT_CONFIGURED` throws in `enableTwoFactor`); `/two-factor/backup-codes/acknowledge` is served whenever any method is on; TOTP enable returns codes regardless of `backup_code`. The test tier enables all four methods, so no current suite exercises a failing configuration (step 8).

F9 — Not implemented (step 2). Problem real against the library source: repeat enable rewrites `secret` and `backupCodes` keeping `verified`; `generateBackupCodes` updates codes only; `backupCodesAcknowledgedAt` is never cleared; `backupCodesReady` never counts unused codes.

F10 — Not implemented (step 5). Problem real: both callers still pass `newestSessionId`.

N2 — Not implemented (step 5). Problem real: the hook still throws after the plugin committed; the comment claiming otherwise is still there.

## hardening, admin re-auth class, preflight, contract, audit — F14, F24, F25, F26, F31, N6 — started and finished

F14 — Not implemented (step 6). Problem real: no `verifyLoginAttempt` in the reset handler.

F24 — Not implemented (step 6). Problem real for `trusted_devices` only: schema and migration 0005 create `idx_trusted_devices_user (user_id, expires_at)`; `sweepTrustedDevices` filters `expires_at` alone; the `db/maintenance.ts` comment now claims a leading `expires_at` index for both new tables.

F25 — Not implemented (step 6). Problem real: `scripts/` has no preflight. The text still names `twoFactorDowngraded`; the signal is now `twoFactorRefused`.

F26 — Not implemented (step 6). Problem real: no test references `hooks`, `getPlugin` or the destructured `_pluginSignInHook`.

F31 — Not implemented (step 6). Problem real.

N6 — Not implemented (step 6). Problem real: `package.json` carries `"@better-auth/core": "^1.7.2"` under `dependencies`; `better-auth@1.7.2` pins `1.7.2` exactly.

## templating, contracts, comments, transport — F19, F20, F27 — started and finished

F19 — Not implemented (step 7). Problem real: one fixed subject and body per channel in `utils/otp.ts`.

F20 — Not implemented (step 7). Problem real: `BETTER_AUTH_BODIES` has two entries, `BETTER_AUTH_LOCAL_THROTTLE_PATHS` one; the custom endpoints declare `z.record`.

F27 — Not implemented (step 7). Problem real: `// ====` lines 28 → 38 in `db/schema.ts`; the maintenance-index claim and the TOTP after-hook catch claim still stand; "keep `backup_code` enabled in every deployment" is still in `utils/validation/two-factor.ts` (and repeated in `.env`). Two inventory entries need re-scoping: the reset-handler atomicity comment is now largely true after the transaction threading, and the passkey "stored rather than compared" comment was replaced in step 1. New since step 1: `tests/helpers/session.ts` carries two consecutive JSDoc blocks on `nextPhoneSuffix`.

## decisions — D1 to D16 — started and finished

D1 — Policy only; nothing lands against it before step 4. Consistent with what exists: `recoveryDefeatsTwoFactor` already compares by contact kind.

D2 — Safety half landed (the refusal group above). Liveness pending steps 2 and 6.

D3 — Not landed (step 2).

D4 — Not landed (step 4). Approach sound.

D5 — Not landed (step 2).

D6 — Not landed (step 5).

D7 — Not landed (step 3). One constraint to add: the sign-in-mode check must use session resolution, not the challenge cookie, as its discriminator (the after-hook note above).

D8 — Not landed (step 3).

D9 — Not landed (step 3).

D10 — Not landed (step 3). Its first item (add `rememberMe` to `loginSchema` so it is validated and documented) appears in no finding's Fix; make sure step 3 carries it.

D11 — Not landed (step 5). Current code contradicts it in two places, both expected until then: a voluntary password change still revokes trusted devices through `revokePendingProofs` → `revokeTwoFactorState`; method removal requires no password and revokes no trust.

D12 — Not landed (step 6).

D13 — The passwordless refusal itself landed in step 0 through the shared `refused` outcome; the routing to the password route (its own code or message) has not — the user is told to contact support.

D14 — Not landed (step 6). Passwordless is gated by `OTP_ENABLED` only.

D15 — Not landed (step 7).

D16 — Mixed. Landed in this tree: the known-path set for the OpenAPI guard (`BETTER_AUTH_KNOWN_PATHS`, plus the served-set coverage check), the `beginAttempt` copy, UV at registration plus the own assertion gate, the counter compare-and-swap, `desc` on the device list, the deterministic phone. Partial: the known set is path-keyed, not method-keyed, so `GET /two-factor/enable` in `BETTER_AUTH_SUMMARIES` would still pass the leftover check; the verification report asked for method-aware keys. Not landed and assigned to no step in the order table: `two_factor_credentials.verified` default → `false` (schema and migration 0005 still `default true`), narrowing `SERVER_ONLY_VIRTUAL_PATH` to a named set, and the pepper-CAS repair. The core pin is step 6; the real-endpoint matrix is step 8.

---

## Outside the document

1. The 2FA OTP channel list (`NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS`) is enforced only at enrolment (`twoFactorOtpEnrollSchema`). `offeredMethods` checks the method list, not the channel list, and `processOtpSend` has no channel gate, so an `otp/email` intent row keeps being offered and delivered after an operator removes `email` from the 2FA channel list — the "server-enabled" term of the intersection is method-granular where the configuration is channel-granular. The management suite's recovery-refusal case enrols `otp/email` by SQL under an `sms`-only 2FA channel configuration and passes only because of this. Same class as the method-list preflight; not tracked.

2. `MSG_CONTACT_CHANGE_STRANDS_TWO_FACTOR` lives in `utils/api-messages.ts`; every other 2FA message lives in `twoFactorMsg` (`app/api/auth/otp/messages.ts`). Two homes for one message family.

## Suites run

- `bun tests/helpers/run.ts unit` → 875 pass, 0 fail (25 files, 296 s).
- `bun tests/helpers/run.ts integration` → 332 pass, 0 fail (27 files, 89 s).
- `bun tests/helpers/run.ts process` → 50 pass, 2 skip, 0 fail (7 files, 98 s).

Matches the Step 1 tally in the tracking document. No temporary test code was added or retained.

---

Review complete: every group above was started and finished; no id is pending.
