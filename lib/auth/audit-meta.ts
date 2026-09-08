import type { GenericEndpointContext } from '@better-auth/core';

import { API_PATH_MAX, getClientIp, USER_AGENT_MAX } from '@/lib/audit';

export function authAuditMeta(
  ctx: Pick<GenericEndpointContext, 'headers' | 'request' | 'path'>,
  path = ctx.path ?? '/auth'
) {
  const headers = ctx.headers ?? ctx.request?.headers ?? new Headers();
  return {
    ip: getClientIp(headers),
    userAgent: headers.get('user-agent')?.slice(0, USER_AGENT_MAX) ?? null,
    apiPath: path.slice(0, API_PATH_MAX),
  };
}
