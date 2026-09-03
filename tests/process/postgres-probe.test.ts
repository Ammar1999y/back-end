/**
 * The readiness probe against PostgreSQL peers that do not answer.
 *
 * Two peers, one child each. The SILENT one accepts and never speaks: every
 * probe must settle within the one deadline both bounds derive from, a
 * concurrent burst must open at most one connection, repeated polls must not
 * stack abandoned statements, and the pool must close with a probe genuinely
 * in flight. The REFUSING one is a closed port: the failure must reach the
 * caller as a thrown error, so the health route can log its class instead of
 * collapsing every misconfiguration into the same silent `false`.
 *
 * "Not reachable" has two honest shapes here. The response race answers `false`
 * when it wins; the driver's own connection timeout, which fires at the same
 * deadline, is a thrown `PostgresError` — and the driver answers the probe
 * right after a failed one from that state without opening a socket. Both are
 * refusals inside the deadline, and the assertions accept either.
 *
 * A child process, because `DATABASE_URL` is read when `db/index.ts` loads, and
 * no `process.exit` in it: a leaked handle would keep it from ending.
 */
import { describe, expect, test } from 'bun:test';
import path from 'node:path';

const CHILD = path.join(
  import.meta.dir,
  '..',
  'fixtures',
  '_postgres-probe-child.ts'
);

/** Timer slack on a loaded CI runner; the deadline itself is 2 s. */
const SLACK_MS = 2500;

interface Line {
  msg: string;
  [key: string]: unknown;
}

interface Outcome {
  exitCode: number | null;
  lines: Line[];
}

async function runChild(mode: 'silent' | 'refusing'): Promise<Outcome> {
  const child = Bun.spawn(['bun', '--no-env-file', CHILD, mode], {
    cwd: path.join(import.meta.dir, '..', '..'),
    env: { ...process.env, NODE_ENV: 'development' },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [out, err, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  // A fixture that died in setup would otherwise surface as missing lines with
  // no cause; the cause is on its stderr.
  if (exitCode !== 0)
    throw new Error(
      `postgres-probe child (${mode}) exited ${exitCode}\n${err.trim().slice(-2000)}`
    );

  const lines = out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Line];
      } catch {
        return [];
      }
    });

  return { exitCode, lines };
}

function one(outcome: Outcome, msg: string): Line {
  const found = outcome.lines.find((line) => line.msg === msg);
  if (!found) throw new Error(`child emitted no "${msg}" line`);
  return found;
}

/** A probe that did not reach `true`: the race's `false` or the driver's throw. */
function expectUnreachable(result: unknown): void {
  expect(result === false || result === 'PostgresError').toBe(true);
}

describe('the readiness probe against a silent PostgreSQL peer', () => {
  const run = runChild('silent');

  test('the child ends on its own, so nothing held the process open', async () => {
    const outcome = await run;
    expect(outcome.exitCode).toBe(0);
    expect(outcome.lines.at(-1)?.msg).toBe('done');
  }, 60_000);

  test('a single probe settles unreachable within the deadline', async () => {
    const outcome = await run;
    const deadline = Number(one(outcome, 'peer listening').deadlineMs);
    const probe = one(outcome, 'single probe');

    expectUnreachable(probe.result);
    expect(Number(probe.ms)).toBeLessThan(deadline + SLACK_MS);
    expect(Number(probe.accepted)).toBeGreaterThanOrEqual(1);
  }, 60_000);

  test('a concurrent burst shares one probe and opens at most one connection', async () => {
    const outcome = await run;
    const deadline = Number(one(outcome, 'peer listening').deadlineMs);
    const before = Number(one(outcome, 'single probe').accepted);
    const burst = one(outcome, 'concurrent probes');

    expect(burst.results).toHaveLength(5);
    for (const result of burst.results as unknown[]) expectUnreachable(result);
    expect(Number(burst.ms)).toBeLessThan(deadline + SLACK_MS);
    expect(Number(burst.accepted) - before).toBeLessThanOrEqual(1);
  }, 60_000);

  test('repeated probes each settle within the deadline and add at most one connection each', async () => {
    const outcome = await run;
    const deadline = Number(one(outcome, 'peer listening').deadlineMs);
    const repeats = outcome.lines.filter(
      (line) => line.msg === 'sequential probe'
    );
    expect(repeats).toHaveLength(3);

    let previous = Number(one(outcome, 'concurrent probes').accepted);
    for (const probe of repeats) {
      expectUnreachable(probe.result);
      expect(Number(probe.ms)).toBeLessThan(deadline + SLACK_MS);
      // A poll that queued behind an abandoned statement would answer late; a
      // poll that opened more than one connection would show here.
      expect(Number(probe.accepted) - previous).toBeLessThanOrEqual(1);
      previous = Number(probe.accepted);
    }
  }, 60_000);

  test('the pool closes with a probe genuinely in flight, settles it, and leaves no socket open', async () => {
    const outcome = await run;
    const deadline = Number(one(outcome, 'peer listening').deadlineMs);
    const closed = one(outcome, 'closed with a probe outstanding');

    // The peer had accepted the probe's socket before `closeDatabase` ran.
    expect(closed.inFlight).toBe(true);
    // `close()` waits for the in-flight attempt, so it takes up to the
    // deadline and no longer — an unbounded wait here would hang shutdown.
    expect(Number(closed.closeMs)).toBeLessThan(deadline + SLACK_MS);
    const outstanding = closed.outstanding as { result: unknown; ms: number };
    expectUnreachable(outstanding.result);
    expect(Number(outstanding.ms)).toBeLessThan(deadline + SLACK_MS);
    expect(closed.open).toBe(0);
  }, 60_000);
});

describe('the readiness probe against a refusing port', () => {
  const run = runChild('refusing');

  test('the refusal is thrown with its class, not flattened to false', async () => {
    const outcome = await run;
    expect(outcome.exitCode).toBe(0);
    expect(outcome.lines.at(-1)?.msg).toBe('done');

    const probe = one(outcome, 'refused probe');
    expect(probe.result).toBe('PostgresError');
    expect(Number(probe.ms)).toBeLessThan(SLACK_MS);
  }, 60_000);
});
