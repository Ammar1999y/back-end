/**
 * Child runner for `sqlite-semantics.test.ts`.
 *
 * Plain CommonJS on purpose. The assertions have to execute `better-sqlite3`,
 * which cannot load under Bun (`NAPI FATAL ERROR`), and Bun is what runs the
 * probes — so this half runs under Node. Plain `.cjs` avoids needing a
 * TypeScript loader or the `@/` path aliases in the child.
 *
 * It does NOT hardcode the SQL. The parent extracts every statement from
 * `lib/rate-limit/store.ts` and `lib/cache/index.ts` and passes them in, so these
 * assertions cannot silently drift from the statements the application runs.
 *
 * Emits one JSON line: `{ ok, results: [{name, pass, detail}] }`.
 */
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const Database = require('better-sqlite3');

const sql = JSON.parse(process.argv[2]);
const results = [];
const dir = mkdtempSync(path.join(tmpdir(), 'sqlite-semantics-'));

function check(name, pass, detail) {
  results.push({ name, pass, detail });
}

function open(file) {
  const db = new Database(path.join(dir, file));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 2000');
  return db;
}

const WINDOW_MS = 60_000;

try {
  // ---- rate-limit admission semantics -------------------------------------
  {
    const db = open('rl.db');
    db.exec(sql.rateLimitDdl);
    const consume = db.prepare(sql.consume);
    const windowStart = 1000 * WINDOW_MS;
    const LIMIT = 5;

    let admitted = 0;
    for (let i = 0; i < 20; i++) {
      if (consume.get('k', windowStart, windowStart + WINDOW_MS, LIMIT))
        admitted++;
    }
    const stored = db
      .prepare('SELECT count FROM rate_limit WHERE key=?')
      .get('k');
    check(
      'admits exactly the limit and never over-counts',
      admitted === LIMIT && Number(stored.count) === LIMIT,
      `admitted=${admitted} stored=${stored.count} expected=${LIMIT}`
    );

    // R-1: a denied request must not write at all
    const before = db.prepare('SELECT total_changes() AS c').get().c;
    for (let i = 0; i < 10; i++)
      consume.get('k', windowStart, windowStart + WINDOW_MS, LIMIT);
    const writes = db.prepare('SELECT total_changes() AS c').get().c - before;
    check(
      'denied requests perform zero writes',
      writes === 0,
      `writes during 10 denied calls = ${writes}`
    );

    // window rollover still resets atomically
    const rolled = consume.get(
      'k',
      windowStart + WINDOW_MS,
      windowStart + 2 * WINDOW_MS,
      LIMIT
    );
    check(
      'window rollover resets the counter to 1',
      rolled && Number(rolled.count) === 1,
      `count after rollover = ${rolled ? rolled.count : 'no row'}`
    );
    db.close();
  }

  // ---- R-1 regression: retryAfter must not be read back ---------------------
  {
    const a = open('race.db');
    a.exec(sql.rateLimitDdl);
    const ca = a.prepare(sql.consume);
    const windowStart = 2000 * WINDOW_MS;
    const LIMIT = 2;
    for (let i = 0; i < LIMIT; i++)
      ca.get('r', windowStart, windowStart + WINDOW_MS, LIMIT);

    const denied = ca.get('r', windowStart, windowStart + WINDOW_MS, LIMIT);

    // A concurrent process rolls the row into the NEXT window.
    const b = open('race.db');
    b.prepare(sql.consume).get(
      'r',
      windowStart + WINDOW_MS,
      windowStart + 2 * WINDOW_MS,
      LIMIT
    );

    const now = windowStart + WINDOW_MS - 1; // 1ms left in the caller's window
    const correct = Math.max(
      1,
      Math.ceil((windowStart + WINDOW_MS - now) / 1000)
    );
    const viaReadback = (() => {
      const row = b
        .prepare('SELECT window_start FROM rate_limit WHERE key=?')
        .get('r');
      return Math.max(
        1,
        Math.ceil((Number(row.window_start) + WINDOW_MS - now) / 1000)
      );
    })();

    check(
      'denial returns no row, so retryAfter comes from the bound window',
      denied === undefined && correct === 1 && viaReadback > correct,
      `bound=${correct}s readback=${viaReadback}s (readback is the race this avoids)`
    );
    a.close();
    b.close();
  }

  // ---- P-5 regression: concurrent migration under BEGIN IMMEDIATE ----------
  {
    const dbPath = path.join(dir, 'migrate.db');
    const runMigration = () => {
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      try {
        db.transaction(() => {
          const current = Number(
            db.pragma('user_version', { simple: true }) ?? 0
          );
          if (current < 1) {
            db.exec(sql.rateLimitDdl);
            db.pragma('user_version = 1');
          }
        }).immediate();
        return null;
      } catch (error) {
        return error.message;
      } finally {
        db.close();
      }
    };
    const failures = [runMigration(), runMigration(), runMigration()].filter(
      Boolean
    );
    check(
      'repeat migration under BEGIN IMMEDIATE is idempotent',
      failures.length === 0,
      failures.length === 0 ? 'no failures' : failures.join(' | ')
    );
  }

  // ---- R-2 regression: the sweep statement is bounded ----------------------
  {
    const db = open('sweep.db');
    db.exec(sql.rateLimitDdl);
    const insert = db.prepare(
      'INSERT INTO rate_limit (key, window_start, count, expires_at) VALUES (?,?,?,?)'
    );
    db.transaction(() => {
      for (let i = 0; i < 1200; i++) insert.run(`s${i}`, 0, 1, 1);
    })();
    const first = db.prepare(sql.sweepRateLimit).run(1000, 500).changes;
    check(
      'sweep deletes at most one batch per statement',
      first === 500,
      `first batch removed ${first} (expected the 500 ceiling, not all 1200)`
    );
    db.close();
  }

  // ---- backlog probe must cover BOTH limiter tables ------------------------
  // The sweep route's `hasMore` is the only signal that expired rows are piling
  // up. A probe that read `rate_limit` alone would report a clean sweep while
  // `auth_rate_limit` — the login limiter's table — grew without bound.
  {
    const db = open('backlog.db');
    db.exec(sql.rateLimitDdl);
    const probe = db.prepare(sql.anyExpired);
    const rlInsert = db.prepare(
      'INSERT INTO rate_limit (key, window_start, count, expires_at) VALUES (?,?,?,?)'
    );
    const authInsert = db.prepare(
      'INSERT INTO auth_rate_limit (key, count, window_start, last_request, expires_at) VALUES (?,?,?,?,?)'
    );
    const present = () => Number(probe.get(1000, 1000).present);

    const empty = present();
    authInsert.run('a', 1, 0, 0, 500);
    const authOnly = present();
    db.prepare('DELETE FROM auth_rate_limit').run();
    rlInsert.run('b', 0, 1, 500);
    const rlOnly = present();
    db.prepare('UPDATE rate_limit SET expires_at = 5000').run();
    const future = present();

    check(
      'backlog probe reports expired rows in either limiter table',
      empty === 0 && authOnly === 1 && rlOnly === 1 && future === 0,
      `empty=${empty} authOnly=${authOnly} rlOnly=${rlOnly} future=${future}`
    );

    // Seeded first: the query planner picks a full scan over a near-empty table
    // regardless of the index, so an unseeded plan check would prove nothing.
    db.transaction(() => {
      for (let i = 0; i < 500; i++) {
        rlInsert.run(`b${i}`, 0, 1, 9_000_000 + i);
        authInsert.run(`a${i}`, 1, 0, 0, 9_000_000 + i);
      }
    })();
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${sql.anyExpired}`)
      .all(1000, 1000)
      .map((r) => r.detail)
      .join(' | ');
    check(
      'backlog probe searches both expires_at indexes rather than scanning',
      plan.includes('INDEX rate_limit_expires_at') &&
        plan.includes('INDEX auth_rate_limit_expires_at') &&
        !plan.includes('SCAN rate_limit') &&
        !plan.includes('SCAN auth_rate_limit'),
      plan
    );
    db.close();
  }

  // ---- R-6 regression: prefix range must cover supplementary Unicode -------
  {
    const db = open('cache.db');
    db.exec(sql.cacheDdl);
    const put = db.prepare(
      'INSERT INTO cache (key, value, expires_at, created_at) VALUES (?,?,?,?)'
    );
    const keys = [
      'p:plain',
      'p:\u{FFFF}tail',
      'p:\u{1F600}tail',
      'p*x:decoy',
      'q:other',
    ];
    for (const k of keys) put.run(k, Buffer.from('v'), 9e15, 0);

    db.prepare(sql.deletePrefix).run(
      'p:',
      `p:${String.fromCodePoint(0x10_ff_ff)}`
    );
    const left = db
      .prepare('SELECT key FROM cache ORDER BY key')
      .all()
      .map((r) => r.key);

    check(
      'prefix delete covers U+FFFF and supplementary characters',
      !left.some((k) => k.startsWith('p:')),
      `remaining: ${left.map((k) => JSON.stringify(k)).join(', ')}`
    );
    check(
      'prefix delete does not touch neighbouring namespaces',
      left.includes('p*x:decoy') && left.includes('q:other'),
      `remaining: ${left.map((k) => JSON.stringify(k)).join(', ')}`
    );
    db.close();
  }
} catch (error) {
  check('child completed', false, `${error.name}: ${error.message}`);
} finally {
  // Windows can refuse to unlink files whose handles the OS has not released
  // yet. Leaving a temp directory behind must not turn into a failed assertion.
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignored on purpose
  }
}

process.stdout.write(
  JSON.stringify({ ok: results.every((r) => r.pass), results })
);
