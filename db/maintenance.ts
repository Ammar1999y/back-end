/**
 * PostgreSQL retention sweep — the counterpart to `lib/sqlite/maintenance.ts`.
 *
 * Separate module and separate schedule, not an extension of the SQLite sweep,
 * for two reasons that both matter operationally:
 *
 * 1. **Cadence.** The limiter/cache sweep reclaims disk from rows that expire in
 *    minutes and wants to run often. This is retention over days, and running it
 *    every few minutes would be almost entirely wasted queries against the one
 *    database serving real traffic.
 * 2. **Failure domain.** This one performs network I/O (R2 deletes) and writes to
 *    PostgreSQL. Folding it into the SQLite sweep would let an R2 outage report
 *    the limiter sweep as failed.
 *
 * **Not a correctness boundary, with one exception.** Session expiry, code
 * expiry and OTP proof validity are all filtered on every read, so a delayed or
 * failed run can never make an expired row usable — it only reclaims disk. The
 * exception is `files`: nothing else in the codebase ever deletes a temporary
 * upload, so if this does not run, R2 objects accumulate and are paid for
 * indefinitely.
 *
 * **What this deliberately does NOT touch: `audit_logs`, and users.** Both were
 * considered and declined; the reasoning is recorded on those tables in
 * `schema.ts`.
 */
import type { FileSweepCount } from '@/lib/media/lifecycle';

import { inArray, lt, or, sql } from 'drizzle-orm';

import { sanitizeForLog } from '@/utils';
import { sweepFiles } from '@/lib/media/lifecycle';
import { retryTransitions } from '@/lib/media/visibility';

import { db } from './index';
import {
  sessions,
  trustedDevices,
  verificationCodes,
  verifications,
  verificationSessions,
} from './schema';

/**
 * How long a row survives past the point it stopped being useful.
 *
 * `SESSION_GRACE` is deliberately not zero: `sessions.expiresAt` is already
 * enforced on every read, so deleting on the expiry second buys nothing, and a
 * short tail keeps a just-expired session visible to anyone debugging why a user
 * was logged out.
 *
 * The file TTL lives with the file lifecycle (`PENDING_FILE_TTL` in
 * `lib/media/lifecycle.ts`), next to the code that claims a pending upload.
 */
const SESSION_GRACE = '30 days';
const VERIFICATION_SESSION_TTL = '1 day';

/**
 * Rows per statement, and a ceiling on statements per table per run — the same
 * two-part bound as `lib/sqlite/sweep.ts`, for a related but not identical
 * reason. There is no single writer lock here, but an unbounded `DELETE` takes
 * row locks for its whole duration and writes one WAL record per row, so on a
 * large backlog it is a long transaction competing with live traffic. Batching
 * keeps each transaction short.
 *
 * PostgreSQL has no `DELETE ... LIMIT`, so the bound is expressed as
 * `WHERE id IN (SELECT id ... LIMIT n)`.
 *
 * The retention windows are BOUND as parameters and cast (`$1::interval`), not
 * interpolated with `sql.raw`. They are module constants today, so neither form
 * is injectable now — but a `raw` interval is one refactor away from taking a
 * caller-supplied window, and this form cannot become that.
 */
const BATCH_SIZE = 500;
const MAX_BATCHES = 40;

/**
 * **Every select below is a sequential scan, and that is knowingly accepted** —
 * except the two newest, `verifications` and `trusted_devices`, which have a
 * leading index on the column they filter (`expires_at`) because both are
 * high-churn enough that a nightly scan would be the wrong shape from the start.
 *
 * Verified with `EXPLAIN`, not assumed: no existing index has a usable leading
 * column for the other predicates — `idx_sessions_user_expires_created` leads
 * with `user_id`, and the OTP proof and files tables have nothing on the columns
 * being filtered.
 *
 * Fine as things stand: this is one nightly job, `LIMIT 500` stops the scan early
 * whenever there IS work, and adding four indexes would put write amplification
 * on `sessions` — written on every login and refresh — to speed up a job nobody
 * waits for.
 *
 * The case that would change the answer is a large table where matching rows are
 * SPARSE and LATE: each of up to `MAX_BATCHES` batches then scans most of it. If
 * a run ever gets slow, the fix is a partial index per predicate — e.g.
 * `(expires_at) WHERE expires_at IS NOT NULL` on `sessions`, `(created_at) WHERE
 * is_temporary` on `files` — not a bigger `BATCH_SIZE`.
 */

interface SweepCount {
  removed: number;
  /** True when the per-run ceiling was reached and rows almost certainly remain. */
  hasMore: boolean;
}

/** Visibility sagas a crashed request left behind, finished or reverted. */
interface TransitionSweepCount {
  reverted: number;
  finished: number;
  /** Object-store deletes that failed; the rows stay marked for the next run. */
  failed: number;
  /** A failed delete, or the step itself threw before it could report. */
  degraded: boolean;
}

/**
 * One step's failure must not skip the steps after it: the file sweep and the
 * transition retry each talk to the object store, and a throw in the first used
 * to leave stuck transitions unrecovered for the whole run. The step reports
 * `fallback` — degraded, with more to do — and the run goes on.
 */
async function guarded<T>(
  step: string,
  run: () => Promise<T>,
  fallback: T
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    console.error(
      sanitizeForLog({
        msg: 'sweep step failed',
        step,
        errorClass: error instanceof Error ? error.name : typeof error,
      })
    );
    return fallback;
  }
}

export interface DatabaseSweepResult {
  /**
   * `degraded` when a store this run was asked to sweep was not swept, matching
   * the rule `lib/sqlite/maintenance.ts` states for the sibling job: containment
   * is not the same as success.
   *
   * It used to be the literal `'ok'`, so this job could not express the state at
   * all — during an R2 outage the nightly pass deleted no objects and removed no
   * `files` rows while `logRun` wrote `scheduled sweep completed, status: "ok"`.
   * `hasMore` was the only signal, and it is indistinguishable from an ordinary
   * backlog. That matters here more than anywhere: nothing else in the codebase
   * deletes an abandoned upload, so the objects accumulate and are paid for.
   */
  status: 'ok' | 'degraded';
  durationMs: number;
  removed: {
    sessions: SweepCount;
    verificationSessions: SweepCount;
    verificationCodes: SweepCount;
    verifications: SweepCount;
    trustedDevices: SweepCount;
    files: FileSweepCount;
    transitions: TransitionSweepCount;
  };
  hasMore: boolean;
}

/** Hands the event loop back so queued requests run between batches. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Runs one bounded delete repeatedly until it clears or the ceiling is hit.
 *
 * `deleteBatch` must delete at most `BATCH_SIZE` rows and return how many it
 * removed. Conservative in the same direction as the SQLite sweep: a final batch
 * that was exactly full reports `hasMore: true` even if it happened to take the
 * last row. One wasted run beats a hidden backlog.
 */
async function sweepBatched(
  deleteBatch: () => Promise<number>
): Promise<SweepCount> {
  let removed = 0;

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const deleted = await deleteBatch();
    removed += deleted;
    if (deleted < BATCH_SIZE) return { removed, hasMore: false };
    await yieldToEventLoop();
  }

  return { removed, hasMore: true };
}

/** Expired sessions, past the grace window. */
function sweepSessions(): Promise<SweepCount> {
  return sweepBatched(async () => {
    const doomed = db
      .select({ id: sessions.id })
      .from(sessions)
      .where(lt(sessions.expiresAt, sql`now() - ${SESSION_GRACE}::interval`))
      .limit(BATCH_SIZE);

    const deleted = await db
      .delete(sessions)
      .where(inArray(sessions.id, doomed))
      .returning({ id: sessions.id });

    return deleted.length;
  });
}

/**
 * Spent or abandoned OTP proof rows. `verification_codes` cascades from here, so
 * this also removes the code attached to each deleted session.
 *
 * **This table is state, not a forensic record.** A consumed row is a single-use
 * replay marker whose code is already gone and whose `consumedAt` is set, and
 * every flow that consumes one writes its own `audit_logs` entry — contact
 * change, password reset, passwordless sign-in. `revokePendingProofs`
 * (`lib/auth/rotation.ts`) already deletes consumed sibling rows on every
 * credential rotation, so the table has never been a complete history.
 *
 * One known consequence, accepted: `verifyAttemptDaily` lives on this row, so
 * deleting it forgives that row's failed verify attempts. The 24-hour verify
 * budget was already forgiven by successful verification and by credential
 * rotation, and verify attempts stay bounded per destination
 * (`enforceOtpVerifyQuota`) and per user by the endpoint limiters.
 */
function sweepVerificationSessions(): Promise<SweepCount> {
  return sweepBatched(async () => {
    const doomed = db
      .select({ id: verificationSessions.id })
      .from(verificationSessions)
      .where(
        or(
          sql`${verificationSessions.consumedAt} IS NOT NULL`,
          lt(
            verificationSessions.createdAt,
            sql`now() - ${VERIFICATION_SESSION_TTL}::interval`
          )
        )
      )
      .limit(BATCH_SIZE);

    const deleted = await db
      .delete(verificationSessions)
      .where(inArray(verificationSessions.id, doomed))
      .returning({ id: verificationSessions.id });

    return deleted.length;
  });
}

/**
 * Expired codes whose session is still live.
 *
 * Not redundant with the cascade above: a code expires in OTP_EXPIRY_MINUTES
 * while its session stays unconsumed and under a day old, so the sweep that
 * removes sessions would leave it behind.
 *
 * Nothing security-critical rides on this — `processOtpVerify` filters on
 * `expires_at` for every lookup, so an expired code cannot be used whether it is
 * here or not. It reclaims rows.
 */
function sweepVerificationCodes(): Promise<SweepCount> {
  return sweepBatched(async () => {
    const doomed = db
      .select({ id: verificationCodes.id })
      .from(verificationCodes)
      .where(lt(verificationCodes.expiresAt, sql`now()`))
      .limit(BATCH_SIZE);

    const deleted = await db
      .delete(verificationCodes)
      .where(inArray(verificationCodes.id, doomed))
      .returning({ id: verificationCodes.id });

    return deleted.length;
  });
}

/**
 * Not a correctness boundary: `consumeVerificationValue` deletes a row past its
 * `expiresAt` and returns null, so an unswept row can never be redeemed. The
 * sweep reclaims disk on what is otherwise the fastest-growing table here.
 */
function sweepVerifications(): Promise<SweepCount> {
  return sweepBatched(async () => {
    const doomed = db
      .select({ id: verifications.id })
      .from(verifications)
      .where(lt(verifications.expiresAt, sql`now()`))
      .limit(BATCH_SIZE);

    const deleted = await db
      .delete(verifications)
      .where(inArray(verifications.id, doomed))
      .returning({ id: verifications.id });

    return deleted.length;
  });
}

/**
 * Also not a correctness boundary — the sign-in check filters on `expiresAt`. It
 * matters for the settings screen, which is user-visible: a list padded with
 * devices that already stopped working teaches users to ignore it.
 */
function sweepTrustedDevices(): Promise<SweepCount> {
  return sweepBatched(async () => {
    const doomed = db
      .select({ id: trustedDevices.id })
      .from(trustedDevices)
      .where(lt(trustedDevices.expiresAt, sql`now()`))
      .limit(BATCH_SIZE);

    const deleted = await db
      .delete(trustedDevices)
      .where(inArray(trustedDevices.id, doomed))
      .returning({ id: trustedDevices.id });

    return deleted.length;
  });
}

/**
 * One retention pass over PostgreSQL.
 *
 * Sequential, not `Promise.all`: each table's sweep is itself a batched loop
 * yielding to the event loop, and running them concurrently would put several
 * long-running delete loops against live traffic instead of one. The whole run
 * is a scheduled background job, so wall-clock is not the thing to optimise.
 *
 * The file half lives in `lib/media/lifecycle.ts` and `lib/media/visibility.ts`,
 * next to the request paths whose unfinished work it completes: abandoned
 * pending uploads, deletes that lost their request between phases, and
 * visibility copies that never flipped or never cleaned up. Those are the only
 * sweeps here that talk to the object store, which is why they alone can report
 * `degraded`.
 */
export async function runDatabaseSweep(
  startedAt = Date.now()
): Promise<DatabaseSweepResult> {
  const removed = {
    // Verification sessions first: the cascade removes their codes, so the code
    // sweep that follows has less to look at.
    verificationSessions: await sweepVerificationSessions(),
    verificationCodes: await sweepVerificationCodes(),
    verifications: await sweepVerifications(),
    trustedDevices: await sweepTrustedDevices(),
    sessions: await sweepSessions(),
    files: await guarded('files', sweepFiles, {
      removed: 0,
      unfiled: { stamped: 0, reaped: 0 },
      hasMore: true,
      degraded: true,
    }),
    transitions: await guarded(
      'transitions',
      async () => {
        const outcome = await retryTransitions();
        return { ...outcome, degraded: outcome.failed > 0 };
      },
      { reverted: 0, finished: 0, failed: 0, degraded: true }
    ),
  };

  return {
    status:
      removed.files.degraded || removed.transitions.degraded
        ? 'degraded'
        : 'ok',
    durationMs: Date.now() - startedAt,
    removed,
    // Reported rather than hidden, for the same reason as the SQLite sweep: a run
    // that removed exactly its ceiling is otherwise indistinguishable from one
    // that finished, and a growing backlog stays invisible. Sustained `true` is
    // the signal, not a single occurrence.
    hasMore:
      removed.sessions.hasMore ||
      removed.verificationSessions.hasMore ||
      removed.verificationCodes.hasMore ||
      removed.verifications.hasMore ||
      removed.trustedDevices.hasMore ||
      removed.files.hasMore ||
      removed.transitions.degraded,
  };
}
