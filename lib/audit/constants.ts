// Limits shared between the audit log and the DB schema column definitions.
// Extracted into its own module so `db/schema.ts` can import these without
// pulling in `lib/audit.ts`, which itself imports tables from `db/schema.ts`
// — a cycle that breaks Turbopack module init order under
// `/api/dash/.../[id]` routes.
//
// ⚠️ Changing these values requires generating a new migration to keep the DB
// column lengths in sync.
export const USER_AGENT_MAX = 512;
export const API_PATH_MAX = 2048;
