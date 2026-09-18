# User preferences and dashboard customization

A design recommendation for persisting per-user UI settings. Nothing here is
built yet. The frontend (`soft-house-dash-4`) keeps every setting in
`localStorage`; the backend knows nothing about them.

**Recommendation in one line:** a separate `user_preferences` table holding one
bounded `jsonb` bag of enumerable values — never a column on `users`, never
`sessions.metadata`, and no free-form style overrides in v1.

Out of scope by instruction: interface language / i18n, and per-user timezone.
Neither appears below except where an existing constraint makes the omission
load-bearing.

---

## 0. What exists today

### Frontend — three stores, two persisted

| Store                                               | Persistence                       | Contents                                                                                                                 |
| --------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `utils/store/setting.ts`                            | `localStorage` `settings`         | `themeLayout` (`vertical` \| `horizontal` \| `mini`)                                                                     |
| `components/theme-customizer/store/editor-store.ts` | `localStorage` `editor-storage-2` | `themeState` (`preset`, `styles.light`, `styles.dark`, `currentMode`, `hslAdjustments`), `containerStretch`, `fontScale` |
| `utils/store/data-table-store.ts`                   | **none — URL only**               | `page`, `perPage`, `sort`, `filters`, `joinOperator`, `search`                                                           |

Light/dark itself is `next-themes`, which keeps its own key and injects its own
blocking script.

Measured, by serialising the defaults:

```
editor-storage-2 JSON bytes: 2635
themeState alone bytes:      2559   (43 CSS custom properties x light + dark)
built-in presets:            52 presets, 126779 bytes of source
```

`2559` of those `2635` bytes are **derived**: `getPresetThemeStyles(preset)`
regenerates them from a preset id, and all 52 presets already ship in the
frontend bundle. This number decides most of what follows.

### Backend — nothing, and one wrong idea already written down

No preferences table. No `GET /api/dash/users/me` — the `me` tree is
change-email, change-password, change-phone and their verify steps only. The
frontend's only bootstrap read of the current user is Better Auth's
`GET /api/auth/get-session`.

`TODO.md:202` contemplates putting "future feature flags, preferences" into
`session.metadata`. Section 2 is the argument against that; treat the TODO line
as superseded.

---

## 1. Client or server

### The benchmark finding

Fifteen products were checked against primary vendor documentation (§12). The
common assumption — _appearance is client-only, identity is server-side_ — does
not hold. **Every** product whose storage model could be verified (Directus,
Grafana, GitLab, Strapi, WordPress, Payload) persists theme and appearance
server-side, per user, light/dark included.

Flash-of-wrong-theme is not solved by keeping theme on the client. It is solved
by a cookie the server can read during SSR, or a blocking inline `<script>` in
`<head>`. In that literature `localStorage` is the _pre-paint cache_, not the
record of truth.

### So: both, with distinct jobs

`localStorage` stays the **first-paint source**. The server is the **sync and
portability layer**. Read order:

```
localStorage → paint → GET preferences → reconcile (last write wins on updated_at)
```

`next-themes` already covers light/dark with its own blocking script, but the
custom properties are applied in a layout effect in
`components/theme-customizer/theme-provider.tsx`, so a small FOUC window exists
today. Server persistence does not widen it — the client still paints from
`localStorage` first. Closing it means a blocking inline script in
`pages/_document.tsx`, or a cookie for SSR. Separate piece of work, not a
prerequisite.

### Settings by tier

| Tier               | Settings                                                                               | Status here                              |
| ------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------- |
| Table stakes       | color mode (light/dark/system); notification toggles                                   | mode: client-only. notifications: absent |
| Common / modern    | first-day-of-week; home/landing page; per-table column visibility and order; page size | all absent                               |
| Differentiating    | full custom theme builder                                                              | present — ahead of most of the field     |
| Not worth building | keyboard-shortcut remapping — GitHub explicitly declines it, nobody surveyed offers it | —                                        |

### On data-table preferences

Worth building, but the original framing of this document was wrong and the
correction changes the estimate. There is **no server-side registry of displayed
columns** to hang them on. `lib/data-table/column-specs.ts` describes what may be
**filtered** — `USERS_FILTER_COLUMNS` is five columns against a `SELECT` that
projects more — and `parsers.ts` bounds filter/sort/page input. Neither knows
what the table renders.

On the client, table state lives in the **URL**, not in a persisted store. So
"remember my columns" is a new concept on both sides, not a persistence layer
over something that exists. WordPress (screen options) and Payload scope this per
user; Strapi scopes it per content-type shared across all admins and takes
criticism for it. Build it last (§8), and see §8 for why it probably wants a
different row model.

---

## 2. Where preferences live

### Not `sessions.metadata`

`refreshRoleSessions` and `refreshUserSessions` (`lib/permissions/utils.ts`)
merge a patch into the session row with jsonb `||`, overlaid onto
`COALESCE(metadata, '{}'::jsonb)`. That structure holds `permissions`, `roleId`,
`roleName`, `roleScope` — the authorization cache the permission checker reads.

Today both writers build the patch server-side from role rows, so nothing
caller-supplied reaches that rail. A preferences write on the same rail is what
would change that, and an object carrying a `permissions` key merges straight
into the authorization cache. Keeping preferences in a different table means the
rail stays unreachable with user input, which is a stronger guarantee than
remembering to sanitize keys at each future call site.

Lifecycle is wrong too. Sessions are N-per-user, so one preference write fans out
across every live session, and rows are deleted 30 days past `expiresAt`
(`db/maintenance.ts`) — preferences would evaporate after logout.

### Not a column on `users`

**It sits on the hottest read path, and this is now verified rather than
assumed.** Better Auth's `findSession` (`node_modules/better-auth/dist/db/internal-adapter.mjs`)
calls `adapter.findOne({ model: 'session', where, join: { user: true } })` with
**no `select`**. The Drizzle adapter's `findOne` then runs
`db.query.sessions.findFirst({ columns: undefined, with: { user: true } })`
(`node_modules/@better-auth/drizzle-adapter/dist/index.mjs:342`) — every column of
`sessions` and every column of `users`, on every cookie-cache miss. A blob on
`users` is read constantly by code that never uses it.

Note this is **not** `assertLiveSession`: that function projects `sessions.id`
alone and joins `users` only as a predicate. It is not the amplification site.

**The compensating benefit is unavailable.** Verified in better-auth 1.7.3:
`parseUserOutput` calls `filterOutputFields` over `getFields(options, 'user', 'output')`
(`dist/db/schema.mjs`), which is the core schema plus `user.additionalFields`
plus plugin fields. An **undeclared** column is stripped from the session payload
— full read cost, no benefit. A **declared** one lands inside the signed
`cookieCache` (`lib/auth.ts`, `maxAge: 5 * 60`): transmitted on every request and
stale for up to five minutes after every change.

The cookie size framing in the previous revision of this document was wrong and
is corrected here: 1.7.3 **chunks** the session-data cookie across up to 100
cookies at 4050 bytes each (`dist/cookies/session-store.mjs`), so 2.6 KB is not a
wall. The cost is bytes on every request and a five-minute staleness window on a
setting the user just changed — which is worse UX than a separate fetch, not
better.

**Row lifecycle differs, though not the way it first appears.** `users` rows are
soft-deleted and never purged, by design — `auditLogs.userId` is
`onDelete: 'restrict'`, and the reasoning is recorded on the `deletedAt` column.
That means a `cascade` FK on a side table **never fires**, so the cleanup is an
explicit delete in the soft-delete handler, exactly like `tx.delete(accounts)`
there today. See §7.

**Precedent agrees.** GitLab is actively migrating settings _off_ `users` into a
`user_preferences` table to stop the table widening (issues #51191, #442489).
Grafana never put them there — its `preferences` table serves org/team/user
scopes from one table via nullable foreign keys.

---

## 3. Schema

Follow `two_factor_credentials`, which is this repository's existing one-row-per-user
table: surrogate `id`, unique index on `user_id`, shared `...timestamps`.

```ts
export const userPreferences = pgTable(
  'user_preferences',
  {
    id: uuid('id').primaryKey().$defaultFn(generateId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ui: jsonb('ui').$type<StoredPreferences>().notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('ux_user_preferences_user').on(t.userId),
    check('chk_user_preferences_size', sql`pg_column_size(ui) <= 4096`),
  ]
);
```

Add `userPreferences` to the relations block and export `UserPreference` /
`NewUserPreference` beside the other `$inferSelect` pairs.

### Traps this schema has to clear

- **Use the local `jsonb` helper** defined at the top of `db/schema.ts`, never the
  `drizzle-orm/pg-core` export. The comment above it explains the double-encode
  under `bun:sql`; a new column reaching for the import reintroduces it.
- **Spell the CHECK's bound out as a literal.** `check()` cannot interpolate a
  constant: drizzle-kit **drops** interpolated params instead of inlining them,
  generating invalid DDL that only fails when the migration is applied — the
  reason `chk_credential_issuer` duplicates its literals. So a shared
  `PREFERENCES_JSON_MAX` in `utils/validation/constants.ts` bounds the **Zod**
  schema, and the SQL says `4096` in full, with the two kept in step by hand.
- **`fromDriver` is a pass-through — the column trusts its writers.** Parse at the
  read boundary (§4). An `as StoredPreferences` on the way out is an unverified
  assumption that breaks silently when the shape drifts.

Measured on PostgreSQL 18.6, because the bound is only worth writing if it holds:
a CHECK is evaluated **before** TOAST compression, so
`pg_column_size(ui) <= 4096` rejected a 200 KB highly-compressible document at
`INSERT` (temporary table, dropped after). The bound is real, not a bound on the
compressed size.

### What goes in the bag

```
{ preset, hslAdjustments, fontScale, containerStretch, themeLayout, colorMode }
```

Roughly 150–250 bytes against the 2635 measured in §0. The client materialises
`styles.light` / `styles.dark` from the preset id. **Store inputs, not
materialised output** — the server has no business holding a second copy of a
stylesheet whose source of truth is a frontend bundle, and a preset edit in the
frontend would strand every stored copy.

### No typed columns in v1

The hybrid model (Grafana's) is right in principle: typed columns for what the
**server** must act on with no browser present, `jsonb` for the pure-UI bag. With
i18n and timezone out of scope, **nothing in v1 is server-acting** — every value
above is read only by the browser. A typed `color_mode` column would be
ceremony: this backend renders no HTML, so it never consults it.

Add the first typed columns when notification preferences arrive (§8), where the
SMTP path genuinely reads them before any browser request exists. Adding a column
to a five-row-wide table is a routine migration; guessing at it now is not.

---

## 4. Validation — the part that actually matters

### `getColorSchema()` does not fit, and this is the main correction

The previous revision recommended validating override colors with
`getColorSchema()` from `utils/validation/rules.ts`. That is wrong on the format:
the theme values are **bare HSL component strings** — `'0 0% 100%'`,
`'172 98% 40%'` (`components/theme-customizer/config/theme.ts`) — interpolated
into `hsl(var(--x))`. `getColorSchema` matches `/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/`,
so it rejects every real value. It is also unreferenced anywhere in the
repository today, so adopting it would be adopting an untested helper for a
format it does not describe.

`ThemeStyleProps` is not colors anyway. It mixes HSL triplets, CSS lengths
(`radius`), a font-family string (`font-mono`), and numeric strings
(`shadow-blur`, `shadow-opacity`). One schema cannot describe it.

### Why that matters more than it looks

`applyStyleToElement` (`components/theme-customizer/utils/apply-style-to-element.ts`)
does not use `setProperty`. It **concatenates into the `style` attribute**:

```ts
element.setAttribute('style', `${cleanedStyle}--${key}: ${value};`);
```

and in `apply-theme.ts` a value beginning with `var(` bypasses `colorFormatter`
and is passed through verbatim. A stored value of
`var(--x); background-image: url(https://…)` therefore injects a declaration into
`<html style>`.

Today that is self-inflicted — the only writer is the user's own `localStorage`.
It stops being self-inflicted the moment the server stores these values, and
stops being theoretical if the role/default cascade in §9 is ever built, because
then one account's stored string renders in another account's browser.

### So v1 stores no free-form overrides

Only the enumerable set:

| Field              | Rule                                                                          |
| ------------------ | ----------------------------------------------------------------------------- |
| `preset`           | `z.enum` over the preset ids, or a bounded slug pattern mirrored client-side  |
| `colorMode`        | `z.enum(['light', 'dark', 'system'])`                                         |
| `themeLayout`      | `z.enum(['vertical', 'horizontal', 'mini'])`                                  |
| `fontScale`        | number, `0.875 ≤ x ≤ 1.125`, snapped to the 0.025 step in `FONT_SCALE_CONFIG` |
| `containerStretch` | boolean                                                                       |
| `hslAdjustments`   | three bounded finite numbers                                                  |

Every one of these is a closed set or a bounded number. Nothing reaching the
`style` attribute is a string the user chose. If free-form overrides are wanted
later, the prerequisite is fixing `applyStyleToElement` to use
`CSSStyleDeclaration.setProperty` and dropping the `var(` passthrough — a
frontend change, and a precondition, not a follow-up.

### Follow the existing jsonb-validation pattern

`utils/validation/permissions.ts` is the model, and it is the closest existing
analogue — a client-supplied document that lands in a `jsonb` column:

- `.strict()` on every object, so a misspelled key is a 422 and not a silent drop
  (the comment there records exactly that bug).
- Validate the **raw wire shape first**, normalise after. The same file records
  what happens when a `z.preprocess` rebuilds the object before `.strict()` sees
  it.
- Arabic user-facing messages in a local `ERROR_MESSAGES` / `*ValidationMsg`
  object, matching `mediaValidationMsg` and the permissions module. New file:
  `utils/validation/preferences.ts`.
- `zodIssueMessage(parsed.error)` → `HTTP_STATUS.UNPROCESSABLE`, as every handler
  does.

### The read boundary

`sanitizePermissions` (`lib/permissions/utils.ts`) is the house pattern for
reading an untrusted jsonb document: take `unknown`, iterate a **known** key set,
rebuild a total typed shape, compare with `=== true` rather than truthiness, and
guard key lookups with `Object.hasOwn` against prototype pollution.

`sanitizePreferences(raw: unknown): Preferences` in that shape is also the
defaults-merge function §9 asks for. One function, both jobs: merge over
`DEFAULT_PREFERENCES`, key by key, dropping anything unrecognised. A stored
document that predates a field then reads as the default instead of `undefined`,
which is what makes adding a field a code change rather than a data migration.

---

## 5. The endpoint

**`PUT`, not `PATCH`.** `HttpMethod` in `lib/http/route-manifest.ts` is
`'GET' | 'POST' | 'PUT' | 'DELETE'`, and the 405 boundary in `app.ts` builds its
`Allow` header from that manifest. A `PATCH` route would mean widening the union,
the OpenAPI generator and the adapter registration — a framework change to add a
preference. Full replace also matches the merge-over-defaults model: the client
holds the whole document anyway.

```ts
{
  method: 'GET',
  path: '/api/dash/users/me/preferences',
  handler: mePreferences.GET,
  preAuth: 'ip-limit',
  auth: 'session',
  captcha: false,
  handlerRateLimit: true,
  body: 'none',
  response: 'envelope',
},
{
  method: 'PUT',
  path: '/api/dash/users/me/preferences',
  handler: mePreferences.PUT,
  preAuth: 'ip-limit',
  auth: 'session',
  captcha: false,
  handlerRateLimit: true,
  body: 'json',
  response: 'envelope',
},
```

`auth: 'session'` is correct: preferences are the caller's own, so no grant is
consulted. `handlerRateLimit: true` is a **declaration** that the handler calls
the limiter itself — it enforces nothing, so the handler must actually do it.

Handler shape, from `app/api/dash/users/me/change-password/handler.ts`:
`requireSession(ctx)` → `enforceRateLimit({ scope: 'users.me.preferences.put', identifier: userIdentifier(userId), limit: … })`
→ `requireJsonBody(await ctx.readJson())` → `safeParse` → single
`INSERT … ON CONFLICT (user_id) DO UPDATE` → `apiSuccess`. No `withTransaction`:
it is one statement.

Rate-limit the write on purpose — a dragged slider is a write storm. `captcha:
false` is right; this is not a credential path.

**Do not `auditLog` preference writes.** `audit_logs` has **no retention sweep at
all** — `db/maintenance.ts` names it as deliberately untouched, and the table
comment says a bare `DELETE` is never the answer. High-frequency, zero-value rows
in a table that grows forever is a worse trade than the lost history is worth.

**Body ceiling.** A JSON route inherits `MAX_JSON_BODY_BYTES` (1 MiB,
`lib/http/request.ts`), so the real ordering is: 1 MiB transport ceiling → Zod
schema → the 4 KB CHECK as backstop. `maxJsonBodyBytes` exists per route for
tightening this, but no route in the table uses it today; taking the default
keeps this route indistinguishable from its neighbours, which is the right
default until there is a reason.

**Messages.** Endpoint-level copy goes in `app/api/dash/users/messages.ts`
alongside `userMsg`; validation copy in the new
`utils/validation/preferences.ts`. Both Arabic, matching everything around them.

**Where new tests come from for free.** A mutating route added to `routes.ts` is
swept into `tests/integration/mutating-route-authorization.test.ts` the moment it
exists — it walks the table, not a list — and into
`tests/unit/openapi-contract.test.ts`. So the route is proved to refuse an
anonymous caller and to refuse before reading the body without anyone writing a
test. Behaviour tests (round-trip, oversize rejection, unknown-key rejection)
still have to be written.

---

## 6. Caching

Do not adopt `lib/cache/` for this. Its header marks it **SCAFFOLD — no call site
uses this yet** and requires the first caller to decide and write down four
things: the key namespace grammar, the total on-disk budget and what enforces it,
the invalidation trigger, and whether decoded values need schema validation. A
single-row primary-key lookup on a table with one row per user is cheaper than
any of those decisions.

---

## 7. What the first patch has to touch

1. `db/schema.ts` — table, relations entry, `UserPreference` / `NewUserPreference`
   type exports.
2. `bun run db:generate` → a new file in `db/drizzle/`, then `bun run db:migrate`.
   `bun run check:schema-drift` runs in the pre-push gate and fails if generate
   was skipped. No hand-written SQL in `db/migrations/` is needed — no extension,
   no trigram index, and `ui` is never searched with `ILIKE`.
3. `app/api/dash/users/me/preferences/handler.ts` — `GET` and `PUT`.
4. `routes.ts` — two rows and the import.
5. `utils/validation/preferences.ts` — schema, defaults, `sanitizePreferences`.
6. `utils/validation/constants.ts` — `PREFERENCES_JSON_MAX`.
7. **`app/api/dash/users/[id]/handler.ts`, the `DELETE` path.** The FK cascade
   never fires, because users are soft-deleted and never purged. That handler
   already deletes side-table rows explicitly inside its transaction
   (`tx.delete(accounts)`, the custom role, `revokePendingProofs`); add
   `tx.delete(userPreferences)` there. Without it, every deleted user's
   preferences persist forever with no owner.
8. Frontend: read-through in both zustand stores — hydrate from `localStorage`,
   then reconcile against `GET`, and write through on change (debounced, since
   the server limiter will otherwise reject a dragged slider).

**No Coolify impact.** No new environment variable, scheduled task, storage or
process-lifecycle requirement, so `reports/coolify-deployment.md` is unaffected.

---

## 8. Build order

1. **The table, the two routes, the schema, the client read-through.** Everything
   above.
2. **Accessibility: reduced motion, high contrast.** Cheap, and both are pure
   client behaviour on an already-bounded enum. Note `circular-transition.css`
   exists but its import in `theme-provider.tsx` is currently commented out.
3. **Landing page / default route.** `DASHBOARD_PAGE_NAMES` (`home`, `users`,
   `permissions`, `media`) enumerates the candidates, but it is also the
   `page_name` pgEnum backing the permission matrix — so validating against it
   couples a preference to the permission model, and extending it is a migration.
   More importantly the stored value must be **re-checked against the caller's
   grants at redirect time**, not just at write time: a role change can strip
   access to the page someone chose, and a preference must never be the thing
   that decides where an unauthorized user lands.
4. **Notification preferences.** Server-side by necessity — the SMTP path needs
   them before any browser request exists. This is where the first typed columns
   earn their place (§3).
5. **Data-table preferences.** The one that argues for Payload's
   `(user_id, key, value)` row-per-key model rather than one blob, because it is
   keyed per table and grows with the table count. Start with the single blob and
   split this out when it arrives — not before. Remember from §1 that this needs
   a new server-side notion of displayed columns _and_ a client store that
   currently does not persist anything.

---

## 9. Design for, do not build

**Cascade.** Roles exist, so Grafana's system → org → team → user maps here to
default → role → user. Do not build it now. Do resolve preferences through
`sanitizePreferences` merging over `DEFAULT_PREFERENCES` (§4) rather than relying
on column defaults, so adding a role tier later is a code change and not a
migration. If it is ever built, the override-validation precondition in §4 stops
being optional.

---

## 10. Open decisions

- **Per-device versus per-account.** `themeLayout` and `containerStretch` are
  arguably per-device — a mini sidebar suits a laptop, vertical suits a desktop.
  No vendor in the survey documents such a split. Recommendation: everything
  per-account for v1; split only if it proves annoying in use.
- **Whether `colorMode` ever becomes a typed column.** Only if something
  server-side renders for the user. Today nothing does.
- **Whether preferences survive a soft-delete.** Recommendation: delete them
  (§7.7), matching the anonymisation the handler already performs. The opposite
  choice is defensible if undelete is ever wanted; it has to be made explicitly
  either way, because the FK will not make it.

---

## 11. Assumptions, and what was not verified

**Assumed:** the two repositories are one system (backend `soft-house-dash-3`,
Next.js frontend `soft-house-dash-4`); single-tenant per deployment, so there is
no org tier between role and user.

**Verified since the previous revision:** Better Auth's `findSession` passes no
column projection, so the `select *` fallback is what runs (§2). The previous
revision listed this as unverified and noted it did not change the
recommendation; it does not, but it is now a fact rather than a caveat.

**Not verified:** the exact JSON byte size of the proposed bag — 150–250 bytes is
arithmetic on the field list, not a measurement, and it is two orders of
magnitude under the CHECK either way. Also not measured: whether a debounced
write-through at any realistic slider cadence stays under a chosen limiter budget
— pick the limit when the frontend debounce interval is chosen, not before.

**Flagged, not fixed:** the `style`-attribute concatenation in
`apply-style-to-element.ts` is a live frontend defect independent of this work. It
is currently only self-exploitable. It is named here because it sets the
precondition for ever storing free-form overrides server-side, and it belongs in
the frontend repository's own backlog.

---

## 12. Sources

Primary vendor documentation unless noted.

| Product                                                          | Storage model                                                                                                                                       | Source                                                                             |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| WordPress                                                        | key/value EAV, `wp_usermeta`                                                                                                                        | `developer.wordpress.org/reference/functions/admin_color_scheme_picker/`           |
| Directus                                                         | typed columns on `directus_users`; instance default → per-user override                                                                             | `directus.com/docs/reference/system/users`                                         |
| Strapi                                                           | 2 per-user fields; list-view columns shared per content-type                                                                                        | `docs.strapi.io/cms/features/content-manager`                                      |
| Payload                                                          | key/value table `payload-preferences`, one row per key per user                                                                                     | `payloadcms.com/docs/admin/preferences`                                            |
| Grafana                                                          | hybrid: typed columns + one `JSONData` blob, one table for org/team/user; user preferences documented to take precedence over team, org and default | `grafana.com/docs/grafana/latest/administration/user-management/user-preferences/` |
| GitLab                                                           | migrating `users` columns → `user_preferences` table                                                                                                | `gitlab.com/gitlab-org/gitlab/-/issues/442489`, `.../gitlab-foss/-/issues/51191`   |
| GitHub                                                           | server, account-scoped; declines shortcut remapping                                                                                                 | `docs.github.com/en/get-started/accessibility/managing-your-theme-settings`        |
| Sanity, Contentful, Ghost, Jira, Linear, Notion, Shopify, Stripe | storage not publicly documented — settings surface only                                                                                             | —                                                                                  |

Grafana's cascade and Payload's preferences collection were confirmed verbatim
against vendor documentation; they are the two strongest models to copy.

**Gaps, flagged rather than filled:** no vendor publishes a case of a setting
regretted as _should have been per-device_, no telemetry on unused personalization
settings, and no documented example in any surveyed product of an explicit
preferences-blob schema version with migrate-on-read. Grafana's
`Preference.Version` field is optimistic concurrency control, not a schema
version — do not conflate them.
