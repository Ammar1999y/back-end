# Two-factor implementation — review findings

Scope: the working-tree change against `HEAD` (`25c7d4f`). Verified with
`bun run lint` (clean), `bun run test` (868 pass), `bun run test:integration`
(324 pass), `bun run test:process` (50 pass, 2 skip), plus reads of
`better-auth@1.7.2` and `@better-auth/passkey@1.7.2` sources in `node_modules`.

Findings 15-20 and section 23 incorporate a second review; section 24 records the
items from it that did not hold against the code.

---

## 1 — CRITICAL — Passkey-as-a-second-factor is unreachable: nothing ever enrols it

`offeredMethods` requires an `intent` row in `two_factor_methods`, and
`issueTwoFactorChallenge` returns `null` unless `users.two_factor_enabled` is
true ([two-factor-challenge.ts:202](lib/auth/two-factor-challenge.ts#L202)).
`recordMethodIntent` has exactly three call sites — TOTP
([two-factor.ts:126](lib/auth/two-factor.ts#L126)), OTP
([two-factor-otp.ts:351](lib/auth/two-factor-otp.ts#L351)) and backup codes
([two-factor-otp.ts:499](lib/auth/two-factor-otp.ts#L499)). **There is no hook
on `/passkey/verify-registration` and no writer of `method: 'passkey'`
anywhere**, and passkey registration never sets `two_factor_enabled` either.

Consequences, in a deployment configured `NEXT_PUBLIC_ENABLED_2FA_METHODS=passkey`:

- registering a passkey produces a `passkeys` row and nothing else;
- `two_factor_enabled` stays `false`, so `/sign-in/email` issues a session with
  no challenge;
- `/two-factor/passkey/options` and `/two-factor/passkey/verify` are dead code —
  `requireChallenge` can never be satisfied.

The whole `passkey` branch of `twoFactorEndpoints()` is registered, documented in
the OpenAPI contract and permanently inert. This is the single feature the
original prompt asked for, and it does not function.

`tests/integration/two-factor-passkey.test.ts` masks this: `givePasskey()`
inserts the `two_factor_methods` row and flips `two_factor_enabled` **by direct
SQL** because no endpoint does. Every assertion in that file is about refusal
paths, so the enrolment gap produces no failure.

**Fix:** add an `after` hook on `/passkey/verify-registration` that, on success,
writes `recordMethodIntent(tx, { userId, method: 'passkey' })` and sets
`twoFactorEnabled: true` — mirroring the TOTP hook, including its
`revokeOtherSessions` step (B.5 lists passkey as a confirmation point and it was
not implemented). The test must then drive registration through the endpoint, or
at minimum assert that a row appears after it.

---

## 2 — CRITICAL — `/two-factor/trust-device` mints a 30-day 2FA bypass for any session, with no second factor proven

[trusted-device.ts:218-236](lib/auth/trusted-device.ts#L218-L236) is gated by
`sessionMiddleware` and `assertLiveSession` and nothing else. It does not check
`users.two_factor_enabled`, does not check that a challenge was just completed,
and does not consult any per-session "2FA was proven" marker. The doc comment on
`grantDeviceTrust` claimed it is "called only after a second factor has actually
been proven" — that claim is false; the endpoint is directly callable.

`consumeDeviceTrust` is the first thing `issueTwoFactorChallenge` consults
([two-factor-challenge.ts:206](lib/auth/two-factor-challenge.ts#L206)), and it
returns before any method is offered. So a trust cookie is a complete,
30-day-renewable skip of the second factor.

Two reachable attacks:

1. **Pre-enrolment planting.** An attacker holding a stolen session on an account
   with no 2FA calls `/two-factor/trust-device`. Nothing in the enrolment paths
   revokes trusted devices — `verifyForEnrolment`
   ([two-factor-otp.ts:368-372](lib/auth/two-factor-otp.ts#L368-L372)) and the
   TOTP hook both call only `revokeOtherSessions`. The victim later enables 2FA,
   their sessions are revoked, and the attacker's _trust cookie survives_. From
   then on, the attacker's password knowledge alone completes a login that 2FA
   was supposed to gate.
2. **Self-service escalation.** Any session can grant itself trust without ever
   completing a challenge, so a session obtained through any means that skips 2FA
   (the empty-offer downgrade in findings 10 and 11) can
   convert itself into a permanent skip.

The project's own test asserts attack 1's precondition as expected behaviour:
`tests/integration/two-factor-trusted-device.test.ts` seeds a plain user with no
2FA, signs in with email+password, calls `/two-factor/trust-device`, and expects a
`trusted_devices` row.

**Fix:** trust must be bound to a proven second factor. Either return a one-shot
grant token from `completeTwoFactorChallenge` (and from the plugin's verify paths
via the existing `after` hook) that `/two-factor/trust-device` consumes, or
record the "2FA proven" fact on the session row and require it here. In addition,
`revokeTwoFactorState` — or a narrower call — must run when 2FA is _enabled_, not
only when a credential rotates.

---

## 3 — HIGH — The passwordless possession rule (B.1) is enforced only at issuance; the OTP endpoints ignore it

`issueTwoFactorChallenge` computes the offered set with `excludeContactKind`
([two-factor-challenge.ts:208](lib/auth/two-factor-challenge.ts#L208)), but the
exclusion is **never persisted** — the challenge row holds only the user id.
`resolveTwoFactorChallenge` then recomputes with no exclusion
([two-factor-challenge.ts:368](lib/auth/two-factor-challenge.ts#L368)) and
derives `otpTarget` from that unfiltered set
([:378](lib/auth/two-factor-challenge.ts#L378)).

Walk it through with a user enrolled in `totp` + `otp(email)` who signs in via
`/passwordless/verify` with an emailed code:

1. issuance excludes email OTP; the response advertises `["totp"]`;
2. the client calls `/two-factor/otp/send` — `signInTarget`
   ([two-factor-otp.ts:226-237](lib/auth/two-factor-otp.ts#L226-L237)) resolves an
   `otpTarget` on **email**, because the exclusion is gone;
3. a second email code is sent and `/two-factor/otp/verify` accepts it,
   completing the login.

Both factors are then satisfied by one mailbox. The rule the plan calls the
closure of F1 is enforced on the advertised list only, which is a UI hint, not a
control. Same hole applies to `/two-factor/passkey/*`, though harmlessly there.

**Fix:** persist the excluded contact kind with the challenge (store JSON in the
verification `value`, or a companion row) and apply it in
`resolveTwoFactorChallenge`. Everything downstream reads `challenge.methods` and
`challenge.otpTarget`, so one change covers all three verify endpoints.

---

## 4 — HIGH — `newestSessionId` can revoke the victim's session and keep the attacker's

`revokeOtherSessions(tx, userId, await newestSessionId(tx, userId))` is used at
both enrolment sites ([two-factor.ts:130-134](lib/auth/two-factor.ts#L130-L134),
[two-factor-otp.ts:370](lib/auth/two-factor-otp.ts#L370)). `newestSessionId`
picks `ORDER BY created_at DESC LIMIT 1` — "whichever session was created last",
not "the caller's".

That is only equivalent to the caller's session when the endpoint rotated it
moments earlier. It does **not** rotate on either of these paths in general:

- `/two-factor/otp/verify` in enrolment mode is entirely ours and never rotates.
  `sessionUser(ctx)` ([two-factor-otp.ts:108](lib/auth/two-factor-otp.ts#L108))
  reads the real session and then discards everything but the user id.
- `/two-factor/verify-totp` rotates only inside
  `if (twoFactor.verified !== true) { if (!user.twoFactorEnabled) { … } }`
  (`node_modules/better-auth/dist/plugins/two-factor/totp/index.mjs`). A user who
  already enabled OTP 2FA and then adds TOTP has `twoFactorEnabled === true`, so
  no rotation happens and `newestSessionId` is again unrelated to the caller.

Failure: attacker signs in at T2 after the victim at T1; victim enrols a second
factor at T3; the revocation keeps T2 (newest) and kills T1. **The user is logged
out and the attacker stays in** — the precise inversion of what B.5 exists to
prevent.

**Fix:** pass the caller's own session id. `sessionUser` already has it from
`findSession`; return it. For the plugin's TOTP path, read the session id from
the response's `Set-Cookie` token, or drop `newestSessionId` and revoke _all_
sessions on confirmed enable (the user is re-prompted once, which is the safe
failure direction).

---

## 5 — HIGH — `/two-factor/methods/disable` does not disable anything for TOTP or backup codes

The endpoint deletes the `two_factor_methods` intent row
([two-factor-otp.ts:434-472](lib/auth/two-factor-otp.ts#L434-L472)) and nothing
else. But the plugin's `/two-factor/verify-totp` and
`/two-factor/verify-backup-code` never read that table — they check only the
`two_factor_credentials` row (`verified !== false` for TOTP; row exists for
backup codes). Both remain allow-listed as long as the method is server-enabled.

So a user who removes `totp` — the natural action when they believe their
authenticator is compromised — can still complete every future challenge with a
TOTP code. `offeredMethods` stops advertising it; nothing stops accepting it.

The same asymmetry makes the backup-code acknowledgement gate cosmetic: an
un-acknowledged set is not offered but is fully accepted at
`/two-factor/verify-backup-code`.

Related, and part of the same class: `/two-factor/methods/disable` is not in
`PASSWORD_PROOF_PATHS` ([lib/auth.ts:216](lib/auth.ts#L216)), so **removing a
second factor needs only a session, while adding one needs a password**. Every
other security-control change in this codebase re-authenticates.

**Fix:** enforce intent in the `before` hook — for `/two-factor/verify-totp` and
`/two-factor/verify-backup-code`, resolve the challenge and reject when the
method is not in `offeredMethods`. Removing TOTP should additionally clear
`two_factor_credentials.secret`/`verified`. Add `/two-factor/methods/disable` to
`PASSWORD_PROOF_PATHS`.

---

## 6 — HIGH — `backup_code` cannot be enabled at all unless `totp` is also enabled

`/two-factor/enable` is the only creator of a `two_factor_credentials` row, and
in `better-auth@1.7.2` it refuses both branches under this configuration:

```js
if (method === "otp"  && !options?.otpOptions?.sendOTP) throw … OTP_NOT_CONFIGURED;
if (method === "totp" &&  options?.totpOptions?.disable) throw … TOTP_NOT_CONFIGURED;
```

`otpOptions` is deliberately unset ([two-factor.ts:71](lib/auth/two-factor.ts#L71))
and `totpOptions.disable` is `!isTwoFactorMethodEnabled('totp')`
([:69](lib/auth/two-factor.ts#L69)). With `totp` off, **every call to
`/two-factor/enable` returns 400**, so no row ever exists, so
`/two-factor/generate-backup-codes` throws `TWO_FACTOR_NOT_ENABLED` (it requires
both `twoFactorEnabled` and an existing row), and
`/two-factor/backup-codes/acknowledge` 404s on its `UPDATE … RETURNING`.

This directly contradicts the design: `utils/validation/two-factor.ts` documents
`backup_code` as separately deployable and the plan makes it the load-bearing
recovery path ("`backup_code` should be enabled server-side in every
deployment"). In `otp,backup_code` or `passkey,backup_code` deployments the
safety net is unreachable, which turns finding 10 into an unrecoverable lockout.

Also note `/two-factor/enable` and `/two-factor/disable` are allow-listed
whenever 2FA is on at all ([allowed-paths.ts](lib/auth/allowed-paths.ts)), so
with `totp` off the contract advertises an endpoint that can only 400.

**Fix:** own backup-code generation rather than delegating it — write the
`two_factor_credentials` row directly (the encryption helpers are importable from
`better-auth/crypto`), or gate `/two-factor/enable` on `totp` and provide a
separate enable path for the non-TOTP methods.

---

## 7 — HIGH — 2FA OTP verification shares its rate-limit key with the anonymous contact-verify surface

`enforceOtpVerifyQuota` ([rate-limit/api.ts:225-235](lib/rate-limit/api.ts#L225-L235))
gives `recovery` its own scope and lumps everything else into
`otp.verify.dest.<kind>` — 10 attempts per 600 s, keyed by destination. `two_factor`
was added to `OtpSendSurface` but not given its own key.

The comment directly above that function documents the exact attack, for
recovery:

> an attacker who knows an address POSTs `/api/auth/otp/verify` ten times with a
> junk code, the 10/600 s budget is spent, and for the rest of the window the
> victim's … reset throws 429 BEFORE the account lookup

That is now reintroduced against the second factor. `/api/auth/otp/verify` is
`auth: 'public'` ([routes.ts:168-172](routes.ts#L168-L172)) and takes an
attacker-supplied `email`/`phoneNumber`. Ten junk verifies burn the shared key,
and for the next ten minutes the victim's `/two-factor/otp/verify` returns 429
**before the code is examined** — they cannot finish signing in. Sustained at one
request per minute per victim, and 2FA denial is strictly worse than recovery
denial: it blocks ordinary login, not just password reset.

**Fix:** give `two_factor` its own scope key, exactly as `recovery` has:

```ts
scope:
  opts.surface === 'recovery' ? `otp.verify.dest.recovery.${kind}`
  : opts.surface === 'two_factor' ? `otp.verify.dest.two_factor.${kind}`
  : `otp.verify.dest.${kind}`,
```

Secondary, lower priority: `enforceOtpGlobalSendBudget` (2000/day/contact-kind)
is shared across every surface, so an app-wide send flood also denies second
factors at sign-in. A small reserved slice for `two_factor` would bound that.

---

## 8 — HIGH — `spendChallengeAttempt` re-arms the counter _before_ verification, so concurrent guesses cost one attempt

[two-factor-challenge.ts:409-422](lib/auth/two-factor-challenge.ts#L409-L422)
consumes the `2fa-attempts-<id>` row, immediately writes it back at the **same**
count, and only then returns to the caller to verify:

```ts
await rearm(used);
return { ok: true, recordFailure: () => rearm(used + 1) };
```

The plugin's own `beginAttempt` deliberately does not do this
(`node_modules/better-auth/dist/plugins/two-factor/verify-two-factor.mjs`): it
consumes and leaves **no row** until `recordFailure()` or `restore()` runs, so a
second request arriving mid-verification finds nothing and is rejected.

Two independent defects follow from the eager re-arm:

1. **Parallel-guess window.** `consumeVerificationValue` serialises on a lock, so
   N concurrent requests each consume the row, each read the same `used`, each
   re-arm at `used`, and each pass the budget check. They then all write
   `used + 1`. N wrong answers cost one attempt. The 5-per-challenge budget —
   documented as the authority shared across every method — is not enforced under
   concurrency.
2. **Lost increments without concurrency.** After `rearm(used)` and
   `rearm(used + 1)` two rows exist for the identifier.
   `consumeVerificationValue` picks `ORDER BY createdAt DESC LIMIT 1`, and
   `verifications.created_at` is `timestamp(2)` — centisecond precision. Two
   inserts inside one centisecond leave the winner undefined, so the `used` row
   can be returned and the failure silently discarded.

Practical blast radius today is bounded by the _other_ counters:
`/two-factor/otp/verify` is still held by `verification_sessions`'
`verifyAttemptNumber` / `verifyAttemptDaily`, which are transactional under a row
lock, and `/two-factor/passkey/verify` is not brute-forceable. TOTP and
backup-code verification use the plugin's `beginAttempt`, not this function, so
they are unaffected. It is still a defect: the challenge budget is the documented
cross-method authority and it does not hold.

**Fix:** match the plugin — do not re-arm before the outcome is known. Return
`recordFailure` and a `restore` and have every caller invoke exactly one of them,
or write the increment first and decrement on success.

---

## 9 — MEDIUM — Backup-code acknowledgement survives regeneration, so `backup_code` is offered for codes the user has never seen

`backupCodesAcknowledgedAt` is set once
([two-factor-otp.ts:495](lib/auth/two-factor-otp.ts#L495)) and never cleared.
`capability.backupCodesReady` is `acknowledgedAt != null`
([two-factor-challenge.ts:96](lib/auth/two-factor-challenge.ts#L96)).

Two writers replace the code set without touching that timestamp:

- `/two-factor/generate-backup-codes` — `update: { backupCodes: … }` only;
- `/two-factor/enable` called a second time — it overwrites **both** `secret` and
  `backupCodes` on the existing row, keeping `verified: true`. So a repeat enable
  silently rotates the user's TOTP secret _and_ invalidates every backup code
  they hold, while `backup_code` stays "acknowledged" and offered.

The plan states regeneration "requires its own acknowledgement". It does not.

Separately, `backupCodesReady` never checks whether any **unused** codes remain.
Once all ten are spent, `backup_code` is still offered and can never be
completed — the plan's own wording ("the user has unused codes") is not
implemented.

A third consequence of the same disconnect: **nothing requires a user to keep
their backup codes.** `/two-factor/enable` always generates and stores a set and
returns it in the response, but acknowledgement is a separate call that enrolment
never forces. A user who enables TOTP, ignores the codes, and later loses their
authenticator has `offeredMethods = ['totp']` — the one thing they cannot do.
`recoveryDefeatsTwoFactor` returns `false` (TOTP is offerable and not
contact-bound), so password recovery _succeeds_ and still leaves them unable to
log in. The only exit is the admin reset. Now that recovery no longer clears the
second factor, acknowledgement should be a required step of enrolment rather than
an optional follow-up.

**Fix:** clear `backupCodesAcknowledgedAt` in the same `before`/`after` hook that
handles `/two-factor/generate-backup-codes` and `/two-factor/enable`. Decode the
stored set to count remaining codes for the capability term, or store a counter
alongside the acknowledgement. Gate the completion of a first enrolment on the
acknowledgement call.

---

## 10 — MEDIUM — Recovery is permanently refused for users whose second factor is already inert

`recoveryDefeatsTwoFactor` ([two-factor-challenge.ts:491-501](lib/auth/two-factor-challenge.ts#L491-L501))
returns `true` whenever `enabled && intent.length > 0 && offeredMethods(state, kind).length === 0`.
It does not distinguish "every method is on the recovery contact" from "no method
is completable at all".

So for a user whose intent rows survive but whose capability is gone — deleted
their last passkey, an operator removed their only method from
`NEXT_PUBLIC_ENABLED_2FA_METHODS`, or `two_factor_credentials` was dropped by
`/two-factor/disable` while intent rows remained (that endpoint clears the
credentials row and the flag but leaves `two_factor_methods` untouched):

- **sign-in** takes the downgrade branch, writes `twoFactorDowngraded` and issues
  a session with no second factor;
- **password recovery** is refused, permanently, with a message telling them to
  "use another verification method" that does not exist.

The account is simultaneously unprotected and unrecoverable. Only the admin reset
in `app/api/dash/users/[id]/two-factor/handler.ts` gets them out.

**Fix:** return `false` when the offered set is empty _without_ the exclusion
applied — i.e. refuse only when the user genuinely has a completable factor and
all of them reach the recovery contact:

```ts
if (offeredMethods(state).length === 0) return false; // nothing to defend
return offeredMethods(state, contactKind).length === 0; // all on this contact
```

---

## 11 — MEDIUM — The B.1 empty-offer case is more permissive than recovery, inverting the plan's own risk ordering

When a passwordless-by-email sign-in leaves the offered set empty (user's only
factor is OTP-to-email), `issueTwoFactorChallenge` returns `null` and the
**session is issued** ([two-factor-challenge.ts:210-223](lib/auth/two-factor-challenge.ts#L210-L223)).
For the identical user and identical possession, `/api/auth/forgot-password/reset`
**refuses**.

The plan itself states the ranking: passwordless "is the sharper of the two …
whereas passwordless mints a session outright". The weaker treatment was applied
to the sharper path. One mailbox therefore yields a full session, which is more
than the reset it is being protected from.

Secondary: this path writes a `twoFactorDowngraded` audit event with
`reason: 'no offered method remained after intersection'` on **every routine
passwordless login** by such a user. That conflates an operator-caused
configuration downgrade with normal traffic, so the event cannot be alerted on.

**Fix:** treat the empty-offer case on `/passwordless/verify` the same way
recovery treats it — refuse the login and tell the user to sign in with their
password. If that is judged too strict, at minimum distinguish the two reasons in
the audit event so the configuration case is still detectable.

---

## 12 — MEDIUM — Two `/two-factor/*` paths escape the `assertLiveSession` sweep this change added

`LIVE_SESSION_PATHS` ([lib/auth.ts:232](lib/auth.ts#L232)) lists every 2FA and
passkey path **except `/two-factor/otp/send` and `/two-factor/otp/verify`**. Those
two authenticate through their own `sessionUser()`
([two-factor-otp.ts:108-116](lib/auth/two-factor-otp.ts#L108-L116)), which reads
the database (so the cookie-cache half of F3 is closed) but checks neither
`users.is_active` nor `users.deleted_at`.

`enrolmentTarget` filters `isNull(users.deletedAt)` but not `isActive`
([two-factor-otp.ts:86](lib/auth/two-factor-otp.ts#L86)), so a **suspended** user
holding a live session row can enrol an OTP second factor and set
`two_factor_enabled = true`. Every other 2FA management path in this change
refuses them.

This is the F3 class the work claims to have closed, missed on the endpoints the
same change introduced.

The same gap covers `/two-factor/verify-totp` and `/two-factor/verify-backup-code`
in their **authenticated** mode. Both are dual-purpose: with a challenge cookie
they complete a sign-in, with a session they complete an enrolment. Neither is in
`LIVE_SESSION_PATHS`, and in enrolment mode `verifyTwoFactor` resolves the caller
through `getSessionFromCtx` — the cookie cache, with no `is_active` /
`deleted_at` check. So a suspended user can complete a TOTP enrolment and flip
`two_factor_enabled`.

**Fix:** add `/two-factor/otp/send`, `/two-factor/otp/verify` to
`LIVE_SESSION_PATHS`, or have `sessionUser` call `assertLiveSession`. For the two
dual-purpose plugin paths the check must be conditional — applied only when the
request carries no challenge cookie, since the sign-in mode has no session to
check and `resolveTwoFactorChallenge` already re-applies the predicate.

---

## 13 — MEDIUM — Custom completion drops "do not remember me", so a non-remembered login gets a 28-day session row

`verifyTwoFactor`'s `valid()` reads the `dont_remember` cookie and passes it on:
`createSession(consumed.value, !!dontRememberMe)`.
`completeTwoFactorChallenge` calls
`ctx.context.internalAdapter.createSession(challenge.user.id)`
([two-factor-challenge.ts:436-438](lib/auth/two-factor-challenge.ts#L436-L438))
with no second argument.

`createSession(userId, dontRememberMe)` uses that flag for the row's expiry:
`expiresAt: dontRememberMe ? getDate(3600 * 24) : getDate(sessionExpiration)`.
With `session.expiresIn: 2_419_200` ([lib/auth.ts:452](lib/auth.ts#L452)) the
difference is **1 day versus 28**.

The state does reach us — `issueTwoFactorChallenge` calls
`deleteSessionCookie(ctx, true)`, and that `true` is `skipDontRememberMe`, so the
cookie survives the challenge — and `setSessionCookie` re-reads it, so the
browser cookie is correctly session-scoped. Only the database row is wrong.

`/sign-in/email` accepts `rememberMe` (`sign-in.mjs:265`) and the `before` hook's
returned body is _merged_, not substituted, so a client-supplied
`rememberMe: false` reaches the handler and sets the cookie even though nothing
in this codebase surfaces the option. Result: a token the user asked to be
short-lived stays valid server-side for 28 days, and the behaviour differs
between completion paths — the plugin's TOTP and backup-code endpoints honour it,
ours do not.

**Fix:** read the `dont_remember` cookie in `completeTwoFactorChallenge` and pass
it to `createSession`, as `valid()` does. Better, fold it into the persisted
challenge state proposed in finding 3, so first-factor context travels with the
challenge instead of being re-derived.

---

## 14 — MEDIUM — Passkey registration requires no password, and a registered passkey survives every credential rotation

`/passkey/verify-registration` and `/passkey/generate-register-options` use
`freshSessionMiddleware` (`@better-auth/passkey/dist/index.mjs:88,324`), and this
deployment sets `freshAge: 60 * 60 * 10` — **ten hours**
([lib/auth.ts:454](lib/auth.ts#L454)). Neither path is in `PASSWORD_PROOF_PATHS`.

So adding a persistent credential to an account needs only a session created some
time in the last ten hours, while enabling TOTP — a strictly less durable
credential — needs the password. And `revokeTwoFactorState`
([rotation.ts:34](lib/auth/rotation.ts#L34)) deletes trusted devices and
verification rows but **not** `passkeys`, so a credential planted during that
window outlives the victim's password change; only the admin reset removes it.

The `assertLiveSession` addition does close the related F3 window — a session
revoked by a password change fails the database check rather than being served
from the cookie cache — so this is about the missing step-up, not about
revocation lag.

**Fix:** add both passkey registration paths to `PASSWORD_PROOF_PATHS`, or require
an existing second factor. Given finding 1, decide this before wiring passkey
enrolment up, not after.

---

## 15 — MEDIUM — The admin 2FA reset requires no re-authentication of the admin

`app/api/dash/users/[id]/two-factor/handler.ts` gates on `requirePermission({
resource: 'users', action: 'resetTwoFactor', forceDB: true })` and a rate limit,
and nothing else. There is no password re-authentication of the acting admin.

The two neighbouring properties did land: the target's sessions and pending proofs
are revoked in the same transaction, and the audit row records both the target
(`userId`, `recordId`) and the actor (`resetBy`).

The gap is the asymmetry. `app/api/dash/users/me/change-password/handler.ts` calls
`verifyLoginAttempt({ returnPasswordProof: true })` before the user may change
_their own_ password, and the same re-auth guards their own email and phone
changes. Stripping a **different** user's second factor — the action the plan
describes as "the one grant that removes a security control from someone else's
account" — asks for less. A stolen admin session is exactly the scenario this
endpoint hands the most value to.

**Fix:** run the same `verifyLoginAttempt` re-auth the self-service sensitive
paths use, with `purpose: 'reauth_two_factor'`, before the reset transaction.

---

## 16 — LOW — `disableSession: true` on `/two-factor/verify-backup-code` burns a code and bricks the challenge

The `before` hook forces `trustDevice: false` on the plugin's verify endpoints
but passes `disableSession` through untouched
([lib/auth.ts:252](lib/auth.ts#L252)). In the plugin, a sign-in-mode call with
`disableSession: true` consumes the backup code and rewrites the stored set, then
returns **without** calling `valid()` — so no session is created and the
challenge is not consumed. `beginAttempt` already consumed the
`2fa-attempts-<id>` row and neither `recordFailure` nor `restore` runs, so the
counter is gone and every subsequent verification on that challenge fails.

Reaching it needs the password (a challenge cookie), so it is a post-credential
nuisance rather than a bypass — but it permanently destroys one backup code per
call and forces a re-login each time.

**Fix:** add `disableSession: false` to the patch in `TRUST_DEVICE_STRIPPED_PATHS`
handling. It is a one-line addition next to the `trustDevice` strip.

---

## 17 — LOW — `revokeTwoFactorState` contains a dead N+1 loop and leaves attempt counters behind

[rotation.ts:34-52](lib/auth/rotation.ts#L34-L52) collects every deleted
`trusted_devices.trustIdentifier` and issues one `DELETE FROM verifications` per
row. **No such rows exist**: `grantDeviceTrust` writes only to `trusted_devices`
and a cookie, and the plugin's own trust path (the only writer of those
`verification` rows) is disabled by the forced `trustDevice: false`. The loop is
a per-device round-trip that always deletes zero rows.

The one real deletion, `WHERE value = userId`, removes challenge rows but not
their `2fa-attempts-<id>` companions (whose `value` is `'0'`), so those survive
rotation until the nightly sweep.

**Fix:** delete the loop. If orphaned counters matter, match
`identifier LIKE '2fa-attempts-%'` against the challenge ids collected before the
first delete.

---

## 18 — LOW — The `hooks`-removal coupling is untested, and every drift mode is silent

`twoFactorAuth()` composes the plugin as `const { hooks: _pluginSignInHook,
...core } = twoFactor({...})` ([two-factor.ts:64](lib/auth/two-factor.ts#L64)).
That rests on two undocumented properties of `better-auth@1.7.2`: `getPlugin`
resolves by `p.id`, so `core` keeping `id: 'two-factor'` is enough for the
plugin's own internals to find their options; and nothing in the plugin except the
sign-in hook reads `hooks`.

No test exercises either — `grep -rn "getPlugin\|_pluginSignInHook" tests/`
returns nothing. The two remaining `getPlugin('two-factor')` call sites in the
library are the `trustDeviceMaxAge` lookup (dead here — `trustDevice` is forced
`false`) and `resolveAccountLockoutConfig`, whose fallback
(`enabled: true, 10 attempts, 900s`) is identical to what an unset config
produces. **So if `getPlugin` stopped resolving, nothing would change
observably** — the account-lockout ladder would quietly fall back to the same
numbers, and a second `hooks` entry added upstream would be dropped without a
single failing assertion.

The two integration suites that do detect drift (`two-factor-totp.test.ts`,
`two-factor-trusted-device.test.ts`) cover the cookie and identifier formats, not
this.

**Fix:** assert directly that `auth.options.plugins` contains a plugin with
`id === 'two-factor'` whose `hooks` is undefined, and that
`twoFactor({...}).hooks.after` has exactly one entry matching the three sign-in
paths. The second assertion is the one that turns an upstream addition into a red
build.

---

## 19 — LOW — A method removal's blast radius cannot be measured before deploying it

The empty-intersection downgrade writes a `twoFactorDowngraded` audit event
([two-factor-challenge.ts:212-221](lib/auth/two-factor-challenge.ts#L212-L221)),
and that is the only signal. It fires per affected login, after the change is
live, in a table nobody reads proactively — and per finding 11 it also fires on
routine passwordless logins, so the signal is not even clean.

The startup gate in `utils/validation/two-factor.ts` refuses only the
deployment-wide worthless configuration; it runs at module load with no database
access and cannot answer "how many users would this remove the last factor from".
There is no script, no dry-run flag and no query documented anywhere for it.

**Fix:** a small script alongside `scripts/check-password-peppers.ts` that takes a
candidate method list and reports the count of users whose intersection would go
empty, plus a per-method breakdown. Cheap, and it converts an unrecoverable
surprise into a pre-deploy number. Add it to the deployment notes.

---

## 20 — LOW — Assorted

- **`listTrustedDevices` sorts oldest-first.** `.orderBy(trustedDevices.lastUsedAt)`
  ([trusted-device.ts:182](lib/auth/trusted-device.ts#L182)) is ascending; the
  settings list should lead with the most recently used device. Use `desc(...)`.
- **`/two-factor/enable` is allow-listed when `totp` is off** and can then only
  return 400 (see finding 6), yet it is published in the OpenAPI contract with a
  200 shape. Gate the entry on `isTwoFactorMethodEnabled('totp')`.
- **Stale `two_factor_methods` rows survive `/two-factor/disable`.** That endpoint
  clears `two_factor_enabled` and the credentials row but leaves intent rows, so
  a later re-enable silently resurrects enrolments the user never re-chose. Clear
  them in an `after` hook on `/two-factor/disable`.
- **`two-factor-challenge.ts` referenced a test file that does not exist**
  (`tests/integration/two-factor-challenge.test.ts`); the drift coverage actually
  lives in `two-factor-totp.test.ts` and `two-factor-trusted-device.test.ts`.
  Removed during the comment pass — noted so the plan's B.9 "condition" is not
  read as satisfied by a file nobody wrote.
- **`uniquePhone()`** (`tests/helpers/session.ts`) takes the last 8 digits of a
  UUIDv7 and relies on them being unique against `ux_users_phone_number`. That is
  a birthday collision at ~10⁴ seeds per table reset, not an impossibility. A
  process-local counter would be deterministic.

---

## 21 — Assessment: default method, priority and fallback UX (prompt item 5)

**None of it exists, and the current shape actively prevents a "route to the
default, offer another" UI.**

- **The offered list has no order.** `readEnrollment` selects from
  `two_factor_methods` with no `ORDER BY`
  ([two-factor-challenge.ts:85-91](lib/auth/two-factor-challenge.ts#L85-L91)), and
  `offeredMethods` preserves that order. Postgres returns heap order, which
  changes after any update to a row. A client doing `methods[0]` gets a _different_
  default between logins for the same user. This must be fixed before any
  auto-routing UI is built, independently of whether a preference feature is added.
- **There is no system priority.** Nothing ranks `passkey > totp > otp >
backup_code`. Every consumer sees an unordered set.
- **There is no per-user preference.** `two_factor_methods` has
  `(user_id, method, channel)` and no `is_default` / `priority` column.
- **`GET /two-factor/methods` returns intent only** — it does not join capability,
  so a settings screen cannot render "enrolled but currently unusable", which is
  exactly the state finding 10 shows users can reach.

**Recommendation, in order:**

1. Add a deterministic server-side order. Define the priority once beside
   `TWO_FACTOR_METHODS` (`passkey`, `totp`, `otp`, `backup_code` — strongest
   first, recovery last) and sort `offeredMethods`' output by it. `backup_code`
   must never sort first: auto-routing to it would spend a recovery code on a
   routine login.
2. Add `two_factor_methods.is_default boolean not null default false` with a
   partial unique index `(user_id) WHERE is_default`, set through a new
   `POST /two-factor/methods/default` (session + `assertLiveSession`; no password
   needed — it changes no capability). The challenge then sorts the user's default
   first and the system priority behind it.
3. Return the ordered array as today (`twoFactorMethods`), so the client's rule is
   simply "attempt `methods[0]`, show the rest under _Try another way_". No new
   response shape is needed.
4. `backup_code` should be excluded from auto-routing even when it sorts first —
   render it only behind the fallback affordance.

One behavioural constraint the UI must respect regardless: for `otp` the client
has to call `/two-factor/otp/send` to trigger delivery, so "auto-route to
default" means an automatic send on challenge display. That interacts with the
per-destination hourly quota (5/hour) — a user who reloads the 2FA page six times
is locked out of their own default method for an hour. Send on first render only,
and drive re-sends from an explicit button with the `nextAllowedIn` value the
endpoint already returns.

---

## 22 — Assessment: password-reset OTP vs 2FA OTP (prompt item 6)

**Factor separation — sound.** `two_factor` is its own `otp_purpose`
([utils/validation/otp.ts](utils/validation/otp.ts)), and `purpose` is part of
`ux_verification_sessions_user_contact_purpose` and of every locked lookup in
`processOtpVerify`. A code minted for `forgot_password` cannot satisfy a
`two_factor` verify or vice versa, and each keeps its own send ladder, per-cycle
budget, anchored 24-hour failure budget and block window. The advisory lock is
keyed on `contactKind || ':' || purpose`, so the two flows do not serialise
against each other either. I found no way to cross-redeem.

**Channel collision — partially addressed, with one gap and one hole.**

- The separate `NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS` variable is the right
  mechanism, and the startup refusal for the provably worthless configuration
  (methods exactly `{otp}`, every channel overlapping recovery) is correct as far
  as it goes.
- The refusal is narrow by design, with `recoveryDefeatsTwoFactor` compensating
  for merely-overlapping configurations. That compensation is real for
  `/api/auth/forgot-password/reset`, but **`/api/auth/passwordless/*` has no
  equivalent** — see finding 11. Passwordless mints a session rather than
  rewriting a password, so the overlap is worse there and the protection is
  weaker. This is the largest remaining gap in the F2 story.
- **Finding 3 defeats the separation entirely** for the passwordless case: even
  when the offered set correctly excludes the shared contact kind,
  `/two-factor/otp/send` will still deliver to it.

**Rate-limit collision — a real, unaddressed denial channel.** See finding 7:
`two_factor` shares `otp.verify.dest.<kind>` with the anonymous
`/api/auth/otp/verify` surface, so an attacker who knows a victim's address can
keep them from completing their second factor. The send side is fine — 2FA has
its own surface key — but the shared global daily breaker means an app-wide send
flood is also a login-denial vector for OTP-only 2FA users.

**One structural limit worth stating plainly**, since the plan records it as
unimplementable rather than as a residual risk: a user has exactly one `email`
and one `phone_number`, both of which are recovery contacts. Where a deployment
enables only email (`PHONE_NUMBER_MODE: 'disabled'`), 2FA-over-OTP can only ever
target the recovery mailbox, and the only real second factors are `totp`,
`passkey` and `backup_code`. Given findings 1 and 6, that leaves `totp` as the
sole functioning second factor in an email-only deployment today.

---

## 23 — Answers to the four confirmation questions

**1. Is the `hooks` removal covered by the divergence test?** No. See finding 18.
The formats the tests do cover are the cookie name and the two identifiers; the
`getPlugin`-by-id and nothing-else-reads-`hooks` assumptions are untested, and
every way they can break is silent.

**2. Can an operator size a downgrade before deploying it?** No. See finding 19.
The audit event is the only signal and it is after-the-fact and per-login.

**3. Did the other three admin-reset properties land?** Two of three. Target
session revocation and the dual actor/target audit row are both present
(`revokeOtherSessions(tx, targetId)` with no exclusion; `resetBy: actorUserId`
beside `userId: targetId`). Admin re-authentication did **not** land — see
finding 15.

**4. Can a user enable TOTP alone and never generate backup codes?** Not quite —
`/two-factor/enable` always generates and stores a set and returns it in the
response, so codes exist. But nothing requires the user to **keep** them: the
acknowledgement call is optional, and a user who ignores it and later loses their
authenticator is locked out with no self-service path, because password recovery
succeeds and still leaves TOTP as the only offered method. The conclusion holds —
acknowledgement should be a required step of enrolment. Written up in finding 9;
note it also depends on finding 6, since in a deployment without `totp` the codes
cannot be generated at all.

---

## 24 — Second-review items that did not hold against the code

Recorded so they are not acted on.

- **"Persist WebAuthn's returned `newCounter`."** Already done —
  [two-factor-passkey.ts:281-284](lib/auth/two-factor-passkey.ts#L281-L284)
  writes `verification.authenticationInfo.newCounter` after every accepted
  assertion. The compare-and-swap suggestion is defensible but low value: the code
  deliberately does not compare counters at all (many authenticators report a
  constant zero), so there is no decision for a CAS to protect.
- **"Declare `@simplewebauthn/server` directly."** Already declared —
  `package.json:49`, `"@simplewebauthn/server": "^13.3.3"`.
- **"Configure Drizzle model mappings for `verifications`, `twoFactorCredentials`
  and `passkeys`."** All three are configured — `verification: { modelName:
'verifications' }` ([lib/auth.ts:688](lib/auth.ts#L688)), `twoFactorTable:
'twoFactorCredentials'` and `schema: { passkey: { modelName: 'passkeys' } }`
  ([two-factor.ts:65,170](lib/auth/two-factor.ts#L65)).
- **"Recovery cannot reuse the unchanged sign-in challenge."** The library facts
  are correct — `verifyTOTP` completes through `valid()`, which creates a normal
  session, and `verifyBackupCode` with `disableSession: true` skips `valid()` and
  therefore skips challenge consumption (that second half is finding 16). But the
  shipped code never issues a challenge from recovery: `issueTwoFactorChallenge`
  has exactly two callers, `/sign-in/email` and `/passwordless/verify`. The plan's
  own header records that B.2's recovery half became a refusal instead. What is
  real here is a stale line in the plan —
  [two-factor-plan.md:801](reports/two-factor-plan.md#L801) still says "Recovery
  proves the second factor before the password is written", contradicting the
  header and the code. Fix the plan, not the implementation; the library
  constraint is worth keeping on record for anyone who later revisits that
  decision.
- **The worked example under "passwordless and empty-capability fail open"** —
  "`totp,otp` globally, recovery=email, 2FA=email, user enrolled only email OTP …
  that user's recovery still consists of two codes delivered to one compromised
  mailbox" — is wrong for `/api/auth/forgot-password/reset`.
  `recoveryDefeatsTwoFactor` computes `offeredMethods(state, 'email')`, which
  drops the email OTP, returns `[]`, and refuses the reset with 403. The
  _conclusion_ is right for the other path and worse than stated there:
  `/passwordless/verify` issues a full session for that user off **one** code, not
  two. That is finding 11.

One partial disagreement on the proposed remedy in the same item: "treat empty
capability as fail-closed and route the user through administrative reset" is
right for the possession-exclusion case (finding 11) and wrong for the
operator-removed-a-method case. The latter is caused by a configuration change
users can neither see nor undo; failing closed there locks people out of their own
accounts with no self-service path, which is why the downgrade branch exists. The
two causes are currently collapsed into one branch with one audit reason — that
conflation is the actual defect, and separating them is what makes a
fail-closed-on-exclusion policy safe to adopt.

The consolidated remedy proposed in that review — an immutable companion challenge
record carrying purpose, permitted methods and channels, first-factor context and
remember-me state, enforced before every verifier — is the right shape. It closes
findings 3, 5 and 13 together, and is a better fix than patching each verifier
separately.
