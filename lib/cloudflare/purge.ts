import { sanitizeForLog } from '@/utils';
import { rateLimit } from '@/lib/rate-limit';

const ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const TOKEN = process.env.CLOUDFLARE_CACHE_PURGE_TOKEN;

/** Both variables, or neither — `lib/env.server.ts` refuses the half-set state. */
export const CACHE_PURGE_CONFIGURED = Boolean(ZONE_ID && TOKEN);

/** The API's per-call ceiling for purge-by-URL. */
export const PURGE_BATCH_SIZE = 30;
const DEADLINE_MS = 10_000;
const ATTEMPTS = 2;

/**
 * The wall clock ONE call may spend, however many batches it was handed.
 *
 * Worst case per batch is `DEADLINE_MS * ATTEMPTS`, and a recursive folder
 * delete can hand this seven batches (`FOLDER_RECURSIVE_DELETE_MAX` / 30) —
 * 140 seconds against a 60-second connection ceiling, so the client lost the
 * answer while the destructive half of the operation went on running. A batch
 * not STARTED before this passes is reported in `failed`, which every caller
 * already treats as "the row keeps its `deleting` marker"; `sweepFiles` retries
 * it. A healthy purge answers in well under a second per batch and never
 * reaches this.
 */
const TOTAL_BUDGET_MS = 25_000;

/**
 * Deployment-wide ceiling on outbound Cloudflare API calls.
 *
 * Cloudflare's limit is 1200 requests per five minutes PER USER, and exceeding
 * it blocks EVERY API call from that token — not only purges — for the next
 * five minutes
 * (`developers.cloudflare.com/fundamentals/api/reference/limits`). Nothing else
 * bounds this: one recursive folder delete is up to seven calls (fourteen with
 * retries) and the media routes admit many such requests per minute per user,
 * so a handful of authenticated users could spend the account's whole API
 * allowance and leave later privacy deletions with live edge copies.
 *
 * Below the provider ceiling so an operator's own dashboard and token use still
 * fit. Refusal is not an error here: the URLs go into `failed` like any other
 * unconfirmed batch. Fail-OPEN when the limiter store is unreachable — a stale
 * edge copy of deleted content is the worse outcome, and the provider's own 429
 * is the backstop.
 */
const API_CALL_BUDGET = 900;
const API_CALL_WINDOW_S = 300;

async function reserveApiCall(): Promise<boolean> {
  const { success } = await rateLimit({
    identifier: 'cloudflare.api:global',
    limit: API_CALL_BUDGET,
    window: API_CALL_WINDOW_S,
  });
  if (!success)
    console.error(
      JSON.stringify({
        msg: 'media.cache-purge budget exhausted',
        effect: 'batch deferred to the sweep; rows keep their deleting marker',
        budget: API_CALL_BUDGET,
        windowSeconds: API_CALL_WINDOW_S,
      })
    );
  return success;
}

export interface PurgeOutcome {
  /** URLs handed to the API, after batching. 0 when unconfigured. */
  attempted: number;
  /** URLs in batches the API acknowledged. */
  purged: number;
  /** URLs in batches the API refused or that never got an answer; the caller keeps its marker for these. */
  failed: string[];
}

async function purgeBatch(urls: readonly string[]): Promise<boolean> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    // Charged per outbound call, retries included: the provider counts them.
    if (!(await reserveApiCall())) return false;
    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/purge_cache`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${TOKEN}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ files: urls }),
          signal: AbortSignal.timeout(DEADLINE_MS),
        }
      );
      if (response.ok) return true;
      // A 4xx is a configuration problem a retry cannot fix; a 5xx may pass.
      if (attempt === ATTEMPTS || response.status < 500) {
        console.error(
          JSON.stringify({
            msg: 'media.cache-purge failed',
            status: response.status,
            count: urls.length,
          })
        );
        return false;
      }
    } catch (error) {
      if (attempt === ATTEMPTS) {
        // Class only: the error text can carry the request URL, which carries
        // the zone id.
        console.error(
          sanitizeForLog({
            msg: 'media.cache-purge failed',
            errorClass: error instanceof Error ? error.name : typeof error,
            count: urls.length,
          })
        );
        return false;
      }
    }
  }
  return false;
}

/**
 * Evicts public URLs from Cloudflare's edge cache.
 *
 * Called after an object has left the public bucket — a delete, an unpublish —
 * and never inside a transaction. Never throws: a failed batch is logged and
 * returned in `failed`, and the caller decides what a stale edge copy means
 * for its own marker. Unconfigured is a supported configuration and a no-op
 * with nothing failed — that deployment has accepted edge copies living out
 * their lifetime.
 */
export async function purgeUrls(
  urls: readonly string[]
): Promise<PurgeOutcome> {
  if (!CACHE_PURGE_CONFIGURED || urls.length === 0)
    return { attempted: 0, purged: 0, failed: [] };

  const giveUpAt = Date.now() + TOTAL_BUDGET_MS;
  let purged = 0;
  let abandoned = 0;
  const failed: string[] = [];
  for (let start = 0; start < urls.length; start += PURGE_BATCH_SIZE) {
    const batch = urls.slice(start, start + PURGE_BATCH_SIZE);
    const expired = Date.now() >= giveUpAt;
    if (expired) abandoned += batch.length;
    if (!expired && (await purgeBatch(batch))) purged += batch.length;
    else failed.push(...batch);
  }
  if (abandoned > 0)
    console.error(
      JSON.stringify({
        msg: 'media.cache-purge deadline reached',
        effect: 'rows keep their deleting marker; the sweep retries them',
        abandoned,
        budgetMs: TOTAL_BUDGET_MS,
      })
    );
  return { attempted: urls.length, purged, failed };
}
