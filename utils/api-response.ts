import { NextResponse } from 'next/server';

import { getConstraintName, isUniqueViolation, sanitizeForLog } from '@/utils';

import {
  HTTP_STATUS,
  MSG_EMAIL_EXISTS,
  MSG_INTERNAL_ERROR,
  MSG_INVALID_INPUT,
  MSG_PHONE_EXISTS,
} from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';

/** Parses request JSON body, throwing 400 instead of 500 on malformed JSON */
export async function parseJsonBody(
  request: Request
): Promise<Record<string, unknown>> {
  try {
    return await request.json();
  } catch {
    throw new CustomError(MSG_INVALID_INPUT, HTTP_STATUS.BAD_REQUEST);
  }
}

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
}

interface ApiErrorOptions {
  message: string;
  status?: number;
}

export function apiSuccess<T = unknown>({
  message,
  data = null as T,
  meta,
  status = HTTP_STATUS.OK,
}: ApiSuccessOptions<T>) {
  const body: Record<string, unknown> = { success: true, message, data };
  if (meta) body.meta = meta;
  return NextResponse.json(body, { status });
}

export function apiError({
  message,
  status = HTTP_STATUS.BAD_REQUEST,
}: ApiErrorOptions) {
  return NextResponse.json({ success: false, message, data: null }, { status });
}

/**
 * Handles the common catch-block pattern across all API endpoints.
 * Checks for unique violations, CustomError, and falls back to 500.
 */
export function handleApiError(
  error: unknown,
  fallbackMessage?: string,
  uniqueViolationMessage?: string
): NextResponse {
  if (uniqueViolationMessage && isUniqueViolation(error)) {
    return apiError({
      message: uniqueViolationMessage,
      status: HTTP_STATUS.CONFLICT,
    });
  }

  if (error instanceof CustomError) {
    return apiError({ message: error.message, status: error.status });
  }

  console.error(sanitizeForLog(error));
  return apiError({
    message: fallbackMessage ?? MSG_INTERNAL_ERROR,
    status: HTTP_STATUS.INTERNAL_ERROR,
  });
}

/**
 * Resolves unique violation message for user endpoints.
 * Matches against full index names defined in db/schema.ts (e.g. 'ux_users_email').
 */
export function resolveUserUniqueViolation(error: unknown): string {
  const constraintName = getConstraintName(error);
  if (constraintName.includes('ux_users_email')) return MSG_EMAIL_EXISTS;
  if (constraintName.includes('ux_users_phone_number')) return MSG_PHONE_EXISTS;
  return MSG_INTERNAL_ERROR;
}

/**
 * Resolves unique violation message for permission/role endpoints.
 * Maps constraint names to specific user-facing messages.
 */
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
