import type { FileKind } from '@/db/schema';
import type { DashboardPage } from '@/lib/permissions/constants';
import type { BucketType } from '@/lib/r2/client';

/**
 * What an upload through `POST /api/upload/file` is FOR, declared in code.
 *
 * The client names a purpose; the purpose decides the bucket and the admitted
 * kinds. No request parameter ever names a bucket — that is the whole point.
 * An upload through a `public` purpose is written straight to the public bucket
 * (one write; copying on save would add a round trip per file to every save,
 * and an abandoned pending upload is unguessable and swept within a day).
 */
export interface UploadPurpose {
  visibility: BucketType;
  kinds: readonly FileKind[];
}

/**
 * The policy an upload with no `purpose` gets: private, any admitted kind. It
 * is also the policy every visitor-facing upload a project adds should start
 * from — nothing a user does at upload time can make a file public.
 */
export const DEFAULT_UPLOAD_PURPOSE: UploadPurpose = {
  visibility: 'private',
  kinds: ['image', 'document'],
};

/**
 * Named purposes per dashboard page. Empty in the starter kit; a project adds
 * one entry per owner field, e.g.
 *
 *   projects: { cover: { visibility: 'public', kinds: ['image'] } }
 *
 * and lists the matching referrer in `lib/media/usages.ts`.
 * `tests/integration/media-usages.test.ts` checks that every purpose has a
 * source with the same resource and visibility, and every source a purpose.
 */
export const UPLOAD_PURPOSES: Readonly<
  Partial<Record<DashboardPage, Readonly<Record<string, UploadPurpose>>>>
> = {};

export const PURPOSE_NAME_MAX = 50;
/** One segment, ASCII, so it can travel in a query string without encoding. */
export const PURPOSE_NAME_PATTERN = '^[a-z][a-zA-Z0-9_-]{0,49}$';
const PURPOSE_NAME = new RegExp(PURPOSE_NAME_PATTERN);

/**
 * The purpose for a request, or `null` when it names one that does not exist.
 * `Object.hasOwn` on both levels: a purpose called `constructor` must not
 * resolve to a function.
 */
export function resolveUploadPurpose(
  resource: DashboardPage,
  purpose: string | null
): UploadPurpose | null {
  if (purpose === null) return DEFAULT_UPLOAD_PURPOSE;
  if (!PURPOSE_NAME.test(purpose)) return null;
  const page = Object.hasOwn(UPLOAD_PURPOSES, resource)
    ? UPLOAD_PURPOSES[resource]
    : undefined;
  if (!page || !Object.hasOwn(page, purpose)) return null;
  return page[purpose] ?? null;
}
