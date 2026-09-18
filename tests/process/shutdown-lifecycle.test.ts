import { describe, expect, test } from 'bun:test';
import path from 'node:path';

const CHILD = path.join(
  import.meta.dir,
  '..',
  'fixtures',
  '_shutdown-child.ts'
);

interface Outcome {
  exitCode: number | null;
  lines: Record<string, unknown>[];
  elapsedMs: number;
}

async function runChild(
  mode: 'clean' | 'half-sent' | 'slow-request'
): Promise<Outcome> {
  const started = performance.now();
  const child = Bun.spawn(['bun', '--no-env-file', CHILD, mode], {
    cwd: path.join(import.meta.dir, '..', '..'),
    env: { ...process.env, NODE_ENV: 'development' },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [out, , exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  const lines = out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });

  return { exitCode, lines, elapsedMs: performance.now() - started };
}

function messages(outcome: Outcome): string[] {
  return outcome.lines.map((line) => String(line.msg));
}

describe('shutdown', () => {
  test('completes and closes every store with no clients attached', async () => {
    const outcome = await runChild('clean');

    expect(outcome.exitCode).toBe(0);
    expect(messages(outcome)).toContain('all stores closed');
  }, 60_000);

  test('completes despite a half-sent request, and still closes stores', async () => {
    const outcome = await runChild('half-sent');

    expect(outcome.exitCode).toBe(0);
    expect(messages(outcome)).toContain('all stores closed');
    expect(outcome.elapsedMs).toBeLessThan(30_000);
  }, 60_000);

  test('a request that outlives the grace interval is completed, not reset', async () => {
    // The half-sent case above forces the escalation to `app.stop(true)` to
    // exist at all; this is the case it must not catch. Measured before the
    // fix: an eight-second handler was RESET at the five-second mark, mid
    // deploy, while the route budget allowed it two more minutes.
    const outcome = await runChild('slow-request');

    expect(outcome.exitCode).toBe(0);
    expect(outcome.lines.find((line) => line.msg === 'inflight')?.outcome).toBe(
      'status 200'
    );
    expect(messages(outcome)).toContain(
      'graceful stop still draining in-flight requests'
    );
    expect(messages(outcome)).toContain('all stores closed');
  }, 60_000);
});
