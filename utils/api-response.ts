import { getConstraintName, isUniqueViolation, sanitizeForLog } from '@/utils';

import {
  HTTP_STATUS,
  MSG_EMAIL_EXISTS,
  MSG_INTERNAL_ERROR,
  MSG_INVALID_INPUT,
  MSG_PHONE_EXISTS,
} from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';

import type { HandlerOutput } from '@/lib/http/contract';

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
}

interface ApiErrorOptions {
  message: string;
  status?: number;
  headers?: Record<string, string>;
}

/**
 * Parses a JSON body from a web `Request`, throwing a 400 CustomError on
 * malformed JSON. Kept for handlers that still accept raw Request, but
 * the standard flow is for the adapter to pre-parse into `ctx.body`.
 */
export async function parseJsonBody(
  request: Request
): Promise<Record<string, unknown>> {
  try {
    return await request.json();
  } catch {
    throw new CustomError(MSG_INVALID_INPUT, HTTP_STATUS.BAD_REQUEST);
  }
}

/**
 * Narrow `ctx.body` to a plain object. Throws 400 if the body is missing
 * or not a JSON object — matches prior `parseJsonBody` behaviour.
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
 * Common catch-block converter. Maps known error types to a HandlerOutput
 * so the adapter can emit a framework-specific response.
 */
export function handleApiError(
  error: unknown,
  fallbackMessage?: string,
  uniqueViolationMessage?: string
): HandlerOutput<null> {
  if (uniqueViolationMessage && isUniqueViolation(error)) {
    return apiError({
      message: uniqueViolationMessage,
      status: HTTP_STATUS.CONFLICT,
    });
  }

  if (error instanceof CustomError) {
    const extraHeaders = (error as CustomError & {
      responseHeaders?: Record<string, string>;
    }).responseHeaders;
    return apiError({
      message: error.message,
      status: error.status,
      ...(extraHeaders && { headers: extraHeaders }),
    });
  }

  console.error(sanitizeForLog(error));
  return apiError({
    message: fallbackMessage ?? MSG_INTERNAL_ERROR,
    status: HTTP_STATUS.INTERNAL_ERROR,
  });
}

/** Resolves unique-violation message for user endpoints. */
export function resolveUserUniqueViolation(error: unknown): string {
  const constraintName = getConstraintName(error);
  if (constraintName.includes('ux_users_email')) return MSG_EMAIL_EXISTS;
  if (constraintName.includes('ux_users_phone_number')) return MSG_PHONE_EXISTS;
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
