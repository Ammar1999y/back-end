import type { DashboardPage } from '@/lib/permissions/constants';
import type { BucketType } from '@/lib/r2/client';

/**
 * One table that references `files.id`.
 *
 * A leaf module: `scripts/migrate.ts` reads this registry to check the referrer
 * contract against the catalog, and that script must run without a password
 * pepper keyring, a Turnstile secret or a session signing key — which importing
 * anything that reaches `@/db` would require.
 *
 * Every referrer MUST be declared here, and the integration tier proves it: a
 * foreign key to `files` that has no entry fails
 * `tests/integration/media-usages.test.ts`. The registry is what answers "used
 * by" for the details endpoint and the 409 on delete, and what decides whether
 * a file has a PUBLIC usage — the one fact that blocks `unpublish`.
 *
 * `table`/`column`/`idColumn` are identifiers from THIS file, never from a
 * request, which is what makes `sql.identifier` on them safe.
 */
export interface UsageSource {
  /** The referencing table, e.g. `project_images`. */
  table: string;
  /** Its `file_id` column. */
  column: string;
  /** The column that identifies the OWNER record, e.g. `project_id`. */
  idColumn: string;
  /** The dashboard page whose `view` grant lets a caller see this usage. */
  resource: DashboardPage;
  /** Whether owners reached through this source are published content. */
  visibility: BucketType;
  /** Shown to the caller in "used by" and in the delete refusal. */
  label: string;
}

/**
 * Empty in the starter kit. A project adds a row per owner table, e.g.
 *
 *   { table: 'projects', column: 'cover_image_id', idColumn: 'id',
 *     resource: 'projects', visibility: 'public', label: 'صورة مشروع' }
 */
export const USAGE_SOURCES: readonly UsageSource[] = [];

/**
 * `table.column` for every registered reference, the key
 * `referrerContractViolations` matches a catalog foreign key against.
 */
export const registeredFileColumns = (): ReadonlySet<string> =>
  new Set(USAGE_SOURCES.map((source) => `${source.table}.${source.column}`));
