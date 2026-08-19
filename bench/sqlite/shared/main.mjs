// Shared entry point. Both projects call main(driver) so the harness, workloads
// and timing code are byte-identical across drivers; only the adapter differs.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { arch, cpus, platform } from 'node:os';
import { join, resolve } from 'node:path';

import { runCorrectness } from './correctness.mjs';
import {
  profileNames,
  PROFILES,
  READBACK_NAMES,
  SINGLE_PROCESS_ONLY,
} from './pragmas.mjs';
import { printGrouped, printHeader, printTable, saveJson } from './report.mjs';
import { runWorkload } from './runner.mjs';
import { summarise } from './stats.mjs';
import {
  buildSuite,
  CONCURRENT_WORKLOADS,
  PRAGMA_WORKLOADS,
} from './workloads.mjs';

/**
 * Bumped to 3 when the harness was realigned with the deployed SQL: both consume
 * statements became max-aware, every sweep became bounded, and the refusal and
 * prefix-invalidation paths gained coverage. v2 throughput numbers for
 * `rl_consume_*`, `auth_atomic_consume` and the two sweeps are therefore NOT
 * comparable with v3 — they measured statements the application no longer runs.
 * `compare.mjs` gates on this field.
 */
const HARNESS_VERSION = 3;

export function parseArgs(argv) {
  const args = {
    mode: 'suite',
    profile: 'baseline',
    tier: 'core',
    workers: 4,
    durationMs: 5000,
    workload: 'rl_consume',
  };
  for (const raw of argv.slice(2)) {
    const [key, value] = raw.replace(/^--/, '').split('=');
    if (value === undefined) continue;
    if (['workers', 'durationMs', 'iterations', 'repeat'].includes(key))
      args[key] = Number(value);
    else args[key] = value;
  }
  return args;
}

function freshDir(root) {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return root;
}

function meta(driver, profile, effectivePragmas, sqliteVersion, extra = {}) {
  return {
    harnessVersion: HARNESS_VERSION,
    driver: driver.name,
    driverVersion: driver.version,
    runtime: driver.runtime,
    runtimeVersion: driver.runtimeVersion,
    sqliteVersion,
    platform: platform(),
    arch: arch(),
    cpus: cpus().length,
    profile,
    effectivePragmas,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

// Each workload gets a pristine database so prior workloads cannot skew it.
function withDatabase(driver, dir, name, profile, schemaScope, fn) {
  const path = join(dir, `${name}.db`);
  const db = driver.open(path, profile, schemaScope);
  try {
    return fn(db, path);
  } finally {
    db.close();
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function aggregate(runs) {
  const first = runs[0];
  const rates = runs.map((r) => r.opsPerSec);
  const p50s = runs.map((r) => r.p50);
  return {
    ...first,
    ops: Math.round(median(runs.map((r) => r.ops))),
    opsPerSec: median(rates),
    elapsedMs: median(runs.map((r) => r.elapsedMs)),
    mean: median(runs.map((r) => r.mean)),
    p50: median(runs.map((r) => r.p50)),
    p95: median(runs.map((r) => r.p95)),
    p99: median(runs.map((r) => r.p99)),
    max: Math.max(...runs.map((r) => r.max)),
    errors: runs.reduce((sum, r) => sum + r.errors, 0),
    busy: runs.reduce((sum, r) => sum + r.busy, 0),
    runs: runs.length,
    spreadPct:
      runs.length > 1 ? (Math.max(...rates) / Math.min(...rates) - 1) * 100 : 0,
    p50SpreadPct:
      runs.length > 1 ? (Math.max(...p50s) / Math.min(...p50s) - 1) * 100 : 0,
    samples: rates.map((r) => Math.round(r)),
    p50Samples: p50s,
  };
}

function validateArgs(args) {
  if (!['suite', 'pragmas', 'concurrent', 'correctness'].includes(args.mode))
    throw new Error(
      `unknown mode: ${args.mode} (expected suite | pragmas | concurrent | correctness)`
    );
  if (!PROFILES[args.profile])
    throw new Error(`unknown pragma profile: ${args.profile}`);
  if (!['core', 'all'].includes(args.tier))
    throw new Error(`unknown tier: ${args.tier} (expected core | all)`);
  for (const key of ['workers', 'durationMs', 'iterations', 'repeat']) {
    if (args[key] === undefined) continue;
    if (!Number.isInteger(args[key]) || args[key] <= 0)
      throw new Error(`--${key} must be a positive integer`);
  }
  if (args.mode === 'concurrent' && !CONCURRENT_WORKLOADS[args.workload])
    throw new Error(
      `unknown concurrent workload: ${args.workload} (expected ${Object.keys(CONCURRENT_WORKLOADS).join(' | ')})`
    );
  if (args.mode === 'pragmas' && !PRAGMA_WORKLOADS[args.workload])
    throw new Error(
      `unknown PRAGMA workload: ${args.workload} (expected ${Object.keys(PRAGMA_WORKLOADS).join(' | ')})`
    );
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

function runSuite(driver, args, dir) {
  const suite = buildSuite({ tier: args.tier }).filter(
    (w) => !args.only || w.name.includes(args.only)
  );
  if (suite.length === 0)
    throw new Error(`--only=${args.only} matched no workload`);
  const repeat = Math.max(1, args.repeat ?? 1);
  const rows = [];
  let effective = null;
  let sqliteVersion = 'unknown';

  for (const workload of suite) {
    const runs = [];
    for (let attempt = 0; attempt < repeat; attempt++) {
      // A fresh file per attempt keeps repeats independent rather than measuring
      // a database that earlier attempts already grew and fragmented.
      withDatabase(
        driver,
        dir,
        `${workload.name}_r${attempt}`,
        args.profile,
        workload.schemaScope,
        (db) => {
          if (!effective) {
            effective = db.readback(READBACK_NAMES);
            sqliteVersion = db.sqliteVersion();
          }
          process.stdout.write(
            `  ${workload.name}${repeat > 1 ? ` [${attempt + 1}/${repeat}]` : ''} ... `
          );
          const result = runWorkload(workload, db, {
            iterations: args.iterations,
          });
          console.log(
            `${Math.round(result.opsPerSec).toLocaleString('en-US')} ops/sec`
          );
          runs.push(result);
        }
      );
    }

    rows.push(aggregate(runs));
  }

  return {
    rows,
    effective,
    sqliteVersion,
    workloadNames: suite.map((workload) => workload.name),
  };
}

function runPragmaMatrix(driver, args, dir) {
  const available = profileNames();
  const requested = args.profiles
    ? [...new Set(args.profiles.split(',').map((name) => name.trim()))].filter(
        Boolean
      )
    : available;
  const unknown = requested.filter((name) => !PROFILES[name]);
  if (unknown.length > 0)
    throw new Error(`unknown PRAGMA profile(s): ${unknown.join(', ')}`);
  if (requested.length === 0)
    throw new Error('--profiles selected no profiles');

  const target = args.workload;
  const repeat = args.repeat ?? 1;
  const byProfile = new Map(requested.map((name) => [name, []]));

  // Move profiles through different positions on repeat runs. A fixed matrix
  // order otherwise confounds profile effects with thermal/cache/system drift.
  for (let attempt = 0; attempt < repeat; attempt++) {
    const offset =
      (attempt * Math.ceil(requested.length / repeat)) % requested.length;
    const ordered = [...requested.slice(offset), ...requested.slice(0, offset)];

    for (const profile of ordered) {
      const workload = PRAGMA_WORKLOADS[target]();
      withDatabase(
        driver,
        dir,
        `pragma_${profile}_r${attempt}`,
        profile,
        workload.schemaScope,
        (db) => {
          process.stdout.write(
            `  profile ${profile.padEnd(20)}${repeat > 1 ? ` [${attempt + 1}/${repeat}]` : ''} ... `
          );
          const result = runWorkload(workload, db, {
            iterations: args.iterations ?? 20_000,
          });
          result.name = profile;
          result.group = `pragma matrix (${target})`;
          result.effectivePragmas = db.readback(READBACK_NAMES);
          console.log(
            `${Math.round(result.opsPerSec).toLocaleString('en-US')} ops/sec`
          );
          byProfile.get(profile).push(result);
        }
      );
    }
  }

  const rows = [];
  for (const profile of requested) {
    const runs = byProfile.get(profile);
    rows.push({
      ...aggregate(runs),
      unsafe: PROFILES[profile].unsafe,
      note: PROFILES[profile].note,
    });
  }
  // Rank by p50: throughput on this workload is dominated by rare multi-hundred
  // millisecond stalls, so the median latency is the comparable signal.
  rows.sort((a, b) => a.p50 - b.p50);
  return { rows, target, profiles: requested, repeat };
}

// Parent spawns N identical workers against ONE shared database file and
// synchronises their start so they genuinely contend.
async function runConcurrent(driver, args, dir) {
  if (SINGLE_PROCESS_ONLY.has(args.profile)) {
    throw new Error(
      `profile "${args.profile}" cannot be used with --mode=concurrent: it does not support this multi-process workload`
    );
  }
  const dbPath = join(dir, 'shared.db');
  const workloadKey = args.workload;
  const seedWorkload = CONCURRENT_WORKLOADS[workloadKey]();

  // Seed the shared database from the parent before workers attach.
  const seed = driver.open(dbPath, args.profile, seedWorkload.schemaScope);
  seedWorkload.setup?.({ db: seed, seed: true });
  seed.close();

  const children = [];
  const ready = [];
  const finished = [];

  for (let id = 0; id < args.workers; id++) {
    const child = spawn(
      process.execPath,
      [
        driver.workerPath,
        `--db=${dbPath}`,
        `--profile=${args.profile}`,
        `--workload=${workloadKey}`,
        `--durationMs=${args.durationMs}`,
        `--schemaScope=${seedWorkload.schemaScope}`,
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

    child.stdout.on('data', (chunk) => {
      out += chunk;
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
          new Error(`worker ${id} exited ${code} before READY: ${out}`)
        );
    });

    finished.push(
      new Promise((resolveWorker, rejectWorker) => {
        child.on('error', rejectWorker);
        child.on('close', (code) => {
          if (code !== 0)
            return rejectWorker(
              new Error(`worker ${id} exited ${code}: ${out}`)
            );
          const payload = out
            .slice(out.indexOf('READY\n') + 'READY\n'.length)
            .trim();
          try {
            resolveWorker(JSON.parse(payload));
          } catch (error) {
            rejectWorker(
              new Error(`worker ${id} bad output: ${payload}\n${error.message}`)
            );
          }
        });
      })
    );
  }

  // Release the barrier only once every worker has finished its own setup.
  try {
    await withTimeout(Promise.all(ready), 30_000, 'worker READY barrier');
  } catch (error) {
    for (const child of children) child.kill('SIGKILL');
    await Promise.allSettled(finished);
    throw error;
  }
  for (const child of children) child.stdin.write('GO\n');

  const results = await Promise.all(finished);

  const rows = results.map((r, i) => ({
    ...r,
    name: `worker ${i}`,
    group: 'per worker',
  }));
  const totalOps = results.reduce((sum, r) => sum + r.ops, 0);
  const totalBusy = results.reduce((sum, r) => sum + (r.busy ?? 0), 0);
  const totalErrors = results.reduce((sum, r) => sum + (r.errors ?? 0), 0);
  const elapsedMs = Math.max(...results.map((r) => r.elapsedMs));
  const aggregate = {
    name: `AGGREGATE (${args.workers} procs)`,
    group: 'aggregate',
    unit: results[0]?.unit ?? 'op',
    ops: totalOps,
    opsPerSec: elapsedMs > 0 ? totalOps / (elapsedMs / 1000) : 0,
    elapsedMs,
    mean:
      totalOps > 0
        ? results.reduce((sum, r) => sum + r.mean * r.ops, 0) / totalOps
        : 0,
    p50: Math.max(...results.map((r) => r.p50)),
    p95: Math.max(...results.map((r) => r.p95)),
    p99: Math.max(...results.map((r) => r.p99)),
    max: Math.max(...results.map((r) => r.max)),
    busy: totalBusy,
    errors: totalErrors,
  };

  const walBytes = Math.max(
    ...results.map((result) => result.walBytesBeforeClose ?? 0)
  );

  return { rows: [...rows, aggregate], walBytes, workloadKey };
}

export async function main(driver) {
  const args = parseArgs(process.argv);
  validateArgs(args);
  const dir = freshDir(resolve(driver.rootDir, '.bench-data'));
  const outDir = resolve(driver.rootDir, '..', 'results');

  console.log(
    `\nmode=${args.mode} profile=${args.profile} driver=${driver.name}\n`
  );

  if (args.mode === 'suite') {
    const { rows, effective, sqliteVersion, workloadNames } = runSuite(
      driver,
      args,
      dir
    );
    const header = meta(driver, args.profile, effective, sqliteVersion, {
      mode: 'suite',
      tier: args.tier,
      repeat: args.repeat ?? 1,
      iterations: args.iterations ?? null,
      only: args.only ?? null,
      workloadNames,
    });
    printHeader(header);
    printGrouped(rows);
    // A filtered run must not overwrite the full-suite results file.
    const suffix = args.only
      ? `-only-${args.only.replace(/[^a-zA-Z0-9_-]+/g, '_')}`
      : '';
    saveJson(
      join(outDir, `${driver.slug}-suite-${args.profile}${suffix}.json`),
      { meta: header, rows }
    );
    return;
  }

  if (args.mode === 'pragmas') {
    const { rows, target, profiles, repeat } = runPragmaMatrix(
      driver,
      args,
      dir
    );
    const probeWorkload = PRAGMA_WORKLOADS[target]();
    const probe = driver.open(
      join(dir, 'probe.db'),
      'baseline',
      probeWorkload.schemaScope
    );
    const header = meta(
      driver,
      'matrix',
      probe.readback(READBACK_NAMES),
      probe.sqliteVersion(),
      {
        mode: 'pragmas',
        workload: target,
        profiles,
        repeat,
        iterations: args.iterations ?? null,
      }
    );
    probe.close();
    printHeader(header);
    printTable(rows, `### PRAGMA matrix`);
    saveJson(join(outDir, `${driver.slug}-pragmas-${target}.json`), {
      meta: header,
      rows,
    });
    return;
  }

  if (args.mode === 'concurrent') {
    const { rows, walBytes, workloadKey } = await runConcurrent(
      driver,
      args,
      dir
    );
    const probeWorkload = CONCURRENT_WORKLOADS[workloadKey]();
    const probe = driver.open(
      join(dir, 'probe.db'),
      args.profile,
      probeWorkload.schemaScope
    );
    const header = meta(
      driver,
      args.profile,
      probe.readback(READBACK_NAMES),
      probe.sqliteVersion(),
      {
        mode: 'concurrent',
        workers: args.workers,
        requestedDurationMs: args.durationMs,
        actualDurationMs: rows.at(-1)?.elapsedMs ?? null,
        workload: workloadKey,
      }
    );
    probe.close();
    printHeader(header);
    console.log(
      `workers=${args.workers} duration=${args.durationMs}ms workload=${workloadKey}`
    );
    printTable(rows, `### multi-process contention`);
    console.log(
      `\nWAL sampled before worker close: ${(walBytes / 1024 / 1024).toFixed(2)} MB`
    );
    saveJson(
      join(
        outDir,
        `${driver.slug}-concurrent-${workloadKey}-${args.workers}p.json`
      ),
      {
        meta: {
          ...header,
          workers: args.workers,
          requestedDurationMs: args.durationMs,
          actualDurationMs: rows.at(-1)?.elapsedMs ?? null,
          workloadKey,
          walBytes,
        },
        rows,
      }
    );
    return;
  }

  if (args.mode === 'correctness') {
    const probe = driver.open(join(dir, 'probe.db'), args.profile);
    const header = meta(
      driver,
      args.profile,
      probe.readback(READBACK_NAMES),
      probe.sqliteVersion(),
      { mode: 'correctness' }
    );
    probe.close();
    printHeader(header);

    const results = await runCorrectness(driver, dir, args.profile);
    console.log('\n### correctness and safety\n');
    let failedCritical = 0;
    for (const r of results) {
      const status = r.pass ? 'PASS' : r.critical ? 'FAIL (CRITICAL)' : 'FAIL';
      if (!r.pass && r.critical) failedCritical++;
      console.log(`${status.padEnd(16)} ${r.name.padEnd(34)} ${r.detail}`);
    }
    console.log(
      failedCritical > 0
        ? `\n${failedCritical} CRITICAL check(s) failed — not shippable as configured.`
        : '\nAll critical checks passed.'
    );
    saveJson(join(outDir, `${driver.slug}-correctness-${args.profile}.json`), {
      meta: header,
      results,
    });
    if (failedCritical > 0) process.exitCode = 1;
    return;
  }
}

export { summarise };
