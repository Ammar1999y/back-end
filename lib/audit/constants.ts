// Limits shared between the audit log and the DB schema column definitions.
// Extracted into its own module so `db/schema.ts` can import these without
// pulling in `lib/audit.ts`, which itself imports tables from `db/schema.ts`
// — an import cycle.
//
// ⚠️ Changing these values requires generating a new migration to keep the DB
// column lengths in sync.
export const USER_AGENT_MAX = 512;
export const API_PATH_MAX = 2048;

/**
 * Trusted edge headers. Shared with Better Auth
 * (`advanced.ipAddress.ipAddressHeaders`) so every IP-derived decision in the
 * app — our limiters, Better Auth's limiter, and session IP metadata — reads
 * the same source instead of Better Auth defaulting to `x-forwarded-for`.
 *
 * `x-vercel-forwarded-for` was removed with the framework: there is no Vercel in
 * this deployment, and a trusted-header entry nothing sets is pure attack
 * surface — a forged value would have been accepted on syntax alone.
 *
 * TODO(proxy-trust): the value here is accepted on SYNTAX alone; nothing checks
 * that the socket peer is the expected upstream, so a request that reaches the
 * origin directly can forge it. Resolution is deferred until the edge is final
 * (the correct TRUSTED_PROXY_CIDRS are not knowable before then) — see
 * reports/should-ignore.md #63 and finding 14 of
 * reports/elysia-migration-review-final.md. `server.requestIP(request)` is the
 * mechanism; it asserts the PROXY, and does not replace this header rule.
 */
export const TRUSTED_IP_HEADERS = ['cf-connecting-ip'] as const;
