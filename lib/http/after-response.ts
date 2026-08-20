/**
 * The one seam for work that must happen per request but that the client should
 * not wait on.
 *
 * Deliberately not a framework feature sprinkled through handlers. Elysia fires
 * `onAfterResponse`, Hono has `c.executionCtx.waitUntil`, Next had nothing
 * portable — so the framework hook is wired to `runAfterResponse` in ONE place
 * (the server file), and everything else talks to this module. A framework move
 * changes that single wiring line.
 *
 * ============================================================================
 * WHAT DOES NOT BELONG HERE: audit writes
 * ============================================================================
 * Deferring audit rows was the obvious candidate and it is the wrong call, and
 * the code says so rather than an opinion. `auditLog(tx, params)` in
 * `lib/audit.ts` takes a transaction handle as its FIRST parameter, and all 24
 * call sites pass one — the row is written inside the same transaction as the
 * mutation it records. Moving any of them here would admit a committed mutation
 * with no audit row whenever the deferred write failed, which inverts the
 * purpose of the trail.
 *
 * The classification, recorded so the next reader does not re-derive it:
 *
 *   transactional, stays  — every `auditLog` call site (app/api/**, lib/auth/**,
 *                           lib/permissions/utils.ts, utils/otp.ts)
 *   post-response, moves  — the request access log below, and anything future
 *                           that neither the client nor a transaction depends on
 *
 * An audit write could only move if it stopped needing the transaction, which is
 * a redesign of `auditLog`, not a call-site change.
 *
 * ============================================================================
 * SHUTDOWN
 * ============================================================================
 * Work started here is ordinary in-process work: nothing in Bun or Elysia waits
 * for it, so a `SIGTERM` that kills the process mid-task drops it. `drain()`
 * exists for exactly that and is awaited by the shutdown path in the server
 * file, bounded so a hung task cannot hold the container open past its grace
 * period.
 */

export type AfterResponseTask = () => void | Promise<void>;

/** What every request contributes to the access log. */
export interface RequestSummary {
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

/**
 * Keyed by the request object rather than by an id: it is the only handle both
 * the handler and the framework hook are guaranteed to share, and a `WeakMap`
 * cannot leak a queue for a request whose response was never produced.
 */
const queues = new WeakMap<Request, AfterResponseTask[]>();

const inFlight = new Set<Promise<void>>();

/**
 * Queue work to run after this request's response has been sent.
 *
 * Safe to call from a framework-agnostic handler: it takes the raw `Request`
 * that `HandlerInput.rawRequest` already carries.
 *
 * NO CALLER YET, and that is worth knowing rather than discovering. The only
 * post-response work today is `logRequest`, which runs synchronously, so
 * `inFlight` is empty on every request and the drain below always returns on its
 * first check. The queue and the settle loop are insurance for the first real
 * caller — they are not currently load-bearing, and no test exercises them.
 */
export function enqueueAfterResponse(
  request: Request,
  task: AfterResponseTask
): void {
  const queue = queues.get(request);
  if (queue) queue.push(task);
  else queues.set(request, [task]);
}

/**
 * Runs the access log and every queued task for a finished request.
 *
 * Never throws and never rejects: this runs after the response is committed, so
 * there is no status left to change and an escaping error would become an
 * unhandled rejection. Each task is isolated — one failure does not skip the
 * rest.
 */
export function runAfterResponse(
  request: Request,
  summary: RequestSummary
): void {
  const queue = queues.get(request) ?? [];
  queues.delete(request);

  logRequest(summary);
  if (queue.length === 0) return;

  const settled = (async () => {
    for (const task of queue) {
      try {
        await task();
      } catch (error) {
        console.error(
          JSON.stringify({
            msg: 'after-response task failed',
            path: summary.path,
            errorClass: (error as { name?: string })?.name ?? 'Unknown',
          })
        );
      }
    }
  })();

  inFlight.add(settled);
  void settled.finally(() => inFlight.delete(settled));
}

/**
 * The access log.
 *
 * One line per request that reaches a route or an error handler, structured, with
 * no query string and no headers: the path alone is enough to attribute latency,
 * and query strings on this API carry search terms and identifiers. This is also
 * the only measurement the application produces of its own request duration — the
 * number `Server-Timing` reports to the client.
 *
 * NOT one line per request in the literal sense, measured: `OPTIONS` produces
 * none. Both OPTIONS answers short-circuit in an `onRequest` hook — the CORS
 * plugin's 204 and `app.ts`'s route-aware 404 — and `onAfterResponse` does not
 * fire for either, so preflight volume and OPTIONS-based path scanning are
 * invisible here. 404s, 405s and 308s DO appear; they come from `onError`, which
 * does reach this hook.
 */
function logRequest(summary: RequestSummary): void {
  console.log(
    JSON.stringify({
      msg: 'request',
      method: summary.method,
      path: summary.path,
      status: summary.status,
      durationMs: Math.round(summary.durationMs),
    })
  );
}

/** How many post-response task batches are still running. */
export function pendingAfterResponse(): number {
  return inFlight.size;
}

/** How long the queue must stay empty before the drain calls it done. */
const SETTLE_MS = 50;

/**
 * Waits for queued post-response work, up to `timeoutMs`.
 *
 * A SETTLE loop, not a single `Promise.all`, and the difference matters. Two
 * ways work can appear after a naive check returns:
 *
 * 1. A request can still arrive, complete and enqueue work while the drain is
 *    running. An earlier revision of this comment gave the wrong reason for that
 *    — it claimed `Elysia.stop()` does not close the listening socket. It does:
 *    re-measured on `elysia@1.4.29`, a new connection is refused as soon as
 *    `stop()` resolves. What survives is an ALREADY-ESTABLISHED keep-alive
 *    connection, on which a further request is still served. The hole is real;
 *    it is narrower than "the listener stays open", and the distinction is
 *    recorded because the wrong version would justify a different fix.
 * 2. A task that itself enqueues follow-up work would be missed.
 *
 * So this waits for the queue to be observably empty for `SETTLE_MS`, and only
 * then reports success. Still bounded overall: a shutdown that waits forever on
 * a stuck task is a container the orchestrator kills anyway, and losing one log
 * line beats missing the grace period.
 *
 * Returns false on timeout, with `pendingAfterResponse()` giving the caller the
 * count it could not finish.
 */
export async function drainAfterResponse(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (inFlight.size === 0) {
      await Bun.sleep(SETTLE_MS);
      if (inFlight.size === 0) return true;
      continue;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    // `.catch` is not `.finally`: a rejected task must not reject this race and
    // abandon the rest of the drain. `runAfterResponse` already isolates task
    // errors, so this is belt-and-braces for a future caller that does not.
    await Promise.race([
      Promise.all(inFlight).catch(() => {}),
      Bun.sleep(Math.min(remaining, SETTLE_MS * 4)),
    ]);
  }

  return inFlight.size === 0;
}
