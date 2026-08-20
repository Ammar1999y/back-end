# Response to the PostgreSQL driver-swap review

Pass completed 2026-08-20 against
[`reports/postgres-driver-swap-review.md`](postgres-driver-swap-review.md).

**Result: all four findings were real. Three are fixed as asked; one is fixed
in half, and the half I declined is argued below rather than quietly dropped.**

The review's scope statement is accepted as-is: the driver swap, the SQLSTATE
relocation, the jsonb double-encode fix, the migration ledger, the pool ceiling
and the lazy-connect property were independently reproduced, and every gate
passed. Nothing in this document disputes that half. `better-auth` stays out of
scope, including the now-unreferenced `authGet` / `authSet` statements —
`TODO.md` PG-3 owns them.

Gates after this pass, run rather than assumed:

| Gate                                             | Result                                               |
| ------------------------------------------------ | ---------------------------------------------------- |
| `bun run verify` (all 9 local gates)             | PASS                                                 |
| `bun run lint` (tsc + eslint)                    | PASS                                                 |
| `bun run format:check`                           | PASS                                                 |
| `bun run test`                                   | **156 pass / 0 fail across 9 files**                 |
| `bun run probe:db` (new)                         | **12 pass / 0 fail across 2 files**                  |
| `bun scripts/find-unused-files.ts`               | PASS                                                 |
| `bun run smoke`                                  | 7/7                                                  |
| `bun run db:generate`                            | "No schema changes" — and now with no `DATABASE_URL` |
| `bun install --frozen-lockfile`                  | PASS                                                 |
| `bun audit`, `actionlint`, `semgrep`, `gitleaks` | PASS                                                 |

Two numbers moved, and the movement is the point of finding 2. The probe suite
went from **150 to 156** assertions across the same 9 files, because the field
this driver actually populates had no coverage at all. And `bun run probe:db`
reports a number for the first time: that script did not exist, so the command
this repository documented in three places had never worked.

---

## 0. Verdict per finding

| #   | Finding                                     | Severity | Review was          | Now                                                    |
| --- | ------------------------------------------- | -------- | ------------------- | ------------------------------------------------------ |
| F1  | `PgErrorFields` hand-authored, not imported | MEDIUM   | CORRECT             | Fixed — `Pick<SQL.PostgresError, …>`                   |
| F2  | Fixed regression has no test; fixture wrong | MEDIUM   | CORRECT             | Fixed at two seams; one placement declined, with cause |
| F3  | `fromDriver` dropped the self-healing parse | LOW      | CORRECT on the fact | Documented; the throw declined, with cause             |
| F4  | `drizzle.config.ts` demands `DATABASE_URL`  | NIT      | CORRECT             | Fixed — `dbCredentials` and the throw both removed     |

One thing the review could not have known is in §5: `reports/test-strategy.md`
was rewritten mid-pass, so its §11 is now §7.4 and the section numbers the
review cites have moved.

---

## 1. F1 — the library type. Accepted, applied.

Verified at `node_modules/bun-types/sql.d.ts`, inside `declare module "bun"` →
`namespace SQL`:

```ts
class PostgresError extends SQLError {
  public readonly code: string;
  public readonly errno?: string | undefined;
  public readonly constraint?: string | undefined;
  // … detail, hint, severity, position, schema, table, column, dataType, file, line, routine
}
```

`utils/index.ts` now reads:

```ts
import type { SQL } from 'bun';

type PgErrorFields = Pick<SQL.PostgresError, 'code' | 'errno' | 'constraint'>;
```

Three points worth recording rather than just complying:

- **The browser constraint is genuinely satisfied**, not merely assumed to be.
  `import type` erases at compile time, so `lib/data-table/parsers.ts` still
  reaches this module with no db layer behind it. The structural read
  (`Partial<…>` plus a one-level `cause` walk) is unchanged — importing the type
  fixes where the field NAMES come from, not how the value is inspected, and the
  structural read is deliberate because Drizzle wraps the driver error.
- **The `MySQLError` argument is the strongest part of the finding** and is now
  in the comment: Bun's own spelling is inconsistent across its drivers —
  `MySQLError` carries `errno: number` AND `sqlState: string`, while
  `PostgresError` puts the SQL state in `errno: string`. A hand-authored type
  keeps compiling against a rename; an imported one breaks the build. That is
  the exact failure mode this change existed to fix, which is why the finding is
  not pedantry.
- `errno` is optional in Bun's declaration, and `PgErrorFields` was already
  consumed through `Partial<…>`, so nothing downstream changed shape.

## 2. F2 — the missing test. Accepted; split across two seams, one placement declined.

**The factual claim is correct and worth stating plainly.**
`log-serializer.test.ts` built `Object.assign(new Error('duplicate key'), { code: '23505' })`
— a spelling `bun:sql` never produces. That assertion passed only because
`hasSqlState` keeps `code` as a compatibility fallback, so CI exercised the path
that already worked while `errno`, the field this driver populates and the one I
had just added to two allowlists, had **zero** coverage.

### 2a. In CI, with no database — and with a better fixture than was asked for

`SQL.PostgresError` turns out to be **constructible**, which the review did not
claim and which changes the cheapest available answer. Measured:

```
name        : PostgresError
instanceof  : true
code/errno  : ERR_POSTGRES_SERVER_ERROR / 23505
constraint  : ux_users_email
own keys    : [ "name", "code", "errno", "detail", "constraint" ]
```

So the fixture can be built from **Bun's own typed constructor** instead of
`Object.assign` on a bare `Error`. That is strictly better than a hand-authored
object for the reason F1 gives: the constructor is typed, so the fixture cannot
drift from the shape the driver throws, and a rename in Bun breaks the build
rather than the assertion's meaning. It needs no infrastructure, so it runs in CI
today.

Six assertions added to `scripts/probe/local/log-serializer.test.ts` (19 → 25 in
that file, 150 → 156 in the suite):

| Assertion                                           | What it pins                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| SQLSTATE in `errno` kept on a real `PostgresError`  | the field the driver actually sets                                                 |
| constraint name kept alongside it                   | `getConstraintName`'s input survives redaction                                     |
| OTP-shaped `errno` redacted                         | `errno` joined `SHAPE_CHECKED_ERROR_KEYS`, so it must be gated exactly like `code` |
| numeric Node `errno` (`-4058`) kept                 | the numeric branch, which the same key hits on Node                                |
| SQLSTATE survives the query-error reduction         | `errno` had to enter `QUERY_ERROR_SAFE_FIELDS` too                                 |
| bound parameter still withheld from that same error | the containment half, asserted in the same breath                                  |

The last pair matters together: widening the allowlist to keep the code is
exactly how the containment property gets broken, so both are asserted against
one error rather than in separate tests.

### 2b. The real-driver test — accepted, but NOT in `scripts/probe/local`

**This is the one placement I am declining.** `bun run test` is
`bun test scripts/probe/local`, CI runs it, and CI has no PostgreSQL service. A
real duplicate insert through Drizzle in that directory fails on the first push.
The review's own "what is still unverified" section makes the same observation
one paragraph later — there is no CI job that touches PostgreSQL — so this is
agreement about the constraint, not about the destination.

The destination that already exists is `scripts/probe/dev-live/`, whose README
states its own contract: real services, destructive, `*.dev-probe.ts` precisely
so `bun test` in CI can never discover them. New file
`scripts/probe/dev-live/database/driver-contract.dev-probe.ts`, 8 assertions, all
passing:

- a real unique violation carries `23505` in `errno` and **not** in `code`, and
  `getConstraintName` returns an index name containing `email`
- a real `users` unique violation maps to **409** through
  `handleUserUniqueViolation` — the contract-level assertion, not the helper-level
  one
- a real foreign-key violation is recognised
- `sanitizeForLog` keeps `42P01`, and keeps `22P02` while withholding the value
  PostgreSQL echoes into that message
- `jsonb_typeof(metadata) = 'object'` after the insert **and** after the `||`
  merge, with an unrelated key surviving and the patch landing
- one backend PID across a transaction, exactly one advisory lock in `pg_locks`,
  rollback on throw
- a nested transaction behaves as a savepoint
- `db.execute()` yields rows as an array

The review asked for "a real duplicate insert through Drizzle inside a
rolled-back transaction". I used seeded rows with `afterAll` cleanup instead,
matching the sibling probe's existing discipline rather than introducing a second
isolation style in the same directory — the README already names shared fixtures
and prefix-wide cleanup as accepted there and unacceptable in the real suite.

### 2c. Two defects this finding exposed by accident

- **`probe:db` did not exist.** The dev-live README and both probe headers said
  `Run: bun run probe:db`. There was no such script, so the documented command
  had never worked in any environment.
- **A directory path cannot work either.** `bun test <dir>` and
  `bun test ./<dir>/` both report "did not match any test files", because
  `.dev-probe.ts` deliberately misses the test glob. Bun says so itself: _"To
  treat the … filter as a path, run `bun test ./…`"_. The script is now
  `bun test ./scripts/probe/dev-live/database/*.dev-probe.ts`, and the README
  records why the leading `./` is load-bearing rather than decoration.

A side effect worth having: the pre-existing OTP verify-budget probe now runs for
the first time and **passes on `bun:sql`** — 12 assertions across 2 files. Its
invariants (the daily failure budget spanning purposes and transports,
transactional enforcement, the refund on a correct code) had never been executed
against this driver.

### 2d. Where the review's conclusion still stands

On demand is not a gate. `bun run probe:db` runs when someone runs it. §3's
service-container decision in `reports/test-strategy.md` is still what turns
these into gates, and it remains the highest-value unblocked item there.

## 3. F3 — `fromDriver`. The fact is right; the throw is declined.

**Accepted as fact.** Drizzle's builtin `jsonb` JSON-parses a string on the way
out and the replacement does not, so a jsonb string scalar reaching one of the
five columns reads back as a `string` wearing the column's declared type. The
review's characterisation is precise: it fails closed on the permission path (a
lookup on a string yields `undefined`, which denies) but it fails silently.

**Also accepted:** exposure today is nil. Re-confirmed — every table is empty and
`jsonb_typeof` returns no non-object rows for any of the five columns. So this is
a design question, not a backfill.

Of the two options offered, I have taken the second (record the trust) and
declined the first (throw), for three reasons:

1. **`mapFromDriverValue` runs on READ.** A throw turns one corrupt row into a
   500 on every request that touches it — for `role_permissions.permissions`, a
   role-wide authorization outage. That trades a fail-closed condition for an
   availability failure, in order to report a mistake made at write time.
2. **Three of the five columns are typed `unknown`, and jsonb legitimately admits
   arrays and scalars there.** `audit_logs.changed_fields` **already stores an
   array**. Refusing a non-object on read would assert an invariant the column
   type does not carry, and `CLAUDE.md` is explicit that narrowing an existing
   contract to fix an unrelated bug is a separate breaking change.
3. **The detection value is low now that both write paths are fixed.** I checked
   the writers rather than assuming: `clampJson` returns either the value or
   `{ _truncated, preview }`, and `stripSensitive` returns objects — nothing in
   this codebase can produce a scalar. The remaining sources are out-of-band (a
   `psql` fix-up, a script), i.e. a human doing surgery, who is better served by
   a write that is refused than by a read that explodes later.

Restoring drizzle's parse is the one option that is clearly wrong, and worth
naming as such: that parse is precisely what hid the double encode — write twice,
read twice, same object back, nothing to see.

**What replaces the throw.** The helper's comment now states that these five
columns trust their writers, what the failure looks like, and why a read-path
throw was rejected. The enforcement that actually fits a write-time invariant is
a database CHECK constraint, which costs a migration, so it is routed to
`TODO.md` **PG-4** with the scope already decided: `jsonb_typeof(...) = 'object'`
on `role_permissions.permissions` and `sessions.metadata` only, and explicitly
**not** on the three `audit_logs` columns. The dev-live probe asserts
`jsonb_typeof = 'object'` after both an insert and the merge, so the property has
a check in the meantime.

## 4. F4 — `drizzle.config.ts`. Accepted, and measured.

**A note on method first, because my initial check was invalid.** `env -u
DATABASE_URL bunx drizzle-kit generate` succeeded, which looked like a
refutation. It is not: Bun re-loads `.env`, so the variable was still set. Run
properly:

| Configuration           | `DATABASE_URL` | Result                                                 |
| ----------------------- | -------------- | ------------------------------------------------------ |
| as shipped              | empty          | throws `Missing required server env var: DATABASE_URL` |
| `dbCredentials` removed | empty          | **"No schema changes"** — works                        |

So the finding is confirmed. Both `dbCredentials` and the throw are removed, with
the reason recorded: every drizzle-kit command that would consume credentials —
`migrate`, `push`, `pull`, `studio` — connects through `pg`, `postgres`,
`@neondatabase/serverless` or `@vercel/postgres`, and this project has none of
them. They were unusable, not merely unused. `generate` reads `db/schema.ts` and
never connects.

## 5. What the review could not have known — the strategy document was renumbered

`reports/test-strategy.md` was rewritten from scratch while this pass was in
flight. It is now "Test Strategy — implementation brief" with sections 1–10, and
the `§11` block this change contributed is now **§7.4 PostgreSQL driver**, items
**a**–**h**. Section numbers moved across the whole file.

That orphaned cross-references, including two the rewrite did not migrate.
Repaired:

| Reference                      | Was    | Now                                                                                                                                            |
| ------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`     | §11.5  | §7.4e                                                                                                                                          |
| `driver-contract.dev-probe.ts` | §11    | §7.4                                                                                                                                           |
| `TODO.md` PG-3                 | §10.7b | §7.2b                                                                                                                                          |
| `TODO.md` EM-13                | §10.4  | §7.1c                                                                                                                                          |
| `log-serializer.test.ts`       | §10.7d | cited by NAME — the standing "never assert against a hand-authored fixture where a real one is reachable" rule, with §5.1 as the concrete case |

The last row is a deliberate change of style, not just a renumber: after one
wholesale renumbering, a reference by name survives the next one.

§7.4 now carries a status block recording which of its items are implemented and
which are specification-only, so the next reader does not re-derive it.

## 6. The review's closing list, checked line by line

| Claim                                                             | Still true?                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nothing has run on Linux or against Coolify                       | **Yes.** Unchanged.                                                                                                                                                                                                                                                                                                    |
| The SIGTERM path that closes the pool first is unexercised        | **Yes.** Windows `TerminateProcess` cannot be intercepted; a spawned server killed with `SIGTERM` exits 143 with no handler output. `closeDatabase()` itself is verified directly (10 backends open → resolves in 1.4 ms → later queries fail → clean exit).                                                           |
| No `statement_timeout`                                            | **Yes.** `TODO.md` PG-1.                                                                                                                                                                                                                                                                                               |
| `MAX_POOL_CONNECTIONS = 10` is not sized against a real server    | **Yes.** `TODO.md` PG-1.                                                                                                                                                                                                                                                                                               |
| `utils/otp.ts` holds a pooled connection across the provider call | **Yes**, and the review's sharpening is recorded in `TODO.md` §2.1: ten simultaneous sends against a hanging SMTP server exhaust the whole pool.                                                                                                                                                                       |
| Every §11 assertion is written and none is implemented            | **No longer accurate.** §7.4**b** runs in CI; §7.4**a**, **c**, **d** and **g** run under `probe:db`. Specification-only: **e** (pool and lazy connect), **f** (type mapping), **h** (the migration runner, which needs a scratch database), and the version guard, which belongs with §7.3's production-launch smoke. |

The last row is the only correction to that section, and the constraint behind it
is unchanged: those five run on demand, not on a gate.

---

## 7. Files changed in this pass

| File                                                           | Change                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `utils/index.ts`                                               | F1 — `Pick<SQL.PostgresError, …>` plus the reasoning                            |
| `scripts/probe/local/log-serializer.test.ts`                   | F2a — six `errno` assertions from Bun's own error constructor                   |
| `scripts/probe/dev-live/database/driver-contract.dev-probe.ts` | F2b — new, 8 live assertions                                                    |
| `scripts/probe/dev-live/README.md`                             | F2c — new probe row, the `./` path requirement, and that `probe:db` was missing |
| `package.json`                                                 | F2c — `probe:db` added                                                          |
| `db/schema.ts`                                                 | F3 — the trust decision and why a read-path throw was rejected                  |
| `TODO.md`                                                      | F3 — PG-4; plus the §7.2b / §7.1c reference repairs                             |
| `drizzle.config.ts`                                            | F4 — `dbCredentials` and the `DATABASE_URL` throw removed                       |
| `.github/workflows/ci.yml`                                     | §5 — reference repair                                                           |
| `reports/test-strategy.md`                                     | §5 — §7.4 status block                                                          |

The database is left empty; both dev-live probes clean up after themselves,
confirmed by a row count after the run.
