/**
 * The provenance sidecar `scripts/check-coverage.ts` reads, and the one
 * condition under which writing it is honest.
 *
 * Its own module rather than a pair of closures in `tests/helpers/run.ts`: the
 * defect it exists to prevent lives in the INTERACTION between the runner and
 * the gate — a tier that produced no report still stamped the sidecar, so CI's
 * `integration --coverage` → `process` → `matrix` → gate order left the gate
 * refusing a report the run before last had legitimately produced — and that
 * interaction can only be tested from something importable.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

/** What `stampCoverageProvenance` writes, and `check-coverage.ts` reads back. */
export interface CoverageProvenance {
  tier: string;
  selection: string;
  startedAt: string;
  finishedAt: string;
  /** `reportDigest` of the lcov this run left behind. */
  digest: string;
}

/**
 * Identifies the report CONTENTS, so the sidecar names one file rather than a
 * path.
 *
 * Timestamps alone cannot: a later `bun test --coverage` — or a restored
 * `coverage/` directory — rewrites `lcov.info` in place and leaves this run's
 * sidecar sitting beside a report it never produced, which the gate then
 * attributes to the tier stamped here. Shared with `scripts/check-coverage.ts`
 * so the two sides cannot hash differently.
 */
export function reportDigest(contents: Uint8Array | string): string {
  return createHash('sha256').update(contents).digest('hex');
}

/**
 * Did this run ask `bun test` for coverage?
 *
 * The only run that rewrites `coverage/lcov.info`, and therefore the only one
 * entitled to claim it. Nothing in `bunfig.toml` turns coverage on — it declares
 * the reporters and no more — so the flag is the whole condition.
 *
 * `--coverage=<value>` as well as the bare flag: Bun accepts both spellings, and
 * matching only the bare one would put the hole back for the caller who used the
 * other.
 */
export function coverageRequested(flags: readonly string[]): boolean {
  return flags.some(
    (flag) => flag === '--coverage' || flag.startsWith('--coverage=')
  );
}

/**
 * Writes `provenance.json` beside the report, and only for a run that produced
 * one.
 *
 * lcov carries no tier and no timestamp, so a stale report from a DIFFERENT tier
 * — whose floors describe a different set of loaded files — passed the gate
 * unnoticed. Stamping unconditionally replaced that hole with its mirror image:
 * the tier that ran last won the sidecar whether or not it had written a report.
 */
export async function stampCoverageProvenance(options: {
  /** Directory holding `lcov.info`; the sidecar is written beside it. */
  coverageDir: string;
  tier: string;
  selection: string;
  /** Forwarded `bun test` flags — the run is only stamped if it asked for coverage. */
  flags: readonly string[];
  startedAt: number;
}): Promise<void> {
  if (!coverageRequested(options.flags)) return;

  const report = Bun.file(path.join(options.coverageDir, 'lcov.info'));
  if (!(await report.exists())) return;

  const stamp: CoverageProvenance = {
    tier: options.tier,
    selection: options.selection,
    startedAt: new Date(options.startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    digest: reportDigest(new Uint8Array(await report.arrayBuffer())),
  };
  await Bun.write(
    path.join(options.coverageDir, 'provenance.json'),
    `${JSON.stringify(stamp, null, 2)}\n`
  );
}
