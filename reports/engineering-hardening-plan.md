# Engineering Hardening Plan

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

The recommended set — `bun audit`, Semgrep OSS, gitleaks, Renovate — is
implemented; see §5.

### Deliberately excluded

Recorded so these are not re-evaluated later:

- **CodeQL** — free only for _public_ repos. Private repos require GitHub Code
  Security (~$30/active committer/month; verify current pricing). Deep
  interprocedural taint analysis is overkill at 16.6k LOC.
- **Snyk Code / SonarQube** — overlap Semgrep and the existing ESLint security
  plugins without adding a distinct signal at this size.

---

## 5. Tooling, CI, and what is still open (2026-08-15)

Phase 0 is implemented and its draft has been removed from this document; the
points where that draft was wrong are recorded below so they are not
reintroduced.

### The one command to run before committing

```bash
bun run precommit
```

`lefthook run fix` (prettier `--write`, then eslint `--fix` — sequential, both
rewrite files) followed by `lefthook run verify` (every gate, in parallel).
40–65 s on this machine, dominated by eslint. Sub-commands:

| Command                     | Does                                                      |
| --------------------------- | --------------------------------------------------------- |
| `bun run precommit`         | fix, then verify — the pre-commit command                 |
| `bun run verify`            | gates only, no writes; identical set to `pre-push` and CI |
| `bun run fix`               | writes only                                               |
| `bun run find:unused-files` | knip — **informational, not a gate** (see below)          |

`verify` runs: `tsc --noEmit`, `eslint . --max-warnings 0`, `prettier --check`,
`bun audit`, `gitleaks git .`, `semgrep scan`, `actionlint`.

The `verify` set is defined once in `lefthook.yml` and reused by `pre-push`
through a YAML anchor, so the two cannot drift. GitHub Actions runs the same
checks again, which is what catches a `--no-verify` commit or a clone that never
ran `bun install`.

### Setup on a new machine

One prerequisite, then two commands:

```bash
scoop install mise   # or: brew install mise / curl https://mise.run | sh
mise install         # installs every tool at the version in mise.toml
bun install          # also wires the git hooks via the `prepare` script
```

### Landed

| Item                | Where                                                                   |
| ------------------- | ----------------------------------------------------------------------- |
| lefthook pre-commit | `lefthook.yml` — typecheck, eslint, prettier, gitleaks, on staged files |
| lefthook pre-push   | `lefthook.yml` — the full `verify` set                                  |
| Hook auto-install   | `package.json` `prepare` script, so `bun install` wires the hooks       |
| CI                  | `.github/workflows/ci.yml` — verify, workflows, audit jobs              |
| SAST + secrets CI   | `.github/workflows/security.yml` — Semgrep OSS, gitleaks, weekly cron   |
| Renovate config     | `renovate.json` — grouped non-major PRs, immediate vulnerability alerts |
| Scanner toolchain   | `mise.toml` — gitleaks, semgrep, actionlint, shellcheck, uv             |

Scan results at time of writing: `bun audit` clean at **all** severities,
Semgrep 0 findings over 135 files, gitleaks 0 leaks over the full history,
actionlint clean on both workflows.

### Every pinned version, and what keeps it current

The rule: nothing floats, and nothing is bumped by hand.

| Value                                          | Lives in                      | Tracked by                          |
| ---------------------------------------------- | ----------------------------- | ----------------------------------- |
| bun 1.3.14                                     | `package.json` packageManager | Renovate npm manager                |
| gitleaks, semgrep, actionlint, shellcheck, uv  | `mise.toml`                   | Renovate mise manager               |
| `actions/checkout`, `setup-bun`, `mise-action` | workflow `uses:` SHAs         | Renovate + `pinGitHubActionDigests` |
| `ubuntu-24.04`                                 | workflow `runs-on:`           | Renovate `github-runner` depType    |
| npm deps and `overrides`                       | `package.json`                | Renovate npm manager                |

Notes on the ones that were not obvious:

- **Actions are pinned to commit SHAs, not tags** (`@3d3c42e5… # v7.0.1`). A git
  tag is mutable; a repointed or compromised tag executes in CI with repo
  permissions. Pinning npm behind a 3-day cooldown while leaving CI on mutable
  tags would have been an inconsistent threat model.
  `helpers:pinGitHubActionDigests` keeps the SHAs current and the trailing
  comment readable.

- **`ubuntu-latest` was the least reproducible value in the repo.** GitHub
  migrates that label to a new OS over 1–2 months, so a workflow can change
  behaviour with no commit. `ubuntu-24.04` is what `ubuntu-latest` resolves to
  today, and Renovate's `github-runner` depType raises a PR when the next LTS
  goes GA.

- **`mise.toml` replaced a bespoke Renovate regex.** The gitleaks version had
  been an inline `VERSION=8.30.1` with a `# renovate:` annotation and a
  `customManagers` rule, because the `github-actions` manager does not read
  `env:` annotations. That worked but was the only piece of config that could
  rot silently — if the line format drifted, tracking would stop with no error.
  The mise manager covers all four tools natively, so the custom manager is
  deleted.

  `mise.toml` also closes the gap that mattered most: the local scanners were
  previously installed ad hoc via scoop and pip and tracked by nothing, so
  `bun run verify` could pass on an old gitleaks whose rule set is compiled into
  the binary. CI and `lefthook.yml` now install and execute from the same file.

  bun is deliberately **not** in `mise.toml`. It is pinned by `packageManager`,
  which `oven-sh/setup-bun` reads automatically and Renovate already tracks;
  listing it in both would recreate the drift the file exists to remove. For the
  same reason there is no `bun-version:` input in the workflow.

  semgrep resolves through mise's `pipx` backend, which needs a Python installer
  present — that is the only reason `uv` is pinned in `mise.toml`. It is an
  implementation detail of pinning semgrep, not a tool anyone invokes.

  `shellcheck` is pinned for a sharper reason. actionlint shells out to it to
  analyse `run:` blocks and **silently skips that analysis when the binary is
  absent** — no warning, exit 0. GitHub's runners ship shellcheck, so a local
  `actionlint` was quietly running a weaker check than CI, and an unquoted
  `$args` (SC2086) passed locally and failed on push. Pinning it here is the
  same fix as pinning gitleaks: the gate is only as good as the binary behind
  it.

- **No semgrep container.** `semgrep/semgrep:1.173.0` as a job container was
  natively tracked, but it left the local semgrep untracked and free to drift
  from it. `zricethezav/gitleaks` was rejected as a job container for a
  different reason: it is alpine-based, and GitHub's bundled Node for JavaScript
  actions is glibc-linked, so `actions/checkout` breaks inside it.

- **Semgrep rule packs are the one thing that cannot be pinned**, and should not
  be: `p/typescript`, `p/nextjs` and `p/secrets` are fetched from the registry
  on every run, so rule coverage is always current regardless of engine version.
  The same is true of `bun audit` and Renovate alerts, which query advisory
  databases live. Scanner-version staleness only degrades detection for
  **gitleaks**, whose rules ship inside the binary — which is precisely why it
  is pinned in `mise.toml` and executed through it locally.

### knip is deliberately not a gate

`bunx knip` currently exits 1 with a long list of unused exports and types —
leftovers from the removed front-end, not regressions. Wiring it into
`precommit` would mean a permanently red gate, so it stays a manual command.
Cleaning that list up is separate work.

Its script also had a real defect: `find:unused-files` ran `bun add -D knip` on
every invocation, mutating `package.json` and `bun.lock` as a side effect of a
read-only query. knip is already a devDependency; the `bun add` is removed.

### Dependency overrides added to fix `bun audit`

Two advisories were open once the gate dropped to "all severities":

- `nanoid@3.3.17` (high, GHSA-2v37-7h3g-55p8) via `next › postcss › nanoid` —
  pinned with `overrides.nanoid: ^3.3.18`.
- `esbuild@0.18.20` (moderate, GHSA-67mh-4wv8-2f99) via
  `drizzle-kit › @esbuild-kit/esm-loader › @esbuild-kit/core-utils` — the
  `@esbuild-kit/*` packages are deprecated and pinned to `~0.18.20`, and
  drizzle-kit 0.31.10 (current latest) still depends on them. Bun's
  `resolutions` do not accept a path-scoped key, so the fix is a flat
  `overrides.esbuild: ^0.28.1`, which also collapses three esbuild copies into
  one. Verified: `drizzle-kit check` still loads `drizzle.config.ts`.

Both overrides should be dropped once the upstream ranges move past them.

### Errors in the deleted Phase 0 draft

Kept so they are not reintroduced:

- **`gitleaks protect` and `gitleaks detect` no longer exist.** Both were
  removed in gitleaks 8.30. The equivalents are `gitleaks git --staged`
  (pre-commit) and `gitleaks git .` (history sweep).
- **`bun tsc --noEmit` and `bun eslint` are not valid invocations.** `bun` runs
  scripts and files, not bin shims; use `bunx`.
- **`bun audit --audit-level=high` hid two real advisories.** The gate now runs
  with no level, so every severity fails it.
- **`actions/checkout@v4` was three majors stale.** v7.0.1 is current — checked
  against the GitHub releases API, not from memory.
- **A `bun run test` CI step would fail on a missing script.** Phase 1 is
  deferred; add that step together with the tests.

### Other implementation notes

- **The CI build step carries a placeholder env block.** `lib/env.server.ts`
  throws at module load on any missing required var, so `next build` cannot run
  in a bare checkout. The values are shaped to pass validation and nothing else
  — no real credential goes in that file. Verified locally: the build succeeds
  with exactly that set.
- **`vulnerabilityAlerts.prPriority` is rejected by Renovate** — `prPriority` is
  only valid inside `packageRules`. Caught by `renovate-config-validator`, which
  is worth running on every edit to `renovate.json`.

### `.gitleaksignore`

Holds one fingerprint: a `mod+shift+enter` keyboard-shortcut literal in the
since-deleted front-end editor code, matched by the generic-api-key entropy
rule. It is scoped to a pre-existing commit — delete the file once the history
is restarted.

### Still open — needs repo-owner action

1. **Repo visibility.** Still public. The original plan assumed a private repo
   would be a prerequisite; it is not. Actions, Renovate and branch protection
   all work on a public repo, and CodeQL is free only while it stays public. The
   one thing going private buys is that the source stops being readable, which
   is a product decision, not a tooling one.

2. **Branch protection.** After the first CI run publishes the check names:

   ```bash
   gh api -X PUT repos/<owner>/<repo>/branches/main/protection \
     -f 'required_status_checks[strict]=true' \
     -f 'required_status_checks[contexts][]=verify' \
     -f 'required_status_checks[contexts][]=workflows' \
     -f 'required_status_checks[contexts][]=audit' \
     -f 'required_status_checks[contexts][]=semgrep' \
     -f 'required_status_checks[contexts][]=gitleaks' \
     -F 'enforce_admins=true' -F 'required_pull_request_reviews=null' \
     -F 'restrictions=null'
   ```

3. **Renovate.** `renovate.json` is inert until the Renovate GitHub App is
   installed on the repo: https://github.com/apps/renovate

   Automerge is deliberately off. Patch releases are only safe if the publisher
   is disciplined about semver, and supply-chain incidents have historically
   arrived through patch versions; with direct-to-production deploys and no test
   suite, a green CI run only proves the project typechecks, lints, and builds.

   **Revisit once Phase 1 lands:** when the test suite exists and runs in CI as
   a required check, green CI means something, and automerging patch-level
   runtime updates becomes reasonable. Do this at the same time as the branch
   protection step above — the required-check list has to include the test job
   before automerge is safe.

4. **`.env` credentials.** The file is git-ignored and history is clean, but it
   holds live Neon, R2, and Upstash secrets on disk. Rotation is a separate
   decision, not a tooling one.
