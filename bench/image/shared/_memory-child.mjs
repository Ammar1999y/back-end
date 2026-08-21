// Spawned by the `memory` scenario, one child per (engine, input).
//
// Peak RSS cannot be compared honestly inside the main benchmark process: the
// scenarios run in sequence, so by the time the last one runs the process has
// already grown to fit everything before it, and neither library returns pages
// to the OS on a schedule the harness controls. A fresh process per measurement
// is the only way the number means "what this image costs".
//
// Usage: `bun _memory-child.mjs sharp|bun <path-to-image>`

import { readFileSync } from 'node:fs';

import { ENGINES } from './engines.mjs';
import { withPeakRss } from './runner.mjs';

const [, , slug, path] = process.argv;
const engine = ENGINES.find((e) => e.slug === slug);
if (!engine) throw new Error(`unknown engine ${slug}`);

const bytes = readFileSync(path);
const target = Number(process.env.BENCH_TARGET_SIZE);
const baseline = process.memoryUsage.rss();

const started = Bun.nanoseconds();
const measured = await withPeakRss(() =>
  engine.optimize(bytes, { targetSize: target })
);
const ms = (Bun.nanoseconds() - started) / 1e6;

console.log(
  JSON.stringify({
    engine: engine.name,
    ms,
    outBytes: measured.value.size,
    iterations: measured.value.iterations,
    // `baseline` is after the module graph loaded and the input was read, so
    // `peak - baseline` is the pipeline's own footprint rather than the
    // runtime's.
    baselineRss: baseline,
    peakRss: measured.rssPeak,
    pipelineRss: measured.rssPeak - baseline,
  })
);
