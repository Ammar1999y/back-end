// Non-throughput checks. A driver that is fast and wrong is disqualified, so
// these run before any performance number is worth reading.
//
// Every check returns { name, pass, detail, critical }.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  NO_LIMIT,
  SQL_AUTH_CONSUME,
  SQL_CACHE_GET,
  SQL_CACHE_PUT,
  SQL_CACHE_SWEEP,
  SQL_RL_CONSUME,
  SWEEP_BATCH_SIZE,
} from './schema.mjs';
import { isBusyError } from './stats.mjs';

const WINDOW_MS = 60_000;

function check(name, pass, detail, critical = false) {
  return { name, pass, detail, critical };
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 1. STRICT actually rejects wrong types, so a bad write fails loudly instead of
//    silently storing a string where a timestamp belongs.
function strictEnforced(db) {
  try {
    db.prepare(
      'INSERT INTO rate_limit (key, window_start, count, expires_at) VALUES (?, ?, ?, ?)'
    ).run('strict-probe', 'not-an-integer', 1, 1);
    return check(
      'strict_type_enforcement',
      false,
      'accepted TEXT into an INTEGER column',
      true
    );
  } catch (error) {
    const message = String(error.message);
    const expectedError =
      message.includes('cannot store') || message.includes('datatype mismatch');
    return check(
      'strict_type_enforcement',
      expectedError,
      expectedError
        ? message.slice(0, 70)
        : `unexpected failure: ${message.slice(0, 60)}`,
      true
    );
  }
}

// 2. Binary fidelity. Cache values are opaque bytes; any transcoding corrupts them.
function blobFidelity(db) {
  const payload = Buffer.from([0, 1, 2, 253, 254, 255, 0, 128, 127]);
  const now = Date.now();
  db.prepare(SQL_CACHE_PUT).run('blob-probe', payload, now + 60_000, now);
  const row = db.prepare(SQL_CACHE_GET).get('blob-probe', now);
  const got = Buffer.from(row.value);
  const identical =
    got.length === payload.length && got.every((b, i) => b === payload[i]);
  return check(
    'blob_byte_fidelity',
    identical,
    identical
      ? `${payload.length} bytes round-tripped exactly`
      : `got ${got.join(',')}`,
    true
  );
}

// 3. A throwing transaction must leave nothing behind.
function rollbackOnThrow(db) {
  const put = db.prepare(SQL_CACHE_PUT);
  const now = Date.now();
  const failing = db.transaction(() => {
    put.run('rollback-probe', Buffer.from('x'), now + 60_000, now);
    throw new Error('deliberate');
  });
  try {
    failing();
  } catch {
    // expected
  }
  const row = db.prepare(SQL_CACHE_GET).get('rollback-probe', now);
  return check(
    'transaction_rollback',
    !row,
    row ? 'row survived a thrown transaction' : 'row absent',
    true
  );
}

function windowRollover(db) {
  const fixed = db.prepare(SQL_RL_CONSUME);
  const auth = db.prepare(SQL_AUTH_CONSUME);
  const firstWindow = 60_000;
  const secondWindow = 120_000;

  // NO_LIMIT throughout: this case asserts rollover, and a real limit would make
  // the second consume a denial instead, which `maxAwareAdmission` covers.
  fixed.get('rollover-fixed', firstWindow, firstWindow + WINDOW_MS, NO_LIMIT);
  const fixedTwo = fixed.get(
    'rollover-fixed',
    firstWindow,
    firstWindow + WINDOW_MS,
    NO_LIMIT
  );
  const fixedReset = fixed.get(
    'rollover-fixed',
    secondWindow,
    secondWindow + WINDOW_MS,
    NO_LIMIT
  );

  auth.get(
    'rollover-auth',
    firstWindow,
    firstWindow,
    firstWindow + WINDOW_MS,
    NO_LIMIT
  );
  const authTwo = auth.get(
    'rollover-auth',
    firstWindow,
    firstWindow + 1,
    firstWindow + WINDOW_MS,
    NO_LIMIT
  );
  const authReset = auth.get(
    'rollover-auth',
    secondWindow,
    secondWindow,
    secondWindow + WINDOW_MS,
    NO_LIMIT
  );

  const pass =
    Number(fixedTwo.count) === 2 &&
    Number(fixedReset.count) === 1 &&
    Number(fixedReset.window_start) === secondWindow &&
    Number(authTwo.count) === 2 &&
    Number(authReset.count) === 1 &&
    Number(authReset.window_start) === secondWindow;
  return check(
    'rate_limit_window_rollover',
    pass,
    `fixed ${fixedTwo.count}->${fixedReset.count}; auth ${authTwo.count}->${authReset.count}`,
    true
  );
}

/**
 * Max-aware admission, for both limiter statements.
 *
 * This is a driver-portability check, not only a SQL check. `ON CONFLICT DO UPDATE
 * … WHERE … RETURNING` has to behave identically on both builds: exactly `max`
 * admissions, no row on refusal, and — the property the clause was added for —
 * ZERO writes while refusing. A driver that returned an empty row object instead
 * of no row, or that applied the update anyway, would keep the limiter correct in
 * count while handing an attacker unlimited writes against the security store.
 */
function maxAwareAdmission(db) {
  const fixed = db.prepare(SQL_RL_CONSUME);
  const auth = db.prepare(SQL_AUTH_CONSUME);
  const windowStart = 5000 * WINDOW_MS;
  const max = 4;
  const attempts = 12;

  let fixedAdmitted = 0;
  for (let i = 0; i < attempts; i++) {
    if (fixed.get('maxaware-fixed', windowStart, windowStart + WINDOW_MS, max))
      fixedAdmitted++;
  }

  let authAdmitted = 0;
  for (let i = 0; i < attempts; i++) {
    if (
      auth.get(
        'maxaware-auth',
        windowStart,
        windowStart + i,
        windowStart + WINDOW_MS,
        max
      )
    )
      authAdmitted++;
  }

  const before = Number(db.prepare('SELECT total_changes() AS c').get().c);
  for (let i = 0; i < attempts; i++) {
    fixed.get('maxaware-fixed', windowStart, windowStart + WINDOW_MS, max);
    auth.get(
      'maxaware-auth',
      windowStart,
      windowStart,
      windowStart + WINDOW_MS,
      max
    );
  }
  const deniedWrites =
    Number(db.prepare('SELECT total_changes() AS c').get().c) - before;

  const storedFixed = Number(
    db
      .prepare('SELECT count FROM rate_limit WHERE key = ?')
      .get('maxaware-fixed').count
  );
  const storedAuth = Number(
    db
      .prepare('SELECT count FROM auth_rate_limit WHERE key = ?')
      .get('maxaware-auth').count
  );

  const pass =
    fixedAdmitted === max &&
    authAdmitted === max &&
    storedFixed === max &&
    storedAuth === max &&
    deniedWrites === 0;
  return check(
    'max_aware_admission_denies_without_writing',
    pass,
    `admitted fixed=${fixedAdmitted} auth=${authAdmitted} of ${attempts} at max=${max}; ` +
      `stored fixed=${storedFixed} auth=${storedAuth}; writes during ${attempts * 2} denials=${deniedWrites}`,
    true
  );
}

function expiryBoundary(db) {
  const put = db.prepare(SQL_CACHE_PUT);
  const get = db.prepare(SQL_CACHE_GET);
  const sweep = db.prepare(SQL_CACHE_SWEEP);
  const boundary = 1_000_000;
  put.run('expiry:past', Buffer.from('past'), boundary - 1, boundary - 10);
  put.run('expiry:equal', Buffer.from('equal'), boundary, boundary - 10);
  put.run('expiry:future', Buffer.from('future'), boundary + 1, boundary - 10);

  const past = get.get('expiry:past', boundary);
  const equal = get.get('expiry:equal', boundary);
  const future = get.get('expiry:future', boundary);
  sweep.run(boundary, SWEEP_BATCH_SIZE);
  const remaining = db
    .prepare("SELECT key FROM cache WHERE key GLOB 'expiry:*' ORDER BY key")
    .all()
    .map((row) => row.key);
  const pass = !past && !equal && Boolean(future) && remaining.length === 1;
  return check(
    'expiry_read_and_sweep_boundary',
    pass,
    `past=${Boolean(past)}, equal=${Boolean(equal)}, future=${Boolean(future)}, remaining=${remaining.join(',')}`,
    true
  );
}

// 4. Integers past 2^53 must not silently lose precision — expiry timestamps are
//    milliseconds now, but a counter or an id could exceed it.
function largeIntegerHandling(db) {
  const big = 9_007_199_254_740_993n; // 2^53 + 1
  const now = Date.now();
  try {
    db.prepare(
      'INSERT INTO rate_limit (key, window_start, count, expires_at) VALUES (?, ?, ?, ?)'
    ).run('bigint-probe', now, 1, big);
    const row = db
      .prepare('SELECT expires_at FROM rate_limit WHERE key = ?')
      .get('bigint-probe');
    const value = row.expires_at;
    const exact =
      typeof value === 'bigint' ? value === big : BigInt(value) === big;
    return check(
      'large_integer_precision',
      exact,
      `stored 2^53+1, read back ${value} (${typeof value})${exact ? '' : ' — precision lost'}`
    );
  } catch (error) {
    return check(
      'large_integer_precision',
      false,
      `threw: ${String(error.message).slice(0, 60)}`
    );
  }
}

// 5. Error messages must not carry the key. Keys hold IPs, emails and user ids,
//    and this codebase logs store failures.
function errorMessagePrivacy(db) {
  const secret = 'ip:203.0.113.77|user:victim@example.com';
  const now = Date.now();
  db.prepare(SQL_CACHE_PUT).run(secret, Buffer.from('v'), now + 60_000, now);
  let leaked = null;
  try {
    // A UNIQUE violation on a key we control is the realistic leak path.
    db.prepare(
      'INSERT INTO cache (key, value, expires_at, created_at) VALUES (?, ?, ?, ?)'
    ).run(secret, Buffer.from('v'), now + 60_000, now);
    return check(
      'error_message_privacy',
      false,
      'duplicate key raised no constraint error; privacy path was not exercised',
      true
    );
  } catch (error) {
    const text = `${error.message} ${error.stack ?? ''}`;
    leaked =
      text.includes('203.0.113.77') || text.includes('victim@example.com');
    return check(
      'error_message_privacy',
      !leaked,
      leaked
        ? `LEAKS key content into the error: ${String(error.message).slice(0, 80)}`
        : `error text carries no key content: ${String(error.message).slice(0, 60)}`,
      true
    );
  }
}

// 6. How long one synchronous call can stall the event loop. Both drivers are
//    synchronous, so this bounds the blast radius of a slow query on a server.
function eventLoopStall(db) {
  const put = db.prepare(SQL_CACHE_PUT);
  const payload = Buffer.alloc(1024 * 1024, 7); // 1 MB value
  const now = Date.now();
  const started = process.hrtime.bigint();
  db.transaction(() => {
    for (let i = 0; i < 64; i++)
      put.run(`stall:${i}`, payload, now + 60_000, now);
  })();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return check(
    'event_loop_stall_64mb_txn',
    true,
    `${ms.toFixed(1)} ms of uninterruptible blocking`
  );
}

// 7. Cold-open cost. Rolling deploys and short-lived scheduled tasks pay this.
function openLatency(driver, dir, profile, schemaScope) {
  const path = join(dir, `open-latency-${schemaScope}.db`);
  const first = driver.open(path, profile, schemaScope);
  first.close();
  const samples = [];
  for (let i = 0; i < 20; i++) {
    const t0 = process.hrtime.bigint();
    const db = driver.open(path, profile, schemaScope);
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    db.close();
  }
  samples.sort((a, b) => a - b);
  return check(
    `warm_open_latency_${schemaScope.replace('-', '_')}`,
    true,
    `median ${samples[10].toFixed(3)} ms per connection`
  );
}

function busyTimeoutBound(driver, dir, profile) {
  const path = join(dir, 'busy-timeout.db');
  const holder = driver.open(path, profile, 'rate-limit');
  const contender = driver.open(path, profile, 'rate-limit');
  const configured = Number(
    contender.readback(['busy_timeout']).busy_timeout ?? 0
  );
  let caught = null;
  let elapsedMs = 0;
  try {
    holder.exec('BEGIN IMMEDIATE');
    const started = process.hrtime.bigint();
    try {
      contender
        .prepare(SQL_RL_CONSUME)
        .get('busy-probe', 0, WINDOW_MS, NO_LIMIT);
    } catch (error) {
      caught = error;
    }
    elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  } finally {
    holder.exec('ROLLBACK');
    contender.close();
    holder.close();
  }

  const lowerBound = configured === 0 ? 0 : configured * 0.75;
  const upperBound = configured + 1500;
  const pass =
    isBusyError(caught) && elapsedMs >= lowerBound && elapsedMs <= upperBound;
  return check(
    'busy_timeout_write_lock_bound',
    pass,
    `configured=${configured} ms, observed=${elapsedMs.toFixed(1)} ms, error=${caught?.code ?? caught?.message ?? 'none'}`,
    true
  );
}

function fileContains(path, marker) {
  return existsSync(path) && readFileSync(path).includes(marker);
}

function deletedContentRemanence(driver, dir, profile) {
  const path = join(dir, 'deleted-content.db');
  const db = driver.open(path, profile, 'cache');
  const marker = Buffer.from(
    'pii-probe:ip=203.0.113.77:user=victim@example.com:phone=+375291234567'
  );
  const put = db.prepare(SQL_CACHE_PUT);
  const now = Date.now();
  db.transaction(() => {
    for (let i = 0; i < 2000; i++)
      put.run(
        i === 1000 ? marker.toString() : `remanence:${i}`,
        Buffer.from(`payload-${i}-`.repeat(24)),
        now + 60_000,
        now
      );
  })();
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.prepare('DELETE FROM cache WHERE key = ?').run(marker.toString());

  const paths = [path, `${path}-wal`];
  const beforeCheckpoint = paths.some((candidate) =>
    fileContains(candidate, marker)
  );
  db.pragma('wal_checkpoint(TRUNCATE)');
  const secureDelete = db.readback(['secure_delete']).secure_delete;
  db.close();
  const afterCheckpoint = paths.some((candidate) =>
    fileContains(candidate, marker)
  );

  return check(
    'deleted_pii_scrubbed_after_checkpoint',
    !afterCheckpoint,
    `secure_delete=${secureDelete}; marker before checkpoint=${beforeCheckpoint}, after=${afterCheckpoint}`
  );
}

// 8. THE security-critical one: N processes each consume exactly K times against
//    one key. An atomic consume must land on exactly N*K with no lost updates.
async function consumeExactness(
  driver,
  dir,
  profile,
  { workers = 4, perWorker = 500 }
) {
  const dbPath = join(dir, 'exactness.db');
  const seed = driver.open(dbPath, profile);
  seed.close();

  const key = 'ip:exactness-probe';
  const windowStart = 0; // fixed window so every consume lands in the same bucket

  const children = [];
  const ready = [];
  const done = [];

  for (let id = 0; id < workers; id++) {
    const child = spawn(
      process.execPath,
      [
        driver.workerPath,
        `--db=${dbPath}`,
        `--profile=${profile}`,
        '--exact=1',
        `--perWorker=${perWorker}`,
        `--key=${key}`,
        `--windowStart=${windowStart}`,
        `--id=${id}`,
      ],
      { stdio: ['pipe', 'pipe', 'inherit'] }
    );
    children.push(child);
    let out = '';
    let signalReady;
    let rejectReady;
    let readySeen = false;
    ready.push(
      new Promise((resolveReady, reject) => {
        signalReady = resolveReady;
        rejectReady = reject;
      })
    );
    child.stdout.on('data', (c) => {
      out += c;
      if (!readySeen && out.includes('READY\n')) {
        readySeen = true;
        signalReady();
      }
    });
    child.on('error', (error) => {
      if (!readySeen) rejectReady(error);
    });
    child.on('close', (code) => {
      if (!readySeen)
        rejectReady(
          new Error(
            `exactness worker ${id} exited ${code} before READY: ${out}`
          )
        );
    });
    done.push(
      new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0
            ? resolve(out)
            : reject(new Error(`exactness worker ${id} exited ${code}: ${out}`))
        );
      })
    );
  }

  try {
    await withTimeout(Promise.all(ready), 30_000, 'exactness READY barrier');
  } catch (error) {
    for (const child of children) child.kill('SIGKILL');
    await Promise.allSettled(done);
    throw error;
  }
  for (const child of children) child.stdin.write('GO\n');
  const outputs = await Promise.all(done);

  const errors = outputs.reduce((sum, out) => {
    const match = out.match(/ERRORS=(\d+)/);
    if (!match) throw new Error(`exactness worker omitted error count: ${out}`);
    return sum + Number(match[1]);
  }, 0);

  const verify = driver.open(dbPath, profile);
  const row = verify
    .prepare('SELECT count FROM rate_limit WHERE key = ?')
    .get(key);
  verify.close();

  const expected = workers * perWorker;
  const actual = row ? Number(row.count) : 0;
  const exact = actual === expected && errors === 0;

  return check(
    'atomic_consume_exactness',
    exact,
    `${workers} procs x ${perWorker}: expected ${expected}, counted ${actual}, failed ${errors}` +
      (exact
        ? ' — no lost updates'
        : ` — ${expected - actual} missing successful consumes`),
    true
  );
}

// 9. Kill a writer mid-transaction, reopen, and confirm the file is intact.
async function crashSafety(driver, dir, profile) {
  const dbPath = join(dir, 'crash.db');
  const seed = driver.open(dbPath, profile);
  const put = seed.prepare(SQL_CACHE_PUT);
  const payload = Buffer.alloc(4096, 3);
  const now = Date.now();
  const committed = 600;
  seed.transaction(() => {
    for (let i = 0; i < committed; i++)
      put.run(`crash:committed:${i}`, payload, now + 600_000, now);
  })();
  seed.close();

  const child = spawn(
    process.execPath,
    [
      driver.workerPath,
      `--db=${dbPath}`,
      `--profile=${profile}`,
      '--hammer=1',
      '--id=0',
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] }
  );

  try {
    await withTimeout(
      new Promise((resolve, reject) => {
        let out = '';
        child.stdout.on('data', (c) => {
          out += c;
          if (out.includes('IN_TXN\n')) resolve();
        });
        child.on('error', reject);
        child.on('close', (code) =>
          reject(new Error(`crash worker exited ${code} before IN_TXN: ${out}`))
        );
      }),
      30_000,
      'crash worker IN_TXN signal'
    );
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }

  // Hard kill with no chance to clean up, mid-write.
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.kill('SIGKILL');
  await closed;

  const walPath = `${dbPath}-wal`;
  const walBytes = existsSync(walPath) ? statSync(walPath).size : 0;

  const reopened = driver.open(dbPath, profile);
  const integrity = reopened.prepare('PRAGMA integrity_check').all();
  const rows = reopened.prepare('SELECT COUNT(*) AS n FROM cache').get();
  const inFlight = reopened
    .prepare(
      "SELECT COUNT(*) AS n FROM cache WHERE key GLOB 'crash:inflight:*'"
    )
    .get();
  reopened.close();

  const integrityOk =
    integrity.length === 1 && Object.values(integrity[0])[0] === 'ok';
  const recovered = Number(rows.n) === committed;
  const rolledBack = Number(inFlight.n) === 0;
  const exercisedWalRecovery = walBytes > 0;
  const ok = integrityOk && recovered && rolledBack && exercisedWalRecovery;
  return check(
    'crash_safety_sigkill_mid_write',
    ok,
    `after SIGKILL: integrity_check=${integrityOk ? 'ok' : JSON.stringify(integrity)}, ` +
      `${rows.n}/${committed} committed rows recovered, in-flight=${inFlight.n}, WAL was ${(walBytes / 1024).toFixed(0)} KB`,
    true
  );
}

export async function runCorrectness(driver, dir, profile) {
  const db = driver.open(join(dir, 'correctness.db'), profile);
  const results = [];
  try {
    results.push(strictEnforced(db));
    results.push(blobFidelity(db));
    results.push(rollbackOnThrow(db));
    results.push(windowRollover(db));
    results.push(maxAwareAdmission(db));
    results.push(expiryBoundary(db));
    results.push(largeIntegerHandling(db));
    results.push(errorMessagePrivacy(db));
    results.push(eventLoopStall(db));
  } finally {
    db.close();
  }
  results.push(openLatency(driver, dir, profile, 'rate-limit'));
  results.push(openLatency(driver, dir, profile, 'cache'));
  results.push(busyTimeoutBound(driver, dir, profile));
  results.push(deletedContentRemanence(driver, dir, profile));
  results.push(
    await consumeExactness(driver, dir, profile, { workers: 4, perWorker: 500 })
  );
  results.push(await crashSafety(driver, dir, profile));
  return results;
}
