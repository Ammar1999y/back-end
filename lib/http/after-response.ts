/**
 * Framework-independent post-response work. Audit writes remain transactional
 * because losing them after a committed mutation would break the audit trail.
 */

type AfterResponseTask = () => void | Promise<void>;

export interface RequestSummary {
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

/** The raw request is the framework-independent handle shared by both stages. */
const queues = new WeakMap<Request, AfterResponseTask[]>();

const inFlight = new Set<Promise<void>>();

/** @knipignore Framework-independent entry point for deferred work. */
export function enqueueAfterResponse(
  request: Request,
  task: AfterResponseTask
): void {
  const queue = queues.get(request);
  if (queue) queue.push(task);
  else queues.set(request, [task]);
}

/** Isolates task failures because the response is already committed. */
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

/** Omits query strings and headers because both can contain user identifiers. */
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

export function pendingAfterResponse(): number {
  return inFlight.size;
}

const SETTLE_MS = 50;

/**
 * Waits for queued post-response work, up to `timeoutMs`.
 *
 * The empty settle period catches a batch registered while another batch is
 * finishing. The overall deadline keeps shutdown bounded.
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
    // A rejected batch must not abandon the rest of the drain.
    await Promise.race([
      Promise.all(inFlight).catch(() => {}),
      Bun.sleep(Math.min(remaining, SETTLE_MS * 4)),
    ]);
  }

  return inFlight.size === 0;
}
