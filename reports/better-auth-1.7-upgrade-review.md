# Better Auth 1.6 → 1.7 — Upgrade Review

**Date:** 2026-08-20
**Declared:** `better-auth: ^1.6`, `@better-auth/core: ^1.6` (`package.json`)
**Resolved in this working tree:** `1.7.1` (`bun.lock`, `node_modules`)
**Method:** every claim below was checked against the installed `1.7.1` source
and, where behaviour was in question, reproduced against the local PostgreSQL 18
dev database on Bun 1.4.0. Version-to-version claims were checked by unpacking
`better-auth@1.6.26` and `@better-auth/core@1.6.26` from the registry into a
scratch directory and reading both trees side by side — not from the upgrade
guide's prose and not from memory. The verification method for each claim is in
Appendix A; the reproduction is in Appendix B.

---

## 0. Bottom line

1. **The upgrade already happened.** `bun.lock` in this working tree resolves
   `better-auth@1.7.1`; the committed lockfile at `HEAD` resolved `1.6.26`.
   `package.json` still declares `^1.6`. The application is running on 1.7 now.

2. **Password login is broken, right now, and it fails silently as "wrong
   password."** 1.7 recognises a credential account by `(issuer, accountId)`. The
   `accounts` table has no `issuer` column, so Better Auth finds no credential
   account and answers `401` — with correct credentials. Reproduced end to end.
   This is the only 1.7 blocker.

3. **Passwordless login still works**, because that path never reads the
   `accounts` table. So the failure is partial, and the shape of it — OTP sign-in
   works, password sign-in says "wrong password" — invites misdiagnosis as a
   password-hashing or pepper problem.

4. **Nothing else in the 1.7 guide reaches this deployment.** Every other
   breaking change is gated behind a provider, plugin, adapter or option this
   project does not use. §4 lists all of them with the reason each is inert.

5. **`tsc --noEmit` passes and `bun run test` is 150/150 green** with the auth
   surface fully broken. Neither gate can see this class of defect.

6. Two things found while verifying, both **pre-existing and unrelated to 1.7**,
   both reported because they were reproduced in the course of this work: an
   audit-log defect that also breaks login (§6.1), and repository documentation
   that 1.7 has made incorrect (§5.1).

---

## 1. Version state

|                                       | Value                                                                 |
| ------------------------------------- | --------------------------------------------------------------------- |
| `package.json` → `better-auth`        | `^1.6`                                                                |
| `package.json` → `@better-auth/core`  | `^1.6`                                                                |
| `package.json` → `@better-auth/utils` | `0.4.2` (exact)                                                       |
| `bun.lock` at `HEAD`                  | `better-auth@1.6.26`, `@better-auth/core@1.6.26`, `better-call@1.3.7` |
| `bun.lock` in working tree            | `better-auth@1.7.1`, `@better-auth/core@1.7.1`, `better-call@1.4.0`   |
| `node_modules`                        | `1.7.1`                                                               |

`^1.6` admits `1.7.x`, so a `bun install` — or Renovate, which already groups
`better-auth` and `@better-auth/**` so they move together — floated the tree to
1.7.1 with no deliberate upgrade step. The declared range no longer describes what
runs.

**Two consequences worth acting on:**

- **Pin the declared range to `^1.7`** for both `better-auth` and
  `@better-auth/core`. Leaving `^1.6` means the manifest documents a version the
  code cannot actually run on (§3), and anyone resolving from `package.json` alone
  would reach a different, incompatible tree.
- **`@better-auth/utils` is now duplicated.** It is pinned exactly at `0.4.2` at
  the top level, and `better-call@1.4.0` depends on `^0.5.0`, so `bun.lock` also
  carries a nested `@better-auth/utils@0.5.0`. `lib/auth/check-password.ts`
  imports `createHash` from the top-level `0.4.2`. Harmless today — the two copies
  do not interact — but it is a second copy of a hashing utility in the tree, and
  the exact pin is what forces the duplication rather than a single hoisted
  `0.5.0`. Decide whether that pin is still buying anything.

---

## 2. Inventory — every Better Auth touchpoint

Import sites (the only files that import from `better-auth` or `@better-auth/*`):

| File                             | Imports                                                                                                       | 1.7 impact                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `lib/auth.ts`                    | `betterAuth`, `drizzleAdapter`, `APIError`, `createAuthMiddleware`, `isAPIError`, `captcha`, `haveIBeenPwned` | **Affected** — §3, §5.1                     |
| `lib/auth/passwordless.ts`       | `BetterAuthPlugin`, `APIError`, `createAuthEndpoint`, `setSessionCookie`                                      | None — all four unchanged; verified working |
| `lib/auth/api-error.ts`          | `APIError`                                                                                                    | None                                        |
| `lib/auth/check-password.ts`     | `createHash` from `@better-auth/utils/hash`                                                                   | None (`0.4.2` pinned)                       |
| `lib/rate-limit/auth-storage.ts` | `BetterAuthRateLimitStorage` from `@better-auth/core`                                                         | None — already migrated to `consume`        |

Files that reference Better Auth without importing it:

| File                                        | Role                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `lib/auth/allowed-paths.ts`                 | The 4-path allowlist: `/get-session`, `/sign-out`, `/sign-in/email`, `/passwordless/verify` |
| `app.ts`                                    | Enforces the allowlist before `auth.handler`; `CORS_POLICY`; comment now stale (§5.1)       |
| `routes.ts`                                 | `ROUTE_PREFIXES` — the 405/404 boundary for `/api/auth/*`                                   |
| `lib/http/openapi.ts`                       | `BETTER_AUTH_BODIES` — schema mapping for the 4 paths                                       |
| `lib/auth/code-errors.ts`                   | `BASE_ERROR_CODES` → Arabic message map, read by the `after` hook                           |
| `lib/env.server.ts`                         | `BETTER_AUTH_SECRET` contract; rejects `BETTER_AUTH_SECRETS`                                |
| `lib/auth/login-guard.ts`                   | Project-owned credential verification (`accounts` read at `:197`)                           |
| `lib/permissions/checker.ts`                | Reads `session.metadata.permissions` from the cookie cache                                  |
| `db/schema.ts`                              | `users` / `sessions` / `accounts` models (`modelName` overrides)                            |
| `.github/workflows/ci.yml`, `renovate.json` | `BETTER_AUTH_SECRET` placeholder; version grouping                                          |

**Configuration surface actually in use** (`lib/auth.ts`): `baseURL`,
`drizzleAdapter(provider: 'pg')`, `emailAndPassword` with a custom `password.hash`
and a stubbed `password.verify`, `hooks.before` / `hooks.after`,
`advanced.database.generateId: false`, `advanced.ipAddress`, `logger.disabled`,
`session` (`expiresIn`, `updateAge`, `freshAge`, `cookieCache`,
`additionalFields.metadata`, `modelName`), `databaseHooks.session.create.before`,
`rateLimit` with `customStorage` + `customRules`, `user.additionalFields`,
`account.modelName`, and three plugins: `haveIBeenPwned`, `captcha`, and the
project's own `passwordless`.

**What this deployment does _not_ use** — and this is why §4 is as short as it is:
no social providers, no generic OAuth, no SSO/SAML, no SCIM, no MCP, no
OIDC/OAuth provider, no Stripe, no organization, no two-factor, no Expo, no device
authorization, no `magicLink` or `emailOTP` plugin, no `secondaryStorage`, no
`experimental` options, and no Better Auth client (`authClient` appears nowhere —
this is a JSON API with a separate front-end).

---

## 3. BLOCKER — `accounts.issuer` is required in 1.7, and the column does not exist

### What changed

1.6.26 identified the credential account by provider alone
(`dist/api/routes/sign-in.mjs:293`):

```js
const credentialAccount = user.accounts.find(
  (a) => a.providerId === 'credential'
);
```

1.7.1 requires three things to match
(`node_modules/better-auth/dist/api/routes/sign-in.mjs:318-319`):

```js
const credentialIssuer = createLocalAccountIssuer('credential'); // → "local:credential"
const credentialAccount = userRecord?.accounts.find(
  (account) =>
    account.providerId === 'credential' &&
    account.issuer === credentialIssuer &&
    account.accountId === userRecord.user.id
);
if (!userRecord || !credentialAccount) {
  await ctx.context.password.hash(password);
  throw APIError.from(
    'UNAUTHORIZED',
    BASE_ERROR_CODES.INVALID_EMAIL_OR_PASSWORD
  );
}
```

`issuer` is a first-class required field on the `account` model in 1.7
(`@better-auth/core/dist/db/get-tables.mjs:201-208`), with a compound unique
index:

```js
indexes: mergeTableIndexes([{ fields: ["issuer", "accountId"], unique: true }], …),
fields: { issuer: { type: "string", required: true, fieldName: … }, … }
```

`createLocalAccountIssuer` is `local:${providerId}`
(`@better-auth/core/dist/db/schema/account.mjs:38-40`), so for this project the
one and only correct value is the constant **`'local:credential'`**.

### What this project has

`db/schema.ts:298` — `accounts` columns are `id`, `accountId`, `providerId`,
`userId`, `password`, `createdAt`, `updatedAt`. Confirmed against the live
database: `id, account_id, provider_id, user_id, password, created_at,
updated_at`. **There is no `issuer` column.**

Both insert sites write `accountId = user.id` and `providerId = 'credential'` and
nothing else — `app/api/dash/users/handler.ts:223` and
`app/api/dev/sign-up/handler.ts:101`. So conditions 1 and 3 of the predicate hold
and condition 2 can never hold.

### Reproduced

Seeded a valid user and credential account with a real Argon2id hash, then
`POST /api/auth/sign-in/email` with the correct password through the real
`auth.handler`:

```
[internalAdapter.findUserByEmail] accounts returned:
  [ { accountId: "…", providerId: "credential", userId: "…", password: "p1:1:$argon2id$…", … } ]
[sign-in.mjs:319 predicate] credentialAccount = undefined  <-- NO MATCH

POST /api/auth/sign-in/email -> 401 {"message":"البيانات المدخله غير صحيحه","code":"__"}
set-cookie = []
```

Adding the column and setting `issuer = 'local:credential'` — changing nothing
else — restores the entire surface:

```
S1 sign-in/email          -> 200   (session token + session_token/session_data cookies)
S2 get-session (cached)   -> 200   metadata.roleName present
S3 get-session (DB path)  -> 200   metadata.roleName present
S4 sign-out               -> 200   {"success":true}
S5 session rows before/after sign-out: 1 -> 0
```

So `issuer` is the single cause and the single fix.

### Why it is silent, and why both gates miss it

- **`tsc --noEmit` passes.** Better Auth's account-model requirement is not
  expressed in the types the project's own Drizzle schema is checked against.
- **No SQL error.** The Drizzle adapter reads with a bare `db.select()`
  (`@better-auth/drizzle-adapter/dist/index.mjs:76`), which projects only the
  columns the _Drizzle schema_ declares. A column absent from the schema is never
  selected, so `issuer` arrives as `undefined` rather than as a
  `column does not exist` error.
- **The adapter's own field-existence guard does not fire.** It throws
  `The field "…" does not exist in the schema for the model "…"` — but only for
  fields referenced in a `where` clause or a `create` (`index.mjs:126`, `:211`,
  `:265`). The sign-in path only reads `issuer` from the projection, and this
  project never creates accounts through Better Auth, so no guard sits on that
  path.
- **`bun run test` is 150 pass / 0 fail.** The probe suite has no end-to-end
  sign-in assertion, so a total authentication break is CI-green.
- **The failure is indistinguishable from a wrong password** at the API boundary.
  The project's own `verifyLoginAttempt` succeeds first (it reads the hash
  directly, `lib/auth/login-guard.ts:197`), so the lockout counter is reset and a
  login-success audit row is written — and _then_ Better Auth returns 401. Logs
  will show successful credential verification followed by a rejected login.

### Fix

1. **Schema** — add the column to `accounts` in `db/schema.ts`:

   ```ts
   issuer: varchar('issuer', { length: 255 }).notNull().default(CREDENTIAL_ISSUER),
   ```

   `providerIdEnumValues` is `['credential']` — exactly one provider — so the
   value is a constant. Define it once next to `CREDENTIAL_PROVIDER_ID` in
   `utils/api-messages.ts` (`export const CREDENTIAL_ISSUER = 'local:credential'`)
   rather than inlining the literal at three sites.

2. **Constrain it**, in the style the table already uses for
   `chk_credential_password`, so the pair cannot drift:

   ```ts
   check('chk_credential_issuer', sql`provider_id <> 'credential' OR issuer = 'local:credential'`),
   uniqueIndex('ux_accounts_issuer_account').on(t.issuer, t.accountId),
   ```

3. **Write it explicitly at both insert sites**
   (`app/api/dash/users/handler.ts:223`, `app/api/dev/sign-up/handler.ts:101`).
   The column default makes omission survivable; writing it makes the requirement
   visible where someone adding a third insert site will read it.

4. **Migration** — add nullable, backfill, then tighten. Ordering matters because
   the column ends up `NOT NULL`:

   ```sql
   ALTER TABLE accounts ADD COLUMN IF NOT EXISTS issuer varchar(255);
   UPDATE accounts SET issuer = 'local:credential' WHERE issuer IS NULL AND provider_id = 'credential';
   ALTER TABLE accounts ALTER COLUMN issuer SET NOT NULL;
   ALTER TABLE accounts ALTER COLUMN issuer SET DEFAULT 'local:credential';
   CREATE UNIQUE INDEX IF NOT EXISTS ux_accounts_issuer_account ON accounts (issuer, account_id);
   ```

   There is no production data yet, so the collision check the upgrade guide
   prescribes is a formality here — but run it on any environment that already has
   rows, because the new index is unique:

   ```sql
   SELECT issuer, account_id, COUNT(*) FROM accounts GROUP BY 1, 2 HAVING COUNT(*) > 1;
   ```

5. **Decide about `ux_accounts_provider_account`.** With one provider,
   `(provider_id, account_id)` and `(issuer, account_id)` are the same constraint
   expressed twice. Keeping both is defensible — they diverge the moment a second
   provider exists. Dropping the old one is also defensible. What is not
   defensible is adding the second index without noticing the overlap.

6. **`bun run db:generate` must report no schema changes** after this lands, or
   the migration and the schema have diverged.

> Not applicable, and worth stating so nobody follows the guide into it: the
> guide's `issuer` backfill matrix covers SIWE, Google One Tap,
> OAuth-with-issuer and OAuth-without-issuer, plus the Microsoft `sub` → `oid`
> migration. This deployment has exactly one provider — `credential` — so the only
> row shape is `issuer: 'local:credential'`, `accountId: user.id`. Everything else
> in that section is inert.

---

## 4. Guide items that do NOT apply — verified, not assumed

Each row was checked against the codebase and, where the claim was about
behaviour, against the installed source.

| 1.7 change                                                                                                                                                                                       | Why inert here                                                                                                                                                  | Evidence                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Account identity scoped by issuer                                                                                                                                                                | **APPLIES — §3**                                                                                                                                                | —                                                                                              |
| Generic OAuth rebuilt on social-provider path                                                                                                                                                    | No `socialProviders`, no generic OAuth                                                                                                                          | No such key in `lib/auth.ts`                                                                   |
| `signIn.oauth2` → `signIn.social`, `oauth2.link` → `linkSocial`                                                                                                                                  | No client, no OAuth                                                                                                                                             | `authClient` appears nowhere in the repo                                                       |
| Identity tokens use one verifier / `verifyIdToken` → `idToken`                                                                                                                                   | No custom providers                                                                                                                                             | —                                                                                              |
| `generateState()` signature change                                                                                                                                                               | Not called                                                                                                                                                      | Grepped: no hits                                                                               |
| OAuth callback code `email_doesn't_match` → `email_does_not_match`                                                                                                                               | Not referenced                                                                                                                                                  | Grepped: no hits for either spelling                                                           |
| Google One Tap requires `clientId`                                                                                                                                                               | Not used                                                                                                                                                        | —                                                                                              |
| SIWE / Electron / Expo / React Native                                                                                                                                                            | Not used                                                                                                                                                        | —                                                                                              |
| Identity Provider (`@better-auth/oauth-provider`): protected resources, DPoP, back-channel logout, RP-initiated logout, introspection, PKCE for confidential clients, refresh-token reuse window | No provider plugin                                                                                                                                              | `plugins: [haveIBeenPwned, captcha, passwordless]`                                             |
| Old `oidcProvider` plugin removed                                                                                                                                                                | Never used                                                                                                                                                      | —                                                                                              |
| MCP moves to its own package, `withMcpAuth` → `requireMcpAuth`                                                                                                                                   | Not used                                                                                                                                                        | —                                                                                              |
| Enterprise SSO (OIDC/SAML), IdP-initiated off by default, certificate lists, `/sso/update-provider`                                                                                              | Not used                                                                                                                                                        | —                                                                                              |
| SCIM: three connection modes, full reprovisioning                                                                                                                                                | Not used                                                                                                                                                        | —                                                                                              |
| Stripe: `organization.enabled`, `onSubscriptionCancel` event                                                                                                                                     | Not used                                                                                                                                                        | —                                                                                              |
| Dynamic base URLs / `advanced.trustedProxyHeaders`                                                                                                                                               | `baseURL` is a plain string (`PUBLIC_ORIGIN`), not `{ allowedHosts }`                                                                                           | `lib/auth.ts:94`                                                                               |
| Adapters must implement `incrementOne` / `consumeOne`                                                                                                                                            | Built-in Drizzle adapter implements both                                                                                                                        | `@better-auth/drizzle-adapter/dist/index.mjs:456`, `:481`                                      |
| Secondary storage must implement `increment` / `getAndDelete`                                                                                                                                    | No `secondaryStorage` configured                                                                                                                                | Grepped: no hits                                                                               |
| Rate-limit storage uses `consume`                                                                                                                                                                | **Already done.** 1.7.1's `BetterAuthRateLimitStorage` has `consume` as its sole member — exactly what is implemented                                           | `@better-auth/core/dist/types/init-options.d.mts:142-165`; `lib/rate-limit/auth-storage.ts:35` |
| `experimental: { joins }` → `advanced: { database: { joins } }`                                                                                                                                  | Never used. (`experimental` is gone from 1.7's option types entirely)                                                                                           | Grepped: no hits                                                                               |
| Drizzle relation keys singular with `usePlural`                                                                                                                                                  | `usePlural` not set (default `false`)                                                                                                                           | `drizzleAdapter(db, { provider: 'pg', schema })`                                               |
| `getIp` → `getIP`                                                                                                                                                                                | Never imported; the project has its own `getClientIp` in `lib/audit.ts`                                                                                         | Grepped: no hits                                                                               |
| Two-factor `enableTwoFactor` discriminated response                                                                                                                                              | No `twoFactor` plugin                                                                                                                                           | —                                                                                              |
| Magic-link / email-OTP sign-in clears unproven credentials                                                                                                                                       | Neither plugin is used. `revokeUnprovenAccountAccess` is called only from `plugins/email-otp/routes.mjs:434` and `plugins/magic-link/index.mjs:178`             | Grepped all call sites                                                                         |
| Device authorization: unique indexes, opt-in OAuth grants                                                                                                                                        | Not used                                                                                                                                                        | —                                                                                              |
| Captcha matches full paths                                                                                                                                                                       | **Behaviour changed and it does reach this deployment — favourably.** §5.1                                                                                      | —                                                                                              |
| Drizzle affected-row validation now throws                                                                                                                                                       | Only when the count is not a finite number (`index.mjs:19-33`). Exercised session create, update and delete through `drizzle-orm/bun-sql` — all correct         | S1–S5 in §3                                                                                    |
| Cookie-cache session binding                                                                                                                                                                     | No option or shape change: the `session` and `session.cookieCache` option sets are identical between 1.6.26 and 1.7.1                                           | Diffed both `init-options.d.mts`                                                               |
| `BASE_ERROR_CODES` changes                                                                                                                                                                       | **None.** Both versions define exactly the same 49 codes                                                                                                        | `comm` over both `error/codes.mjs` — nothing added, nothing removed                            |
| Secret handling                                                                                                                                                                                  | `SecretConfig` identical; the default-secret literal `better-auth-secret-12345678901234567890` is unchanged, so the guard at `lib/env.server.ts:76` still bites | Diffed `types/secret.d.mts`; `utils/constants.mjs:2`                                           |
| `haveIBeenPwned`                                                                                                                                                                                 | Identical in both versions; `customPasswordCompromisedMessage` still honoured                                                                                   | Diffed `plugins/haveibeenpwned/index.mjs`                                                      |
| Telemetry                                                                                                                                                                                        | Opt-in, defaults to **false**; no new outbound traffic                                                                                                          | `@better-auth/telemetry/dist/index.mjs:360`                                                    |

---

## 5. Behaviour changes that do reach this deployment

### 5.1 Captcha now matches exact paths — the substring bypass is fixed upstream

1.6.26 matched by substring (`dist/plugins/captcha/index.mjs:29`):

```js
return (
  pathname.includes(endpoint) && !exemptPaths.some((p) => pathname.includes(p))
);
```

1.7.1 strips the base path and compares exactly, using a wildcard only when the
configured entry contains `*` (`dist/plugins/captcha/index.mjs:12-16`, `:28`):

```js
const pathname = normalizeEndpointPath(url.pathname, basePath); // "/api/auth/sign-in/email" → "/sign-in/email"
if (
  !endpoints.some((e) =>
    e.includes('*') ? wildcardMatch(e)(pathname) : e === pathname
  )
)
  return;
```

`lib/auth.ts:460` configures `endpoints: ['/sign-in/email']` — an exact full path
— so captcha still fires. Verified with four live requests:

```
/sign-in/email   without x-captcha-response  -> 400 {"message":"Missing CAPTCHA response","code":"MISSING_RESPONSE"}
/sign-in/email   with    x-captcha-response  -> reaches credential verification
/api/auth/zz/sign-in/email/zz, no header     -> 404   (1.6 answered 400 here)
/sign-in/email/  (trailing slash), no header -> 400   (normalizeEndpointPath canonicalises)
```

**Two consequences.**

**(a) Three places in the repository now describe the library incorrectly.** They
were accurate for 1.6 and are not for 1.7:

- `app.ts:342` — "That plugin matches its endpoint list with
  `pathname.includes(...)` — read in
  `node_modules/better-auth/dist/plugins/captcha/index.mjs` — so ANY path
  containing `sign-in/email` matched."
- `TODO.md` → **EM-15**, which records the substring behaviour as an open upstream
  concern and asks whether to narrow the plugin's exposure. 1.7.1 closes the
  underlying issue, so EM-15 can be closed with a note — and its warning that
  "every entry added there widens more than it looks" no longer holds: an added
  entry now widens by exactly one path.
- `reports/coolify-deployment.md` §12.5, which describes the same measured
  `400 Missing CAPTCHA response` on `/api/auth/zz/sign-in/email/zz` as current
  behaviour.

The `app.ts` allowlist check **should stay** — it is defence in depth, it is
cheaper than the plugin chain, and it protects any future plugin with the same
class of bug. Only the justification comment needs correcting, from "the plugin
does this" to "the plugin did this through 1.6.26; fixed in 1.7".

**(b) The `// TODO: add the proper endpoints` at `lib/auth.ts:460` now has
different semantics.** Under 1.6, `'/sign-in'` would have covered
`/sign-in/email` by substring. Under 1.7 it covers nothing — a prefix needs
`'/sign-in/*'` written explicitly. Anyone acting on that TODO from memory of the
old behaviour will silently disable captcha on the path they meant to protect.
Worth amending the comment to say so.

---

## 6. Incidental findings — pre-existing, not caused by 1.7

Reported because they were reproduced during this work, and because the first one
independently breaks login and would otherwise be attributed to the upgrade.

### 6.1 Every audited write throws a `TypeError` (login included)

`redactValue` builds prototype-free objects deliberately, to stop
`safe['__proto__'] = v` from mutating a prototype instead of recording a key
(`lib/audit.ts:215`):

```ts
const safe: Record<string, unknown> = Object.create(null);
```

Those objects are then passed straight into Drizzle as column values
(`lib/audit.ts:338`, as `oldData` / `newData`). Drizzle's `is()` guards `null` and
non-objects, but not a null prototype (`node_modules/drizzle-orm/entity.js:15`):

```js
if (!value || typeof value !== "object") return false;
if (value instanceof type) return true;
…
let cls = Object.getPrototypeOf(value).constructor;   // null.constructor → TypeError
```

Isolated:

```
plain object   -> false
null-proto obj -> THROWS: null is not an object (evaluating 'Object.getPrototypeOf(value).constructor')
null           -> false
array          -> false
```

Observed live as a `500` on the login-success path — `auditLog` called from
`lib/auth/login-guard.ts:271`, immediately after the password verified.

**Not a regression from this upgrade.** The `Object.create(null)` is present at
`HEAD`, and `drizzle-orm` is unchanged at `0.45.2` in this working tree.

**Fix at the boundary, not in the traversal.** The prototype-free guard is correct
where it is, and removing it would reopen the `__proto__` hole. Convert once,
where the value crosses into Drizzle. Note that a shallow spread is not enough:
`redactValue` recurses, so nested levels are prototype-free too. `clampJson`
already calls `JSON.stringify` on the value, so doing the round-trip there is
close to free.

**This is a class, not an instance.** Every `auditLog` caller that passes
`oldData` or `newData` is affected — user, permission, contact-change,
password-change and login paths. Sweep all call sites, or fix inside `auditLog` so
that no caller can get it wrong.

### 6.2 `trustedOrigins` is `[PUBLIC_ORIGIN]` only, and the failure codes are unmapped

Not a 1.7 change — `formCsrfMiddleware`, the `Sec-Fetch-*` logic and
`CROSS_SITE_NAVIGATION_LOGIN_BLOCKED` are all present in 1.6.26 at the same lines,
and `/sign-in/email` used the same middleware there. Recorded because it was
measured and because it interacts with the CORS policy.

With valid credentials (that is, after the §3 fix):

```
V1 no Origin, no Sec-Fetch (API client)   -> 200
V2 same-origin browser fetch              -> 200
V3 UNTRUSTED origin                       -> 403 {"message":"Invalid origin","code":"INVALID_ORIGIN"}
V4 cross-site NAVIGATE (form post)        -> 403 {"code":"CROSS_SITE_NAVIGATION_LOGIN_BLOCKED"}
V5 Sec-Fetch present but no Origin        -> 403 {"message":"Missing or null Origin","code":"MISSING_OR_NULL_ORIGIN"}
```

Measured context: `skipOriginCheck = false`, `skipCSRFCheck = false`,
`trustedOrigins = ["http://localhost:3000"]` — that is, `baseURL` and nothing
else, since `trustedOrigins` is not configured.

Three things follow:

- **A cross-origin front-end cannot sign in.** `trustedOrigins` defaults to
  `[baseURL]`. `app.ts`'s `CORS_POLICY` is a _separate_ list, so an origin CORS
  permits but `trustedOrigins` does not will pass preflight and then take a `403`
  on sign-in. Two lists that must agree and are maintained independently is the
  same drift hazard `CORS_POLICY` was extracted to prevent; if the front-end is
  ever served from another origin, derive both from one value.
- **All three codes are absent from `lib/auth/code-errors.ts`.** Unmapped codes
  fall through the `after` hook (`lib/auth.ts:217-238`), so the client gets raw
  English (`"Invalid origin"`) in an Arabic-only UI, and the hook `console.error`s
  a routine CSRF rejection as an application error. The map needs
  `INVALID_ORIGIN`, `MISSING_OR_NULL_ORIGIN` and
  `CROSS_SITE_NAVIGATION_LOGIN_BLOCKED` — and, while there, `SESSION_NOT_FRESH`
  and `METHOD_NOT_ALLOWED_DEFER_SESSION_REQUIRED` (§6.3).
- **The project's `before` hook runs ahead of this middleware**, so a request from
  an untrusted origin pays a full Argon2id verification, a database transaction, an
  audit write and a rate-limit slot _before_ the origin is ever checked —
  measured: untrusted origin plus wrong password answers `401`, not `403`. Not a
  vulnerability (the origin check still rejects), but the expensive work is ordered
  ahead of the cheap check. `V1` also shows the whole layer is browser-only: no
  `Origin` and no `Sec-Fetch-*` means no origin validation at all.

### 6.3 `POST /get-session` answers 405 with an unmapped code

`session.mjs:37` rejects `POST` unless `session.deferSessionRefresh` is set —
present in 1.6.26 too (`:42`), so not an upgrade change. `routes.ts` registers both
`GET` and `POST` for `/api/auth/*`, so the path is reachable:

```
GET  /api/auth/get-session -> 200 null
POST /api/auth/get-session -> 405 {"message":"POST method requires deferSessionRefresh to be enabled in session config","code":"METHOD_NOT_ALLOWED_DEFER_SESSION_REQUIRED"}
```

Either map the code, or stop advertising `POST` for that path in `ROUTE_PREFIXES`
and the OpenAPI document so the 405 comes from the project's own boundary with its
own envelope.

### 6.4 The `session_data` cookie is signed, not encrypted

Informational. With `cookieCache` enabled, the payload is base64url plus an HMAC
by default (`strategy: 'compact'`). Decoding the cookie produced by the
reproduction yields the full session, including `metadata.roleId`,
`metadata.roleName`, `metadata.roleScope` and the entire `permissions` object in
clear text. This is the user's own session, so it is not a leak _to_ anyone new —
but the permission matrix and role names travel in a client-readable cookie, and
`strategy: 'jwe'` (available in both 1.6 and 1.7) encrypts it if that is unwanted.
A decision, not a defect.

---

## 7. New features — value assessment for this project

| Feature                                                                                                                                                                                                                              | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`user.validateUserInfo`** — the one genuinely new option in 1.7 (`@better-auth/core/dist/types/init-options.d.mts:828`; the `ValidateUserInfo*` types are the only additions to the whole option surface between the two versions) | **No value here.** It fires on `create-user`, `link-account` and provider `sign-in` only; its own documentation states "Non-provider returning sign-ins are not re-validated." This project creates users with Drizzle, never through Better Auth, and has no providers — so it would never fire. The existing `databaseHooks.session.create.before` already occupies the equivalent seam, and 1.7's own docs point there for exactly this case.                                                                                                                                                                                            |
| **`advanced.database.joins`** (relocated from `experimental.joins`)                                                                                                                                                                  | **Worth measuring, not adopting blind.** `GET /get-session` is the hottest authenticated path — `GET_SESSION_LIMIT_PER_MINUTE = 300` exists precisely because every dashboard navigation hits it — and it currently costs two round trips (session, then user). Prerequisite: the Drizzle adapter resolves joins through `db.query`, and logs `The model "…" was not found in the query object` and falls back if the relations are not discoverable under Better Auth's model names (`index.mjs:310`, `:363`). `db/schema.ts` does define relations, so this is plausible but unproven. Route to `TODO.md` as a measurement, not a change. |
| **Adapter `incrementOne` / `consumeOne`** now required and implemented                                                                                                                                                               | **No direct value.** They are the internal adapter contract, not a helper exposed to project code. Worth knowing only because `incrementOne` is an atomic guarded increment — the same primitive `TODO.md` F-16 wants for `users.failed_login_attempts`, currently a `FOR UPDATE` on the `users` row. It does not make that item easier; it shows the library reached the same conclusion.                                                                                                                                                                                                                                                  |
| **Captcha exact-path matching**                                                                                                                                                                                                      | **Real security value, already delivered.** Closes the substring bypass with no configuration change (§5.1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Cookie-cache `version` / `strategy` / `refreshCache`**                                                                                                                                                                             | **Not new** (identical option sets in 1.6.26 and 1.7.1) but **unused and relevant.** `version` is a global cookie-cache invalidation lever, which is the mechanism `TODO.md` F-03 ("Stale Cookie Cache Allows Continued Access After Deactivation") is missing — bumping it invalidates every cached session at once. It is a blunt instrument rather than the per-user timestamp check F-03 proposes, but it is a real kill switch that exists today and costs nothing to know about. `strategy: 'jwe'` addresses §6.4.                                                                                                                    |
| **Telemetry** (`@better-auth/telemetry@1.7.1` is now an edge in the tree)                                                                                                                                                            | **No action.** Opt-in, default false, no new egress. Confirmed rather than assumed, because the package is a new dependency edge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Nothing else in 1.7 adds value here, because nearly all of the release is
OAuth-provider, SSO, SCIM and MCP work — surfaces this deployment deliberately
does not have.

---

## 8. Recommended plan

**First, decide whether to stay on 1.7.** Staying is the right call: the fix is one
column, the rest of the release is inert here, and it brings the captcha fix.
Downgrading means pinning `1.6.26` exactly — not `^1.6`, which floats straight
back — and giving up that fix.

1. **Fix the blocker (§3).** Column, constant, check constraint, unique index,
   both insert sites, migration, `db:generate` clean.
2. **Fix §6.1** at the `auditLog` boundary, and sweep every caller. Do this
   _before_ re-testing login, or the §3 fix will still surface as a 500 and look
   as though it failed.
3. **Pin `package.json` to `^1.7`** for `better-auth` and `@better-auth/core`;
   decide on the `@better-auth/utils` exact pin (§1).
4. **Map the missing error codes** (§6.2, §6.3).
5. **Correct the three stale documentation sites** and close `TODO.md` EM-15
   (§5.1).
6. **Decide `trustedOrigins`** once the front-end origin is known, and derive it
   and `CORS_POLICY` from one value (§6.2).
7. **Add the sign-in end-to-end test** (§9). This defect class is invisible to both
   existing gates, so the fix is not finished until something can fail.

Steps 1 and 2 are the only ones blocking a working login. Steps 3–6 are
correctness and hygiene. Step 7 is what stops the next one.

**No deployment changes.** `reports/coolify-deployment.md` needs no new environment
variable, start command, scheduled task or gate for this upgrade — only the §12.5
correction in step 5. The migration in step 1 runs through the existing
`bun run db:migrate`.

---

## 9. Test gaps this exposed — route to `reports/test-strategy.md`

The framing that matters: **a complete authentication outage passed
`tsc --noEmit` and 150/150 probes.** Every assertion below exists because
something shipped that those two gates could not see.

1. **`POST /api/auth/sign-in/email` with correct credentials returns 200 and sets
   a `session_token` cookie.** In-process via `auth.handler` (or `app.handle`)
   against a seeded user. This one assertion catches the entire §3 class. It must
   assert the 200 _and_ the cookie, not merely "not 500" — the defect's signature
   is a well-formed 401.
2. **The credential account row satisfies Better Auth's own predicate.** Assert
   that a freshly created account has `issuer = 'local:credential'` and
   `accountId = user.id`. A unit-level guard that fails at the row, not four layers
   later at the response.
3. **`auditLog` with `oldData`/`newData` inserts successfully** against a real
   database, including a nested object, so §6.1 cannot come back. A test that only
   calls `stripSensitive` and inspects the result proves the redaction, not the
   insert — the defect is entirely at the Drizzle boundary.
4. **Captcha fires on the configured endpoint, and only on it.** Assert
   `400 MISSING_RESPONSE` for `/sign-in/email` with no header, and `404` — not
   `400` — for `/api/auth/zz/sign-in/email/zz`. That second assertion is what
   detects the matching semantics changing again in either direction.
5. **The full allowed-path surface, table-driven over
   `BETTER_AUTH_ALLOWED_PATHS`:** sign-in → get-session (cached) → get-session
   (`disableCookieCache=true`) → sign-out, asserting the session row count drops to
   zero. This is the S1–S5 sequence from §3, and it exercises session create, read
   and delete through `drizzle-orm/bun-sql` — a driver/adapter pairing nothing else
   in the suite covers.
6. **Origin behaviour is pinned** (§6.2): same-origin 200, untrusted origin 403,
   no-Origin-no-Sec-Fetch 200. The third is the one worth writing down, because it
   records that the protection is browser-only.
7. **Every `BASE_ERROR_CODES` key Better Auth can return on an allowed path has an
   Arabic mapping.** Derivable: iterate the library's exported codes, filter to
   those reachable from the four allowed paths, assert each is in the project's
   map. That turns §6.2 and §6.3 into a check that fails on the next unmapped code
   instead of a list that goes stale.

---

## 10. Routing

Per `CLAUDE.md`, three items belong in other files rather than in code. Not yet
applied — this report only records them:

- **`reports/test-strategy.md`** — §9, as a new subsection of §7 (the assertion
  catalogue), sitting alongside §7.4 (PostgreSQL driver) and §7.6 (integration
  behaviour). Same shape as those: assertions that exist because something shipped
  broken. Note that §7.1d already covers the Better Auth **path allowlist** — the
  assertions here are about the credential _account shape_ and the sign-in
  contract, which that section does not reach. Assertion 1 (sign-in returns 200
  and sets a cookie) is the one to add first; it is a single test that would have
  caught a total auth outage.
- **`TODO.md`** — the `advanced.database.joins` measurement (§7), the
  `trustedOrigins` / `CORS_POLICY` single-source decision (§6.2), the
  `@better-auth/utils` pin decision (§1), the `session_data` encryption decision
  (§6.4), and closing **EM-15** as fixed upstream (§5.1).
- **`reports/coolify-deployment.md`** — §12.5's captcha paragraph is now factually
  wrong (§5.1). Nothing else in the runbook changes: no new variable, no new
  command, no new gate.

---

## Appendix A — how each claim was verified

| Claim                                         | Method                                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Tree is on 1.7.1; `HEAD` was 1.6.26           | `node_modules/*/package.json`; `git diff bun.lock`; `git show HEAD:package.json`                                                         |
| 1.7 requires `issuer`; 1.6 did not            | Read both `dist/api/routes/sign-in.mjs` side by side (1.6.26 unpacked from the registry into a scratch directory, never installed)       |
| `issuer` is required and uniquely indexed     | `@better-auth/core/dist/db/get-tables.mjs:201-208`                                                                                       |
| `'local:credential'` is the value             | `@better-auth/core/dist/db/schema/account.mjs:38-40`                                                                                     |
| Live table has no `issuer`                    | `information_schema.columns` on the dev database                                                                                         |
| Login returns 401 with correct credentials    | End-to-end `auth.handler` reproduction (Appendix B)                                                                                      |
| Adding `issuer` fixes it completely           | Same harness with the column added; S1–S5 all pass                                                                                       |
| Failure is silent, not a SQL error            | `@better-auth/drizzle-adapter/dist/index.mjs:76` (bare `db.select()`); the guards at `:126`, `:211`, `:265` are where-clause/create-only |
| Passwordless is unaffected                    | `lib/auth/passwordless.ts` reads `findUserById` and `createSession` only; no `accounts` access anywhere in the file                      |
| Captcha semantics changed                     | 1.6.26 `plugins/captcha/index.mjs:29` vs 1.7.1 `:12-16`, `:28`; four live requests                                                       |
| Error codes identical                         | `comm` over both `error/codes.mjs` — 49 each, no difference                                                                              |
| Option surface: only `validateUserInfo` added | `comm` over `BetterAuthOptions`, `BetterAuthAdvancedOptions`, `session` and `session.cookieCache` keys in both `init-options.d.mts`      |
| Rate-limit contract already satisfied         | `@better-auth/core/dist/types/init-options.d.mts:142-165` vs `lib/rate-limit/auth-storage.ts:35`                                         |
| Telemetry off by default                      | `@better-auth/telemetry/dist/index.mjs:360`                                                                                              |
| Secret guard still valid                      | `better-auth/dist/utils/constants.mjs:2`; `types/secret.d.mts` identical in both                                                         |
| Drizzle null-prototype throw                  | Isolated call to `is()` from `drizzle-orm/entity.js`; observed live at `lib/auth/login-guard.ts:271`                                     |
| Audit defect is pre-existing                  | `git show HEAD:lib/audit.ts`; `drizzle-orm` unchanged at `0.45.2` per `git diff bun.lock`                                                |
| Origin/CSRF behaviour                         | Five live requests with valid credentials; `skipOriginCheck` read from the live auth context; `create-context.mjs:210`                   |
| `POST /get-session` 405 pre-dates 1.7         | 1.7.1 `session.mjs:37` vs 1.6.26 `session.mjs:42`                                                                                        |
| Build and suite state                         | `bun run build` → exit 0; `bun run test` → 150 pass / 0 fail                                                                             |

## Appendix B — the reproduction

Ad-hoc, and **deliberately not kept** — it seeded and deleted rows in the dev
database and temporarily patched two tracked files. Both files were restored and
checksum-verified (`lib/audit.ts` `66691c4d…`, `db/schema.ts` `f5d2d56b…`), the
temporary `issuer` column was dropped, every seeded row was deleted (`users`,
`roles`, `sessions`, `audit_logs` and `accounts` all back to 0), and no scratch
script remains in the working tree. §9 exists so this becomes a real test instead
of a one-off.

Shape, for whoever writes that test:

1. Seed a role, a user and a credential account directly with Drizzle or SQL, using
   **UUID v7** ids. `validID` (`utils/index.ts:507`) rejects v4, so
   `gen_random_uuid()` fails the `databaseHooks.session.create.before` gate with a
   401 that looks exactly like the §3 defect. This cost a false lead; use
   `generateUuidV7` from `@/lib/id`.
2. Hash with the project's own `hashPassword(password: string)` — note it takes a
   bare string, not an options object.
3. Use an allowlisted email domain: `emailSchema`
   (`utils/validation/rules.ts:164`) permits only gmail / outlook / hotmail / live
   / yahoo. Anything else fails the `before` hook's `loginSchema` parse with a 422
   before Better Auth is reached at all.
4. Send `cf-connecting-ip` (the per-IP limiter fails closed without a trusted
   header) and `x-captcha-response` (the development Turnstile test secret accepts
   any value).
5. Probe at two depths: the exact predicate from `sign-in.mjs:319` evaluated
   against `internalAdapter.findUserByEmail(email, { includeAccounts: true })`, and
   the full `auth.handler` response. The first localises the cause; the second
   proves the contract.
6. Re-seed between origin cases — a rejected attempt increments
   `failed_login_attempts`, and the per-account lockout will otherwise mask later
   results.
