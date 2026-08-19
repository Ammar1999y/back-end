/**
 * Bounded, cooperative deletion of expired rows.
 *
 * Two separate problems, and batching alone only solves the first:
 *
 * 1. **Writer-lock hold.** One unbounded `DELETE` holds SQLite's sole writer
 *    lock for its whole duration, so every limiter write waits on `busy_timeout`
 *    behind it. Committing every `BATCH_SIZE` rows bounds that.
 * 2. **Event-loop monopoly.** Both drivers are synchronous, so a tight loop of
 *    bounded deletes still blocks the single Node process end to end — releasing
 *    the SQLite lock between statements does not let the runtime serve another
 *    request. Measured: a sweep over a large backlog delayed a concurrent health
 *    request by roughly its own duration. Yielding to the event loop between
 *    batches is what actually fixes that, which is why this is async.
 *
 * `hasMore` reports that the per-run ceiling was reached. Without it, a run that
 * removed exactly the ceiling is indistinguishable from one that finished, and a
 * growing backlog stays invisible.
 *
 * It is deliberately CONSERVATIVE: a run whose final batch was exactly full
 * reports `true` even when that batch happened to remove the last expired row.
 * The false positive costs one extra sweep; the opposite error would hide a
 * genuine backlog, so the bias is the safe one. Anything alerting on it should
 * treat sustained `true` as the signal, not a single occurrence.
 */

import type { SqliteStatement } from './driver';

/** Rows per statement. Small enough that one commit is never a long lock hold. */
const BATCH_SIZE = 500;

/**
 * Ceiling per table per run. A backlog larger than this is reported via
 * `hasMore` rather than being chased in one invocation, so a single run cannot
 * grow without bound.
 */
const MAX_BATCHES = 200;

export interface SweepResult {
  removed: number;
  /** True when the ceiling was hit and expired rows almost certainly remain. */
  hasMore: boolean;
}

/** Hands the event loop back so queued requests run between batches. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * `statement` must be a bounded delete taking `(cutoff, limit)` and returning the
 * number of rows it removed.
 */
export async function sweepInBatches(
  statement: SqliteStatement,
  cutoff: number
): Promise<SweepResult> {
  let removed = 0;

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const { changes } = statement.run(cutoff, BATCH_SIZE);
    removed += changes;
    if (changes < BATCH_SIZE) return { removed, hasMore: false };
    await yieldToEventLoop();
  }

  return { removed, hasMore: true };
}
