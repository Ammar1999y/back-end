// Whether the application's password KDF can move from the `argon2` npm package
// to the built-in `Bun.password`, and what that would cost.
//
// The baseline candidate calls `hashPassword` / `verifyPassword` from
// lib/auth/password.ts rather than restating the profile, so its number is the
// application's real cost, pepper included. The `p2:` candidate — a keyed
// prehash that gives `Bun.password` the pepper it has no option for — is written
// out below instead of imported, because nothing in the application implements
// it: this bench is what decides whether anything should.
//
// Compatibility is settled in the check phase, not in the timings. A primitive
// that cannot read the rows already in the database is not a faster KDF, it is an
// outage, so those checks are critical and abort the run.

import crypto from 'node:crypto';
import { arch, cpus, platform, totalmem } from 'node:os';
import { resolve } from 'node:path';

import * as argon2 from 'argon2';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import {
  getActivePasswordPepper,
  getPasswordPepper,
} from '@/lib/auth/password-pepper';

import {
  fmtMiB,
  fmtMs,
  percentile,
  startLagSampler,
  startRssSampler,
} from './shared/stats.mjs';

const HARNESS_VERSION = 1;

/**
 * Mirrors lib/auth/password.ts only to label results; `assertAppProfile` reads
 * the real parameters back out of a real hash, so drift in the application fails
 * the run instead of relabelling it.
 */
const APP_PROFILE = {
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
  hashLength: 32,
};

/**
 * `parallelism` is absent on purpose. Bun accepts the key and ignores it — the
 * emitted PHC says `p=1` either way, which `compatibilityChecks` proves rather
 * than assumes. Passing it here would document a parameter this candidate does
 * not have.
 */
const BUN_MATCHED = {
  algorithm: 'argon2id',
  memoryCost: APP_PROFILE.memoryCost,
  timeCost: APP_PROFILE.timeCost,
};

/** Enough to exercise the code paths in the compatibility checks, not the CPU. */
const CHEAP_BUN = { algorithm: 'argon2id', memoryCost: 8192, timeCost: 1 };
const CHEAP_NPM = { memoryCost: 8192, timeCost: 1, parallelism: 4 };

const CONCURRENCY_LEVELS = [1, 4, 10, 32];

const PASSWORD = () => `Bench-${crypto.randomUUID()}-Aa1!`;

const SECRET_A = crypto.randomBytes(32);
const SECRET_B = crypto.randomBytes(32);

// ── The `p2:` candidate ──────────────────────────────────────────────────────
// The only construction that keeps the pepper while hashing with
// `Bun.password`: HMAC the password under the pepper, hash the MAC. The pepper
// id stays in the envelope, so the rotation and lazy-rehash machinery in
// lib/auth/login-guard.ts keeps working unchanged.

const P2_VERSION = 'p2';

function pepperPrehash(password, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(password.normalize('NFKC'), 'utf8')
    .digest('base64url');
}

async function p2Hash(password, pepper = getActivePasswordPepper()) {
  const phc = await Bun.password.hash(
    pepperPrehash(password, pepper.secret),
    BUN_MATCHED
  );
  return `${P2_VERSION}:${pepper.id}:${phc}`;
}

async function p2Verify(password, stored) {
  const parts = String(stored).split(':');
  const [version, pepperId, phc] = parts;
  if (parts.length !== 3 || version !== P2_VERSION || !pepperId || !phc)
    return false;

  let pepper;
  try {
    pepper = getPasswordPepper(pepperId);
  } catch {
    return false;
  }

  // `Bun.password.verify` THROWS on a stored value it cannot parse, where
  // `argon2.verify` returns false — see the error-surface table. Swallowed for
  // the reason the docblock on `verifyPasswordDetailed` gives: on the login path
  // an escaping throw is a bodyless 500 sitting next to a 401, and that
  // difference is an unauthenticated account-existence oracle. Any real
  // migration owes this try/catch, so the bench measures the construction with
  // it rather than one nobody could ship.
  try {
    return await Bun.password.verify(
      pepperPrehash(password, pepper.secret),
      phc
    );
  } catch {
    return false;
  }
}

const bunVerify = async (password, stored) => {
  try {
    return await Bun.password.verify(password.normalize('NFKC'), stored);
  } catch {
    return false;
  }
};

// ── Candidates ───────────────────────────────────────────────────────────────

const CANDIDATES = {
  'npm-app': {
    label: 'argon2 npm — the application path (m=64Mi, t=3, p=4, peppered)',
    pepper: 'argon2 secret',
    hash: (password) => hashPassword(password),
    verify: (password, stored) => verifyPassword({ password, hash: stored }),
  },
  'bun-peppered': {
    label:
      'Bun.password argon2id m=64Mi t=3 — over an HMAC-SHA-256 pepper prehash',
    pepper: 'HMAC prehash',
    hash: (password) => p2Hash(password),
    verify: (password, stored) => p2Verify(password, stored),
  },
  'bun-naive': {
    label:
      'Bun.password argon2id m=64Mi t=3 — no pepper (a bare call-site swap)',
    pepper: 'none',
    hash: (password) =>
      Bun.password.hash(password.normalize('NFKC'), BUN_MATCHED),
    verify: bunVerify,
  },
  'bun-default': {
    label: 'Bun.password — library defaults (m=64Mi, t=2, p=1), no pepper',
    pepper: 'none',
    hash: (password) => Bun.password.hash(password.normalize('NFKC')),
    verify: bunVerify,
  },
};

// ── Measurement ──────────────────────────────────────────────────────────────

/**
 * A worker pool holds the requested concurrency steady. `Promise.all` over the
 * whole batch would launch N at once and tail off, reporting a peak from one
 * instant and a latency from a mixture of levels.
 */
async function measure({ op, count, concurrency }) {
  const latencies = new Array(count);
  const rss = startRssSampler();
  const lag = startLagSampler();

  let next = 0;
  const started = performance.now();

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const index = next++;
        if (index >= count) return;
        const t0 = performance.now();
        await op(index);
        latencies[index] = performance.now() - t0;
      }
    })
  );

  const wall = performance.now() - started;
  const lags = lag.stop();
  const memory = rss.stop();

  return {
    concurrency,
    count,
    wallMs: wall,
    opsPerSec: (count / wall) * 1000,
    p50: percentile(latencies, 50),
    p99: percentile(latencies, 99),
    maxMs: Math.max(...latencies),
    rssPeakBytes: memory.peak,
    rssDeltaBytes: memory.delta,
    lagP99: percentile(lags, 99),
    lagMax: lags.length > 0 ? Math.max(...lags) : Number.NaN,
  };
}

/** One candidate, three phases, across every concurrency level. */
async function profileCandidate(name, { count }) {
  const candidate = CANDIDATES[name];
  const rows = [];

  // Built once for all four levels: the corpus is identical at every level and
  // neither primitive caches, so rebuilding it serially per level would be the
  // dominant cost of the run and would measure nothing.
  const corpus = [];
  for (let i = 0; i < count; i++) {
    const password = PASSWORD();
    corpus.push({ password, stored: await candidate.hash(password) });
  }

  for (const concurrency of CONCURRENCY_LEVELS) {
    rows.push({
      phase: 'hash',
      ...(await measure({
        op: () => candidate.hash(PASSWORD()),
        count,
        concurrency,
      })),
    });

    rows.push({
      phase: 'verify (match)',
      ...(await measure({
        op: (i) => candidate.verify(corpus[i].password, corpus[i].stored),
        count,
        concurrency,
      })),
    });

    // Measured separately because a wrong password is the load an online
    // attacker generates, and a verify benchmark that only tests matches
    // reports the wrong half of it.
    rows.push({
      phase: 'verify (miss)',
      ...(await measure({
        op: (i) => candidate.verify(PASSWORD(), corpus[i].stored),
        count,
        concurrency,
      })),
    });
  }

  return rows;
}

/**
 * The per-login cost while a rollout is in flight: verify the stored `p1:` hash
 * with argon2, then write a `p2:` hash with Bun. The number that decides whether
 * the existing lazy-rehash path can carry the migration under live traffic, and
 * not the sum of two table rows — the two run back to back on one request,
 * against a threadpool the rest of the burst is also using.
 */
async function profileTransition({ count }) {
  const corpus = [];
  for (let i = 0; i < count; i++) {
    const password = PASSWORD();
    corpus.push({ password, stored: await hashPassword(password) });
  }

  const rows = [];
  for (const concurrency of CONCURRENCY_LEVELS) {
    rows.push({
      phase: 'verify p1 + hash p2',
      ...(await measure({
        op: async (i) => {
          await verifyPassword({
            password: corpus[i].password,
            hash: corpus[i].stored,
          });
          await p2Hash(corpus[i].password);
        },
        count,
        concurrency,
      })),
    });
  }
  return rows;
}

/**
 * Whether the 64 MiB per operation is actually returned, or accumulates.
 *
 * The per-level RSS peak cannot answer this — a peak looks the same whether the
 * memory is freed afterwards or not. Residual RSS after a forced GC is what
 * separates "allocates and frees per operation" from "grows under sustained
 * load", which is the difference between a KDF that is safe on a small VPS and
 * one that OOMs it overnight.
 */
async function soak(name, { count, concurrency }) {
  const candidate = CANDIDATES[name];
  const baseline = await settledRss();

  const rss = startRssSampler();
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        if (next++ >= count) return;
        const password = PASSWORD();
        const stored = await candidate.hash(password);
        await candidate.verify(password, stored);
      }
    })
  );
  const { peak } = rss.stop();

  return {
    ops: count * 2,
    concurrency,
    baselineBytes: baseline,
    peakBytes: peak,
    residualBytes: (await settledRss()) - baseline,
  };
}

/**
 * RSS once the allocator has actually given the memory back.
 *
 * A single `Bun.gc(true)` is not enough to read a residual from: the first pass
 * frees, and what it made unreachable only becomes collectable on a later one,
 * so a reading taken immediately after reports collection lag as if it were
 * retention. The macrotask between passes is what lets the collector run.
 */
async function settledRss() {
  for (let i = 0; i < 3; i++) {
    Bun.gc(true);
    await new Promise((r) => setTimeout(r, 60));
  }
  return process.memoryUsage.rss();
}

/**
 * Retention is measured in a CHILD per candidate, and the earlier in-process
 * version of this is why. Its baseline was taken after the preceding
 * candidate's timed phases, while the allocator was still holding half a
 * gigabyte it had not yet returned, so every residual came out NEGATIVE — RSS
 * fell during the soak. The sign was the only honest bit of it. A fresh process
 * has nothing to give back, so the number means what the column header says.
 */
async function soakInChild(name, { count }) {
  const child = Bun.spawn(
    [
      process.execPath,
      import.meta.path,
      `--soak-only=${name}`,
      `--soak=${count}`,
      '--no-json',
    ],
    { stdout: 'pipe', stderr: 'pipe', env: process.env }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const line = stdout.split('\n').find((l) => l.startsWith(SOAK_MARKER));
  if (code !== 0 || !line)
    throw new Error(
      `retention child for ${name} failed (exit ${code}): ${stderr.trim() || stdout.trim()}`
    );
  return JSON.parse(line.slice(SOAK_MARKER.length));
}

const SOAK_MARKER = 'SOAK ';

// ── Compatibility and correctness gates ──────────────────────────────────────
// A latency number for a primitive that cannot read the application's stored
// rows is noise. Everything below runs before anything is timed.

/** `argon2@0.45`'s `m,p,t` parameter order, rewritten to the `m,t,p` Bun parses. */
const reorderPhc = (phc) =>
  phc.replace(
    /m=(\d+),p=(\d+),t=(\d+)/,
    (_, m, p, t) => `m=${m},t=${t},p=${p}`
  );

const stripEnvelope = (stored) => stored.slice(stored.indexOf('$argon2id$'));

const phcParams = (phc) => phc.split('$').slice(1, 4).join('$');

/** `false`, `true`, or the argon2/Bun error name, for one stored-value shape. */
async function outcome(fn) {
  try {
    return String(await fn());
  } catch (error) {
    const detail =
      error instanceof Error ? /"([^"]+)"/.exec(error.message)?.[1] : null;
    return `throw${detail ? ` ${detail}` : ''}`;
  }
}

const npmHash = (password, options) =>
  argon2.hash(password, { type: argon2.argon2id, ...CHEAP_NPM, ...options });

/**
 * The parameters the report claims, read back from the module that owns them.
 *
 * `argon2.hash` does not expose its options, so the assertion is indirect: the
 * profile is encoded into the PHC string `hashPassword` returns. Parameter order
 * is `m,p,t` — argon2@0.45 emits parallelism before timeCost, not the reading
 * order of the options object.
 */
async function assertAppProfile() {
  const phc = stripEnvelope(await hashPassword(PASSWORD()));
  const expected = `$argon2id$v=19$m=${APP_PROFILE.memoryCost},p=${APP_PROFILE.parallelism},t=${APP_PROFILE.timeCost}$`;
  return {
    name: 'app profile matches lib/auth/password.ts',
    pass: phc.startsWith(expected),
    detail: phcParams(phc),
    critical: true,
  };
}

async function compatibilityChecks() {
  const password = PASSWORD();
  const checks = [];

  const appPhc = stripEnvelope(await hashPassword(password));
  const onAppHash = await outcome(() => Bun.password.verify(password, appPhc));
  checks.push({
    name: 'Bun cannot read a stored application hash',
    pass: onAppHash.startsWith('throw'),
    detail: onAppHash,
    critical: true,
  });

  // Two independent reasons it cannot, separated because the second one is the
  // dangerous half: reordering the parameters gets Bun past the parser, and
  // then a correct password is reported wrong with no error raised at all.
  const unpeppered = await npmHash(password);
  checks.push({
    name: '  reason 1: PHC parameter order — reorder alone fixes an UNPEPPERED hash',
    pass:
      (await outcome(() =>
        Bun.password.verify(password, reorderPhc(unpeppered))
      )) === 'true',
    detail: `${phcParams(unpeppered)} -> ${phcParams(reorderPhc(unpeppered))}`,
    critical: true,
  });

  const peppered = await npmHash(password, { secret: SECRET_A });
  checks.push({
    name: '  reason 2: the pepper — a reordered PEPPERED hash returns FALSE',
    pass:
      (await outcome(() =>
        Bun.password.verify(password, reorderPhc(peppered))
      )) === 'false',
    detail: 'correct password reported wrong; no error raised',
    critical: true,
  });

  const bunPhc = await Bun.password.hash(password, CHEAP_BUN);
  checks.push({
    name: 'argon2 npm CAN read a Bun hash (the reverse direction works)',
    pass: (await outcome(() => argon2.verify(bunPhc, password))) === 'true',
    critical: true,
  });

  checks.push({
    name: 'Bun IGNORES `parallelism` — silently, no throw',
    pass: (
      await Bun.password.hash(password, { ...CHEAP_BUN, parallelism: 4 })
    ).includes(',p=1$'),
    detail: 'requested p=4, emitted p=1',
    critical: true,
  });

  checks.push({
    name: 'Bun IGNORES `secret` — silently, so a swap drops the pepper',
    pass:
      (await outcome(() =>
        Bun.password
          .hash(password, { ...CHEAP_BUN, secret: SECRET_A })
          .then((phc) => Bun.password.verify(password, phc))
      )) === 'true',
    detail: 'hashed with a secret, verifies without one',
    critical: true,
  });

  checks.push({
    name: 'Bun output length matches the app hashLength',
    pass:
      Buffer.from(bunPhc.split('$').pop(), 'base64').length ===
      APP_PROFILE.hashLength,
    detail: `${Buffer.from(bunPhc.split('$').pop(), 'base64').length} bytes`,
    critical: false,
  });

  return checks;
}

/** Correct password verifies, wrong password does not, and the pepper binds. */
async function correctnessChecks() {
  const checks = [];
  const password = PASSWORD();
  const other = PASSWORD();

  for (const [name, candidate] of Object.entries(CANDIDATES)) {
    const stored = await candidate.hash(password);
    checks.push({
      name: `${name}: correct password verifies`,
      pass: (await candidate.verify(password, stored)) === true,
      critical: true,
    });
    checks.push({
      name: `${name}: wrong password rejected`,
      pass: (await candidate.verify(other, stored)) === false,
      critical: true,
    });
    checks.push({
      name: `${name}: salted`,
      pass: (await candidate.hash(password)) !== stored,
      detail: `pepper: ${candidate.pepper}`,
      critical: true,
    });
  }

  // The property the whole migration turns on, asserted on both constructions:
  // a hash made under one pepper must not verify under another.
  const peppered = await npmHash(password, { secret: SECRET_A });
  checks.push({
    name: 'argon2 secret binds — an A-hash fails under B',
    pass:
      (await outcome(() =>
        argon2.verify(peppered, password, { secret: SECRET_B })
      )) === 'false',
    critical: true,
  });

  const p2A = await p2Hash(password, { id: 'benchA', secret: SECRET_A });
  checks.push({
    name: 'p2 prehash binds — an unknown pepper id is refused, not thrown',
    pass:
      (await p2Verify(password, p2A.replace(':benchA:', ':benchB:'))) === false,
    critical: true,
  });
  checks.push({
    // The check above could pass for the wrong reason: an unknown id is refused
    // before any MAC is computed. This one goes straight at the MAC.
    name: 'p2 prehash binds — the same id under the wrong secret fails',
    pass:
      (await Bun.password.verify(
        pepperPrehash(password, SECRET_B),
        stripEnvelope(p2A)
      )) === false,
    critical: true,
  });

  return checks;
}

/**
 * What each library does with a stored value it cannot use. Reported as a table
 * rather than asserted, because the difference IS the finding: the application's
 * only verification entry point converts a throw into a failed login, and a
 * migration that stopped doing so would reintroduce the 500-vs-401 oracle its
 * docblock describes.
 */
async function errorSurface(password) {
  const good = reorderPhc(await npmHash(password));
  const bcrypt = await Bun.password.hash(password, {
    algorithm: 'bcrypt',
    cost: 4,
  });

  // Three truncation lengths, not one: whether Bun throws or returns false
  // depends on where the cut lands relative to a base64 3-byte boundary. One
  // row would report either half of that as if it were the rule.
  const shapes = [
    ['empty string', ''],
    ['not a hash', 'not-a-hash'],
    ['truncated PHC, -1 char', good.slice(0, -1)],
    ['truncated PHC, -2 chars', good.slice(0, -2)],
    ['truncated PHC, -3 chars', good.slice(0, -3)],
    ['truncated PHC, -4 chars', good.slice(0, -4)],
    ['app `p1:` envelope', `p1:k1:${good}`],
    ['argon2 order (m,p,t)', await npmHash(password)],
    ['bcrypt hash, same password', bcrypt],
  ];

  const rows = [];
  for (const [shape, stored] of shapes) {
    rows.push({
      shape,
      npm: await outcome(() => argon2.verify(stored, password)),
      bun: await outcome(() => Bun.password.verify(password, stored)),
    });
  }

  // `Bun.password.verify` infers the algorithm from the stored string, so the
  // row above says `true`: a stored bcrypt cost=4 hash is honoured where the
  // application expects argon2id at 64 MiB. Pinning the algorithm is the
  // defence, and it THROWS rather than returning false — so pinning without a
  // try/catch trades a downgrade for a 500. The `$argon2id$` prefix test in
  // `parsePasswordHash` is what currently closes this, and must survive any
  // migration.
  rows.push({
    shape: '  ...pinned to argon2id',
    npm: 'n/a (type is an option)',
    bun: await outcome(() => Bun.password.verify(password, bcrypt, 'argon2id')),
  });
  rows.push({
    shape: 'hash("") — empty password',
    npm: await outcome(() => npmHash('').then(() => 'accepted')),
    bun: await outcome(() =>
      Bun.password.hash('', CHEAP_BUN).then(() => 'accepted')
    ),
  });
  return rows;
}

// ── Output ───────────────────────────────────────────────────────────────────

function printTable(title, rows) {
  console.log(`\n### ${title}`);
  const header = [
    'phase'.padEnd(19),
    'conc'.padStart(5),
    'ops/s'.padStart(8),
    'p50 ms'.padStart(9),
    'p99 ms'.padStart(9),
    'max ms'.padStart(9),
    'RSS peak'.padStart(10),
    'RSS Δ'.padStart(9),
    'lag p99'.padStart(8),
  ].join('  ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of rows) {
    console.log(
      [
        r.phase.padEnd(19),
        String(r.concurrency).padStart(5),
        r.opsPerSec.toFixed(1).padStart(8),
        fmtMs(r.p50).padStart(9),
        fmtMs(r.p99).padStart(9),
        fmtMs(r.maxMs).padStart(9),
        `${fmtMiB(r.rssPeakBytes)}M`.padStart(10),
        `${fmtMiB(r.rssDeltaBytes)}M`.padStart(9),
        fmtMs(r.lagP99).padStart(8),
      ].join('  ')
    );
  }
}

function printChecks(checks) {
  let failed = 0;
  for (const c of checks) {
    const status = c.pass ? (c.critical ? 'PASS' : 'INFO') : 'FAIL (CRITICAL)';
    if (!c.pass && c.critical) failed++;
    console.log(`${status.padEnd(16)} ${c.name.padEnd(68)} ${c.detail ?? ''}`);
  }
  return failed;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { count: 16, soak: 40, json: true, only: null, soakOnly: null };
  for (const raw of argv.slice(2)) {
    const [flag, value] = raw.replace(/^--/, '').split('=');
    if (flag === 'count') args.count = Number(value);
    else if (flag === 'soak') args.soak = Number(value);
    else if (flag === 'only') args.only = value ? value.split(',') : [];
    else if (flag === 'soak-only') args.soakOnly = value ?? '';
    else if (flag === 'checks-only') args.only = [];
    else if (flag === 'no-json') args.json = false;
    else if (flag) throw new Error(`unknown flag: --${flag}`);
  }
  for (const [flag, value] of [
    ['count', args.count],
    ['soak', args.soak],
  ])
    if (!Number.isInteger(value) || value < 1)
      throw new Error(`--${flag} must be a positive integer`);
  for (const name of [...(args.only ?? []), args.soakOnly ?? []].flat())
    if (typeof name === 'string' && !(name in CANDIDATES))
      throw new Error(
        `unknown candidate: ${name} (have: ${Object.keys(CANDIDATES).join(', ')})`
      );
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const width = 106;

  // The child half of `soakInChild`: one candidate, no checks, no timings, one
  // machine-readable line on stdout.
  if (args.soakOnly !== null) {
    const result = await soak(args.soakOnly, {
      count: args.soak,
      concurrency: 4,
    });
    console.log(`${SOAK_MARKER}${JSON.stringify(result)}`);
    return;
  }

  console.log('='.repeat(width));
  console.log(`runtime         : bun ${Bun.version}`);
  console.log(
    `platform        : ${platform()} ${arch()}  cpus=${cpus().length}  ram=${fmtMiB(totalmem())}M`
  );
  console.log(
    `threadpool      : UV_THREADPOOL_SIZE=${process.env.UV_THREADPOOL_SIZE ?? '(default)'}`
  );
  console.log(
    `harness         : v${HARNESS_VERSION}  count=${args.count}/level  soak=${args.soak}`
  );
  console.log('='.repeat(width));

  const checks = [
    await assertAppProfile(),
    ...(await compatibilityChecks()),
    ...(await correctnessChecks()),
  ];
  console.log('\n### Compatibility and correctness');
  const failed = printChecks(checks);

  const errors = await errorSurface(PASSWORD());
  console.log('\n### Error surface — a stored value the library cannot use');
  console.log(
    `${'stored value'.padEnd(24)}  ${'argon2 npm'.padEnd(24)}  Bun.password`
  );
  console.log('-'.repeat(76));
  for (const r of errors)
    console.log(`${r.shape.padEnd(24)}  ${r.npm.padEnd(24)}  ${r.bun}`);

  if (failed > 0) {
    console.error(`\n${failed} critical check(s) failed — timings not run.`);
    process.exitCode = 1;
    return;
  }

  const names = args.only ?? Object.keys(CANDIDATES);
  const results = {};
  const retention = {};
  for (const name of names) {
    results[name] = await profileCandidate(name, { count: args.count });
    printTable(CANDIDATES[name].label, results[name]);
    retention[name] = await soakInChild(name, { count: args.soak });
  }

  let transition = null;
  if (names.includes('npm-app') && names.includes('bun-peppered')) {
    transition = await profileTransition({ count: args.count });
    printTable('Rollout: one login during the p1 -> p2 transition', transition);
  }

  if (names.length > 0) {
    console.log('\n### Retention after a forced GC');
    const header = [
      'candidate'.padEnd(16),
      'ops'.padStart(5),
      'conc'.padStart(5),
      'baseline'.padStart(10),
      'peak'.padStart(10),
      'residual'.padStart(10),
    ].join('  ');
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const [name, s] of Object.entries(retention))
      console.log(
        [
          name.padEnd(16),
          String(s.ops).padStart(5),
          String(s.concurrency).padStart(5),
          `${fmtMiB(s.baselineBytes)}M`.padStart(10),
          `${fmtMiB(s.peakBytes)}M`.padStart(10),
          `${fmtMiB(s.residualBytes)}M`.padStart(10),
        ].join('  ')
      );
  }

  if (args.json) {
    const path = resolve(import.meta.dir, 'results/latest.json');
    await Bun.write(
      path,
      `${JSON.stringify(
        {
          harnessVersion: HARNESS_VERSION,
          bun: Bun.version,
          platform: platform(),
          arch: arch(),
          cpus: cpus().length,
          totalmem: totalmem(),
          threadpoolSize: process.env.UV_THREADPOOL_SIZE ?? null,
          countPerLevel: args.count,
          soakOps: args.soak,
          appProfile: APP_PROFILE,
          bunOptions: BUN_MATCHED,
          checks,
          errorSurface: errors,
          results,
          transition,
          retention,
        },
        null,
        2
      )}\n`
    );
    console.log(`\nwrote ${path}`);
  }
}

await main();
