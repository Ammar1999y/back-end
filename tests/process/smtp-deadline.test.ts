/**
 * `sendMailWithDeadline` against a real SMTP peer that stalls at each phase.
 *
 * The property is the one Nodemailer's own timeouts cannot give: a bound on the
 * WHOLE delivery. Its `socketTimeout` is an inactivity timer, so a peer that
 * keeps a multi-line reply going never trips it — the `drip` mode here. The
 * child sets every phase timeout to four times the deadline, so a rejection
 * inside the window can only be the deadline's, and it reports whether the peer
 * saw the socket close, which is the cleanup half of the contract.
 */
import { describe, expect, test } from 'bun:test';
import path from 'node:path';

const CHILD = path.join(
  import.meta.dir,
  '..',
  'fixtures',
  '_smtp-deadline-child.ts'
);

const STALL_MODES: string[] = ['greeting', 'ehlo', 'auth', 'data', 'drip'];

/** Timer slack on a loaded CI runner. */
const SLACK_MS = 1000;

interface Line {
  msg: string;
  [key: string]: unknown;
}

interface Outcome {
  exitCode: number | null;
  lines: Line[];
  elapsedMs: number;
}

async function runChild(): Promise<Outcome> {
  const started = performance.now();
  const child = Bun.spawn(['bun', '--no-env-file', CHILD], {
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

  // A fixture that died in setup would otherwise surface as nine missing
  // outcomes with no cause; the cause is on its stderr.
  if (exitCode !== 0)
    throw new Error(
      `smtp-deadline child exited ${exitCode}\n${err.trim().slice(-2000)}`
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

  return { exitCode, lines, elapsedMs: performance.now() - started };
}

function settled(outcome: Outcome, mode: string): Line {
  const found = outcome.lines.find(
    (line) => line.msg === 'send settled' && line.mode === mode
  );
  if (!found) throw new Error(`child reported no outcome for mode "${mode}"`);
  return found;
}

describe('the SMTP delivery deadline', () => {
  const run = runChild();

  test('the child exits on its own, so no destroyed socket kept the process alive', async () => {
    const outcome = await run;
    expect(outcome.exitCode).toBe(0);
    expect(outcome.lines.at(-1)?.msg).toBe('done');
  }, 60_000);

  test('a peer that completes the protocol gets a delivery, so the injected socket is a real one', async () => {
    const outcome = await run;
    const success = settled(outcome, 'success');

    expect(success.settled).toBe('resolved');
    expect(typeof success.messageId).toBe('string');
    expect(success.peerClosed).toBe(true);
  }, 60_000);

  test.each(STALL_MODES)(
    'a peer silent after %s is refused at the deadline and its socket is closed',
    async (mode) => {
      const outcome = await run;
      const deadline = Number(
        outcome.lines.find((line) => line.msg === 'peer listening')?.deadlineMs
      );
      const result = settled(outcome, mode);

      expect(result.settled).toBe('rejected');
      expect(result.name).toBe('SmtpDeadlineExceeded');
      expect(result.code).toBe('EDEADLINE');
      expect(Number(result.ms)).toBeGreaterThanOrEqual(deadline - 50);
      expect(Number(result.ms)).toBeLessThan(deadline + SLACK_MS);
      expect(result.peerClosed).toBe(true);
    },
    60_000
  );

  /**
   * The branch production takes: Gmail's service definition is implicit TLS on
   * 465, so `sendMailWithDeadline` opens the socket with `tls.connect`. The
   * plaintext cases above never reach that code.
   */
  test('an implicit-TLS peer gets a delivery over the owned TLS socket', async () => {
    const outcome = await run;
    const result = settled(outcome, 'tls-success');

    expect(result.tls).toBe(true);
    expect(result.settled).toBe('resolved');
    expect(typeof result.messageId).toBe('string');
    expect(result.peerClosed).toBe(true);
  }, 60_000);

  test('a TLS handshake that never completes is refused at the deadline and the socket is destroyed', async () => {
    const outcome = await run;
    const deadline = Number(
      outcome.lines.find((line) => line.msg === 'peer listening')?.deadlineMs
    );
    const result = settled(outcome, 'tls-handshake');

    expect(result.tls).toBe(true);
    expect(result.settled).toBe('rejected');
    expect(result.name).toBe('SmtpDeadlineExceeded');
    expect(result.code).toBe('EDEADLINE');
    expect(Number(result.ms)).toBeGreaterThanOrEqual(deadline - 50);
    expect(Number(result.ms)).toBeLessThan(deadline + SLACK_MS);
    expect(result.peerClosed).toBe(true);
  }, 60_000);
});
