### SEC-1 — 🟠 High · ⚠️ Always — Email change: no ownership proof + `emailVerified` not reset

**Where:**
[change-email/handler.ts:120](app/api/dash/users/me/change-email/handler.ts#L120),
[users/[id]/handler.ts:429-442](app/api/dash/users/[id]/handler.ts#L429-L442)
(`handleAdminEdit`).

Both the self-service email change and the admin user edit update `users.email`
without touching `users.emailVerified`. The new, unproven address silently
inherits the previous address's verified status.

**Verified by full-codebase trace.** There is **no mass-assignment path** —
`emailVerified`/`phoneNumberVerified` appear in **no** Zod schema and in **no**
handler other than OTP verify; every UPDATE uses an explicit column allowlist.
The only `true` write is
[otp/verify/handler.ts:135-138](app/api/auth/otp/verify/handler.ts#L135-L138),
and it is genuinely sound: it fires only after a real code match, under a
`FOR UPDATE` lock on the user row, with an active-user re-check and an
idempotency guard. The flaw is therefore _not_ "the flag can be flipped without
verification" — it is that a stale `true` is **carried onto** a new, unproven
address. Notably, the admin handler already computes `emailChanged`
([users/[id]/handler.ts:428](app/api/dash/users/[id]/handler.ts#L428)) but uses
it only to drive session revocation, not to reset the flag — strong evidence the
omission is an oversight, not a deliberate policy.

**Compounding bug:** OTP _send_ refuses to send when `emailVerified === true`
([send/handler.ts:103-110](app/api/auth/otp/send/handler.ts#L103-L110)), so once
an address is wrongly marked verified, the user can **never** re-trigger
verification for it. The wrong state is unrecoverable through the API.

**Impact:** Today nothing gates on the flag (see SEC-2), so direct blast radius
is small — but it violates the stated invariant _"`emailVerified` cannot be
`true` without a successful verification"_ and is a latent landmine. An attacker
can pre-stage it: verify a throwaway, then change to `victim@allowed-domain` —
the account now carries a "verified" address it never owned. The day anyone adds
password reset, `requireEmailVerification`, a verified badge, or trusted-email
notifications, every account that ever changed its email is silently
pre-trusted.

**Second, related half — no ownership proof of the new address.** Beyond the
stale flag, the self-service flow never proves the user controls `newEmail`: it
checks the current password and uniqueness, then writes the new address directly
([change-email/handler.ts:120-123](app/api/dash/users/me/change-email/handler.ts#L120-L123)).
A typo or an address the user does not own becomes the account's primary email.
Resetting the flag (below) contains the _trust_ damage, but the account's
contact of record is still an unverified address until ownership is proven.

**Required fix.** A new email is an **unverified pending change**: `users.email`
must never be overwritten until the new address proves ownership via OTP. This
is the single, final solution and applies to **both** the self-service and admin
paths.

1. On the change request, do **not** write `users.email`. Persist the new
   address as a pending target bound to an OTP `purpose = 'change_email'` and
   `targetIdentifier = newEmail` (the model in **SEC-3**), and send the code to
   the **new** address. The self-service path still requires current-password
   re-auth to _initiate_ the change; the admin path is authorized by the admin's
   permission.
2. Only on successful verification of that code — inside the same transaction —
   commit `email = newEmail` and set `emailVerified = true` (now genuinely
   proven), and revoke the user's other sessions and pending verifications.
3. The admin path obeys the same rule: the change stays **pending** until the
   new address is verified by whoever controls it. An admin edit must never flip
   the account onto an unproven address.

This closes both halves at once: the address only changes once owned, and the
flag is therefore always `true`-because-proven — the "stale carried `true`"
state can no longer arise. Apply the identical rule to `phoneNumber` /
`phoneNumberVerified` (see DATA-1), and add a comment above `users.email` that
it must never be written outside this verified pending-change flow.

---

### SEC-2 — 🟡 Medium · ⚠️ Always — Verification flags are never enforced at login (undocumented policy)

**Where:** [lib/auth.ts:200-225](lib/auth.ts#L200-L225); Better Auth is
configured **without** `requireEmailVerification`
([lib/auth.ts:37-47](lib/auth.ts#L37-L47)).

The session-creation hook gates only on `isActive` + active role. It never
selects or checks `emailVerified` / `phoneNumberVerified`, and login does not
require verification. Combined with SEC-1 this makes the flags **write-only
trust state**: an unverified user authenticates normally, and the frontend has
no signal to route them into the OTP flow. Worse, every login failure (wrong
password, unknown user, inactive, locked) collapses to one generic `401`
invalid-credentials response, so even if the client wanted to detect "needs
verification" it cannot.

**Required fix.** Email verification is required to use the account; enforce it
**and** expose a dedicated signal for the unverified state:

1. In the session-creation hook (which runs _after_ password verification has
   already passed), select `emailVerified` and reject session creation when it
   is `false`.
2. Reject with a **distinct, dedicated error code** (e.g. `EMAIL_NOT_VERIFIED`,
   status `403`) returned for **no other** login failure. Every other failure
   keeps the single generic `401` invalid-credentials response.
3. The frontend keys on that distinct code to trigger an OTP send and open the
   code-entry screen; after a successful verify the user signs in.

**Why this is safe (no enumeration leak).** The distinct signal is reachable
**only after a correct password** (`verifyLoginAttempt` has already succeeded),
so the caller has proven account ownership. It therefore leaks nothing to an
attacker who does not know the password — the wrong-password / unknown-user
paths still return the identical generic `401`.

---

### SEC-3 — 🟡 Medium · 🧪 Early Stage — OTP has no purpose binding, recency, or one-time consume

**Where:** [verification_sessions schema:416-490](db/schema.ts#L416-L490),
[sendOtpSchema / verifyOtpSchema:42-112](utils/validation/otp.ts#L42-L112),
[otp/verify/handler.ts](app/api/auth/otp/verify/handler.ts),
[processOtpVerify:406-579](utils/otp.ts#L406-L579).

**What the implementation actually does (verified):** the send and verify Zod
schemas carry only `channel` + identifier (+ `code`) — **no `purpose`/`reason`
field**. The `verification_sessions` row stores channel, identifier, and attempt
counters — **no `purpose`, no `verifiedAt`, no `consumedAt`** — and is keyed
unique by `(userId, channel)` only. On a successful match the sole side effect
is flipping `emailVerified`/`phoneNumberVerified`, after which the session row
is **deleted** ([utils/otp.ts:557-559](utils/otp.ts#L557-L559)). No post-verify
artifact survives.

**This is safe today** and worth stating plainly: the OTP system has exactly one
purpose — prove ownership of an unverified email/phone. The other listed
purposes are handled elsewhere or not at all: **change-password** and
**change-email** use **current-password re-authentication**
([change-password/handler.ts:72-86](app/api/dash/users/me/change-password/handler.ts#L72-L86),
[change-email/handler.ts:67-81](app/api/dash/users/me/change-email/handler.ts#L67-L81)),
not OTP; **passwordless login** and **forgot-password** are not implemented
(only `/sign-in/email` is reachable — all other Better Auth paths 404 via the
`ALLOWED_PATHS` allowlist, [lib/auth.ts:30](lib/auth.ts#L30)). Because verify
leaves no reusable artifact, there is currently **no cross-purpose replay
surface**.

Stated purpose vs. reality in the code:

| Stated purpose     | Reality in code                                                      |
| ------------------ | -------------------------------------------------------------------- |
| Passwordless login | ❌ Not implemented — only `/sign-in/email` is reachable; others 404. |
| Forgot password    | ❌ Not exposed (a test asserts the route is not reachable).          |
| Change password    | ✅ Current-password re-authentication, **not** OTP.                  |
| Change email       | ✅ Current-password re-authentication, **not** OTP.                  |
| Add / change phone | ⚠️ No endpoint exists (see DATA-1).                                  |

Re-auth with the current password is a **valid — arguably stronger —
alternative** to OTP purpose binding: it sidesteps purpose confusion entirely,
which is why the current design is sound and should not be replaced by OTP
without the guardrails below. _(One bypass worth recording: an admin changing a
user's email between OTP send and verify cannot create a replay — the user
lookup and the session `identifier` both stop matching, so verify correctly
fails. Confirmed by the Sonnet review.)_

#### Answering the design questions directly

**Q: dedicated verify endpoint per action, or one shared `otp/verify`?** A
single shared send/verify pair is the right choice — _provided_ it is
purpose-bound. Spawning a near-duplicate verify endpoint per action multiplies
code and invites drift; it does not, by itself, prevent purpose confusion. The
decisive rule is different: **the verify endpoint must not be the place that
authorizes the sensitive action.** Verification should only _produce a proof_;
the sensitive-action endpoint _consumes_ it. That is where (a) recency, (b)
purpose, and (c) purpose-matches-action must be checked — because the window
between "verified" and "acted" is exactly where replay and confusion live.

**Q: does the action API check (a) last-verify timestamp, (b) purpose, (c)
purpose↔action match?** Today: **N/A** — no sensitive action consumes an OTP, so
none of (a)/(b)/(c) is checked, and that is currently fine because re-auth is
used instead. The danger is the _next_ step: the current pattern is "delete the
session and flip a **global boolean**." A global boolean such as `emailVerified`
has **no recency and no purpose** — it is a permanent, ambient grant. If anyone
later authorizes a sensitive action off such a flag, they inherit an
indefinitely-valid, purpose-agnostic proof: precisely the vulnerability this
focus area warns about. (This is why SEC-2 — "do not trust the flag as a gate" —
and SEC-3 are the same underlying principle.)

**Required design** — implement this purpose-binding model before adding any
second OTP purpose, and as the prerequisite for SEC-1's verified change-email
flow:

1. Add a `purpose` enum, bind it at send and verify time, and **widen the unique
   index to `(userId, channel, purpose)`**. ⚠️ _Trap:_ the send upsert's
   `onConflictDoUpdate` target is currently `[userId, channel]`
   ([utils/otp.ts:318-319](utils/otp.ts#L318-L319)); left unchanged once
   multiple purposes exist, a "change_email" send would **clobber** an in-flight
   "login" code for the same channel. The unique key and the conflict target
   must move together.

   ```ts
   export const otpPurpose = pgEnum('otp_purpose', [
     'verify_contact', 'passwordless_login', 'forgot_password',
     'change_password', 'change_email', 'change_phone',
   ]);
   // verification_sessions: purpose notNull default 'verify_contact'
   // uniqueIndex on (userId, channel, purpose)
   ```

2. Persist a proof on success instead of only flipping a flag: stamp
   `verifiedAt` and `consumedAt` on the verification row. The sensitive-action
   endpoint must then **atomically consume** a matching, recent, unconsumed
   proof **inside the same transaction** as the change — this enforces reason +
   recency + single-use in one statement:

   ```ts
   const [v] = await tx.update(verificationSessions)
     .set({ consumedAt: sql`now()` })
     .where(and(
       eq(verificationSessions.userId, userId),
       eq(verificationSessions.purpose, 'change_password'),
       isNull(verificationSessions.consumedAt),
       gt(verificationSessions.verifiedAt, sql`now() - interval '10 minutes'`),
     ))
     .returning({ id: verificationSessions.id });
   if (!v) throw new CustomError('OTP verification required', HTTP_STATUS.FORBIDDEN);
   ```

   Use a DB-stored proof, not a signed/JWT token: the row makes strict
   single-use trivial (the `consumedAt` UPDATE is the atomic gate), whereas a
   stateless token needs a separate revocation store to prevent replay.

3. **Bind the proof to the target identifier, not the current contact (Codex).**
   For `change_email` / `change_phone`, the OTP proves ownership of the **new**
   identifier being added. Verify currently matches against the user's
   **current** `users.email`
   ([otp/verify/handler.ts:66-69](app/api/auth/otp/verify/handler.ts#L66-L69)),
   so these flows need an explicit `targetIdentifier` on the session (per
   Codex's recommended schema) and must verify the code against _that_, not the
   existing contact.

4. Until all of the above is in place, **keep current-password re-auth** for
   password/email change — it is the safer pattern and should not be swapped for
   OTP without it.

---

### DATA-1 — 🟢 Low · 🧪 Early Stage — Phone-number lifecycle is incomplete

A cluster of related phone gaps; resolve together before enabling the
`sms`/`whatsapp` channels in `ENABLED_OTP_CHANNELS`:

1. **Dead path:** No reviewed endpoint ever assigns `users.phoneNumber` (it is
   only read, or set to `null` on soft-delete,
   [users/[id]/handler.ts:687](app/api/dash/users/[id]/handler.ts#L687)). OTP
   send/verify match by `eq(users.phoneNumber, identifier)`, so with every
   `phoneNumber` NULL, **phone OTP can never succeed** and `phoneNumberVerified`
   can never legitimately become `true`. Confirm whether phone is populated by
   an out-of-scope registration flow, or whether the feature is half-wired.
2. **No reset path:** There is no phone-change endpoint and `updateUserSchema`
   excludes `phoneNumber`, so `phoneNumberVerified` can never be reset. When a
   phone-change path is added, it must set `phoneNumberVerified: false` on
   change (mirror SEC-1).
3. **Weak DB invariant:** the schema allows
   `phone_number IS NULL AND phone_number_verified = true`
   ([db/schema.ts:127-131](db/schema.ts#L127-L131)). Add a guard so a verified
   flag requires a present number:

   ```ts
   check('chk_phone_verified_requires_phone',
     sql`phone_number_verified = false OR phone_number IS NOT NULL`)
   ```

> Minor doc fix (low): `processOtp*` comments say codes are stored as
> **argon2**, but `hashOtpCode` delegates to better-auth `hashPassword`
> (**scrypt**). Hashing is correct and salted; only the comment is inaccurate.

---
