import { withTransaction } from '@/db';
import { sanitizeForLog } from '@/utils';
import { auditLog } from '@/lib/audit';

/**
 * Records that a just-issued session was withdrawn before its cookie shipped.
 *
 * Best-effort and swallowed: the caller is already rethrowing the failure that
 * caused it, and a second fault here must not replace that one. A missing
 * compensating row leaves the same gap this closes, which is why it is logged.
 */
export async function recordAbandonedSession(params: {
  userId: string;
  userEmail: string;
  sessionId: string;
  auditMeta: { ip: string | null; userAgent: string | null; apiPath: string };
  reason?:
    | 'cookie_delivery_failed'
    | 'post_commit_admission_failed'
    | 'result_delivery_failed';
}): Promise<void> {
  try {
    await withTransaction((tx) =>
      auditLog(tx, {
        userId: params.userId,
        userEmail: params.userEmail,
        action: 'DELETE',
        tableName: 'sessions',
        recordId: params.sessionId,
        oldData: { loginSuccess: true },
        newData: {
          sessionAbandoned: true,
          reason: params.reason ?? 'cookie_delivery_failed',
        },
        meta: params.auditMeta,
      })
    );
  } catch (error) {
    console.error(
      sanitizeForLog({
        msg: 'auth.abandonedSessionAudit.failed',
        userId: params.userId,
        sessionId: params.sessionId,
        error,
      })
    );
  }
}
