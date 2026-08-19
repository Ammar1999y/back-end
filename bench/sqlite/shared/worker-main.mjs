// One child process. Three roles, selected by flag:
//   default    contend on a shared database for a fixed duration (benchmark)
//   --exact    perform exactly N consumes against one key (correctness)
//   --hammer   pause inside an uncommitted write transaction (crash-safety)

import { existsSync, readSync, statSync } from 'node:fs';

import { parseArgs } from './main.mjs';
import { runWorkloadForDuration } from './runner.mjs';
import {
  makePayload,
  NO_LIMIT,
  SQL_CACHE_PUT,
  SQL_RL_CONSUME,
} from './schema.mjs';
import { isBusyError } from './stats.mjs';
import { CONCURRENT_WORKLOADS } from './workloads.mjs';

function waitForGo() {
  const buffer = Buffer.alloc(64);
  let received = '';
  while (!received.includes('GO')) {
    let read = 0;
    try {
      read = readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      if (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK') continue;
      if (error.code === 'EOF') break;
      throw error;
    }
    if (read > 0) received += buffer.toString('utf8', 0, read);
  }
}

// Exactly N consumes on one key. Any rejected consume fails the parent check.
function runExact(db, args) {
  const stmt = db.prepare(SQL_RL_CONSUME);
  const total = Number(args.perWorker);
  const windowStart = Number(args.windowStart);
  process.stdout.write('READY\n');
  waitForGo();

  let errors = 0;
  for (let i = 0; i < total; i++) {
    try {
      // NO_LIMIT: this case asserts that N*K consumes all land, so every one of
      // them has to be admitted. A real max would make the tail refusals, and
      // `max_aware_admission_denies_without_writing` covers that path instead.
      stmt.get(args.key, windowStart, windowStart + 60_000, NO_LIMIT);
    } catch (error) {
      errors++;
      if (!isBusyError(error)) throw error;
    }
  }
  process.stdout.write(`ERRORS=${errors}\n`);
}

// Stop inside a live transaction so the parent can deterministically kill this
// process before COMMIT and verify that every in-flight row rolls back.
function runHammer(db) {
  // Force dirty pages to spill before COMMIT so SIGKILL tests recovery from an
  // actual uncommitted WAL, independent of each runtime's page-cache default.
  db.pragma('cache_size=-64');
  const put = db.prepare(SQL_CACHE_PUT);
  const payload = makePayload(4096);
  const block = new Int32Array(new SharedArrayBuffer(4));
  const batch = db.transaction(() => {
    const now = Date.now();
    for (let k = 0; k < 1000; k++)
      put.run(`crash:inflight:${k}`, payload, now + 600_000, now);
    process.stdout.write('IN_TXN\n');
    Atomics.wait(block, 0, 0);
  });
  batch();
}

export function workerMain(driver) {
  const args = parseArgs(process.argv);
  const db = driver.open(args.db, args.profile, args.schemaScope ?? 'all');

  try {
    if (args.exact) return runExact(db, args);
    if (args.hammer) return runHammer(db);

    const factory = CONCURRENT_WORKLOADS[args.workload];
    if (!factory) throw new Error(`unknown workload: ${args.workload}`);

    const result = runWorkloadForDuration(factory(), db, {
      durationMs: Number(args.durationMs),
      seed: false,
      onReady: () => {
        process.stdout.write('READY\n');
        waitForGo();
      },
    });
    const walPath = `${args.db}-wal`;
    result.walBytesBeforeClose = existsSync(walPath)
      ? statSync(walPath).size
      : 0;

    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    db.close();
  }
}
