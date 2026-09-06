import type { BucketType } from '@/lib/r2/client';

import { and, eq, gt, inArray, isNull } from 'drizzle-orm';

import { db } from '@/db';
import { files } from '@/db/schema';
import {
  ENABLED_VISIBILITIES,
  headObjectInR2,
  listObjectsInR2,
} from '@/lib/r2/client';

import { OBJECT_KEY_PREFIX } from './keys';

/** Enough to act on, not enough to flood a log line. */
const SAMPLE_SIZE = 20;
/** A ceiling on one run's listing, so a runaway bucket cannot pin the process. */
const MAX_LISTED_KEYS = 200_000;
/**
 * `HeadObject` calls one run may spend per bucket, on rows whose key is not
 * under the listed prefix and on absences the listing suggested. A suspect is
 * confirmed by its own HEAD before it is reported; beyond the budget it is
 * counted as unchecked rather than guessed.
 */
const MAX_HEAD_CHECKS = 200;
/** Settled rows held in memory at once while they are compared with the listing. */
const ROW_PAGE_SIZE = 1000;

interface BucketReport {
  bucket: BucketType;
  listed: number;
  /** Objects with no row at all — a put whose row insert never committed, or a manual upload. */
  orphanObjects: { count: number; sample: string[] };
  /** Objects whose row names the OTHER bucket and is not mid-transition — a cleanup that never ran. */
  staleCopies: { count: number; sample: string[] };
  /** Settled active rows naming this bucket whose object a HEAD confirmed missing. */
  danglingRows: { count: number; sample: string[] };
  /** Rows this run could not check: the listing was cut short, or the HEAD budget ran out. */
  unchecked: number;
  truncated: boolean;
}

export interface ReconcileReport {
  buckets: BucketReport[];
  durationMs: number;
}

function sampled(keys: readonly string[]) {
  return { count: keys.length, sample: keys.slice(0, SAMPLE_SIZE) };
}

/**
 * The settled rows of one bucket that deserve a `HeadObject`, and how many rows
 * this run left unchecked.
 *
 * Keyset pages rather than one unbounded `SELECT`: the comparison is against a
 * key set already capped by `MAX_LISTED_KEYS`, so paging bounds what a weekly
 * job sharing the process with live traffic holds at once, without making the
 * dangling verdict partial the way a truncated row query would. Suspects are
 * capped at the HEAD budget, since only a confirmed absence is ever reported.
 */
async function suspectKeys(
  bucket: BucketType,
  listed: ReadonlySet<string>,
  truncated: boolean
): Promise<{ suspects: string[]; unchecked: number }> {
  const suspects: string[] = [];
  let unchecked = 0;
  let after: string | null = null;
  for (;;) {
    const settled: { id: string; r2Key: string }[] = await db
      .select({ id: files.id, r2Key: files.r2Key })
      .from(files)
      .where(
        and(
          eq(files.bucketType, bucket),
          eq(files.status, 'active'),
          isNull(files.transition),
          after === null ? undefined : gt(files.id, after)
        )
      )
      .orderBy(files.id)
      .limit(ROW_PAGE_SIZE);

    for (const { r2Key } of settled) {
      // A key outside the prefix cannot be compared with the listing at all;
      // one inside it is comparable only when the listing was complete.
      const comparable = r2Key.startsWith(OBJECT_KEY_PREFIX);
      if (comparable && truncated) unchecked += 1;
      else if (!comparable || !listed.has(r2Key)) {
        if (suspects.length < MAX_HEAD_CHECKS) suspects.push(r2Key);
        else unchecked += 1;
      }
    }

    if (settled.length < ROW_PAGE_SIZE) break;
    after = settled.at(-1)?.id ?? null;
    if (after === null) break;
  }
  return { suspects, unchecked };
}

/**
 * Read-only drift report between the two buckets and `files`. Nothing is
 * deleted here: an orphan object may be a request one second from committing
 * its row, and the report is what a human acts on.
 *
 * The listing covers the application's prefix; the row side is the rows whose
 * object must exist — `active`, no transition in flight. A `pending` row is the
 * sweep's business (its object may not be written yet, or may never be), and a
 * `deleting` row's object is on its way out. Rows whose key predates the prefix
 * cannot be compared with the listing and are checked one by one.
 */
export async function reconcileObjectStore(
  startedAt = Date.now()
): Promise<ReconcileReport> {
  const reports: BucketReport[] = [];

  for (const bucket of ENABLED_VISIBILITIES) {
    const listed = new Set<string>();
    const orphans: string[] = [];
    const stale: string[] = [];
    let truncated = false;
    let token: string | undefined;

    do {
      const page = await listObjectsInR2({
        bucketType: bucket,
        prefix: OBJECT_KEY_PREFIX,
        continuationToken: token,
      });
      const keys = page.objects.map((object) => object.key);
      for (const key of keys) listed.add(key);

      if (keys.length > 0) {
        const rows = await db
          .select({
            r2Key: files.r2Key,
            bucketType: files.bucketType,
            transition: files.transition,
          })
          .from(files)
          .where(inArray(files.r2Key, keys));
        const byKey = new Map(rows.map((row) => [row.r2Key, row]));
        for (const key of keys) {
          const row = byKey.get(key);
          if (!row) orphans.push(key);
          else if (row.transition === null && row.bucketType !== bucket)
            stale.push(key);
        }
      }

      token = page.nextContinuationToken ?? undefined;
      if (token && listed.size >= MAX_LISTED_KEYS) {
        truncated = true;
        token = undefined;
      }
    } while (token);

    const { suspects, unchecked } = await suspectKeys(
      bucket,
      listed,
      truncated
    );

    const dangling: string[] = [];
    for (const key of suspects)
      if ((await headObjectInR2({ key, bucketType: bucket })) === null)
        dangling.push(key);

    reports.push({
      bucket,
      listed: listed.size,
      orphanObjects: sampled(orphans),
      staleCopies: sampled(stale),
      danglingRows: sampled(dangling),
      unchecked,
      truncated,
    });
  }

  return { buckets: reports, durationMs: Date.now() - startedAt };
}
