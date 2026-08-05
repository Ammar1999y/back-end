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
semgrep --config=p/typescript --config=p/nextjs --config=p/secrets

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
- **Trivy** — its dependency scanning duplicates `bun audit`, and its
  container/IaC scanning has no target here (no Dockerfile, no Kubernetes, no
  Terraform).
- **Snyk Code / SonarQube** — overlap Semgrep and the existing ESLint security
  plugins without adding a distinct signal at this size.

### Noise control — the part that decides whether any of this survives

The standard criticism of SAST is real: too many findings, too many false
positives, a backlog nobody triages. A tool producing 400 ignored alerts equals
zero protection.

**Rule: baseline everything, then fail CI only on _new_ findings.**

```bash
semgrep --baseline-commit=<sha>       # only findings introduced by the PR
bun audit --audit-level=high          # gate on high/critical; ignore low/moderate
```

Existing findings go to a tracked backlog, never a blocking gate. A gate that is
red on arrival gets bypassed within a week.

---

## 5. Phase 3 — Maintainability

### 5.1 eslint-plugin-drizzle

Catches `.delete()` / `.update()` calls with no `.where()`. With soft-deletes
and audit logs in this schema, one missing `where` is a table wipe. Two rules,
near-zero false positives.

```bash
bun add -D eslint-plugin-drizzle
```

### 5.2 knip

Finds unused files, **plus** unused exports, dependencies, and devDependencies.
Directly replaces the homegrown `scripts/find-unused-files.ts`.

```bash
bun add -D knip && bunx knip
```

### 5.3 dependency-cruiser

Encode the intended architecture as an enforced rule — e.g. `app/api/**` may not
import `db/schema.ts` directly, only through `db/queries/**`. This is how
layering survives a deadline.

```bash
bun add -D dependency-cruiser && bunx depcruise --init
```

### 5.4 Additional TS hardening

`noImplicitAny` is already enabled. The remaining high-value flag:

```jsonc
"noUncheckedIndexedAccess": true   // array/record access yields `T | undefined`
```

Expect real errors — each one is a latent runtime crash. Enable it when there is
time to work through the fallout, not mid-feature.

### 5.5 ESLint debt

`eslint.config.mjs` disables ~35 rules, two of them under an explicit
`TODO: should remove it and fix the issues`. Re-enable in small batches once
tests exist to catch regressions — starting with `react-hooks/exhaustive-deps`
and `react-hooks/set-state-in-effect`.

---

## 6. Phase 4 — Runtime Observability

Static analysis cannot see production. This phase addresses `TODO.md` item 9
(alerting when errors spike).

- **Sentry** — error grouping, spike alerts to email/Slack, plus performance
  tracing. First-class Next.js SDK; free tier covers 5k errors/month. This is
  the direct answer to TODO #9.
- **Neon query insights** — built in, no setup. Use it to find slow SQL.
- **Checkly** or **Better Stack** — synthetic uptime checks on the auth
  endpoints after deployment.

For performance work specifically: Sentry tracing identifies _which_ of the 21
routes is slow; Neon insights identify _which query_ inside it. Guessing without
both is wasted effort.

---

## 7. Checklist

Work top to bottom. Each item is independently shippable.

**Phase 0 — Foundation**

- [ ] Push to a private GitHub repo
- [ ] Add `lefthook` + `lefthook.yml`, run `bunx lefthook install`
- [ ] Add `.github/workflows/ci.yml`
- [ ] Enable branch protection on `main` requiring CI to pass

**Phase 1 — Tests**

- [ ] Install vitest, add `test` scripts
- [ ] Unit tests: `lib/permissions/checker.ts`
- [ ] Unit tests: `lib/auth/*`
- [ ] Unit tests: `utils/validation/*`
- [ ] Unit tests: `lib/rate-limit/*`
- [ ] Integration tests on API routes via testcontainers + Postgres

**Phase 2 — Security**

- [ ] `bun audit --audit-level=high` in CI
- [ ] One-time `gitleaks detect` history sweep
- [ ] `gitleaks protect` in pre-commit
- [ ] Semgrep in CI with `--baseline-commit`
- [ ] Enable Renovate

**Phase 3 — Maintainability**

- [ ] `eslint-plugin-drizzle`
- [ ] Replace `scripts/find-unused-files.ts` with `knip`
- [ ] `dependency-cruiser` layering rules
- [ ] `noUncheckedIndexedAccess: true`
- [ ] Re-enable disabled ESLint rules in batches

**Phase 4 — Observability**

- [ ] Sentry (closes TODO #9)
- [ ] Review Neon query insights
- [ ] Uptime monitoring on auth endpoints

---

## 8. Caveats

- The snapshot in section 1 was verified directly against the repository.
- Pricing figures and free-tier limits are from training knowledge and change
  frequently — confirm before committing budget.
