// Limits shared between the audit log and the DB schema column definitions.
// Extracted into its own module so `db/schema.ts` can import these without
// pulling in `lib/audit.ts`, which itself imports tables from `db/schema.ts`
// — an import cycle.
//
// ⚠️ Changing these values requires generating a new migration to keep the DB
// column lengths in sync.
export const USER_AGENT_MAX = 512;
export const API_PATH_MAX = 2048;
