# Two-factor authentication — security findings and implementation plan

Status: **complete. All phases implemented and verified.**

| Phase                                     | State |
| ----------------------------------------- | ----- |
| 0 — dependencies and schema               | done  |
| 1 — fail-closed password proof            | done  |
| 2 — challenge issuer, TOTP, backup codes  | done  |
| 3 — our OTP as a 2FA method, passwordless | done  |
| 4 — trusted devices                       | done  |
| 5 — passkey as a second factor            | done  |
| 6 — recovery refusal, admin reset         | done  |
| 7 — contract, docs, deployment            | done  |

Verified at the last change: `tsc`, `eslint`, `prettier` and the unreachable-file
gate clean; `bun run build` passes with two-factor both OFF (24 documented paths)
and ON (45); **868 unit + 324 integration + 50 process tests, 0 failures**.

## Two decisions the implementation changed

**B.2's recovery half became a refusal rather than a second-factor step.**
Requiring the second factor at recovery does not fix what F2 describes: if the
user's only factor is an OTP to the contact recovery uses, the attacker holding
that mailbox proves it too, and the extra step changes nothing. What closes it is
refusing the reset when it would defeat the user's entire second factor
(`recoveryDefeatsTwoFactor`), which is stronger for that case and equivalent for
every other — after a reset, a TOTP, passkey or backup code still blocks the
login. Implemented in the existing handler; the endpoint did not have to move
into a plugin.

**`@better-auth/core` is a direct dependency.** B.9 planned to derive the context
type from an exported value rather than depend on the package. That derivation
turned out to describe only the MIDDLEWARE context, and every helper here is
called from endpoints too, so the library's own `GenericEndpointContext` is
imported instead — with a caret range against the version `better-auth` pins
exactly, so an upgrade moves both.

---

# Part A — Security findings

Ordered by severity. Findings on the EXISTING flows come first because they
change what the new work has to do. "Checked and fine" results are recorded at
the end.

## A.1 Findings

### F1 — CRITICAL — Passwordless login bypasses 2FA completely

`lib/auth/passwordless.ts:254` issues a session through
`ctx.context.internalAdapter.createSession` directly. The 2FA plugin attaches
its challenge through a single `after` hook whose matcher is

```js
context.path === '/sign-in/email' ||
  context.path === '/sign-in/username' ||
  context.path === '/sign-in/phone-number';
```

(`better-auth/dist/plugins/two-factor/index.mjs`). `/passwordless/verify`
matches none of them.

Consequence: a user who has enabled 2FA logs in with one OTP and receives a
full, fully-privileged session with no second factor. In any deployment where
both features are on, 2FA is decorative. This is latent today (no 2FA plugin
installed) and becomes real the moment 2FA ships.

**Remedy (settled, B.1):** passwordless becomes a first factor and issues the
same challenge, offering only methods that are a **different possession** from
the contact it just proved.

### F2 — HIGH — 2FA OTP on the same contact as recovery collapses both factors

If the 2FA OTP destination reaches the same mailbox or number used by
`/api/auth/forgot-password/*` or `/api/auth/passwordless/*`, one possession
yields both factors: the attacker resets the password through that contact
(first factor) and receives the 2FA code at the same contact (second factor).

It matters for **both** recovery paths, and passwordless is the sharper of the
two: forgot-password only rewrites the password and revokes sessions, so the
attacker must still complete a login, whereas passwordless mints a session
outright.

**Remedy (settled, B.2):** a startup failure on the provably worthless
configuration, plus a second factor on password recovery. A documentation note
alone is not a remedy.

### F3 — MEDIUM — better-auth's session middlewares bypass `assertLiveSession`

`sessionMiddleware` and `freshSessionMiddleware`
(`better-auth/dist/api/routes/session.mjs:285` and `:324`) resolve the session
via `getSessionFromCtx` **without** `disableCookieCache`, and check neither
`users.is_active` nor `users.deleted_at`.

Every plugin management endpoint we would allowlist uses one of them:

| Endpoint                                          | Middleware                   | Cookie cache      | Live check |
| ------------------------------------------------- | ---------------------------- | ----------------- | ---------- |
| `/two-factor/enable`                              | `sessionMiddleware`          | served from cache | none       |
| `/two-factor/get-totp-uri`                        | `sessionMiddleware`          | served from cache | none       |
| `/two-factor/generate-backup-codes`               | `sessionMiddleware`          | served from cache | none       |
| `/two-factor/disable`                             | `sensitiveSessionMiddleware` | authoritative     | none       |
| `/passkey/generate-register-options`              | `freshSessionMiddleware`     | served from cache | none       |
| `/passkey/verify-registration`                    | `freshSessionMiddleware`     | served from cache | none       |
| `/passkey/list-user-passkeys`, `delete`, `update` | `sessionMiddleware`          | served from cache | none       |

Two distinct gaps, and the second is the larger one:

1. **Unbounded**: a suspended or soft-deleted user whose session row still
   exists can enable 2FA, read their TOTP URI and register passkeys with no time
   limit at all, because `is_active` and `deleted_at` are never consulted.
2. **300-second cookie-cache window**: usually minor, with one exception that is
   not. `/passkey/verify-registration` requires only a _fresh session_ — **no
   password**. So in the five minutes after a victim changes their password (the
   act that revokes the attacker's session), an attacker on the revoked session
   can still plant a passkey; and per the settled rotation policy, passkeys
   survive a password change. A five-minute stale read becomes permanent access,
   at exactly the moment the victim is locking the attacker out.

**Remedy:** one `assertLiveSession` call in the `before` hook of `lib/auth.ts`
for the session-bearing `/two-factor/*` and `/passkey/*` paths. It reads the
database, so it closes both gaps in the same call — there is no tradeoff to make
between them.

### F4 — MEDIUM — the `password.verify` stub fails OPEN for any newly allowlisted path

`lib/auth.ts:88` sets `verify: async () => true`. Today only `/sign-in/email`
reaches it, and the `before` hook compensates. The 2FA plugin adds four
password-gated paths that reach it through `validatePassword` / `checkPassword`
(`better-auth/dist/utils/password.mjs`): `/two-factor/enable`,
`/two-factor/disable`, `/two-factor/get-totp-uri`,
`/two-factor/generate-backup-codes`.

Allowlisting any of them as-is is an immediate credential bypass: any holder of
a session could enable or disable 2FA and read the TOTP secret without knowing
the password.

**Remedy (settled, B.3):** the password-proof mechanism, which converts the stub
from fail-open to fail-closed.

### F5 — MEDIUM — `loginSuccess` audit rows would describe sessions that no longer exist

A pending 2FA challenge requires deleting the session the sign-in handler just
created, clearing its cookie and resetting `newSession`. By then
`lib/auth.ts`'s `session.create.after` has already committed an audit row with
`loginSuccess: true` for that session id, breaking the invariant that hook's own
doc-comment establishes — and breaking it for _every_ 2FA-enabled sign-in, not
an edge case.

**Remedy:** a compensating audit event, the same shape as
`recordAbandonedSession` in `lib/auth/passwordless.ts`, written by the challenge
issuer. Audit logs are append-only, so compensation is the only honest option.

### F6 — LOW — credential rotation does not invalidate 2FA challenges or trusted devices

`revokePendingProofs` (`lib/auth/rotation.ts`) deletes `verification_sessions`
rows. The 2FA challenge, its attempt counter and the trusted-device record live
elsewhere, under random identifiers that helper does not touch.

After a password change or a forgot-password reset an in-flight challenge stays
valid to its expiry, and a previously trusted device keeps skipping 2FA. Neither
yields a session without the _new_ password, so this is not an escalation. The
trusted-device half is still worth fixing: recovery is exactly the flow where
you must assume the attacker holds a device the victim previously trusted.

**Remedy (settled, B.4):** rotation revokes challenges and trusted devices, and
trusted devices become visible and individually revocable to the user.

### F7 — LOW — the plugin's account lockout does not cover OTP-only users

`assertTwoFactorNotLocked` / `recordTwoFactorFailure`
(`two-factor/verify-two-factor.mjs`) operate on a row in the `twoFactor` table.
`/two-factor/enable` with `method: "otp"` sets `user.twoFactorEnabled = true`
and creates **no** row at all, so the plugin's cross-challenge lockout never
engages for a user whose only method is OTP.

Not our exposure — our OTP path carries `verifyAttemptNumber`,
`verifyAttemptDaily` and the block ladder in `verification_sessions` — but it is
independent evidence for owning the OTP path rather than delegating it.

### F8 — INFO — the plugin's own rate limits are inert in this deployment

`lib/auth.ts` sets `rateLimit: { enabled: false }`, so the plugin's
`rateLimit: [{ pathMatcher: /^\/two-factor\//, window: 10, max: 3 }]` never
runs. Every new path needs an explicit `preAuthLimit` in
`BETTER_AUTH_ENDPOINTS`. Recorded because the plugin _looks_ like it brought its
own protection.

### F9 — MEDIUM — the plugin derives OTP availability from server config, not from the user

`method` on `/two-factor/enable` selects a branch and is never persisted. The
`otp` branch's only write is `updateUser(user.id, { twoFactorEnabled: true })`;
the `twoFactor` table has six columns (`secret`, `backupCodes`, `userId`,
`verified`, `failedVerificationCount`, `lockedUntil`) and none of them records a
method. At challenge time the list is re-derived, and derived differently per
method (`plugins/two-factor/index.mjs`):

```js
if (!options?.totpOptions?.disable) {
  const userTotpSecret = await adapter.findOne({ model: twoFactorTable, where: [{ field: 'userId', ... }] });
  if (userTotpSecret && userTotpSecret.verified !== false) twoFactorMethods.push('totp');
}
/** otp is server-level — if sendOTP is configured,
 *  any user with 2fa enabled can receive a code. */
if (options?.otpOptions?.sendOTP) twoFactorMethods.push('otp');
```

So `totp` is per-user state, `otp` is a property of the deployment, and
`backup_code` is never listed at all despite its verify endpoint existing.

Consequence had we adopted that derivation: configuring OTP offers it as a
fallback to **every** 2FA-enabled user, including one who deliberately enrolled
only TOTP. Their second factor silently becomes "TOTP **or** a code to their
email" — the strong factor they chose downgraded to the weakest the server
offers, with no way to decline, and per F2 that contact may be the one that
already resets their password.

**Remedy (settled, B.10):** per-user enrollment in `two_factor_methods`, and an
offered set computed by us rather than by the plugin.

## A.2 Checked and found fine

- **G1 — OTP core.** `processOtpSend` / `processOtpVerify` have no 2FA-relevant
  defect. `purpose` is part of `ux_verification_sessions_user_contact_purpose`
  and part of every locked lookup, so no existing surface can mint a
  `two_factor` proof and no existing proof can satisfy a `two_factor` verify.
  Adding the purpose is additive; the core is reused unmodified.
- **G2 — Forgot-password is not a bypass of the F1 shape.**
  `forgot-password/reset/handler.ts` sets the password and calls
  `revokeOtherSessions`; it issues no session. It is a 2FA weakening vector only
  through F2.
- **G3 — `/api/auth/otp/verify`** (`verify_contact`) issues no session.
- **G4 — `/api/dev/sign-up`** is stripped from the registered route table
  outside development by `toRegisteredRoutes`, and issues no session in any
  case.
- **G5 — Session-issuing paths are exactly two today**: `/sign-in/email` and
  `/passwordless/verify`. `SESSION_METHOD_BY_PATH` is complete, and gains an
  entry for each new 2FA completion path.
- **G6 — Denying passkey sign-in is a data change, not a code change.** There is
  no `/sign-in/passkey` server endpoint; `authClient.signIn.passkey()` is a
  client-side composite of `GET /passkey/generate-authenticate-options` and
  `POST /passkey/verify-authentication`. Omitting both from
  `BETTER_AUTH_ENDPOINTS` makes them unreachable at two independent layers
  (`app.ts` wildcard, then the `before` hook), and it fails closed.
- **G7 — The 2FA surfaces are not enumeration surfaces.** Unlike
  `/api/auth/otp/*`, a 2FA send or verify requires a valid challenge cookie, so
  the user is already known and no identifier is accepted from the body. The
  timing-floor and response-collapse machinery (`ensureMinDelay`,
  `collapseProofThrottle`) is therefore not needed there — a simpler threat
  model, not a laxer one. Stated so the omission reads as a decision.
- **G8 — Passkey registration cannot be aimed at another user.**
  `/passkey/verify-registration` compares `userData.id` from the stored
  challenge against the session user and throws
  `YOU_ARE_NOT_ALLOWED_TO_REGISTER_THIS_PASSKEY` on mismatch. Read in source.
- **G9 — Every divergence mode of the challenge reimplementation fails closed.**
  See C.4.

## A.3 The assessment in the referenced GitHub comment

> "if a Passkey is registered, it should be required for authentication"

The conclusion is directionally right, the reasoning is wrong, and the proposed
remedy is worse than the problem.

- Registering a passkey while password login stays enabled does **not weaken**
  the account directly. The password's attack surface is unchanged. What is true
  is that it does not _strengthen_ it either: with two independent single-factor
  paths, account security equals the **weaker** path, so the phishing-resistant
  credential buys nothing while the phishable one remains valid.
- There is a real second-order weakening the comment does not name: a parallel
  authenticator is one more credential that can be stolen, cloud-synced (iCloud
  and Google Password Manager sync passkeys by default), or **silently
  registered by an attacker holding a session** — granting persistent access
  that survives a password reset. F3 shows exactly how wide that window is here.
- "Require the passkey once registered" is a lockout generator: lose the device,
  lose the account. The correct answers are (a) passkey as a _second_ factor —
  what this project builds, strictly stronger than either alone — or (b) letting
  a user explicitly disable password login once a passkey exists.
- As a second factor, WebAuthn keeps its main property. A real-time phishing
  proxy can capture the password but **cannot replay the assertion**: it is
  origin-bound. This is the only method in the set with that property.

---

# Part B — Settled decisions

## B.1 Passwordless is a first factor, compared by contact kind

The bypass (F1) is closed by making `/passwordless/verify` issue the same 2FA
challenge, and the offered method set is computed from **possession**, not from
the method name:

```
K = contactKind(the passwordless channel just proved)   // 'email' | 'phone'

offered = [ ...user's enabled non-OTP methods,
            ...user's enabled OTP channels whose contactKind !== K ]

offered.length > 0   -> issue the challenge, offering exactly `offered`
offered.length === 0 -> issue the session
```

The empty case is deliberate and is not a bypass: the only second factor left
would be an OTP to the very contact the user proved seconds ago. Sending it
proves nothing, costs another message, and blocks the login for no gain.

Comparing contact kind rather than method name matters: a user who signs in
passwordless by email and whose 2FA OTP channel is SMS has a genuinely different
possession, and is challenged for it.

The same predicate does **not** apply to password sign-in. A password is a
knowledge factor, so an OTP to any contact is a real second factor there.

## B.2 F2 — a startup failure plus a second factor on recovery

**What is not implementable, stated plainly.** Per-user destination separation —
"the contact registered for recovery cannot also be the 2FA OTP destination" —
cannot be expressed in this schema. A user has exactly one `email` and one
`phone_number`, `userContactColumn` maps a channel onto one of them, and both
are recovery contacts. Separating them requires a new "2FA destination" column
with its own verification lifecycle. Not proposed.

What ships instead, both parts:

1. **Startup failure on the provably worthless configuration.** Fatal at module
   load when the enabled 2FA method set is exactly `{otp}` **and** every enabled
   2FA OTP contact kind is also an enabled recovery contact kind. In that
   configuration 2FA cannot add a factor for any user, so it is a
   misconfiguration rather than a tradeoff, and it is refused with a message
   naming both variables. Configurations that merely overlap are allowed,
   because part 2 closes them.

2. **Password recovery requires the second factor.**
   `/api/auth/forgot-password/reset`, for a user with 2FA enabled, proves the
   second factor before the new password is written. This is the general fix: it
   closes the collapse for every method combination rather than only for
   disjoint channel sets, and it matches what account recovery does everywhere
   that takes 2FA seriously.

   **Consequence, stated rather than buried:** a user who loses every second
   factor can no longer reset their own password. Backup codes become
   load-bearing, which is why `backup_code` should be enabled server-side in
   every deployment, and why the admin reset in B.6 exists.

## B.3 The password proof — per-request token, plus a length bound

**Ordering — confirmed.** `dispatchAuthEndpoint`
(`better-auth/dist/api/dispatch.mjs:207-230`) runs `runBeforeHooks`, merges the
returned context, then calls `endpoint(internalContext)`. `/sign-in/email` calls
`ctx.context.password.verify` inside its handler (`api/routes/sign-in.mjs:332`);
the 2FA paths call it via `validatePassword` / `checkPassword` inside theirs.

**Body modification — return, do not mutate:**

```ts
return { context: { ...ctx, body: { ...ctx.body, password: marker } } };
```

Verified by running the dispatcher's own merge (`defuReplaceArrays(rest,
internalContext)`): `rest` wins for every key it defines, including `false`, and
keys it omits survive from the original body. So `method`, `issuer` and `code`
pass through untouched while `password` is substituted. The hook sees the raw
body — better-call validates inside the endpoint — so the marker must satisfy
the endpoint's schema, which is `z.string()` in every case here.

**Every other `password.verify` call site:**

| Call site                                                                                  | Reachable here?                                     |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `api/routes/sign-in.mjs:332` (`/sign-in/email`)                                            | **Yes** — allowlisted; a marker is minted here too. |
| `utils/password.mjs` via `/two-factor/{enable,disable,get-totp-uri,generate-backup-codes}` | **Yes**, once allowlisted.                          |
| `api/routes/update-user.mjs:175` and `:302`                                                | No — not allowlisted; we own change-password.       |
| `plugins/phone-number/routes.mjs:91`, `plugins/username/index.mjs:188`                     | No — plugins not installed.                         |

A future version adding a verify on a path we allowlist receives a real
plaintext, finds no matching proof, and returns `false` → **fails closed**.

**Why a per-request token and not a constant env secret.** The length bound
below does close the objection about a user-supplied value colliding with the
marker. It does not close the one that decides the question: a constant is a
long-lived secret living in env, CI and backups, whose disclosure permanently
and silently disables password verification on every allowlisted path, with no
rotation story and no detection. A per-request token has no value at rest.
Further, the length bound is _our_ invariant applied in _our_ hook, not a
structural property — better-auth's own schemas are unbounded `z.string()`.
Resting a permanent secret on an invariant we must remember to apply everywhere
is the exact shape of F4.

**The mechanism:**

```ts
// lib/auth/password-proof.ts
const pending = new Map<string, { hashes: Set<string>; expiresAt: number }>();

export function mintPasswordProof(hashes: readonly string[]): string;
export function consumePasswordProof(hash: string, candidate: string): boolean;
```

- single-use by construction; an unknown token returns `false`;
- carries a **set** of acceptable hashes. This is what makes the pepper upgrade
  safe: `verifyLoginAttempt` rewrites the stored hash after a successful sign-in
  when the pepper generation changed, and `returnPasswordProof: true` suppresses
  that upgrade entirely — so a marker bound to one hash would either fail for
  users mid-rotation or silently disable pepper rotation on login. The hook
  registers both the pre- and post-upgrade hash;
- per-process and ephemeral: no key material, nothing to rotate, nothing
  survives a restart. Correct, because the `before` hook and the handler always
  run in the same process for the same request;
- TTL plus an opportunistic sweep, so a token abandoned by a handler that threw
  before verifying does not accumulate.

**The length bound, as a second independent layer.** The token is longer than
`PASSWORD_MAX` (128), and the `before` hook rejects any inbound body carrying a
`password` field longer than `PASSWORD_MAX` — **generically, on every
allowlisted path**, not per path, because the 2FA endpoints' own schemas are
unbounded. User password space and marker space then cannot overlap by
construction.

Two properties verified for this to hold: `normalizePasswordInput`
(`utils/validation/rules.ts:177`) applies `String.normalize('NFKC')` and nothing
else — no trim, no truncation — so nothing shortens a long value before the
check; and NFKC _can_ change a string's length, so the bound is applied to the
normalized value. The token itself is ASCII base64url and therefore
NFKC-invariant.

**Downsides of the plaintext not travelling past the hook:**

1. `sign-in.mjs` calls `ctx.context.password.hash(password)` in its
   user-not-found branches as a timing guard; it would hash the token. Harmless
   — those branches are unreachable because our hook already rejected, and
   `runPasswordTimingGuard` is our guard.
2. Any future better-auth feature needing the real plaintext at verify time
   would silently operate on the token. This is recorded in a comment beside the
   stub. It is the mirror of today's risk and strictly smaller: today such a
   feature would operate on a password **nobody checked**.
3. `sanitizeForLog` already denylists `password`, so the token inherits
   redaction.

## B.4 Trusted devices — owned end to end, visible and individually revocable

**Why we own the sign-in hook.** F1 and F2 both require minting a 2FA challenge
from a path the plugin's hook will never fire on (`/passwordless/verify`,
`/api/auth/forgot-password/reset`), so the challenge-issuance helper is written
regardless. Once it exists, letting the plugin also issue challenges means two
issuers and two trusted-device stories. So the plugin is composed **without its
`hooks`**:

```ts
const { hooks: _pluginSignInHook, ...twoFactorCore } = twoFactor(options);
```

`twoFactorCore` keeps `id: 'two-factor'`, `endpoints`, `options` and `schema`.
Verified: `getPlugin` resolves by `p.id` (`context/create-context.mjs:125`), so
`verifyTwoFactor`'s `trustDeviceMaxAge` lookup still works. Nothing else in the
plugin reads `hooks`.

This buys three things at once: the method list is computed in one place rather
than patched by a second `after` hook; the F5 compensating audit event is
written by the same code that deletes the session; and trusted devices stop
depending on the plugin's identifier rotation, which would otherwise orphan any
companion record on every sign-in.

**What ships:**

- A `trusted_devices` table: `userId`, `trustIdentifier`, `userAgent`,
  `ipAddress`, `label`, `createdAt`, `lastUsedAt`, `expiresAt`. Enough to
  recognise a device in a list.
- `trustDevice` is forced to `false` on the plugin's own verify endpoints in the
  `before` hook, so the plugin never mints a record we do not know about.
  (Verified above that a `false` in the returned body overrides a `true` in the
  request.)
- Trust is granted by an explicit action after a successful verification, so the
  record is created by us with full metadata, and the cookie is minted in the
  format our own sign-in hook verifies.
- `GET` list and per-device revoke endpoints for the settings screen. The user
  decides what to revoke; there is no mass-revocation button.
- Credential rotation (password change, forgot-password reset) revokes the
  user's trusted devices and any in-flight challenge, alongside the existing
  session and proof revocation, keeping one rotation policy in
  `lib/auth/rotation.ts`.
- `trustDeviceMaxAge` stays at the 30-day default.

## B.5 Session revocation when 2FA is enabled

Enabling 2FA revokes the user's **other** sessions and keeps the current one. An
attacker already holding a session must not remain inside while the user
believes they have just secured the account.

Revocation fires only once a method is **confirmed working**, never when setup
begins, so an abandoned setup logs nobody out. Per method, the confirmation
point is:

| Method       | Confirmed when                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| TOTP         | `/two-factor/verify-totp` succeeds in the enable flow (the plugin's branch that flips `twoFactorEnabled`) |
| OTP          | a code sent to the chosen channel is verified once, in a confirm step we add                              |
| Passkey      | `/passkey/verify-registration` succeeds and it is the user's first passkey                                |
| Backup codes | the user acknowledges the displayed set (B.7)                                                             |

The plugin already rotates the current session on enable (`createSession` then
`deleteSession` of the old one), so "keep the current one" means keep the
newly-rotated session, and the revocation excludes it.

## B.6 Admin reset of a user's 2FA

Without it, the B.2 recovery fix makes total factor loss unrecoverable. A
permission-gated, audited endpoint clears a target user's 2FA enrollment,
passkeys and trusted devices, then revokes their sessions and pending proofs.

It is its **own permission action**, not folded into `users.edit`. The existing
model already supports page-scoped actions: `sanitizePermissions` gates each
action on that page's `availablePermissions`
(`lib/permissions/utils.ts:196`), so a new `resetTwoFactor` action listed only
under the `users` page resolves to `false` on every other page by construction,
and to `false` for every existing role — the key is absent from stored jsonb and
`rawPerms[action] === true` is false. No role gains the capability by upgrade.

## B.7 The three self-decided items

**Backup codes are shown once.** They are returned at generation and never
again. The method counts as enabled only after an explicit acknowledgement call;
until then the codes exist but `backup_code` is not offered as a method, so a
user cannot believe they have a recovery path they never saved. Regeneration is
allowed at any time with password re-authentication, invalidates the entire
previous set atomically, and requires its own acknowledgement.

**Removing the last enabled method is blocked.** It returns a conflict telling
the user to disable 2FA explicitly, which requires password re-authentication.
Auto-disabling on the removal of the final method is a silent security downgrade
the user did not ask for, and it is indistinguishable from an accident.

Disabling 2FA requires password re-authentication only, not the second factor —
consistent with the plugin and with the repo's change-password pattern, and
sound because holding a session already implies the 2FA gate was passed at
login.

**A method removed from the env after users enabled it.** The challenge offers
the intersection of server-enabled and user-enabled methods. Backup codes stay
in that intersection whenever `backup_code` is server-enabled and the user has
unused codes, which is the safety net — this is the concrete reason to keep
`backup_code` enabled in every deployment.

If the intersection is nonetheless empty, the sign-in **proceeds without a
second factor** and writes a `twoFactorDowngraded` audit event naming the user
and the method that became unavailable. The alternative locks users out of their
own accounts through an operator action they can neither see nor undo, with no
self-service path back. The downgrade is deliberate, bounded to a configuration
the operator chose, and recorded.

## B.8 Conditional table creation — accept the empty tables

`drizzle-kit generate` emits static SQL from `db/schema.ts` at author time and
never connects; `scripts/migrate.ts` applies `db/drizzle/` against a ledger and
`db/migrations/` idempotently. Nothing in that pipeline can branch on a
deployment's environment.

The schema module _can_ branch, and the repo does — `PHONE_REQUIRED ? notNull :
nullable`, the `chk_phone_disabled` / `chk_phone_verified_requires_phone` split,
`REQUIRE_ROLE_FOR_LOGIN` gating a check constraint — but every one of those
branches on a **compile-time constant in `utils/config.ts`**, never on
`process.env`, each with a "⚠️ toggling this requires a new migration" contract.
If the generated SQL depended on the environment, `bun run db:generate` on one
machine would emit a migration that drops another environment's tables.

So the tables are created unconditionally. An unused table costs a catalogue
row, and 2FA is the point of this work. A conditional migration runner is
rejected: it makes the applied schema differ per environment with no ledger to
detect it, which is the failure mode `resolveSqliteDir` and the pepper keyring
gate exist to prevent.

## B.9 Passkey — kept, and passkey sign-in denied unconditionally

Three reasons it stays:

1. **Its marginal cost is small, because the expensive part is required
   anyway.** The challenge module is written for OTP-as-2FA, for F1 and for F2
   regardless. Passkey adds one options endpoint, one assertion-verify endpoint,
   `allowCredentials` scoped to the challenge user, and a hard
   `passkey.userId === challengeUserId` check.
2. **Every divergence mode fails closed.** The reimplementation couples to three
   private formats: the cookie name `"two_factor"`, the attempts identifier
   `2fa-attempts-<key>`, and the trust-device HMAC. If any changes upstream, the
   cookie or record is not found and the request is rejected, or the user is
   simply prompted for 2FA again. None opens a hole. Written to _require_ each
   piece rather than tolerate absence, the property holds by construction.
3. **It is the only phishing-resistant method in the set.** TOTP and OTP are
   both replayable by a real-time phishing proxy.

**The condition:** an integration test that performs a real `/sign-in/email`
against a 2FA-enabled user, asserts our challenge module resolves the cookie our
issuer set, and asserts a trust cookie our endpoint mints is honoured on the
next sign-in. That turns silent divergence into a red CI run on the next
`better-auth` bump. Passkey ships only with that test.

`/passkey/generate-authenticate-options` and `/passkey/verify-authentication`
are **never allowlisted, and not behind a flag**. An env flag on those two paths
is one typo away from restoring a full unauthenticated sign-in endpoint;
re-adding two lines to a reviewed file is a better gate than a variable.

---

## B.10 Method enrollment is ours, and it is intent rather than capability

F9 leaves nowhere to record that a user turned a method on. A fifth table,
`two_factor_methods`, holds one row per `(userId, method)`, with `channel` set
for `otp` and only for `otp` (a CHECK equivalence, so neither direction drifts).

Storing enrollment on `two_factor_credentials` was considered and rejected. That
row does not exist for an OTP-only user — the plugin creates it only on the TOTP
branch — and making its `secret` / `backup_codes` nullable so one could be
synthesised is actively unsafe: `/two-factor/enable` computes
`verified: existingTwoFactor != null && existingTwoFactor.verified === true`, so
a pre-existing row would make a later TOTP enrollment **verified without the
user ever proving a code**. The table stays exactly as the plugin expects, and is
written only by the plugin.

**A row is intent, not capability.** What a challenge offers is the intersection
of three independent terms:

1. **server-enabled** — `NEXT_PUBLIC_ENABLED_2FA_METHODS`;
2. **user intent** — this table;
3. **capability** — a verified TOTP secret, an acknowledged backup-code set, a
   registered passkey, a verified contact for OTP.

Separating them is what makes a stale row harmless: a user who deletes their
last passkey keeps the intent row, and the capability term drops the method from
the challenge instead of offering a factor they cannot complete. It is also what
the "cannot remove your last method" rule counts — intent, so a transient
capability loss never silently un-enrolls anyone.

`channel` is what makes the B.1 comparison possible: it records which contact the
user chose for 2FA codes, which is the value compared against the possession a
passwordless sign-in just proved.

---

# Part C — Implementation plan

## C.1 Environment variables

### `NEXT_PUBLIC_ENABLED_2FA_METHODS`

- **Accepted values**: comma-separated subset of `totp`, `otp`, `backup_code`,
  `passkey`. Order irrelevant; each entry is trimmed.
- **Unset or empty**: 2FA is disabled entirely. No `/two-factor/*` and no
  `/passkey/*` path is allowlisted, so all answer 404 at both layers. One
  `console.error` at module load records it — same treatment and reasoning as
  `otp.disabled` in `utils/validation/otp.ts`: a deploy fault, logged once,
  never per request.
- **Parse failures, all fatal at module load**: unknown method name; duplicate
  entry; empty entry (`a,,b`, or a trailing comma). Each throws naming the
  offending value and the valid set, mirroring `parseEnvChannels`. The failure
  this prevents is the measured one in that function's comment — a typo silently
  reading as "feature intentionally disabled".
- **Dependent rejections, also fatal**: `otp` present while
  `NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS` is empty; and the worthless
  configuration in B.2 (methods exactly `{otp}` with every 2FA OTP contact kind
  also a recovery contact kind).
- **Production credential gate**: `passkey` needs nothing beyond `PUBLIC_URL`
  (the RP ID derives from its hostname — verified in the plugin's `getRpID`).
  `totp` and `backup_code` need `BETTER_AUTH_SECRET`, already in
  `REQUIRED_IN_PRODUCTION`. `otp` inherits the per-channel gate below.

### `NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS`

- **Accepted values**: comma-separated subset of `email`, `sms`, `whatsapp` —
  the same `OTP_CHANNELS` union, the same type, the same validator. Deliberately
  separate from `NEXT_PUBLIC_ENABLED_OTP_CHANNELS` so 2FA delivery can differ
  from account verification, which is what makes the F2 mitigation possible at
  all.
- **Unset or empty**: the `otp` 2FA method is unavailable; fatal only if `otp`
  is named in the methods variable.
- **Phone channels** are stripped rather than rejected when
  `PHONE_NUMBER_MODE === 'disabled'` — identical treatment to the existing
  parser, for the identical reason.
- **`OTP_AUTO_VERIFY` does not apply.** The dev bypass covers contact
  verification and contact change; it must never short-circuit a second factor,
  on the same principle that keeps it out of recovery and passwordless today.
- **Production credential gate**: each enabled channel's credentials must be
  present, reusing `CHANNEL_CREDENTIALS`, not gated on any bypass flag.

Both parsers live in a new `utils/validation/two-factor.ts`, a direct sibling of
`utils/validation/otp.ts`: same strictness, same fatal-at-load posture, same
single-source-of-truth exports consumed by `allowed-paths.ts` and the endpoints.

## C.2 Phases

### Phase 0 — dependencies and schema

**Ships:** the database can hold 2FA state; nothing is reachable yet.

Files: `package.json`, `db/schema.ts`, `db/drizzle/0005_*.sql`.

- `better-auth` → `^1.7.2`; add `@better-auth/passkey@^1.7.2` (peer requirement;
  brings `@simplewebauthn/server`).
- New tables `verification`, `twoFactor`, `passkey`, `trusted_devices`, authored
  in the repo's style (`uuid().$defaultFn(generateId)` because
  `advanced.database.generateId: false`, explicit indexes, the `timestamps`
  spread), matching the field names the plugins' `schema` blocks declare.
- `users.two_factor_enabled` column; `otp_purpose` gains `two_factor`.
- **Reversibility:** the tables and the column are reversible by `DROP`. The
  enum value is **not** — PostgreSQL cannot remove a label, so a rollback
  requires recreating the type. The same constraint the existing `otp_purpose`
  values live under, and the reason `0003` exists.
- Verify: `bun run db:migrate` against a scratch database, then `bun run lint`.

### Phase 1 — fail-closed password proof

**Ships:** F4 closed. Behaviour identical to today; the stub can no longer be
abused by any path.

Files: `lib/auth/password-proof.ts` (new), `lib/auth.ts`,
`lib/auth/login-guard.ts`.

- The `before` hook mints the proof for `/sign-in/email` and enforces the
  generic `PASSWORD_MAX` bound on any inbound `password` field; `verify` becomes
  `consumePasswordProof`.
- `login-guard.ts` surfaces both the pre- and post-upgrade hash on the sign-in
  path, leaving the three re-auth callers untouched.
- Verify: `tests/integration/sign-in-controls.test.ts` passes unchanged, plus
  new cases — a real plaintext reaching `verify` returns false, and an
  over-length `password` is rejected before any handler runs.

### Phase 2 — the challenge issuer, TOTP and backup codes

**Ships:** working TOTP and backup-code 2FA, env-gated, with method choice.

Files: `utils/validation/two-factor.ts` (new),
`lib/auth/two-factor-challenge.ts` (new), `lib/auth/allowed-paths.ts`,
`lib/auth.ts`.

- The env parsers (C.1).
- The challenge module: issuance (session deletion, cookie clearing, challenge
  and attempt-counter records, signed cookie, F5 compensating audit) and
  resolution (cookie → record → user, attempt budget, completion, trust).
- `twoFactor()` composed without its `hooks` (B.4); our own `after` hook on
  `/sign-in/email` issues the challenge and computes the offered method set.
- Allowlist entries, conditional on the parsed method set, each with an explicit
  `preAuthLimit` and `captcha` flag (F8).
- `assertLiveSession` on the session-bearing paths (F3); the password proof
  extended to the four password-gated paths; `trustDevice` forced to `false` on
  the plugin's verify endpoints.
- `SESSION_METHOD_BY_PATH` gains `/two-factor/verify-totp` and
  `/two-factor/verify-backup-code`.
- Backup-code acknowledgement and the last-method rule (B.7); session revocation
  on confirmed enable (B.5).
- Verify: enable, sign in, challenge, verify TOTP, session; wrong code; disable
  with a wrong password must fail; the empty-intersection downgrade writes its
  audit event.

### Phase 3 — our OTP as a 2FA method, and the passwordless fix

**Ships:** OTP 2FA on our own OTP system; F1 closed.

Files: `lib/auth/two-factor-otp.ts` (new), `utils/validation/otp.ts`,
`lib/rate-limit/api.ts`, `lib/auth/passwordless.ts`, `lib/auth/rotation.ts`.

- `/two-factor/otp/send` and `/two-factor/otp/verify` built on `processOtpSend`
  and `processOtpVerify` with `purpose: 'two_factor'`, modelled directly on
  `lib/auth/passwordless.ts`.
- One new `otp_purpose` value and one new `OtpSendSurface` value.
- `/passwordless/verify` issues the challenge per B.1.
- Rotation revokes challenges and trusted devices (F6).
- Verify: a 2FA-enabled user attempting passwordless does not receive a session;
  the contact-kind rule is exercised in both directions.

### Phase 4 — trusted devices, visible and revocable

**Ships:** the settings-screen surface for trusted devices.

Files: `lib/auth/two-factor-challenge.ts`, `db/schema.ts` usage, new endpoints.

- Trust granted through our own action with full metadata; list and per-device
  revoke endpoints; `lastUsedAt` refreshed on each accepted trust.
- Verify: a trusted device skips the challenge on the next sign-in; revoking it
  restores the challenge; the divergence test from B.9.

### Phase 5 — passkey as a second factor

**Ships:** passkey 2FA, server side. Skippable without touching phases 0-4.

Files: `lib/auth/two-factor-passkey.ts` (new), `lib/auth.ts`,
`lib/auth/allowed-paths.ts`.

- `passkey()` registered for registration and management only; the two
  authentication paths never allowlisted.
- `/two-factor/passkey/options` and `/two-factor/passkey/verify` on the shared
  challenge module, using `@simplewebauthn/server` directly.
- Verify: `/passkey/verify-authentication` answers 404; an assertion from a
  passkey belonging to another user is rejected against the challenge user.

### Phase 6 — recovery requires the second factor, and admin reset

**Ships:** F2 closed.

Files: `app/api/auth/forgot-password/reset/handler.ts`,
`app/api/dash/users/[id]/two-factor/reset/handler.ts` (new),
`lib/permissions/constants.ts`, `routes.ts`.

- Recovery proves the second factor before the password is written (B.2).
- The admin reset action and its `resetTwoFactor` permission (B.6).
- Verify: recovery for a 2FA-enabled user cannot complete without the second
  factor; the admin reset requires the new permission and writes its audit row;
  a role without it is refused.

### Phase 7 — contract, docs, deployment

Files: generated OpenAPI, `reports/coolify-deployment.md`, `.env` example.

- `bun run build` regenerates the document from the route manifest.
- Both variables and their production gates recorded for the server side.
- An `.env` block in the style of the existing OTP block, stating plainly that
  OTP-only 2FA is a usability tier rather than a security tier (F2).

## C.3 Rollout order and reversibility

Phases 0 and 1 are independent of every product decision and can land first;
phase 1 is a security fix on existing behaviour and is worth shipping on its
own. Phases 2, 3, 4 and 6 are ordered by dependency. Phase 5 is optional and
removable without touching anything before it.

Every migration is reversible by `DROP` except the `otp_purpose` enum value in
phase 0, which is additive and harmless to leave in place.

## C.4 What we implement by hand, and how it compares to the library

| Piece                                           | What better-auth does                                                                                                                                         | Us                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Challenge issuance                              | the plugin's sign-in `after` hook: delete the session, clear the cookie, create the challenge and attempt records, set a signed cookie                        | **Match**, and extended: the same helper serves `/sign-in/email`, `/passwordless/verify` and recovery, which the plugin's hook cannot, and it writes the F5 compensating audit event the plugin has no notion of.                                                                                                                                                            |
| Challenge resolution                            | `verifyTwoFactor` reads the signed `two_factor` cookie, loads the record, resolves the user                                                                   | **Match**, step for step. Not exported (`better-auth`'s `exports` map blocks deep imports — probed and confirmed), so it is reimplemented from the source we read.                                                                                                                                                                                                           |
| Challenge single-use                            | consume the record on success, then expire the cookie                                                                                                         | **Match.**                                                                                                                                                                                                                                                                                                                                                                   |
| Attempt budget                                  | `2fa-attempts-<key>` record, consume-and-rearm, invalidate the challenge at the cap                                                                           | **Match**, same identifier so the budget is shared across every method rather than per-method.                                                                                                                                                                                                                                                                               |
| Session issuance                                | `createSession` then `setSessionCookie`                                                                                                                       | **Match**; our `session.create.before` gates run automatically, as they already do for passwordless.                                                                                                                                                                                                                                                                         |
| Trusted device                                  | random identifier, `HMAC-SHA256(secret, "<userId>!<id>")` base64url-unpadded, a record, a signed cookie, rotated on each use, invisible to the user           | **Beat.** Same cookie format, because our own hook verifies it. Additionally: a companion row with user agent, IP, label, created and last-used, a list and per-device revoke for the user, and revocation on credential rotation. Implemented with `node:crypto` rather than adding `@better-auth/utils` as a direct dependency; the phase 4 test proves the formats agree. |
| OTP generation, storage, verification           | 6 digits, plain/hashed/encrypted in a record, 5 attempts, 3-minute window, no send budget, no cost breaker, no audit                                          | **Beat.** Ours: HMAC envelope with a key generation (`otp-hash.ts`), per-proof send ladder with exponential backoff, per-cycle and anchored-24h verify budgets, block ladder, per-surface and global spend caps, in-transaction audit.                                                                                                                                       |
| Account lockout across challenges               | `failedVerificationCount` / `lockedUntil` on the `twoFactor` row; absent for OTP-only users (F7)                                                              | **Match for TOTP and backup codes** (the plugin's, untouched); **beat for OTP** (proof-row counters, which also cover the F7 gap).                                                                                                                                                                                                                                           |
| TOTP secret, encryption, URI                    | `generateRandomString(32)`, `symmetricEncrypt` under the auth secret, `createOTP().url()`                                                                     | **Delegate unchanged.** No reason to reimplement audited crypto.                                                                                                                                                                                                                                                                                                             |
| Backup codes                                    | 10 × 10 characters, encrypted at rest, single-use by rewrite                                                                                                  | **Delegate the crypto unchanged**; add the show-once acknowledgement gate and atomic regeneration around it (B.7).                                                                                                                                                                                                                                                           |
| WebAuthn registration                           | `@simplewebauthn/server`, challenge in a record plus a signed cookie, `excludeCredentials`, session binding                                                   | **Delegate unchanged** (plugin endpoints, session-gated), with `assertLiveSession` added at the boundary (F3).                                                                                                                                                                                                                                                               |
| WebAuthn assertion                              | looks the credential up **by `credentialID` alone** and signs in whoever owns it                                                                              | **Beat.** Ours restricts `allowCredentials` to the challenge user's passkeys **and** rejects any assertion whose `passkey.userId` differs from the challenge user. The plugin's version is a full sign-in endpoint; ours is a second-factor proof.                                                                                                                           |
| Password re-auth on management paths            | `validatePassword` / `checkPassword` against `password.verify`                                                                                                | **Beat.** Ours runs the real `verifyLoginAttempt` — row lock, lockout ladder, pepper upgrade, audit — in the `before` hook, and makes the stub fail closed for any path we have not compensated.                                                                                                                                                                             |
| Which methods a user enrolled in                | not modelled: `method` is a branch selector that is never persisted, `otp` availability is derived from server config, and backup codes are never listed (F9) | **Beat.** `two_factor_methods` records intent per user, and the offered set is intent ∩ capability ∩ server-enabled (B.10).                                                                                                                                                                                                                                                  |
| Enumeration and timing collapse on 2FA surfaces | none                                                                                                                                                          | **N/A by construction** — see G7.                                                                                                                                                                                                                                                                                                                                            |
