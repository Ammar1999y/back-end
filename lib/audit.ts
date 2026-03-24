import type { AuditAction } from '@/db/schema';
import type { WsTx } from '@/db/ws';

import { auditLogs } from '@/db/schema';
import { EntityID } from '@/types';

// Max valid IP length: IPv6 mapped IPv4 = 45 chars
const MAX_IP_LENGTH = 45;
// Block injection: only allow hex digits, dots, colons (valid IP chars)
const IP_PATTERN = /^[\da-fA-F.:]+$/;

/**
 * Extracts the client IP from trusted proxy headers.
 * Priority: cf-connecting-ip (Cloudflare) → x-vercel-forwarded-for (Vercel) → x-forwarded-for (generic)
 * Validates the IP to prevent header injection in audit logs.
 */
function getClientIp(headers: Headers): string | null {
  const raw =
    headers.get('cf-connecting-ip') ??
    headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() ??
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    null;

  if (!raw || raw.length > MAX_IP_LENGTH || !IP_PATTERN.test(raw))
    return null;
  return raw;
}

// Fields that must never appear in audit log data
const SENSITIVE_KEYS = new Set([
  'password',
  'token',
  'secret',
  'hashedPassword',
]);

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
  request: Request;
}

/**
 * Inserts an audit log entry within the given transaction.
 * Must be called inside the same transaction as the mutation to guarantee atomicity.
 */
export async function auditLog(tx: WsTx, params: AuditLogParams) {
  const { userId, userEmail, action, tableName, recordId, request } = params;

  const oldData = params.oldData ? stripSensitive(params.oldData) : null;
  const newData = params.newData ? stripSensitive(params.newData) : null;

  const changedFields =
    action === 'UPDATE' && oldData && newData
      ? computeChangedFields(
          oldData as Record<string, unknown>,
          newData as Record<string, unknown>
        )
      : null;

  const url = new URL(request.url);

  const ipAddress = getClientIp(request.headers);

  await tx.insert(auditLogs).values({
    userId,
    userEmail,
    action,
    tableName,
    recordId,
    oldData,
    newData,
    changedFields,
    ipAddress,
    userAgent: request.headers.get('user-agent')?.slice(0, 2000) ?? null,
    apiPath: url.pathname,
  });
}
