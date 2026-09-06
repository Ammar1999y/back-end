/**
 * Every object this application stores lives under this prefix, in either
 * bucket. Reconciliation lists it; nothing else in the bucket is ours.
 */
export const OBJECT_KEY_PREFIX = 'm/';

/**
 * `m/<yyyy>/<mm>/<file id>.<ext>` — opaque, immutable, identical in both
 * buckets. No filename (it would go stale on the first rename and leak the
 * uploader's name into every public URL) and no entity prefix (an owner created
 * in the same form as the upload has no id yet).
 *
 * The id is the row's primary key, so two objects cannot share a key without a
 * primary-key collision first; the year/month is a listing convenience for a
 * human in the Cloudflare console, not a partition anything reads.
 */
export function objectKey(
  fileId: string,
  extension: string,
  now = new Date()
): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${OBJECT_KEY_PREFIX}${year}/${month}/${fileId}.${extension}`;
}
