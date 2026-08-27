import type { Tx } from '@/db';
import type { AuditAction } from '@/db/schema';
import type { HandlerInput } from '@/lib/http/contract';
import type { EntityID } from '@/types';

import { auditLogs } from '@/db/schema';
import * as z from 'zod';

import { API_PATH_MAX, USER_AGENT_MAX } from './audit/constants';

// Max valid IP length: IPv6 mapped IPv4 = 45 chars
const MAX_IP_LENGTH = 45;
const IP_SCHEMA = z.union([z.ipv4(), z.ipv6()]);
// Re-exported from a leaf module so db/schema.ts can import these without
// reaching back into lib/audit.ts → a Turbopack-breaking import cycle.
export { API_PATH_MAX, USER_AGENT_MAX } from './audit/constants';

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

/**
 * The identifier used when no trusted header is present AND this is a
 * development process.
 *
 * Not a security hole, and the reason is structural: `NODE_ENV` is now validated
 * against exactly `development` / `test` / `production` in `server.ts` before any
 * application module loads, so this branch cannot be reached by a misspelt or
 * absent value the way the production guards previously could be.
 *
 * Without it, every `preAuthIpLimit` route answers 503 on a developer machine —
 * `ipIdentifier` fails closed by design — which made local dashboard work
 * impossible and pushed towards weakening the production rule instead.
 */
const DEVELOPMENT_FALLBACK_IP = '127.0.0.1';

/**
 * Extracts the client IP from trusted proxy headers only.
 *
 * `x-forwarded-for` is intentionally NOT accepted — it is client-controllable
 * when the origin is directly reachable. Block direct-origin traffic at the
 * edge (Cloudflare-only ingress).
 *
 * TODO(proxy-trust): see the note on TRUSTED_IP_HEADERS.
 */
export function getClientIp(headers: Headers): string | null {
  const raw = headers.get(TRUSTED_IP_HEADERS[0]);

  if (raw && raw.length <= MAX_IP_LENGTH && IP_SCHEMA.safeParse(raw).success)
    return raw;

  return process.env.NODE_ENV === 'development'
    ? DEVELOPMENT_FALLBACK_IP
    : null;
}

/** Extract request-scoped metadata used by audit logs from a HandlerInput. */
export function getAuditMeta(ctx: HandlerInput): {
  ip: string | null;
  userAgent: string | null;
  apiPath: string;
} {
  return {
    ip: ctx.ip || null,
    userAgent: ctx.userAgent?.slice(0, USER_AGENT_MAX) ?? null,
    apiPath: ctx.apiPath.slice(0, API_PATH_MAX),
  };
}

/**
 * Key fragments whose values must never be stored in an audit row.
 *
 * Fragments, not exact names: the previous exact set (`password`, `token`,
 * `secret`, `hashedPassword`) let `newPassword`, `currentPassword` and
 * `sessionToken` straight through — the same blacklist-too-narrow failure the
 * log serializer had. Matched against a normalised key so `new_password` and
 * `newPassword` behave alike.
 *
 * Still a net, not a boundary: a secret inside a free-text value is invisible
 * to it. Callers pass explicit, named fields; nothing here licenses handing
 * this function a credential.
 */
const SENSITIVE_KEY_FRAGMENTS = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'credential',
  'pepper',
  'apikey',
  'privatekey',
  'passphrase',
  'signature',
  'authorization',
  'cookie',
  'bearer',
  'jwt',
  'salt',
  'hash',
];

/**
 * Is this key/value pair a secret?
 *
 * Two rules, in order, replacing what was a fragment denylist plus a hand-kept
 * list of exceptions:
 *
 * 1. **A boolean is never a secret.** `true`/`false` cannot carry a credential,
 *    so a flag ABOUT one is safe by construction. The denylist could not tell
 *    `password` from `passwordChanged`, and because it dropped the flag from
 *    `oldData`, `newData` and `changedFields` alike, an admin resetting a
 *    password produced an audit row with no trace of it — as did every
 *    `passwordHashUpgraded` and `passwordlessProofVerified` event. Adding two
 *    names fixed two reports; this rule fixes the class, including flags nobody
 *    has written yet.
 * 2. **`safeFields`, declared by the event.** Non-boolean metadata whose name
 *    mentions a credential — a pepper VERSION id, not the pepper — is named by
 *    the call site that knows the shape of its own event. Generic redaction then
 *    only has to be defense in depth for everything not declared.
 *
 * Anything else still falls to the fragment denylist.
 */
function isSensitiveAuditKey(
  key: string,
  value: unknown,
  safeFields?: ReadonlySet<string>
): boolean {
  if (typeof value === 'boolean') return false;
  if (safeFields?.has(key)) return false;
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment)
  );
}

// Cap for JSONB audit payloads, in JSON *characters* (not UTF-8 bytes — Arabic
// text costs 2 bytes per character, so the stored row can be ~2x this). Anything
// bigger is replaced with a truncated marker so a buggy caller can't bloat the
// table.
const MAX_AUDIT_JSON_CHARS = 32_768;
/** Guard against a pathological nested payload; audit data is 2–3 deep. */
const MAX_AUDIT_DEPTH = 6;

/**
 * Bound a value for a `jsonb` column, and hand back one the driver will accept.
 *
 * The re-parse is not a formality. `redactValue` builds every level with
 * `Object.create(null)`, and Drizzle's `is()` — run on every value passed to
 * `.values()` — reads `Object.getPrototypeOf(value).constructor`, which throws
 * on a null prototype. Every audited write was a `TypeError` (reproduced on
 * `drizzle-orm@0.45.2`), including the one on the login-success path.
 *
 * It re-parses rather than spreading because this also runs on `changedFields`,
 * an array: `{ ...['a', 'b'] }` is `{ 0: 'a', 1: 'b' }`, so a spread would
 * quietly store that column as an object. Re-parsing is also indifferent to how
 * deeply the driver inspects — `is()` reads only the top level today, which is
 * an implementation detail and not a contract. What is stored does not change:
 * the driver JSON-serializes the value anyway, so this round trip is an identity
 * on the column — which is also why the cast is safe.
 */
function clampJson<T>(value: T): T | { _truncated: true; preview: string } {
  if (value == null) return value;
  const s = JSON.stringify(value);
  if (s.length <= MAX_AUDIT_JSON_CHARS) return JSON.parse(s) as T;
  return { _truncated: true, preview: s.slice(0, 1024) };
}

/**
 * Removes sensitive fields at every level, within a fixed work budget.
 *
 * Recursive because a shallow pass only protected top-level keys — a secret
 * nested inside `{ payload: { password } }` was stored verbatim.
 *
 * The node budget bounds the WORK, not just the output — and it has to STOP the
 * traversal to do that, which the first version did not:
 *
 * - `value.map(...)` visited every element of a 100k array regardless of budget;
 * - `Object.entries(value)` materialised every key AND read every value, running
 *   any getters, before the budget was consulted;
 * - the loop then kept going, writing `[budget-limit]` once per remaining key.
 *
 * So the output was bounded while the work was not. Iteration now breaks at the
 * limit and leaves a single marker. `for...in` + `hasOwn` is lazy where
 * `Object.entries` is eager, and it keeps inherited keys out.
 */
const MAX_AUDIT_NODES = 2000;
const BUDGET_MARKER = '_truncated';

function redactValue(
  value: unknown,
  depth: number,
  budget: { nodes: number },
  safeFields?: ReadonlySet<string>
): unknown {
  if (budget.nodes <= 0) return '[budget-limit]';
  budget.nodes -= 1;
  if (depth >= MAX_AUDIT_DEPTH) return '[depth-limit]';

  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      if (budget.nodes <= 0) {
        items.push('[budget-limit]');
        break;
      }
      items.push(redactValue(item, depth + 1, budget, safeFields));
    }
    return items;
  }

  if (value === null || typeof value !== 'object') return value;

  // Prototype-free: `safe['__proto__'] = v` on a plain object mutates the
  // prototype instead of recording a key, so the field would silently vanish.
  const safe: Record<string, unknown> = Object.create(null);
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (budget.nodes <= 0) {
      safe[BUDGET_MARKER] = true;
      break;
    }
    // Read only after the budget check — the read itself is the expensive part
    // when the property is a getter.
    const item = (value as Record<string, unknown>)[key];
    if (isSensitiveAuditKey(key, item, safeFields)) continue;
    safe[key] = redactValue(item, depth + 1, budget, safeFields);
  }
  return safe;
}

function stripSensitive<T extends Record<string, unknown>>(
  data: T,
  safeFields?: ReadonlySet<string>
): Partial<T> {
  return redactValue(
    data,
    0,
    { nodes: MAX_AUDIT_NODES },
    safeFields
  ) as Partial<T>;
}

/**
 * Fields that actually changed between old and new data.
 *
 * `metadataFields` are excluded: an event's own bookkeeping (`auditVersion`,
 * `forUserId`, `changedPermissions`) is not business state, and counting it
 * made every permission event report metadata as a changed field — and an
 * event whose only "changes" were metadata look like a real mutation.
 */
function computeChangedFields(
  oldData: Record<string, unknown>,
  newData: Record<string, unknown>,
  metadataFields?: readonly string[],
  safeFields?: ReadonlySet<string>
): string[] {
  const skip = new Set(metadataFields);
  const changed: string[] = [];
  for (const [key, newValue] of Object.entries(newData)) {
    if (
      newValue === undefined ||
      skip.has(key) ||
      isSensitiveAuditKey(key, newValue, safeFields)
    )
      continue;
    const oldVal = JSON.stringify(oldData[key] ?? null);
    const newVal = JSON.stringify(newValue ?? null);
    if (oldVal !== newVal) changed.push(key);
  }
  return changed;
}

interface AuditLogParams {
  userId: EntityID;
  userEmail: string;
  action: AuditAction;
  tableName: string;
  recordId: EntityID;
  oldData?: Record<string, unknown> | null;
  newData?: Record<string, unknown> | null;
  /**
   * Keys in `oldData`/`newData` that describe the EVENT rather than the record
   * (`auditVersion`, `forUserId`, `changedPermissions`). Excluded from
   * `changedFields` so it only ever lists real business changes.
   */
  metadataFields?: readonly string[];
  /**
   * Keys this event declares non-secret despite matching the generic denylist —
   * a pepper VERSION id, for instance, which is metadata about a credential and
   * not the credential. Booleans never need listing here; see
   * `isSensitiveAuditKey`.
   */
  safeFields?: readonly string[];
  /**
   * Skip the insert when an UPDATE turns out to have changed nothing.
   *
   * A custom-permissions-only edit still ran the users UPDATE event, storing a
   * row with `changedFields: []` beside the roles event that carried the real
   * change — noise that makes a genuine no-change event indistinguishable from a
   * real one during an investigation. Opt-in, because "no changed business
   * fields" is meaningful for some events and not others.
   */
  skipIfUnchanged?: boolean;
  /** Request metadata (from `getAuditMeta(ctx)`). */
  meta: { ip: string | null; userAgent: string | null; apiPath: string };
}

/**
 * Inserts an audit log entry within the given transaction.
 * Must be called inside the same transaction as the mutation to guarantee atomicity.
 *
 * TODO: stream entries to an external append-only sink (e.g. S3 Object Lock,
 * BigQuery, CloudWatch Logs) so an attacker with DB access can't erase their
 * trail. Not urgent — production-maturity item.
 */
export async function auditLog(tx: Tx, params: AuditLogParams) {
  const { userId, userEmail, action, tableName, recordId, meta } = params;

  const safeFields = params.safeFields ? new Set(params.safeFields) : undefined;

  const oldData = params.oldData
    ? stripSensitive(params.oldData, safeFields)
    : null;
  const newData = params.newData
    ? stripSensitive(params.newData, safeFields)
    : null;

  const changedFields =
    action === 'UPDATE' && oldData && newData
      ? computeChangedFields(
          oldData as Record<string, unknown>,
          newData as Record<string, unknown>,
          params.metadataFields,
          safeFields
        )
      : null;

  // Only when both sides were supplied — `changedFields` is null (not empty)
  // when the caller gave no before/after pair, and that is not a no-op.
  if (params.skipIfUnchanged && changedFields?.length === 0) return;

  await tx.insert(auditLogs).values({
    userId,
    userEmail,
    action,
    tableName,
    recordId,
    oldData: oldData ? clampJson(oldData) : null,
    newData: newData ? clampJson(newData) : null,
    changedFields: changedFields ? clampJson(changedFields) : null,
    ipAddress: meta.ip,
    userAgent: meta.userAgent,
    apiPath: meta.apiPath,
  });
}
