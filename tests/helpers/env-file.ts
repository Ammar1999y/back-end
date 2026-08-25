/* eslint-disable security/detect-non-literal-fs-filename -- fixed paths under the repository root, never input */
/**
 * Reading `.env.test`.
 *
 * `bun run` auto-loads `.env` into the invoking process but not `.env.test`, and
 * the tier runner spawns `bun test` with `--no-env-file` so the child's
 * environment is exactly what it was handed — no second load that could re-win.
 * That makes an explicit reader necessary, and shared, because `run.ts` and
 * `reset.ts` both need `TEST_DATABASE_URL` before they connect.
 *
 * Only `KEY=value` lines matter; anything else in the file is a comment or blank.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.join(import.meta.dir, '..', '..');

/** Module-private: `loadTestEnv` is the only caller and the only useful shape. */
function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};

  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed
      .slice(eq + 1)
      .trim()
      .replaceAll(/^["'](.*)["']$/gs, '$1');
  }
  return out;
}

/**
 * Applies `.env.test` over the current environment and returns what it set.
 *
 * Applied to the reading process too, not only to the child: `adminUrl()` reads
 * `TEST_DATABASE_URL` from `process.env`, and the whole point of the file is that
 * the harness's target is configured somewhere `.env` is not.
 */
export function loadTestEnv(): Record<string, string> {
  const values = readEnvFile(path.join(REPO_ROOT, '.env.test'));
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  return values;
}
