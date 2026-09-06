import { sanitizeForLog } from '@/utils';

const ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const TOKEN = process.env.CLOUDFLARE_CACHE_PURGE_TOKEN;

/** Both variables, or neither — `lib/env.server.ts` refuses the half-set state. */
export const CACHE_PURGE_CONFIGURED = Boolean(ZONE_ID && TOKEN);

/** The API's per-call ceiling for purge-by-URL. */
export const PURGE_BATCH_SIZE = 30;
const DEADLINE_MS = 10_000;
const ATTEMPTS = 2;

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

  let purged = 0;
  const failed: string[] = [];
  for (let start = 0; start < urls.length; start += PURGE_BATCH_SIZE) {
    const batch = urls.slice(start, start + PURGE_BATCH_SIZE);
    if (await purgeBatch(batch)) purged += batch.length;
    else failed.push(...batch);
  }
  return { attempted: urls.length, purged, failed };
}
