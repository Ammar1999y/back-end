@.claude/skills/caveman/SKILL.md @CLAUDE.md

Both files above are standing instructions for this session.

# Objective

Bun test suites covering this codebase. `bun test` and `bun:test` only. Bun 1.4 features
where they fit: https://bun.com/blog/bun-v1.4

# Build the harness first, alone

`reports/test-strategy.md` designs a harness that does not exist yet — no `tests/`, no
`bunfig.toml`, and `bun run test` still points at `scripts/probe/local`, though parts of
the strategy are already realised there. Build the harness before delegating: the preload
rewriting `DATABASE_URL` and `SQLITE_DIR`, database provisioning, egress guard, sign-in
fixture. Prove it green on two or three files.

`bun run test` is `bun test scripts/probe/local` — a substring **filter**, not a path.
Measured: a test file outside that directory is skipped silently with exit 0, so
`ci.yml:34` and `lefthook.yml:57` miss it too. Fix the selection as part of the harness.

Name each run's database uniquely rather than by worker index, and drop it at the end —
agents run their own tests concurrently, and a worker-index name makes two runs truncate
each other's tables. Nothing in PostgreSQL or SQLite is real, so provisioning is free to
be destructive.

# Then shard and delegate

Shard by area: a whole API endpoint with its failure paths, or a group of related
functions in one module. Never one test, never one function. Count the handlers under
`app/api/` and the modules under `lib/` yourself — another session is adding files while
you work — and expect roughly 15 to 20 areas. Show me the list first.

Dispatch `test-author` subagents, 4 to 6 at a time, refilling as they finish. Each task
names the files that agent owns, the fixtures it may assume, and the assertions that
must be proven — never "write good tests for X".

Keep for yourself: the harness, every shared helper and fixture, the assertion list per
shard, the full-suite run between rounds, and whether coverage is adequate.

# scripts/probe/

Green today, and not a standard: some of it predates these requirements and none of it is
exempt from them. Audit it, fix or replace whatever does not hold up, and keep it green. It
moves into `tests/` per the layout in the strategy — that move is what lets `bunfig.toml`
give each tier its own preload. It exercises only `test`, `expect` and `mock`; lifecycle
hooks, `spyOn`, snapshots and `setSystemTime` are unused and some areas will want them.

`scripts/probe/dev-live/*.dev-probe.ts` runs only via `bun run probe:db`. It needs no HTTP
server, but it writes to the real database in `.env` and its own header calls it "not a
test, not safe for CI". Decide whether it joins the suite, and say which way.

# Two traps, both measured

`mock.module` is process-wide: it leaks into every file that runs after it, and
`mock.restore()` does not undo it (reproduced on Bun 1.4.0). `otp-global-breaker.test.ts`
already does this to the rate-limit barrel. Inject the boundary or mock a narrower
module — a lifecycle hook will not save you.

Never hand-copy a production list into a test. Two have already drifted: the required-env
mirror in `env-secret.test.ts`, and `REAL_SCOPES` in `rate-limit-log-boundary.test.ts`,
which lists 5 of 6 real scopes under a comment claiming 14 routes where there are 22.
Derive or import it — `sqlite-semantics.test.ts` extracts production SQL from source, and
that is the house pattern.

# reports/test-strategy.md

Guidance, not authority — every finding is a hypothesis. Where it is wrong or thin, say
so and test what matters instead. Its gaps are yours to find.

# Report

Each area and what it covers, the raw full-suite output, every failing test with its
reason, and what you left untested.
