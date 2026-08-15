# Engineering Hardening Plan

## 2. Phase 0 — Foundation

### 2.1 Private GitHub repo

Unlocks Actions, Renovate, branch protection, and code scanning. Every later
phase depends on it.

### 2.2 Pre-commit gate — lefthook

Single Go binary, faster than husky, no `node_modules` shims.

```bash
bun add -D lefthook && bunx lefthook install
```

```yaml
# lefthook.yml
pre-commit:
  parallel: true
  commands:
    typecheck:
      run: bun tsc --noEmit
    lint:
      glob: '*.{ts,tsx,mts}'
      run: bun eslint {staged_files}
    secrets:
      run: gitleaks protect --staged --redact --verbose
```

### 2.3 CI on every PR

The single highest-leverage file in this plan.

```yaml
# .github/workflows/ci.yml
name: CI
on:
  pull_request:
  push:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.14
      - run: bun install --frozen-lockfile
      - name: Typecheck and lint
        run: bun run lint
      - name: Dependency audit
        run: bun audit --audit-level=high
      - name: Tests
        run: bun run test
      - name: Build
        run: bun run build
```

Then enable branch protection on `main` requiring `verify` to pass.

---

## 3. Phase 1 — Tests

**The biggest stability gap in the project — larger than any security finding.**

Zero tests across 16.6k LOC of auth logic means every refactor is a gamble, and
no scanner substitutes for that.

```bash
bun add -D vitest @vitest/coverage-v8
```

Add to `package.json`:

```json
"test": "vitest run",
"test:watch": "vitest",
"test:coverage": "vitest run --coverage"
```

### Priority order — highest risk, cheapest to test, pure logic

1. `lib/permissions/checker.ts` — a bug here is a full auth bypass
2. `lib/auth/password.ts`, `lib/auth/password-pepper.ts`,
   `lib/auth/login-guard.ts`
3. `utils/validation/` — every zod schema
4. `lib/rate-limit/` — the limiter meant to stop brute-force

### Then: integration tests on the 21 routes

Use a real Postgres via `@testcontainers/postgresql` plus the existing Drizzle
migrations.

> Do not mock the database for permissions tests — that tests the mock, not the
> security boundary.

---

## 4. Phase 2 — Security Scanning

### Recommended set

| Tool            | Cost | Role                                                                                              |
| --------------- | ---- | ------------------------------------------------------------------------------------------------- |
| **`bun audit`** | free | Dependency CVEs. Already installed — zero setup. Wire into CI first.                              |
| **Semgrep OSS** | free | SAST. Works locally, no GitHub required.                                                          |
| **gitleaks**    | free | Secret scanning. History is clean now; this keeps it that way.                                    |
| **Renovate**    | free | Dependency updates. Better `bun.lock` support than Dependabot and groups PRs instead of flooding. |

```bash
# Semgrep
semgrep --config=p/typescript --config=p/nextjs --config=p/secrets --baseline-commit=<sha> # only findings introduced by the PR

# Secret history sweep (one-time, then rely on the pre-commit hook)
gitleaks detect --source . --redact --verbose
```

`gitleaks` matters here specifically because `.env` holds live Neon, R2, and
Upstash credentials.

### Deliberately excluded

Recorded so these are not re-evaluated later:

- **CodeQL** — free only for _public_ repos. Private repos require GitHub Code
  Security (~$30/active committer/month; verify current pricing). Deep
  interprocedural taint analysis is overkill at 16.6k LOC.
- **Snyk Code / SonarQube** — overlap Semgrep and the existing ESLint security
  plugins without adding a distinct signal at this size.
