/* eslint-disable unicorn/no-process-exit -- this IS a gate: a rejected tool or
   runtime must stop the install before a foreign lockfile or an untested Bun
   reaches the tree. */
/**
 * Refuses every package manager but Bun, and every Bun older than the pin in
 * `packageManager` — and where it can, repairs the machine instead of only
 * complaining.
 *
 * ## Where it runs from
 *
 * Two entry points, and the split is deliberate.
 *
 * `preinstall` invokes it as `bun scripts/require-bun.mjs`. Under `bun install`
 * Bun is present by definition, so that command cannot fail for want of a
 * runtime — and the alternative, `node …`, would have leaned on Bun prepending
 * a `node` symlink that points at itself when no Node is on `$PATH`. That
 * substitution is real and measured here on Windows, but it is the deployment
 * container — Bun image, no Node — that would have depended on it, and it could
 * not be verified on Linux from this machine. A build that breaks for an
 * unverifiable reason is not worth the tidier command.
 *
 * `node scripts/require-bun.mjs` is the BOOTSTRAP, for the one case the hook
 * cannot serve: a machine with no Bun at all, where nothing Bun-flavoured can
 * run yet. That is why this file is plain `.mjs` with no Bun API and no import
 * from `node_modules` — it has to execute under a bare Node before the tree
 * exists. The unsatisfiable `engines` ranges in `package.json` name this command
 * in their text, so it is what an npm or pnpm user is told to run.
 *
 * ## Which tools actually reach it
 *
 * Measured against this repository, not assumed (npm 11.1.0, yarn 1.22.22,
 * pnpm 10.8.1). Every one exits 1 and writes no lockfile:
 *
 *   * `bun install` — runs it. Bun reads NEITHER `packageManager` nor
 *     `engines`, so this hook is the only thing standing there.
 *   * `npm install` — never reaches it. npm honours `packageManager` only
 *     through Corepack, which is off by default, so `engine-strict` plus the
 *     `engines` ranges are what stop it — during resolution, before any
 *     lifecycle script, which is also why `--ignore-scripts` cannot get past
 *     them. That is why those ranges carry an instruction rather than a version.
 *   * `pnpm install` — never reaches it: pnpm reads `packageManager` itself and
 *     exits with "This project is configured to use bun".
 *   * `yarn install` — never reaches it either, for the same reason: yarn 1.22
 *     sees `packageManager` and demands Corepack. Remove that field and yarn
 *     WOULD run this hook, before validating `engines` — so the ordering differs
 *     per tool, and no single layer covers all four.
 *
 * ## What it cannot do
 *
 * `--ignore-scripts` (the CLI flag, bunfig `[install] ignoreScripts`, or
 * `.npmrc` `ignore-scripts=true`) skips this file silently. That hole is covered
 * from two other sides rather than pretended away: the `engines` rejection above
 * happens before scripts are considered at all, and the foreign-lockfile check
 * below runs again as a `lefthook verify` gate, where it catches the tree a
 * skipped install left behind.
 *
 * Bun itself reads NEITHER `packageManager` NOR `engines` (verified against the
 * 1.4.0 binary: the string `packageManager` does not occur in it, and an
 * `engines` range of `>=99.0.0` installs with exit 0 and no warning). There is
 * no Corepack for Bun. So every check here is this file's own work — nothing is
 * delegated to the package manager.
 *
 * Run it directly to check a machine without installing anything:
 *
 *     bun scripts/require-bun.mjs
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Lockfiles nothing in this repo writes. One on disk means a foreign install
 * ran — and it is not cosmetic: it pins a second, unaudited resolution of the
 * same dependency graph, which `bun audit` and CI never look at.
 */
const FOREIGN_LOCKFILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
];

const INSTALLER_POSIX = 'https://bun.com/install';
const INSTALLER_WINDOWS = 'https://bun.com/install.ps1';

const isWindows = process.platform === 'win32';

/**
 * `true` when this must not touch the network or the machine.
 *
 * CI is excluded because the runner installs Bun itself — `oven-sh/setup-bun`
 * reads `packageManager` — so an auto-install there would be a second, unpinned
 * toolchain appearing mid-build. A container build sets
 * `BUN_GUARD_NO_AUTO_INSTALL` for the same reason; see
 * `reports/coolify-deployment.md`.
 */
const autoInstallDisabled = Boolean(
  process.env.CI || process.env.BUN_GUARD_NO_AUTO_INSTALL
);

/** @param {string[]} lines */
function report(lines) {
  console.error(['', ...lines, ''].join('\n'));
}

/**
 * @param {string[]} lines
 * @returns {never}
 */
function fail(lines) {
  report(lines);
  process.exit(1);
}

/**
 * The pin, parsed from the one place it lives.
 *
 * `server.ts` derives its own floor from the same field. Neither holds a
 * literal version, because a duplicated pin is a pin that drifts — this file
 * replaced exactly that, a hardcoded `1.4.0` in `server.ts` that had to be
 * remembered alongside `packageManager`.
 *
 * @returns {{ raw: string, parts: number[] }}
 */
function requiredVersion() {
  const manifest = path.join(ROOT, 'package.json');
  const { packageManager } = JSON.parse(readFileSync(manifest, 'utf8'));

  if (typeof packageManager !== 'string')
    fail([
      'package.json has no `packageManager` field.',
      'This guard reads the required Bun version from it, so it cannot run without it.',
      'Add:  "packageManager": "bun@<major>.<minor>.<patch>"',
    ]);

  const match = /^bun@(\d+\.\d+\.\d+)$/.exec(packageManager);
  if (!match)
    fail([
      `package.json declares \`packageManager: "${packageManager}"\`.`,
      'This project is Bun-only and that field must read exactly `bun@<major>.<minor>.<patch>`.',
    ]);

  const raw = /** @type {string} */ (match[1]);
  return { raw, parts: raw.split('.').map(Number) };
}

/**
 * `[major, minor, patch]`, or `null` when the text carries no release number.
 *
 * A canary build reports something like `1.4.1-canary.20260101`. The numeric
 * prefix is what a floor comparison needs, and the suffix is dropped rather
 * than rejected — refusing to run on a canary is not this guard's call.
 *
 * @param {string} text
 * @returns {number[] | null}
 */
function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * @param {number[]} actual
 * @param {number[]} required
 */
function isAtLeast(actual, required) {
  for (const [index, floor] of required.entries()) {
    const value = actual[index] ?? 0;
    if (value > floor) return true;
    if (value < floor) return false;
  }
  return true;
}

/**
 * The tool that started this install, from `npm_config_user_agent`.
 *
 * All four set it, each with its own name first. Bun writes
 * `bun/1.4.0 npm/? node/v26.3.0 win32 x64` — where both `npm/?` and the Node
 * version are literals Bun invents, so ONLY the leading token may be read.
 * `process.versions.bun` cannot stand in for this: it describes whichever
 * runtime is executing this file, which under `bun install` is Bun even when
 * npm asked for the install.
 *
 * @returns {string | null}
 */
function detectManager() {
  const agent = process.env.npm_config_user_agent;
  if (!agent) return null;
  const name = agent.split('/', 1)[0];
  return name ? name.toLowerCase() : null;
}

/**
 * Where Bun is and what version it reports, or `null` when it is not installed.
 *
 * `~/.bun/bin` is probed after `PATH` because a process that has just run the
 * installer does not inherit the new `PATH` entry — without this, a successful
 * auto-install would still read back as "Bun not found".
 *
 * The `.exe` variants are not cosmetic. Windows resolves `PATHEXT` only for a
 * bare command name; an ABSOLUTE path is used verbatim, so
 * `%BUN_INSTALL%\bin\bun` names a file that does not exist and both directory
 * probes silently missed a Bun that was installed — reported as "Bun is not
 * installed" on the exact machines the fallback exists for.
 *
 * @returns {{ path: string, version: number[] } | null}
 */
function findBun() {
  const bunInstall = process.env.BUN_INSTALL;
  const directories = [
    ...(bunInstall ? [path.join(bunInstall, 'bin')] : []),
    path.join(homedir(), '.bun', 'bin'),
  ];
  const candidates = [
    'bun',
    ...directories.flatMap((directory) =>
      isWindows
        ? [path.join(directory, 'bun.exe'), path.join(directory, 'bun')]
        : [path.join(directory, 'bun')]
    ),
  ];

  for (const candidate of candidates) {
    try {
      const output = execFileSync(candidate, ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const version = parseVersion(output);
      if (version) return { path: candidate, version };
    } catch {
      // Not on PATH, or not executable. Try the next candidate.
    }
  }
  return null;
}

/**
 * Which installer owns this Bun — because upgrading it the wrong way leaves two.
 *
 * Bun's own docs carve out Homebrew and Scoop by name ("to avoid conflicts, use
 * `brew upgrade bun` / `scoop update bun` instead"). Running the official
 * installer over either produces a second binary in `~/.bun/bin`, and `PATH`
 * order decides which one answers — so a user could "upgrade" successfully and
 * still be running the old version.
 *
 * @param {string} bunPath
 * @returns {'homebrew' | 'scoop' | 'npm' | 'native'}
 */
function installSource(bunPath) {
  let resolved = bunPath;
  if (resolved === 'bun')
    try {
      // Bun is asked where it is, rather than `which` / `where` being asked
      // about Bun. Those are two different portability problems: `where` is
      // Windows-only, `which` is absent from a plain busybox or a slim
      // container image, and both would have needed a platform branch that
      // could be wrong on a third platform. This has none.
      resolved = execFileSync('bun', ['--print', 'process.execPath'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      // Leave it as the bare name; the classification below then falls through
      // to 'native', which is the conservative answer — it offers the official
      // installer rather than a package-manager command that may not apply.
    }

  // Lower-cased for Windows' case-insensitive paths and for Homebrew's
  // `Cellar`. Every token matched below is a directory name that is lowercase
  // by convention on the platforms that use it, so this cannot turn a
  // case-sensitive POSIX path into a false match.
  const lower = resolved.toLowerCase().replaceAll('\\', '/');
  // `/opt/homebrew`, `/usr/local/Cellar`, `/home/linuxbrew/.linuxbrew`.
  if (/\/(?:cellar|homebrew|linuxbrew)\//.test(lower)) return 'homebrew';
  if (lower.includes('/scoop/')) return 'scoop';
  if (lower.includes('/node_modules/')) return 'npm';
  return 'native';
}

/**
 * `true` when `command` exists and can be executed.
 *
 * Used only to tell the user WHICH prerequisite is missing. Without it, a
 * container image with no `curl` produced a bare non-zero exit and the fallback
 * message said "Bun is not installed" — true, but not the reason.
 *
 * @param {string} command
 */
function canRun(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

/**
 * The official install command for one exact version, for this platform.
 *
 * One function so the command that RUNS and the command printed for the user to
 * run by hand can never drift apart.
 *
 * The tag form is `bun-v<version>` on BOTH platforms, which is not the shape
 * either documented example uses. It is the only form that needs no trust in
 * normalisation: the bash installer uses its argument verbatim as the release
 * tag, and `install.ps1` rewrites a bare `1.4.0` to `bun-v1.4.0` but passes
 * `bun-v1.4.0` through untouched (read from the live scripts, 2026-08-24).
 *
 * macOS and Linux share the curl form — Bun's installer resolves the platform
 * and architecture itself, including Linux musl and arm64, so there is nothing
 * per-distribution to branch on here.
 *
 * @param {string} version
 */
function installCommand(version) {
  const tag = `bun-v${version}`;
  return isWindows
    ? `iex "& {$(irm ${INSTALLER_WINDOWS})} -Version ${tag}"`
    : `curl -fsSL ${INSTALLER_POSIX} | bash -s "${tag}"`;
}

/**
 * Runs Bun's official installer for one exact version.
 *
 * The exact command is printed before it runs. This fetches and executes a
 * remote script — the method Bun documents, and still a supply-chain action the
 * user is entitled to see, refuse (`BUN_GUARD_NO_AUTO_INSTALL=1`) and audit.
 *
 * @param {string} version
 * @returns {boolean}
 */
function installBun(version) {
  const command = installCommand(version);

  // Bun's installer is a bash script fetched with curl, and the pipe between
  // them needs a shell — so on any POSIX platform all three have to be present.
  // `bash` specifically, not `sh`: the script uses bash builtins and Alpine's
  // default shell is not bash. Named individually because "install failed" and
  // "this image has no curl" are different problems for whoever reads it.
  if (!isWindows) {
    const missing = ['curl', 'bash'].filter((tool) => !canRun(tool));
    if (missing.length > 0) {
      report([
        `Cannot install Bun automatically: ${missing.join(' and ')} not available.`,
        "Bun's installer needs both. Install them, or use a package manager:",
        '    brew install oven-sh/bun/bun',
        '    npm install -g bun',
      ]);
      return false;
    }
  }

  report([
    `Installing Bun ${version} with Bun's official installer:`,
    `    ${command}`,
    'To skip this and get instructions only:  BUN_GUARD_NO_AUTO_INSTALL=1',
  ]);

  const result = isWindows
    ? spawnSync(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
        { stdio: 'inherit' }
      )
    : spawnSync('bash', ['-c', command], { stdio: 'inherit' });

  return result.status === 0;
}

/**
 * @param {string} version
 * @param {'missing' | 'outdated'} reason
 * @returns {never}
 */
function manualInstructions(version, reason) {
  const command = installCommand(version);
  fail([
    reason === 'missing'
      ? `Bun ${version} or newer is required, and Bun is not installed.`
      : `Bun ${version} or newer is required.`,
    '',
    isWindows ? `    powershell -c '${command}'` : `    ${command}`,
    '',
    'Then:  bun install',
  ]);
}

function assertNoForeignLockfile() {
  const found = FOREIGN_LOCKFILES.filter((name) =>
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- `name` comes from the FOREIGN_LOCKFILES literal above
    existsSync(path.join(ROOT, name))
  );
  if (found.length === 0) return;

  fail([
    `Foreign lockfile in the repository: ${found.join(', ')}`,
    'Only `bun.lock` describes this project. A second lockfile pins a resolution',
    'of the same graph that `bun audit` and CI never inspect.',
    '',
    isWindows
      ? `    Remove-Item ${found.join(', ')}; bun install`
      : `    rm ${found.join(' ')} && bun install`,
  ]);
}

function main() {
  const required = requiredVersion();
  const manager = detectManager();

  assertNoForeignLockfile();

  const bun = findBun();

  if (!bun) {
    if (autoInstallDisabled) manualInstructions(required.raw, 'missing');
    if (!installBun(required.raw)) manualInstructions(required.raw, 'missing');
    // Non-zero even though the install succeeded. Bun is on disk now, but this
    // process was started by the wrong tool, and letting it continue is exactly
    // how a foreign lockfile gets written after a successful install.
    fail([
      'Bun is installed. Open a new shell so PATH picks it up, then:',
      '',
      '    bun install',
    ]);
  }

  const running = bun.version.join('.');

  if (!isAtLeast(bun.version, required.parts)) {
    const source = installSource(bun.path);

    if (source !== 'native')
      fail([
        `Bun ${running} is older than the required ${required.raw}, and it was installed with ${source}.`,
        'Upgrading it any other way leaves two Bun binaries, and PATH order decides which answers.',
        '',
        `    ${
          {
            homebrew: 'brew upgrade bun',
            scoop: 'scoop update bun',
            npm: `npm install -g bun@${required.raw}`,
          }[source]
        }`,
        '',
        'Then:  bun install',
      ]);

    if (autoInstallDisabled) manualInstructions(required.raw, 'outdated');

    report([`Bun ${running} is older than the required ${required.raw}.`]);
    if (!installBun(required.raw)) manualInstructions(required.raw, 'outdated');

    // Same reason as the missing-Bun path: this process is still the old
    // binary. `bun upgrade` would also work here and would land on latest
    // rather than on the pin; the pin is used so a repaired machine matches CI
    // exactly.
    fail([`Bun ${required.raw} is installed. Re-run:`, '', '    bun install']);
  }

  if (manager && manager !== 'bun')
    fail([
      `This project is Bun-only, and \`${manager}\` started this install.`,
      `Bun ${running} is already on this machine, so nothing needs installing:`,
      '',
      '    bun install',
    ]);
}

const entry = process.argv[1];
if (entry && pathToFileURL(path.resolve(entry)).href === import.meta.url)
  main();
