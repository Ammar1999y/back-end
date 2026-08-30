/**
 * The preload every tier gets, from `bunfig.toml`.
 *
 * A preload is the only hook that reliably runs before the first test module is
 * imported — measured: a top-level `await` here completes before any test file
 * loads — which is what makes it the only place a `process.env` rewrite is seen
 * by an application module's load-time reads. `lib/env.server.ts` reads
 * `SQLITE_DIR` at load, `db/index.ts` constructs its pool from `DATABASE_URL` at
 * load; neither can be fixed from inside a test file.
 *
 * What this file must NOT do: import anything from `@/lib`, `@/db` or `@/app`.
 * Every one of those modules reads the environment this file is still setting up.
 */
import { afterEach, beforeEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { drainAfterResponse } from '@/lib/http/after-response';

import {
  assertNoEgressViolations,
  installEgressGuard,
  resetEgress,
} from './egress';
import { nodemailerStub, resetMailbox } from './mailbox';
import { presignerStub, resetObjectStore, s3ClientStub } from './object-store';

/**
 * Guard 4 of the four in the strategy, and the only one that belongs here rather
 * than in the database preload: it is not about which database was resolved, it
 * is about the suite refusing to run in a production process at all. Everything
 * below — deleting SQLite files, exhausting budgets — is destructive regardless
 * of whether PostgreSQL is involved.
 */
if (process.env.NODE_ENV === 'production')
  throw new Error(
    'refusing to run the test suite with NODE_ENV=production. It deletes SQLite ' +
      'databases, exhausts rate-limit budgets and truncates tables.'
  );

/**
 * `rate-limit.db` is shared mutable state with windows up to 24 hours long, so
 * the repository's `data/` directory is the one place it must never be: a row
 * left by a previous run denies the next run's first assertion with no error at
 * all — just an unexpected 429 — and a fixed-window counter inside its window is
 * not expired, so the sweep does not clear it either.
 *
 * Per PROCESS, not per run: `--parallel` workers each open their own files, and
 * two workers exhausting the same OTP budget is the same collision as two runs.
 */
const sqliteDir = path.join(
  os.tmpdir(),
  `bun-test-sqlite-${process.pid}-${Math.trunc(performance.now() * 1000)}`
);
// eslint-disable-next-line security/detect-non-literal-fs-filename -- a name this file just built under the OS temp root
mkdirSync(sqliteDir, { recursive: true });
// The path is published through the environment and NOT as an export. Importing
// this module from a test file re-executes it — under `--isolate` that means a
// second temp directory and a second installation of the mocks below. A test that
// needs the path reads `process.env.SQLITE_DIR`.
process.env.SQLITE_DIR = sqliteDir;

/**
 * **No `DATABASE_URL` rewrite here, deliberately.**
 *
 * `bunfig.toml`'s `[test] preload` applies to EVERY `bun test` under this
 * directory, not only to the three tiers, so redirecting the variable from here
 * breaks any command that shells out to `bun test` — with an error naming a
 * refused port rather than this file.
 *
 * The protection lives at the point of danger instead: `assertHarnessDatabase()`
 * in `./database.ts` refuses to truncate or seed a database the harness did not
 * create, asked of the server. That holds for a bare `bun test`, a hand-run of
 * one file and a mis-set `TEST_DATABASE_URL` alike.
 */

installEgressGuard();

/**
 * The two egress boundaries `fetch` cannot cover, installed once for the whole
 * process.
 *
 * SMTP is not HTTP. R2 is HTTP but goes through the AWS SDK's
 * `NodeHttpHandler` — `node:http`, not `fetch` — so the router in `./egress.ts`
 * never sees it. Both are third-party modules at the process boundary, which is
 * the one category `mock.module` is the right tool for, and both are installed
 * HERE rather than in a test file: the replacement is process-wide and
 * `mock.restore()` does not undo it, so uniformity is the only thing that makes
 * it safe. See `./mailbox.ts` and `./object-store.ts`.
 */
const { mock } = await import('bun:test');
await mock.module('nodemailer', () => nodemailerStub());
await mock.module('@aws-sdk/client-s3', () => s3ClientStub());
await mock.module('@aws-sdk/s3-request-presigner', () => presignerStub());

/**
 * Throwaway R2 configuration.
 *
 * `lib/r2/client.ts` computes `validateR2Config` at module load, and with the
 * variables unset `uploadToR2`, `copyFileInR2` and `getPresignedUrl` throw before
 * reaching the client at all — so the upload pipeline is unreachable rather than
 * merely unfaked. These values never leave the process: every S3 call lands in
 * the stub above.
 */
process.env.R2_ACCOUNT_ID ??= 'harness-account';
process.env.R2_ACCESS_KEY_ID ??= 'harness-access-key';
process.env.R2_SECRET_ACCESS_KEY ??= 'harness-secret-key';
process.env.R2_PUBLIC_BUCKET ??= 'harness-public';
process.env.R2_PRIVATE_BUCKET ??= 'harness-private';
process.env.R2_PUBLIC_URL ??= 'https://cdn.example.invalid';

/**
 * The maintenance token, for the same reason as the R2 block above: it is read at
 * module load in `lib/env.server.ts`, so a test file setting it changes nothing —
 * and with it unset, `maintenanceTokenMatches` fails closed and the AUTHORIZED
 * path of `/api/health/storage?deep=1` is unreachable. Only the 401 shape would
 * be assertable, which cannot distinguish "guarded" from "guarded and broken".
 * (The two `/api/internal/*` sweep routes it also used to gate are gone — the
 * sweeps run in-process, see `lib/schedule.ts`.)
 *
 * `??=` so a run that sets a real one keeps it.
 */

process.env.SQLITE_MAINTENANCE_TOKEN ??= 'harness-maintenance-token-0123456789';

const DEFERRED_WORK_DRAIN_MS = 5000;

beforeEach(async () => {
  await drainAfterResponse(DEFERRED_WORK_DRAIN_MS);
  resetEgress();
  resetMailbox();
  resetObjectStore();
});

/**
 * The negative half of the egress boundary, and the reset that has to pair with
 * it.
 *
 * **`resetEgress` runs in BOTH hooks, and the `afterEach` half is not
 * redundant.** With the reset only in `beforeEach`, an override installed by the
 * last test of one `describe` was still in force during the NEXT `describe`'s
 * `beforeAll` — Bun runs a describe's `beforeAll` after the previous describe's
 * tests and before any `beforeEach`. That is not theoretical: a
 * `scriptEgress('challenges.cloudflare.com', … {success:false})` flood leaked
 * into a later fixture's `signIn()` and answered it `403 VERIFICATION_FAILED`,
 * which reads as a broken sign-in rather than as a leaked stub.
 *
 * The assertion runs first: it consumes the violations it reports, and resetting
 * before it would throw the evidence away.
 */
afterEach(async () => {
  await drainAfterResponse(DEFERRED_WORK_DRAIN_MS);
  try {
    assertNoEgressViolations();
  } finally {
    resetEgress();
    resetMailbox();
    resetObjectStore();
  }
});

process.on('exit', () => {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- same directory this module created
    if (existsSync(sqliteDir))
      rmSync(sqliteDir, { recursive: true, force: true });
  } catch {
    // A held file handle on Windows is not worth failing a green run over; the
    // directory is under the OS temp root and the name carries the pid.
  }
});
