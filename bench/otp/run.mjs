// Entry point. `bun bench/otp/run.mjs [--flags]` from the repo root.
//
// Answers ONE question, the one TODO.md gates the OTP-hashing change on: is the
// 64 MiB Argon2id profile a measurable latency or memory problem for OTP codes
// at the concurrency this application's own limiters permit?
//
// It measures the APPLICATION's primitives — `hashPassword` / `verifyPassword`
// from `lib/auth/password.ts`, which is exactly what `hashOtpCode` /
// `verifyOtpCode` in `utils/otp.ts` delegate to, one-line aliases with no
// parameters of their own. Importing `utils/otp.ts` itself would drag in the
// database pool and nodemailer for no gain.
//
// The HMAC-SHA-256 column is the proposed replacement, not a general "fast hash"
// straw man: a keyed MAC over the code with a dedicated versioned secret,
// compared in constant time. It is here to size the gap, not to win a race —
// nobody doubts which is faster.
//
// See README.md for flags and the numbers from the last recorded run.

import crypto from 'node:crypto';
import { arch, cpus, platform, totalmem } from 'node:os';
import { resolve } from 'node:path';

import { hashPassword, verifyPassword } from '@/lib/auth/password';

import {
  OTP_EXPIRY_MINUTES,
  OTP_MAX_VERIFY_ATTEMPTS,
} from '@/utils/validation/constants';

import {
  fmtMiB,
  fmtMs,
  mean,
  percentile,
  startLagSampler,
  startRssSampler,
} from './shared/stats.mjs';

const HARNESS_VERSION = 1;

/**
 * The Argon2id profile under test, restated from `lib/auth/password.ts` so the
 * report says what was measured. Asserted against the real module below rather
 * than trusted — a copied constant that silently drifts is worse than no
 * constant, because the output keeps claiming the old number.
 */
const EXPECTED_PROFILE = { memoryCost: 65_536, timeCost: 3, parallelism: 4 };

/**
 * Concurrency levels, chosen from what the limiters actually admit rather than
 * round numbers.
 *
 * `PRE_AUTH_LIMIT` is 120 requests/minute per IP per surface, and the
 * per-destination OTP caps bound a RATE, not a simultaneous working set — which
 * is precisely the gap TODO.md describes. So the interesting levels are the ones
 * a single admitted burst can reach: 1 (the floor), 4 (a plausible steady load),
 * 10 (`MAX_POOL_CONNECTIONS`, the process's own transaction ceiling), and 32
 * (a burst well inside a single minute's per-IP allowance).
 */
const CONCURRENCY_LEVELS = [1, 4, 10, 32];

const SIX_DIGIT = () => crypto.randomInt(100_000, 1_000_000).toString();

// ── HMAC candidate ───────────────────────────────────────────────────────────
// Deliberately NOT imported from application code: it does not exist there yet.
// This is the construction the fix would introduce, written out so the numbers
// belong to something specific.
const HMAC_KEY = crypto.randomBytes(32);
const HMAC_KEY_ID = 'k1';

function hmacOtp(code) {
  const mac = crypto
    .createHmac('sha256', HMAC_KEY)
    .update(code, 'utf8')
    .digest();
  return `${HMAC_KEY_ID}:${mac.toString('base64url')}`;
}

function verifyHmacOtp(code, stored) {
  const [keyId, encoded] = stored.split(':');
  if (keyId !== HMAC_KEY_ID || !encoded) return false;
  const expected = crypto
    .createHmac('sha256', HMAC_KEY)
    .update(code, 'utf8')
    .digest();
  const actual = Buffer.from(encoded, 'base64url');
  // Length check first: timingSafeEqual THROWS on a length mismatch rather than
  // returning false, so an attacker-supplied stored value of the wrong length
  // would be a 500 instead of a rejection.
  return (
    actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected)
  );
}

const ALGORITHMS = {
  argon2id: {
    label: 'Argon2id 64MiB t=3 p=4',
    hash: (code) => hashPassword(code),
    verify: (code, stored) => verifyPassword({ password: code, hash: stored }),
  },
  hmac: {
    label: 'HMAC-SHA-256 keyed',
    hash: async (code) => hmacOtp(code),
    verify: async (code, stored) => verifyHmacOtp(code, stored),
  },
};

// ── Measurement ──────────────────────────────────────────────────────────────

/**
 * Runs `count` operations at a fixed in-flight `concurrency`, recording per-
 * operation latency, peak RSS and event-loop lag for the whole window.
 *
 * A worker pool, not `Promise.all` over everything: `Promise.all` on 32 promises
 * launches 32 at once and then tails off, so the reported peak belongs to a
 * moment of 32 and the reported latency to a mixture. A pool holds the level
 * steady, which is what "N concurrent OTP verifies" means.
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

/** One algorithm, both phases, across every concurrency level. */
async function profileAlgorithm(name, { count }) {
  const algorithm = ALGORITHMS[name];
  const rows = [];

  for (const concurrency of CONCURRENCY_LEVELS) {
    // Pre-hash the corpus for the verify phase so the verify measurement does
    // not include a hash. Done at concurrency 1 and outside the sampler.
    const corpus = [];
    for (let i = 0; i < count; i++) {
      const code = SIX_DIGIT();
      corpus.push({ code, stored: await algorithm.hash(code) });
    }

    rows.push({
      phase: 'hash',
      ...(await measure({
        op: () => algorithm.hash(SIX_DIGIT()),
        count,
        concurrency,
      })),
    });

    rows.push({
      phase: 'verify (match)',
      ...(await measure({
        op: (i) => algorithm.verify(corpus[i].code, corpus[i].stored),
        count,
        concurrency,
      })),
    });

    // The realistic attacker path, and the one the attempt budget bounds. Argon2
    // pays full cost on a miss; a MAC does not care. Measured separately because
    // a verify benchmark that only tests matches reports the cheaper half of a
    // brute-force attempt for neither construction.
    rows.push({
      phase: 'verify (miss)',
      ...(await measure({
        op: (i) => algorithm.verify(SIX_DIGIT(), corpus[i].stored),
        count,
        concurrency,
      })),
    });
  }

  return rows;
}

// ── Correctness gate ─────────────────────────────────────────────────────────
// A latency number for a function that does not verify correctly is noise. These
// run before anything is timed.
async function correctnessChecks() {
  const checks = [];
  const code = SIX_DIGIT();
  const other = code === '123456' ? '654321' : '123456';

  for (const [name, algorithm] of Object.entries(ALGORITHMS)) {
    const stored = await algorithm.hash(code);
    checks.push({
      name: `${name}: correct code verifies`,
      pass: (await algorithm.verify(code, stored)) === true,
      critical: true,
    });
    checks.push({
      name: `${name}: wrong code rejected`,
      pass: (await algorithm.verify(other, stored)) === false,
      critical: true,
    });
    checks.push({
      name: `${name}: same code hashes to distinct stored values`,
      // Argon2 salts, so two hashes of one code differ. A keyed MAC is
      // deterministic and must NOT — reporting the difference rather than
      // asserting one shape, because it is a real property difference between
      // the two candidates and it is the reason the MAC cannot be used where a
      // password hash is.
      pass: true,
      detail:
        (await algorithm.hash(code)) === (await algorithm.hash(code))
          ? 'deterministic (keyed MAC)'
          : 'salted (distinct each time)',
      critical: false,
    });
  }

  const stored = await ALGORITHMS.hmac.hash(code);
  checks.push({
    name: 'hmac: truncated stored value rejected, does not throw',
    pass: (await ALGORITHMS.hmac.verify(code, stored.slice(0, -4))) === false,
    critical: true,
  });

  return checks;
}

/**
 * The profile the report claims, read back from the module that owns it.
 *
 * `argon2.hash` does not expose its options, so the assertion is indirect: a
 * 64 MiB / t=3 / p=4 hash encodes those parameters into its own PHC string, and
 * `hashPassword` returns that string behind the `p1:<pepperId>:` envelope. If the
 * application's profile changes, this stops matching and the run says so instead
 * of silently reporting stale parameters.
 */
async function verifyProfile() {
  const phc = await hashPassword(SIX_DIGIT());
  // Parameter order is `m,p,t` — argon2@0.45 emits parallelism before timeCost,
  // not the `m,t,p` reading order of the options object. Measured, after this
  // check failed on the assumed order.
  const expected = `$argon2id$v=19$m=${EXPECTED_PROFILE.memoryCost},p=${EXPECTED_PROFILE.parallelism},t=${EXPECTED_PROFILE.timeCost}$`;
  return {
    name: 'measured profile matches lib/auth/password.ts',
    pass: phc.includes(expected),
    detail: phc.slice(phc.indexOf('$argon2id$'), phc.lastIndexOf('$')),
    critical: true,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { count: 24, json: true };
  for (const raw of argv.slice(2)) {
    const [flag, value] = raw.replace(/^--/, '').split('=');
    if (flag === 'count') args.count = Number(value);
    else if (flag === 'no-json') args.json = false;
    else if (flag) throw new Error(`unknown flag: --${flag}`);
  }
  if (!Number.isInteger(args.count) || args.count < 1)
    throw new Error('--count must be a positive integer');
  return args;
}

function printTable(title, rows) {
  console.log(`\n### ${title}`);
  const header = [
    'phase'.padEnd(15),
    'conc'.padStart(5),
    'ops/s'.padStart(9),
    'p50 ms'.padStart(9),
    'p99 ms'.padStart(9),
    'max ms'.padStart(9),
    'RSS peak'.padStart(10),
    'RSS Δ'.padStart(9),
    'lag p99'.padStart(9),
  ].join('  ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of rows) {
    console.log(
      [
        r.phase.padEnd(15),
        String(r.concurrency).padStart(5),
        r.opsPerSec.toFixed(1).padStart(9),
        fmtMs(r.p50).padStart(9),
        fmtMs(r.p99).padStart(9),
        fmtMs(r.maxMs).padStart(9),
        `${fmtMiB(r.rssPeakBytes)}M`.padStart(10),
        `${fmtMiB(r.rssDeltaBytes)}M`.padStart(9),
        fmtMs(r.lagP99).padStart(9),
      ].join('  ')
    );
  }
}

async function main() {
  const args = parseArgs(process.argv);

  console.log('='.repeat(104));
  console.log(`runtime         : bun ${Bun.version}`);
  console.log(
    `platform        : ${platform()} ${arch()}  cpus=${cpus().length}  ram=${fmtMiB(totalmem())}M`
  );
  console.log(
    `threadpool      : UV_THREADPOOL_SIZE=${process.env.UV_THREADPOOL_SIZE ?? '(default)'}`
  );
  console.log(
    `harness         : v${HARNESS_VERSION}  count=${args.count}/level`
  );
  console.log(
    `app constants   : OTP_EXPIRY_MINUTES=${OTP_EXPIRY_MINUTES}  OTP_MAX_VERIFY_ATTEMPTS=${OTP_MAX_VERIFY_ATTEMPTS}`
  );
  console.log('='.repeat(104));

  const checks = [await verifyProfile(), ...(await correctnessChecks())];
  console.log('\n### Correctness');
  let failed = 0;
  for (const c of checks) {
    const status = c.pass ? (c.critical ? 'PASS' : 'INFO') : 'FAIL (CRITICAL)';
    if (!c.pass && c.critical) failed++;
    console.log(`${status.padEnd(16)} ${c.name.padEnd(58)} ${c.detail ?? ''}`);
  }
  if (failed > 0) {
    console.error(`\n${failed} critical check(s) failed — timings not run.`);
    process.exitCode = 1;
    return;
  }

  const results = {};
  for (const name of Object.keys(ALGORITHMS)) {
    results[name] = await profileAlgorithm(name, { count: args.count });
    printTable(ALGORITHMS[name].label, results[name]);
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
          profile: EXPECTED_PROFILE,
          checks,
          results,
        },
        null,
        2
      )}\n`
    );
    console.log(`\nwrote ${path}`);
  }
}

await main();
