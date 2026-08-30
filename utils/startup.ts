/**
 * The DECISIONS behind `server.ts`'s boot gates, as pure functions.
 *
 * Split out for one reason: those gates run at module scope, before `./app` is
 * dynamically imported, so importing `server.ts` to test them starts a server
 * and binds a port. The only observable behaviour left was a spawned process's
 * exit code, and two of the four gates could not be varied from a child at all —
 * `assertBunVersion` reads the running Bun and the repository's own
 * `package.json`, `assertSqliteVersion` reads the version compiled into the
 * binary. Both were therefore untested, which is the state a fail-closed guard
 * silently regresses from.
 *
 * Every function here is total: same input, same verdict, no environment, no
 * process, no I/O. `server.ts` keeps the wiring — read the value, call the
 * verdict, `fail(reason)` — and `tests/unit/startup-gates-logic.test.ts` asserts
 * the verdicts. What remains unasserted is that one-line wiring, and the
 * spawned cases in `tests/process/startup-gates.test.ts` cover it for the two
 * gates whose inputs a child CAN vary.
 *
 * No application import, and nothing here may gain one: it is loaded by the
 * entry point above the `NODE_ENV` check.
 */

/** A gate's answer. `warning` is for something notable that is not a refusal. */
export type Verdict =
  { ok: true; warning?: string } | { ok: false; reason: string };

/** Leading `major.minor.patch`, ignoring any `-canary.…` tail. */
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)/;

/** The one spelling `packageManager` may take — the single source for the pin. */
const PACKAGE_MANAGER_PATTERN = /^bun@(\d+\.\d+\.\d+)$/;

export const DEFAULT_PORT = 3000;

/** `[major, minor, patch]`, or `null` when the text carries no release number. */
export function parseVersionParts(text: string): number[] | null {
  const match = VERSION_PATTERN.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** `true` when `running` is at or above `floor`, compared field by field. */
export function atLeastVersion(
  running: readonly number[],
  floor: readonly number[]
): boolean {
  for (const [index, value] of floor.entries()) {
    const actual = running[index] ?? 0;
    if (actual > value) return true;
    if (actual < value) return false;
  }
  return true;
}

/**
 * A port, or the reason to refuse one.
 *
 * `Number(process.env.PORT)` accepted `''` as 0, `'3000abc'` as NaN and
 * `'3000.5'` as a float. Bun then binds an ephemeral or clamped port while the
 * startup log reports the requested value — so the log lies to the operator
 * about where the server is. An EMPTY value is the absent case, not a rejection:
 * an orchestrator that declares `PORT` without a value means "you choose".
 */
export function portVerdict(
  raw: string | undefined,
  fallback: number = DEFAULT_PORT
): { ok: true; port: number } | { ok: false; reason: string } {
  const trimmed = raw?.trim();
  if (!trimmed) return { ok: true, port: fallback };
  if (!/^\d+$/.test(trimmed))
    return {
      ok: false,
      reason: `PORT must be a decimal integer. Received: "${trimmed}".`,
    };
  const port = Number(trimmed);
  if (port < 1 || port > 65_535)
    return {
      ok: false,
      reason: `PORT must be between 1 and 65535. Received: ${port}.`,
    };
  return { ok: true, port };
}

/**
 * Refuses a Bun OLDER than the tested pin, and warns about anything newer.
 *
 * A FLOOR, not an equality check, and the difference is deliberate. BOTH
 * database drivers are compiled into the binary, so their transaction semantics
 * travel with the Bun version rather than with a lockfile entry. `bun:sqlite` is
 * the older reason. `bun:sql` is the sharper one: through 1.3.x a simple-protocol
 * query running concurrently with a not-yet-prepared parameterized query on the
 * same connection could deliver one query's rows to the other, and the `BEGIN`,
 * `COMMIT` and `ROLLBACK` that `db.transaction()` issues ARE simple-protocol
 * queries (Bun #32772, fixed in 1.4.0). Below the pin, every transaction in the
 * application is exposed to that — so below the pin is fatal.
 *
 * Above the pin is a WARNING, not a failure: newer is untested, not
 * known-broken, and refusing it turns a routine image bump into an outage.
 * `scripts/require-bun.mjs` treats the pin as a floor too, so the install check
 * and the boot check state one policy.
 *
 * A malformed pin is fatal rather than "no pin": `bun@1.4` or `bun@^1.4.0` is
 * not a looser requirement, it is a server that cannot say what it was tested
 * against.
 */
export function bunVersionVerdict(
  running: string,
  packageManager: string
): Verdict {
  const pin = PACKAGE_MANAGER_PATTERN.exec(packageManager)?.[1];
  if (!pin)
    return {
      ok: false,
      reason:
        `package.json declares packageManager "${packageManager}". ` +
        'It must read exactly bun@<major>.<minor>.<patch> — it is the only source ' +
        'for the tested runtime version, read here and by scripts/require-bun.mjs.',
    };

  if (running === pin) return { ok: true };

  const parts = parseVersionParts(running);
  if (!parts)
    return {
      ok: false,
      reason:
        `Bun reports version "${running}", which is not major.minor.patch. ` +
        `The tested version is ${pin} and this cannot be compared to it.`,
    };

  if (!atLeastVersion(parts, pin.split('.').map(Number)))
    return {
      ok: false,
      reason:
        `Bun ${running} is older than the tested ${pin}. ` +
        'Both database drivers are compiled into the runtime, so this is a ' +
        'transaction-correctness floor and not a preference — see Bun #32772. ' +
        'Upgrade the image, or run: bun run check:runtime',
    };

  return {
    ok: true,
    warning: JSON.stringify({
      msg: 'bun version ahead of the tested pin',
      running,
      tested: pin,
    }),
  };
}

/**
 * The conservative floor for the WAL-reset race — see the SQLite notice linked
 * from `reports/coolify-deployment.md` §6. `bun:sqlite` links SQLite into the
 * Bun binary, so this is a property of the deployed runtime rather than of a
 * pinned npm package, and nothing but an assertion can catch drift.
 */
export function sqliteVersionVerdict(
  version: string,
  floor: readonly number[]
): Verdict {
  // A version string this cannot parse is refused rather than waved through:
  // `''` is what `sqlite_version()` returns when the probe itself went wrong.
  const parts = parseVersionParts(version);
  if (!parts)
    return {
      ok: false,
      reason:
        `SQLite reported version "${version}", which is not major.minor.patch, ` +
        `so it cannot be compared to the ${floor.join('.')} floor for the WAL-reset race.`,
    };

  if (atLeastVersion(parts, floor)) return { ok: true };
  return {
    ok: false,
    reason:
      `SQLite ${version} is below the ${floor.join('.')} floor for the ` +
      'WAL-reset race. It ships with the Bun binary; change the image, not a package.',
  };
}
