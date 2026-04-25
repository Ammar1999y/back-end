import { getConstraintName, sanitizeForLog } from '@/utils';

import {
  HTTP_STATUS,
  MSG_EMAIL_EXISTS,
  MSG_INTERNAL_ERROR,
  MSG_INVALID_INPUT,
  MSG_PHONE_EXISTS,
} from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';

import type { HandlerCookie, HandlerOutput } from '@/lib/http/contract';

export interface PaginationMeta {
  page: number;
  perPage: number;
  total: number;
  pageCount: number;
}

interface ApiSuccessOptions<T = unknown> {
  message: string;
  data?: T;
  meta?: PaginationMeta;
  status?: number;
  headers?: Record<string, string>;
  cookies?: HandlerCookie[];
}

interface ApiErrorOptions {
  message: string;
  status?: number;
  headers?: Record<string, string>;
}


/**
 * Narrow `ctx.body` to a plain object. Throws 400 if the body is missing
 * or not a JSON object
 */
export function requireJsonBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new CustomError(MSG_INVALID_INPUT, HTTP_STATUS.BAD_REQUEST);
  return body as Record<string, unknown>;
}

export function apiSuccess<T = unknown>({
  message,
  data = null as T,
  meta,
  status = HTTP_STATUS.OK,
  headers,
  cookies,
}: ApiSuccessOptions<T>): HandlerOutput<T> {
  return {
    status,
    body: {
      success: true,
      message,
      data,
      ...(meta && { meta }),
    },
    ...(headers && { headers }),
    ...(cookies && { cookies }),
  };
}

export function apiError({
  message,
  status = HTTP_STATUS.BAD_REQUEST,
  headers,
}: ApiErrorOptions): HandlerOutput<null> {
  return {
    status,
    body: { success: false, message, data: null },
    ...(headers && { headers }),
  };
}

/**
 * Read `responseHeaders` off an unknown error shape (CustomError or any
 * object carrying the field) without pulling in the class at the call site.
 */
export function getErrorHeaders(
  error: unknown
): Record<string, string> | undefined {
  if (error && typeof error === 'object' && 'responseHeaders' in error) {
    return (error as { responseHeaders?: Record<string, string> })
      .responseHeaders;
  }
  return undefined;
}

/**
 * Common catch-block converter. Maps known error types to a HandlerOutput
 * so the adapter can emit a framework-specific response.
 *
 * Pass `extraHeaders` when a catch block rewrites an error into a new
 * `CustomError` and still needs outbound headers (Retry-After, rate-limit,
 * idempotency, ...) that were attached to the original error.
 */
export function handleApiError(
  error: unknown,
  fallbackMessage?: string,
  extraHeaders?: Record<string, string>
): HandlerOutput<null> {
  if (error instanceof CustomError) {
    const errorHeaders = error.responseHeaders;
    const headers =
      errorHeaders || extraHeaders
        ? { ...extraHeaders, ...errorHeaders }
        : undefined;
    return apiError({
      message: error.message,
      status: error.status,
      ...(headers && { headers }),
    });
  }

  console.error(sanitizeForLog(error));
  return apiError({
    message: fallbackMessage ?? MSG_INTERNAL_ERROR,
    status: HTTP_STATUS.INTERNAL_ERROR,
    ...(extraHeaders && { headers: extraHeaders }),
  });
}

/** Resolves unique-violation message for user endpoints. */
export function resolveUserUniqueViolation(error: unknown): string {
  const constraintName = getConstraintName(error);
  if (constraintName.includes('ux_users_email')) return MSG_EMAIL_EXISTS;
  if (constraintName.includes('ux_users_phone_number')) return MSG_PHONE_EXISTS;
  console.error('Unknown unique violation:', sanitizeForLog({ constraintName, error }));
  return MSG_INTERNAL_ERROR;
}

/** Resolves unique-violation message for permission/role endpoints. */
export function resolvePermissionUniqueViolation(
  error: unknown,
  messages: {
    nameExists: string;
    duplicatePagePermission: string;
    fallback: string;
  }
): string {
  const constraintName = getConstraintName(error);
  if (constraintName.includes('ux_roles_role_name')) return messages.nameExists;
  if (constraintName.includes('ux_role_permissions_role_page'))
    return messages.duplicatePagePermission;
  return messages.fallback;
}
