# Review — Neon → local PostgreSQL via `bun:sql`

**Date:** 2026-08-20 **Reviewed:** uncommitted working tree against `f3be25b`
("elysia migration")

**Scope of verification.** The driver swap, the SQLSTATE relocation, the jsonb
double-encode fix, the migration ledger, the pool ceiling and the lazy-connect
property were each reproduced against the real local PostgreSQL 18.6 on Bun
1.4.0, and all gates (`tsc`, `eslint`, 150 probe assertions, `find-unused-files`,
`smoke`, `db:generate`, `--frozen-lockfile`) pass here. Those hold; this document
records only what I would change. Throwaway probes were used and deleted.

`better-auth` is out of scope by request — it is being handled separately — so
nothing downstream of that library's version is assessed here, including the now
unreferenced `authGet` / `authSet` statements in `lib/rate-limit/store.ts`.

---

## Finding 1 — MEDIUM · `PgErrorFields` regressed from a library type to a hand-authored one

`utils/index.ts` previously had `Pick<NeonDbError, 'code' | 'constraint'>` — an
imported type. It now has:

```ts
type PgErrorFields = { code: string; errno: string; constraint: string };
```

But Bun exports the real thing. `node_modules/bun-types/sql.d.ts:104`:

```ts
class PostgresError extends SQLError {
  public readonly code: string;
  public readonly errno?: string | undefined;
  public readonly constraint?: string | undefined;
  public readonly detail?: string | undefined;
  // … hint, severity, position, schema, table, column, dataType, file, line, routine
}
```

`CLAUDE.md`: _"If a library exports a type, import it."_ The comment's own
reason for keeping this module db-free — `lib/data-table/parsers.ts` reaches it
from the browser — is fully satisfied by `import type { SQL } from 'bun'`, which
erases at compile time and pulls in nothing.

This is not pedantry here. Bun's own naming across its three error classes is
inconsistent: `MySQLError` has `errno: number` **and** `sqlState: string`, while
`PostgresError` puts the SQL state in `errno: string`. If a future Bun adds
`sqlState` to `PostgresError` or changes `errno`'s type, an imported type breaks
the build and a hand-authored one silently keeps compiling while matching
nothing — which is precisely the failure this change just spent its effort
fixing.

## Finding 2 — MEDIUM · The regression that was just fixed has no test, and the existing fixture is now provably wrong

`scripts/probe/local/log-serializer.test.ts:103` still builds:

```ts
Object.assign(new Error('duplicate key'), { code: '23505' });
```

That is the spelling this driver never produces. The assertion passes only
because `hasSqlState` deliberately kept `code` as a compatibility fallback — so
the suite that runs in CI exercises the path that was already working, not the
`errno` path that was broken. `reports/test-strategy.md` §11.1 asks for exactly
this and correctly insists on errors thrown by the real driver, but the suite
itself was not touched.

Given the whole value of centralising at `hasSqlState`, one probe — a real
duplicate insert through Drizzle inside a rolled-back transaction, asserting
`isUniqueViolation` is true and `getConstraintName` returns the index name — is
cheap and would have caught this class the day it appeared. I ran that by hand
and it passes; a check I ran once is not a check that stays.

## Finding 3 — LOW · `fromDriver` dropped drizzle's self-healing parse

```ts
fromDriver: (value) => value,
```

Drizzle's builtin `jsonb` JSON-parses a string on the way out; the replacement
does not. If a jsonb string scalar ever lands in one of these five columns — a
`psql` fix-up, a script that pre-stringifies, any writer that hands over JSON
text instead of a value — the read returns a `string` typed as
`SessionMetadata`, and nothing complains. It fails _closed_ rather than open (a
permission lookup on a string yields `undefined` → deny), but it fails
silently, and silent is the property this whole class of defect is about.

Exposure today is nil: every table in the local database is empty (0 users, 0
sessions, 0 roles, 0 audit rows; `jsonb_typeof` returns no rows for any of the
five columns), and there is no production data. So this is a design question,
not a backfill:

- either make `fromDriver` **throw** on a string — loud, and it cannot re-hide a
  double encode the way a silent parse would;
- or keep the pass-through and record in the helper's comment that the column
  trusts its writers.

## Finding 4 — NIT · `drizzle.config.ts` still requires `DATABASE_URL` for a command that never connects

`db:migrate` no longer goes through drizzle-kit, so `generate` is the only
remaining consumer of that config — and it reads `db/schema.ts` without
connecting. But the file still throws on a missing `DATABASE_URL` and still
declares `dbCredentials`, so `bun run db:generate` needlessly demands the
variable. Pre-existing, but this change is what made `dbCredentials` dead.

---

## What is still unverified — stated, not implied

- **Nothing has run on Linux or against Coolify.** The runbook says so, and the
  SIGTERM path that now closes the pool first is specifically unexercised:
  Windows `TerminateProcess` cannot be intercepted, so a spawned server killed
  with `SIGTERM` here exits 143 with no handler output. This belongs in
  `reports/test-strategy.md` §10.8's spawned-process suite and needs Linux.
- **No `statement_timeout`** (`TODO.md` PG-1). A runaway query can hold a pooled
  connection indefinitely, and with a ceiling of 10 that is the whole
  transaction capacity of the process.
- **`MAX_POOL_CONNECTIONS = 10` is not sized against a real server.** It is
  Bun's default restated. `TODO.md` PG-1 owns this.
- **`utils/otp.ts` still holds a pooled connection across the provider HTTP
  call** (`TODO.md` §2.1). The swap made this sharper rather than milder: ten
  simultaneous OTP sends against a hanging SMTP server now exhaust the entire
  pool, not one slot of a serverless one.
- **Every §11 assertion is written and none is implemented.** There is still no
  CI job that touches PostgreSQL, so everything I confirmed above is a
  point-in-time measurement by hand — which is the gap §11 exists to close, and
  finding 2 is its sharpest instance.
