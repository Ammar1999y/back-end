import type { HandlerCookie, HandlerOutput } from '@/lib/http/contract';

import {
  getConstraintName,
  isForeignKeyViolation,
  isUniqueViolation,
  sanitizeForLog,
} from '@/utils';

import {
  HTTP_STATUS,
  MSG_EMAIL_EXISTS,
  MSG_INTERNAL_ERROR,
  MSG_INVALID_INPUT,
  MSG_PHONE_EXISTS,
} from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';

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

/**
 * Response whose body is NOT the standard envelope.
 *
 * Only for endpoints whose shape is fixed by an external consumer — the Coolify
 * health check and the scheduled sweep task both read specific top-level
 * fields, so wrapping them would break a deployment rather than a client we
 * control. Everything reachable by an API client uses `apiSuccess`/`apiError`.
 */
export function apiRaw({
  body,
  status = HTTP_STATUS.OK,
  headers,
}: {
  body: unknown;
  status?: number;
  headers?: Record<string, string>;
}): HandlerOutput<never> {
  return {
    status,
    body: { raw: body },
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
 * Read `responseHeaders` off an unknown error shape (CustomError or any
 * object carrying the field) without pulling in the class at the call site.
 */
function getErrorHeaders(error: unknown): Record<string, string> | undefined {
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

/**
 * An unrecognized unique constraint is a code/schema mismatch, not something
 * the client can correct. Log it with the constraint name so monitoring can
 * find it, and let the caller fall through to the standard 500 — reporting it
 * as a 409 would hide a server bug behind a client-error status.
 */
function reportUnknownUniqueViolation(scope: string, error: unknown): null {
  // Constraint + scope only. The caller falls through to `handleApiError`,
  // which logs the full error a moment later — including it here would just
  // duplicate the payload on every occurrence.
  console.error(
    sanitizeForLog({
      msg: 'db.unknownUniqueViolation',
      scope,
      constraint: getConstraintName(error) || '(none)',
    })
  );
  return null;
}

/**
 * Resolves the 409 message for user endpoints.
 * Returns `null` when the constraint is not a known, user-correctable one.
 */
// Exact names, not substrings: `includes()` would classify any constraint
// whose name merely CONTAINS a known one — an `archive_ux_users_email_copy`
// added later would be reported to the client as an email conflict (409)
// instead of surfacing as the schema mismatch it is.
//
// A Map, not an object literal: `lookup[name]` resolves inherited members, so
// a constraint called `constructor` or `toString` would return a function and
// be reported as a known conflict. Same class of bug as the data-table column
// lookup — a plain object is never a safe keyed table for external strings.
const USER_UNIQUE_CONSTRAINTS = new Map<string, string>([
  ['ux_users_email', MSG_EMAIL_EXISTS],
  ['ux_users_phone_number', MSG_PHONE_EXISTS],
]);

function resolveUserUniqueViolation(error: unknown): string | null {
  const constraintName = getConstraintName(error);
  return (
    USER_UNIQUE_CONSTRAINTS.get(constraintName) ??
    reportUnknownUniqueViolation('users', error)
  );
}

/**
 * Resolves the 409 message for permission/role endpoints.
 * Returns `null` when the constraint is not a known, user-correctable one.
 */
function resolvePermissionUniqueViolation(
  error: unknown,
  messages: {
    nameExists: string;
    duplicatePagePermission: string;
  }
): string | null {
  // Same exact-match Map shape as the user resolver, so a future fix lands
  // in both rather than one.
  const byConstraint = new Map<string, string>([
    ['ux_roles_role_name', messages.nameExists],
    ['ux_role_permissions_role_page', messages.duplicatePagePermission],
  ]);
  return (
    byConstraint.get(getConstraintName(error)) ??
    reportUnknownUniqueViolation('roles', error)
  );
}

/**
 * Catch-block helper: convert a *known* user unique-violation into a 409.
 * Returns `undefined` for anything else so the caller keeps its own handling
 * (which ends at the standard 500 path).
 */
export function handleUserUniqueViolation(
  error: unknown
): HandlerOutput<null> | undefined {
  if (!isUniqueViolation(error)) return undefined;
  const message = resolveUserUniqueViolation(error);
  if (!message) return undefined;
  return handleApiError(
    new CustomError(message, HTTP_STATUS.CONFLICT),
    undefined,
    getErrorHeaders(error)
  );
}

/**
 * Foreign-key constraints on `users`, matched EXACTLY.
 *
 * `constraint.includes('role_id')` also matched
 * `role_permissions_role_id_roles_id_fk` and every future FK whose name happens
 * to contain the column — reporting "role not found" for an unrelated integrity
 * failure. Names come from drizzle's generator
 * (`<table>_<column>_<ref-table>_<ref-column>_fk`); a rename in a migration
 * lands here, and an unmapped violation stays a 500 so the mismatch is visible.
 */
const USER_FK_CONSTRAINTS = new Set(['users_role_id_roles_id_fk']);

/**
 * Catch-block helper: a *known* users FK violation becomes a 400.
 * Same `undefined` contract as `handleUserUniqueViolation`.
 */
export function handleUserForeignKeyViolation(
  error: unknown,
  messages: { roleNotFound: string }
): HandlerOutput<null> | undefined {
  if (!isForeignKeyViolation(error)) return undefined;
  const constraint = getConstraintName(error);
  if (!USER_FK_CONSTRAINTS.has(constraint)) {
    // Deliberately NOT mapped: `role_permissions_role_id_roles_id_fk` can only
    // fail on a role this transaction just created or locked, which is a server
    // invariant break, not something the client can correct. Logged, then left
    // to the 500 path.
    console.error(
      sanitizeForLog({
        msg: 'db.unknownForeignKeyViolation',
        scope: 'users',
        constraint: constraint || '(none)',
      })
    );
    return undefined;
  }
  return handleApiError(
    new CustomError(messages.roleNotFound, HTTP_STATUS.BAD_REQUEST),
    undefined,
    getErrorHeaders(error)
  );
}

/** Same contract as `handleUserUniqueViolation`, for permission/role endpoints. */
export function handlePermissionUniqueViolation(
  error: unknown,
  messages: { nameExists: string; duplicatePagePermission: string }
): HandlerOutput<null> | undefined {
  if (!isUniqueViolation(error)) return undefined;
  const message = resolvePermissionUniqueViolation(error, messages);
  if (!message) return undefined;
  return handleApiError(
    new CustomError(message, HTTP_STATUS.CONFLICT),
    undefined,
    getErrorHeaders(error)
  );
}
