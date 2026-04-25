import * as z from 'zod';

import type { AuditAction } from '@/db/schema';
import type { WsTx } from '@/db/ws';

import { auditLogs } from '@/db/schema';
import { EntityID } from '@/types';

import type { HandlerInput } from '@/lib/http/contract';

// Max valid IP length: IPv6 mapped IPv4 = 45 chars
const MAX_IP_LENGTH = 45;
const IP_SCHEMA = z.union([z.ipv4(), z.ipv6()]);
// ⚠️ Changing this value requires generating a new migration to keep the DB in sync.
export const USER_AGENT_MAX = 512; 
const API_PATH_MAX = 255;

/**
 * Extracts the client IP from trusted proxy headers only.
 * Priority: cf-connecting-ip (Cloudflare) → x-vercel-forwarded-for (Vercel).
 * `x-forwarded-for` is intentionally NOT accepted — it is client-controllable
 * when the origin is directly reachable. Block direct-origin traffic at the
 * edge (Cloudflare-only ingress / firewall allowlist for Vercel).
 * TODO: set the right header to get the IP when deplay the app
 */
export function getClientIp(headers: Headers): string | null {
  const raw =
    headers.get('cf-connecting-ip') ??
    headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() ??
    null;

  if (!raw || raw.length > MAX_IP_LENGTH) return null;
  return IP_SCHEMA.safeParse(raw).success ? raw : null;
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

// Fields that must never appear in audit log data
const SENSITIVE_KEYS = new Set([
  'password',
  'token',
  'secret',
  'hashedPassword',
]);

// Hard cap for JSONB audit payloads. Anything bigger is replaced with a
// truncated marker so a buggy caller can't bloat the table.
const MAX_AUDIT_JSON_BYTES = 32_768;

function clampJson<T>(value: T): T | { _truncated: true; preview: string } {
  if (value == null) return value;
  const s = JSON.stringify(value);
  if (s.length <= MAX_AUDIT_JSON_BYTES) return value;
  return { _truncated: true, preview: s.slice(0, 1024) };
}

/** Strips sensitive fields from an object before storing in audit logs */
function stripSensitive<T extends Record<string, unknown>>(
  data: T
): Partial<T> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!SENSITIVE_KEYS.has(key)) safe[key] = value;
  }
  return safe as Partial<T>;
}

/** Computes only the fields that actually changed between old and new data */
function computeChangedFields(
  oldData: Record<string, unknown>,
  newData: Record<string, unknown>
): string[] {
  const changed: string[] = [];
  for (const key of Object.keys(newData)) {
    if (SENSITIVE_KEYS.has(key)) continue;
    const oldVal = JSON.stringify(oldData[key] ?? null);
    const newVal = JSON.stringify(newData[key] ?? null);
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
export async function auditLog(tx: WsTx, params: AuditLogParams) {
  const { userId, userEmail, action, tableName, recordId, meta } = params;

  const oldData = params.oldData ? stripSensitive(params.oldData) : null;
  const newData = params.newData ? stripSensitive(params.newData) : null;

  const changedFields =
    action === 'UPDATE' && oldData && newData
      ? computeChangedFields(
          oldData as Record<string, unknown>,
          newData as Record<string, unknown>
        )
      : null;

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
