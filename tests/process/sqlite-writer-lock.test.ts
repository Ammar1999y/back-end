import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { acquireWriterLock } from '@/lib/sqlite/writer-lock';

const HOLDER = path.join(
  import.meta.dir,
  '..',
  'fixtures',
  '_writer-lock-child.ts'
);

const created: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'writer-lock-'));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

async function startHolder(directory: string) {
  const child = Bun.spawn(['bun', '--no-env-file', HOLDER, directory], {
    cwd: path.join(import.meta.dir, '..', '..'),
    env: { ...process.env, NODE_ENV: 'development' },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + 15_000;
  let buffered = '';
  while (Date.now() < deadline && !buffered.includes('"held":true')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffered += decoder.decode(chunk.value);
  }
  reader.releaseLock();
  if (!buffered.includes('"held":true'))
    throw new Error(`holder never reported the lock. Output: ${buffered}`);
  return child;
}

describe('the writer lock', () => {
  test('a second acquirer in another process is refused, loudly', async () => {
    const directory = tempDir();
    const holder = await startHolder(directory);

    try {
      expect(() => acquireWriterLock(directory)).toThrow(
        /already owns the SQLite directory/
      );
    } finally {
      holder.kill();
      await holder.exited;
    }
  }, 60_000);

  test('a hard-killed holder does not leave the lock stuck', async () => {
    // The reason this is a SQLite transaction and not a lock file: a plain file
    // needs stale-entry handling, because a killed process leaves one behind and
    // the next boot cannot tell "held" from "abandoned". An OS file lock is
    // released by the kernel.
    const directory = tempDir();
    const holder = await startHolder(directory);
    holder.kill(9);
    await holder.exited;

    const lock = acquireWriterLock(directory);
    expect(lock.release).toBeFunction();
    lock.release();
  }, 60_000);

  test('releasing lets the next acquirer through — a redeploy is not blocked', () => {
    const directory = tempDir();
    const first = acquireWriterLock(directory);
    first.release();

    const second = acquireWriterLock(directory);
    second.release();
    // Idempotent: shutdown can call it twice (the normal path and the
    // forced-exit timer).
    expect(() => second.release()).not.toThrow();
  });

  test('two directories are independent locks', () => {
    const a = acquireWriterLock(tempDir());
    const b = acquireWriterLock(tempDir());
    a.release();
    b.release();
  });
});
