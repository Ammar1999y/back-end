// Entry point. `bun bench/image/run.mjs [--flags]` from the repo root.
//
// Compares `sharp` against `Bun.Image` on the three pipelines this application
// actually runs (see shared/engines.mjs), plus the capability, hostile-input and
// resource questions that decide whether the swap is safe rather than merely
// faster.
//
// Requires the Bun runtime; `Bun.Image` exists nowhere else.
//
// See README.md for flags, sample output and the recorded results.

import { arch, cpus, platform } from 'node:os';
import { resolve } from 'node:path';

import sharp from 'sharp';

import {
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SIZE,
  SERVER_MAX_IMAGE_SIZE,
} from '@/utils/validation/constants';

import {
  alphaChecks,
  behaviourChecks,
  capabilityChecks,
  hostileChecks,
  metadataChecks,
  optimizeChecks,
  pipelineFidelity,
  pixelCapChecks,
} from './shared/checks.mjs';
import {
  behaviourInputs,
  CORPUS_VERSION,
  hostileInputs,
  loadCorpus,
} from './shared/corpus.mjs';
import { ENGINES } from './shared/engines.mjs';
import { compareEncoded, resampleDelta } from './shared/quality.mjs';
import {
  printChecks,
  printHeader,
  printTable,
  saveJson,
} from './shared/report.mjs';
import {
  startLagSampler,
  timeConcurrent,
  timeRepeats,
  withPeakRss,
} from './shared/runner.mjs';
import { fmtBytes, fmtDb, fmtInt, fmtMs, fmtRatio } from './shared/stats.mjs';

const HARNESS_VERSION = 1;
const MODES = [
  'all',
  'capability',
  'perf',
  'quality',
  'blurhash',
  'concurrency',
  'hostile',
  'startup',
  'memory',
];
const NUMERIC_FLAGS = ['repeat', 'concurrency'];
const BOOLEAN_FLAGS = ['heavy'];

const TARGET_SIZE = SERVER_MAX_IMAGE_SIZE * 1024 * 1024;
const UPLOAD_CAP_BYTES = MAX_IMAGE_SIZE * 1024 * 1024;
const QUALITY_LADDER = [95, 85, 75, 65, 55];

/**
 * The 12 MP PNG is 34 MB on disk — the route's own `MAX_FILE_SIZE` rejects it
 * long before either library sees it, and one optimize pass over it is ~10-20 s.
 * It stays out of the default run for both reasons and comes back with
 * `--heavy`, where it answers a different question: how the two scale when the
 * upload cap is eventually raised from its placeholder value.
 */
const HEAVY_ONLY = new Set(['photo-4000x3000.png']);

function parseArgs(argv) {
  const args = { mode: 'all', repeat: 3, concurrency: 4, heavy: false };
  for (const raw of argv.slice(2)) {
    const [key, value] = raw.replace(/^--/, '').split('=');
    if (BOOLEAN_FLAGS.includes(key)) {
      args[key] = value === undefined ? true : value !== 'false';
      continue;
    }
    if (value === undefined) continue;
    args[key] = NUMERIC_FLAGS.includes(key) ? Number(value) : value;
  }
  if (!MODES.includes(args.mode))
    throw new Error(
      `unknown mode: ${args.mode} (expected ${MODES.join(' | ')})`
    );
  for (const key of NUMERIC_FLAGS)
    if (!Number.isInteger(args[key]) || args[key] <= 0)
      throw new Error(`--${key} must be a positive integer`);
  return args;
}

const withinUploadCap = (entry) => entry.bytes.length <= UPLOAD_CAP_BYTES;

async function main() {
  const args = parseArgs(process.argv);
  const cacheDir = resolve(import.meta.dirname, 'results');

  const meta = {
    harnessVersion: HARNESS_VERSION,
    bun: `${Bun.version} (${Bun.revision.slice(0, 9)})`,
    platform: platform(),
    arch: arch(),
    cpus: cpus().length,
    sharp: sharp.versions?.sharp ?? 'unknown',
    libvips: sharp.versions?.vips ?? 'unknown',
    imageBackend: Bun.Image.backend,
    mode: args.mode,
    repeat: args.repeat,
    concurrency: args.concurrency,
    heavy: args.heavy,
    maxImagePixels: MAX_IMAGE_PIXELS,
    maxImageSizeMb: MAX_IMAGE_SIZE,
    targetSize: TARGET_SIZE,
    timestamp: new Date().toISOString(),
  };
  printHeader(meta);

  const wants = (mode) => args.mode === 'all' || args.mode === mode;
  const allInputs = (await loadCorpus(cacheDir)).filter(
    (entry) => args.heavy || !HEAVY_ONLY.has(entry.name)
  );
  // `hostile` entries belong only to the refusal checks: including them in the
  // parity tables would score two different (correct) refusal messages as a
  // disagreement.
  const corpus = allInputs.filter((entry) => entry.kind !== 'hostile');
  const perfCorpus = corpus.filter(
    (entry) => entry.kind === 'perf' || entry.name === 'atcap-5000x5000.png'
  );
  const payload = { meta };
  let failedCritical = 0;

  printTable(
    'corpus',
    [
      { label: 'input', width: 18, align: 'left', render: (r) => r.label },
      {
        label: 'file size',
        width: 11,
        render: (r) => fmtBytes(r.bytes.length),
      },
      {
        label: `<= ${MAX_IMAGE_SIZE} MB route cap`,
        width: 20,
        render: (r) => (withinUploadCap(r) ? 'yes' : 'NO — scaling only'),
      },
    ],
    corpus
  );

  // ------------------------------------------------------------- capability
  if (wants('capability')) {
    const svg = hostileInputs(perfCorpus[0].bytes).find(
      (i) => i.name === 'svg'
    );
    const results = [
      ...(await capabilityChecks(ENGINES, corpus, svg.bytes)),
      ...(await metadataChecks(ENGINES, corpus)),
      ...(await optimizeChecks(
        ENGINES,
        perfCorpus.filter(withinUploadCap),
        TARGET_SIZE
      )),
      ...(await alphaChecks(
        ENGINES,
        corpus.find((c) => c.name === 'alpha-1200x900.png'),
        TARGET_SIZE
      )),
    ];
    payload.capability = results;
    failedCritical += printChecks('capability and pipeline parity', results);
  }

  // ------------------------------------------------------------------- perf
  if (wants('perf')) {
    const rows = [];
    for (const entry of perfCorpus) {
      for (const engine of ENGINES) {
        const metadata = await timeRepeats(
          () => engine.metadata(entry.bytes),
          args.repeat
        );
        const single = await timeRepeats(
          () => engine.encodeOnce(entry.bytes, { width: 1600, quality: 80 }),
          args.repeat
        );
        const measured = await withPeakRss(() =>
          timeRepeats(
            () => engine.optimize(entry.bytes, { targetSize: TARGET_SIZE }),
            args.repeat
          )
        );
        const optimize = measured.value;
        rows.push({
          input: entry.label,
          engine: engine.name,
          metadataMs: metadata.msMedian,
          singleMs: single.msMedian,
          singleBytes: single.result.size,
          optimizeMs: optimize.msMedian,
          optimizeMsMin: optimize.msMin,
          optimizeMsMax: optimize.msMax,
          iterations: optimize.result.iterations,
          outBytes: optimize.result.size,
          outDims: `${optimize.result.width}x${optimize.result.height}`,
          rssDelta: measured.rssDelta,
          rssPeak: measured.rssPeak,
        });
        process.stdout.write(
          `  perf ${entry.label.padEnd(16)} ${engine.name.padEnd(10)} optimize ${fmtMs(optimize.msMedian)} ms\n`
        );
      }
    }
    payload.perf = rows;

    printTable(
      'metadata probe (width/height only, no pixel decode)',
      [
        { label: 'input', width: 18, align: 'left', render: (r) => r.input },
        { label: 'engine', width: 10, align: 'left', render: (r) => r.engine },
        {
          label: 'ms (median)',
          width: 12,
          render: (r) => fmtMs(r.metadataMs, 2),
        },
      ],
      rows
    );

    printTable(
      'one resize+encode pass (width 1600, quality 80)',
      [
        { label: 'input', width: 18, align: 'left', render: (r) => r.input },
        { label: 'engine', width: 10, align: 'left', render: (r) => r.engine },
        { label: 'ms (median)', width: 12, render: (r) => fmtMs(r.singleMs) },
        { label: 'output', width: 11, render: (r) => fmtBytes(r.singleBytes) },
      ],
      rows
    );

    printTable(
      'full optimize loop (the production search)',
      [
        { label: 'input', width: 18, align: 'left', render: (r) => r.input },
        { label: 'engine', width: 10, align: 'left', render: (r) => r.engine },
        { label: 'ms (median)', width: 12, render: (r) => fmtMs(r.optimizeMs) },
        {
          label: 'ms min-max',
          width: 16,
          render: (r) => `${fmtMs(r.optimizeMsMin)}-${fmtMs(r.optimizeMsMax)}`,
        },
        { label: 'iterations', width: 10, render: (r) => fmtInt(r.iterations) },
        { label: 'output', width: 11, render: (r) => fmtBytes(r.outBytes) },
        { label: 'dims', width: 11, render: (r) => r.outDims },
        // Delta, not absolute: the scenarios share one process, so an absolute
        // peak late in the run mostly reports what earlier scenarios allocated.
        // The `memory` scenario measures this properly, one child process per
        // image.
        { label: 'RSS delta', width: 11, render: (r) => fmtBytes(r.rssDelta) },
      ],
      rows
    );

    printTable(
      'optimize speedup, per input',
      [
        { label: 'input', width: 18, align: 'left', render: (r) => r.input },
        { label: 'sharp ms', width: 10, render: (r) => fmtMs(r.sharp) },
        { label: 'Bun.Image ms', width: 13, render: (r) => fmtMs(r.bun) },
        { label: 'bun is', width: 9, render: (r) => fmtRatio(r.sharp, r.bun) },
        {
          label: 'output size delta',
          width: 18,
          render: (r) =>
            `${r.bunBytes >= r.sharpBytes ? '+' : ''}${(((r.bunBytes - r.sharpBytes) / r.sharpBytes) * 100).toFixed(1)}%`,
        },
      ],
      speedupRows(rows)
    );
  }

  // ---------------------------------------------------------------- quality
  if (wants('quality')) {
    const subjects = [
      'photo-1600x1200.webp',
      'ui-1920x1080.png',
      'alpha-1200x900.png',
    ]
      .map((name) => corpus.find((c) => c.name === name))
      .filter(Boolean);

    const curve = [];
    for (const entry of subjects) {
      // One reference per input, at the encode geometry, produced by ONE
      // resampler for both engines so this table isolates the encoder.
      for (const quality of QUALITY_LADDER) {
        for (const engine of ENGINES) {
          const out = await engine.encodeOnce(entry.bytes, {
            width: 1200,
            quality,
          });
          const reference = await sharp(entry.bytes, {
            limitInputPixels: MAX_IMAGE_PIXELS,
          })
            .resize({ width: out.width, height: out.height, fit: 'fill' })
            .png()
            .toBuffer();
          const fidelity = await compareEncoded(reference, out.bytes);
          curve.push({
            input: entry.label,
            quality,
            engine: engine.name,
            size: out.size,
            psnr: fidelity.psnr,
            ssim: fidelity.ssim,
          });
        }
      }
    }
    payload.qualityCurve = curve;
    printTable(
      'size / fidelity at the same quality setting (encoder isolated)',
      [
        { label: 'input', width: 18, align: 'left', render: (r) => r.input },
        { label: 'quality', width: 8, render: (r) => String(r.quality) },
        { label: 'engine', width: 10, align: 'left', render: (r) => r.engine },
        { label: 'size', width: 11, render: (r) => fmtBytes(r.size) },
        { label: 'PSNR', width: 11, render: (r) => fmtDb(r.psnr) },
        { label: 'SSIM', width: 8, render: (r) => r.ssim.toFixed(4) },
      ],
      curve
    );

    const resample = [];
    for (const entry of subjects) {
      const delta = await resampleDelta(entry.bytes, 800, ENGINES);
      resample.push({ input: entry.label, ...delta });
    }
    payload.resample = resample;
    printTable(
      'resampler difference, engine vs engine (lossless, no reference)',
      [
        { label: 'input', width: 18, align: 'left', render: (r) => r.input },
        { label: 'dims', width: 11, render: (r) => r.dims },
        { label: 'PSNR', width: 11, render: (r) => fmtDb(r.psnr) },
        { label: 'SSIM', width: 8, render: (r) => r.ssim.toFixed(4) },
      ],
      resample
    );

    const shipped = [];
    for (const entry of subjects) {
      for (const row of await pipelineFidelity(ENGINES, entry, TARGET_SIZE))
        shipped.push({ input: entry.label, ...row });
    }
    payload.pipelineFidelity = shipped;
    printTable(
      'what the production loop actually ships (target-constrained)',
      [
        { label: 'input', width: 18, align: 'left', render: (r) => r.input },
        { label: 'engine', width: 10, align: 'left', render: (r) => r.engine },
        { label: 'size', width: 11, render: (r) => fmtBytes(r.size) },
        { label: 'dims', width: 11, render: (r) => r.dims ?? '-' },
        { label: 'iterations', width: 10, render: (r) => fmtInt(r.iterations) },
        { label: 'PSNR', width: 11, render: (r) => fmtDb(r.psnr) },
        { label: 'SSIM', width: 8, render: (r) => (r.ssim ?? 0).toFixed(4) },
      ],
      shipped
    );
  }

  // --------------------------------------------------------------- blurhash
  if (wants('blurhash')) {
    const rows = [];
    for (const entry of corpus.filter((c) => c.kind === 'perf')) {
      for (const engine of ENGINES) {
        const timed = await timeRepeats(
          () => engine.blurhash(entry.bytes),
          args.repeat
        );
        rows.push({
          input: entry.label,
          engine: engine.name,
          ms: timed.msMedian,
          hash: timed.result.hash,
        });
      }
    }
    payload.blurhash = rows;
    printTable(
      'blurhash (32px RGBA -> 4x3 components)',
      [
        { label: 'input', width: 18, align: 'left', render: (r) => r.input },
        { label: 'engine', width: 10, align: 'left', render: (r) => r.engine },
        { label: 'ms (median)', width: 12, render: (r) => fmtMs(r.ms) },
        // Bun's side pays for a lossless PNG round-trip inside `imageToRgba`
        // (no raw terminal exists); it is inside the millisecond figure rather
        // than a column of its own.
        { label: 'hash', width: 30, align: 'left', render: (r) => r.hash },
      ],
      rows
    );
  }

  // ------------------------------------------------------------ concurrency
  if (wants('concurrency')) {
    const entry =
      corpus.find((c) => c.name === 'photo-1600x1200.webp') ?? perfCorpus[0];
    const rows = [];
    for (const level of [1, args.concurrency]) {
      for (const engine of ENGINES) {
        const measured = await withPeakRss(() =>
          timeConcurrent(
            () => engine.optimize(entry.bytes, { targetSize: TARGET_SIZE }),
            level
          )
        );
        rows.push({
          engine: engine.name,
          level,
          wallMs: measured.value.wallMs,
          perImageMs: measured.value.perImageMs,
          lagMaxMs: measured.value.lag.maxMs,
          lagMedianMs: measured.value.lag.medianMs,
          failures: measured.value.failures,
          rssPeakMb: measured.rssPeak / 1024 / 1024,
        });
      }
    }

    // The idle baseline: the same sampler with no image work at all, so a lag
    // number above can be read against what this machine's timer does anyway.
    const idle = startLagSampler();
    await Bun.sleep(300);
    const idleLag = idle.stop();
    payload.concurrency = { rows, idleLag };

    printTable(
      `concurrent optimize of ${entry.label} (idle-baseline lag: max ${fmtMs(idleLag.maxMs)} ms, median ${fmtMs(idleLag.medianMs)} ms)`,
      [
        { label: 'engine', width: 10, align: 'left', render: (r) => r.engine },
        { label: 'in flight', width: 9, render: (r) => String(r.level) },
        { label: 'wall ms', width: 10, render: (r) => fmtMs(r.wallMs) },
        { label: 'ms/image', width: 10, render: (r) => fmtMs(r.perImageMs) },
        { label: 'loop lag max', width: 13, render: (r) => fmtMs(r.lagMaxMs) },
        { label: 'lag median', width: 11, render: (r) => fmtMs(r.lagMedianMs) },
        {
          label: 'peak RSS',
          width: 10,
          render: (r) => fmtBytes(r.rssPeakMb * 1024 * 1024),
        },
        { label: 'failures', width: 9, render: (r) => String(r.failures) },
      ],
      rows
    );
  }

  // ---------------------------------------------------------------- hostile
  if (wants('hostile')) {
    const valid = corpus.find((c) => c.name === 'ui-1920x1080.png');
    const hostile = hostileInputs(valid.bytes);
    const behaviour = await behaviourInputs(valid.bytes);
    const results = [
      ...(await hostileChecks(ENGINES, hostile, TARGET_SIZE)),
      ...(await pixelCapChecks(
        ENGINES,
        allInputs.find((c) => c.name === 'overcap-6000x5000.png'),
        corpus.find((c) => c.name === 'atcap-5000x5000.png')
      )),
      ...(await behaviourChecks(ENGINES, behaviour, TARGET_SIZE)),
    ];
    payload.hostile = results;
    failedCritical += printChecks(
      'hostile input, pixel cap and behaviour differences',
      results
    );
  }

  // ----------------------------------------------------------------- memory
  if (wants('memory')) {
    const child = resolve(import.meta.dirname, 'shared', '_memory-child.mjs');
    const subjects = ['atcap-5000x5000.png', 'photo-1600x1200.webp']
      .map((name) => corpus.find((c) => c.name === name))
      .filter(Boolean);
    const rows = [];
    for (const entry of subjects) {
      const path = resolve(cacheDir, `corpus-v${CORPUS_VERSION}`, entry.name);
      for (const engine of ENGINES) {
        const proc = Bun.spawn(['bun', child, engine.slug, path], {
          stdout: 'pipe',
          env: { ...process.env, BENCH_TARGET_SIZE: String(TARGET_SIZE) },
        });
        const text = await new Response(proc.stdout).text();
        await proc.exited;
        rows.push({
          input: entry.label,
          ...JSON.parse(text.trim().split('\n').pop()),
        });
      }
    }
    payload.memory = rows;
    printTable(
      'peak RSS, one fresh process per measurement',
      [
        { label: 'input', width: 18, align: 'left', render: (r) => r.input },
        { label: 'engine', width: 10, align: 'left', render: (r) => r.engine },
        {
          label: 'baseline RSS',
          width: 13,
          render: (r) => fmtBytes(r.baselineRss),
        },
        { label: 'peak RSS', width: 11, render: (r) => fmtBytes(r.peakRss) },
        {
          label: 'pipeline cost',
          width: 14,
          render: (r) => fmtBytes(r.pipelineRss),
        },
        { label: 'ms', width: 9, render: (r) => fmtMs(r.ms) },
      ],
      rows
    );
  }

  // ---------------------------------------------------------------- startup
  if (wants('startup')) {
    const child = resolve(import.meta.dirname, 'shared', '_startup-child.mjs');
    const rows = [];
    for (const engine of ['sharp', 'bun']) {
      const started = Bun.nanoseconds();
      const proc = Bun.spawn(['bun', child, engine], { stdout: 'pipe' });
      const text = await new Response(proc.stdout).text();
      await proc.exited;
      const processMs = (Bun.nanoseconds() - started) / 1e6;
      const parsed = JSON.parse(text.trim().split('\n').pop());
      rows.push({ ...parsed, processMs });
    }
    payload.startup = rows;
    printTable(
      'cold start, in a fresh process',
      [
        { label: 'engine', width: 10, align: 'left', render: (r) => r.engine },
        {
          label: 'module load ms',
          width: 15,
          render: (r) => fmtMs(r.loadMs, 2),
        },
        { label: 'first op ms', width: 12, render: (r) => fmtMs(r.firstOpMs) },
        {
          label: 'RSS after load',
          width: 15,
          render: (r) => fmtBytes(r.rssAfter),
        },
        {
          label: 'whole process ms',
          width: 17,
          render: (r) => fmtMs(r.processMs),
        },
      ],
      rows
    );
  }

  saveJson(resolve(cacheDir, 'latest.json'), payload);

  if (failedCritical > 0) {
    console.log(
      `\n${failedCritical} CRITICAL check(s) FAILED — see the capability section before reading the timings as a verdict.`
    );
    process.exitCode = 1;
  } else {
    console.log('\nAll critical checks passed.');
  }
}

function speedupRows(rows) {
  const byInput = new Map();
  for (const row of rows) {
    const current = byInput.get(row.input) ?? { input: row.input };
    if (row.engine === 'sharp') {
      current.sharp = row.optimizeMs;
      current.sharpBytes = row.outBytes;
    } else {
      current.bun = row.optimizeMs;
      current.bunBytes = row.outBytes;
    }
    byInput.set(row.input, current);
  }
  return [...byInput.values()];
}

await main();
