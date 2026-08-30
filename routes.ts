/**
 * The route table, as data.
 *
 * Framework-free on purpose: this file imports no server library, so it is the
 * one artefact a move to Hono keeps unchanged. `app.ts` iterates it and does the
 * Elysia-specific registration; the 405 boundary and the unused-file scanner
 * read the manifest derived from it.
 *
 * Paths are reproduced verbatim from the Next file-system routes so no client
 * contract changes: `app/api/dash/users/[id]/route.ts` became
 * `/api/dash/users/:id`, and so on.
 *
 * Every row states its request and response policies explicitly. Required
 * fields make omission a compile error rather than an unsafe default.
 *
 * `auth` is read off the handler, not guessed: `requirePermission` /
 * `requireAnyPermission` / `requireDashboardAccess` are `permission`,
 * `requireSession` alone is `session`, and a handler that calls none of them is
 * `public`. It is what publishes each operation's 401 and 403 in
 * `lib/http/openapi.ts`.
 *
 * Order matters only for readability here. Elysia resolves static segments
 * before wildcards regardless of registration order, which is why
 * `/api/dash/users/me/...` still wins over `/api/dash/users/:id`.
 */
import type { RouteDefinition, RoutePrefix } from '@/lib/http/route-manifest';

import * as authForgotReset from '@/app/api/auth/forgot-password/reset/handler';
import * as authForgotSend from '@/app/api/auth/forgot-password/send/handler';
import * as authOtpSend from '@/app/api/auth/otp/send/handler';
import * as authOtpVerify from '@/app/api/auth/otp/verify/handler';
import * as authPasswordlessSend from '@/app/api/auth/passwordless/send/handler';
import * as dashPermissionsId from '@/app/api/dash/permissions/[id]/handler';
import * as dashPermissions from '@/app/api/dash/permissions/handler';
import * as dashRoles from '@/app/api/dash/roles/handler';
import * as dashUsersId from '@/app/api/dash/users/[id]/handler';
import * as dashUsersIdSessions from '@/app/api/dash/users/[id]/sessions/handler';
import {
  SESSION_CURSOR_MAX_LENGTH,
  SESSION_CURSOR_PATTERN,
  SESSIONS_MAX_PAGE_SIZE,
} from '@/app/api/dash/users/[id]/sessions/pagination';
import * as dashUsers from '@/app/api/dash/users/handler';
import * as meChangeEmail from '@/app/api/dash/users/me/change-email/handler';
import * as meChangeEmailVerify from '@/app/api/dash/users/me/change-email/verify/handler';
import * as meChangePassword from '@/app/api/dash/users/me/change-password/handler';
import * as meChangePhone from '@/app/api/dash/users/me/change-phone/handler';
import * as meChangePhoneVerify from '@/app/api/dash/users/me/change-phone/verify/handler';
import * as devSignUp from '@/app/api/dev/sign-up/handler';
import * as healthStorage from '@/app/api/health/storage/handler';
import * as uploadImage from '@/app/api/upload/image/handler';
import { BETTER_AUTH_ENDPOINTS } from '@/lib/auth/allowed-paths';
import {
  MAX_FILTERS_RAW_LENGTH,
  MAX_PAGE,
  MAX_PER_PAGE,
  MAX_SEARCH_LENGTH,
  MAX_SORT_RAW_LENGTH,
} from '@/lib/data-table/parsers';
import { openApiRouteHandler } from '@/lib/http/openapi';
import {
  toPublishedManifest,
  toRegisteredRoutes,
} from '@/lib/http/route-manifest';
// A plain frozen object of page keys — no server library, so the framework-free
// property above holds.
import { DASHBOARD_PAGE_NAMES } from '@/lib/permissions/constants';

const dataTableQuery = (
  columns: string
): NonNullable<RouteDefinition['query']> => [
  {
    name: 'maxPerPage',
    required: false,
    description: 'Upper bound applied to perPage for this request.',
    type: 'integer',
    minimum: 1,
    maximum: MAX_PER_PAGE,
  },
  {
    name: 'page',
    required: false,
    description: 'One-based page number.',
    type: 'integer',
    minimum: 1,
    maximum: MAX_PAGE,
  },
  {
    name: 'perPage',
    required: false,
    description: 'Rows per page.',
    type: 'integer',
    minimum: 1,
    maximum: MAX_PER_PAGE,
  },
  {
    name: 'sort',
    required: false,
    description: `JSON array of { id, desc } objects. Allowed ids: ${columns}.`,
    maxLength: MAX_SORT_RAW_LENGTH,
    example: '[{"id":"createdAt","desc":true}]',
  },
  {
    name: 'filters',
    required: false,
    description: `JSON array of { id, value, variant, operator, filterId } objects. Allowed ids: ${columns}.`,
    maxLength: MAX_FILTERS_RAW_LENGTH,
  },
  {
    name: 'joinOperator',
    required: false,
    description: 'How multiple structured filters are combined.',
    enum: ['and', 'or'],
  },
  {
    name: 'search',
    required: false,
    description:
      'Quick search. Terms shorter than three characters are intentionally ignored.',
    maxLength: MAX_SEARCH_LENGTH,
  },
];

export const ROUTES: readonly RouteDefinition[] = [
  // ---- auth ---------------------------------------------------------------
  {
    method: 'POST',
    path: '/api/auth/forgot-password/reset',
    handler: authForgotReset.POST,
    preAuth: 'ip-limit',
    auth: 'public',
    captcha: true,
    handlerRateLimit: true,
    body: 'json',
    response: 'envelope',
  },
  {
    method: 'POST',
    path: '/api/auth/forgot-password/send',
    handler: authForgotSend.POST,
    preAuth: 'ip-limit',
    auth: 'public',
    captcha: true,
    handlerRateLimit: true,
    body: 'json',
    response: 'envelope',
  },
  // No pre-auth limit: the OTP endpoints carry their own per-identifier and
  // per-destination budgets, which are tighter than the coarse per-IP one.
  {
    method: 'POST',
    path: '/api/auth/otp/send',
    handler: authOtpSend.POST,
    preAuth: 'none',
    auth: 'public',
    captcha: true,
    handlerRateLimit: true,
    body: 'json',
    response: 'envelope',
  },
  {
    method: 'POST',
    path: '/api/auth/otp/verify',
    handler: authOtpVerify.POST,
    preAuth: 'none',
    auth: 'public',
    captcha: true,
    handlerRateLimit: true,
    body: 'json',
    response: 'envelope',
  },
  {
    method: 'POST',
    path: '/api/auth/passwordless/send',
    handler: authPasswordlessSend.POST,
    preAuth: 'ip-limit',
    auth: 'public',
    captcha: true,
    handlerRateLimit: true,
    body: 'json',
    response: 'envelope',
  },

  // ---- dashboard: permissions & roles -------------------------------------
  {
    method: 'GET',
    path: '/api/dash/permissions',
    handler: dashPermissions.GET,
    preAuth: 'ip-limit',
    auth: 'permission',
    captcha: false,
    handlerRateLimit: true,
    body: 'none',
    response: 'envelope',
    query: dataTableQuery(
      'roleName, description, isActive, createdAt, updatedAt'
    ),
  },
  {
    method: 'POST',
    path: '/api/dash/permissions',
    handler: dashPermissions.POST,
    preAuth: 'ip-limit',
    auth: 'permission',
    captcha: false,
    handlerRateLimit: true,
    body: 'json',
    response: 'envelope',
  },
  {
    method: 'GET',
    path: '/api/dash/permissions/:id',
    handler: dashPermissionsId.GET,
    preAuth: 'ip-limit',
    auth: 'permission',
    captcha: false,
    handlerRateLimit: true,
    body: 'none',
    response: 'envelope',
  },
  {
    method: 'PUT',
    path: '/api/dash/permissions/:id',
    handler: dashPermissionsId.PUT,
    preAuth: 'ip-limit',
    auth: 'permission',
    captcha: false,
    handlerRateLimit: true,
    body: 'json',
    response: 'envelope',
  },
  {
    method: 'DELETE',
    path: '/api/dash/permissions/:id',
    handler: dashPermissionsId.DELETE,
    preAuth: 'ip-limit',
    auth: 'permission',
    captcha: false,
    handlerRateLimit: true,
    body: 'none',
    response: 'envelope',
  },
  {
    method: 'GET',
    path: '/api/dash/roles',
    handler: dashRoles.GET,
    preAuth: 'ip-limit',
    auth: 'permission',
    captcha: false,
    handlerRateLimit: true,
    body: 'none',
    response: 'envelope',
  },

  // ---- dashboard: self-service (static, so it wins over /:id) -------------
  {
    method: 'POST',
    path: '/api/dash/users/me/change-email',
    handler: meChangeEmail.POST,
    preAuth: 'ip-limit',
    auth: 'session',
    captcha: true,
    handlerRateLimit: true,
    body: 'json',
    response: 'envelope',
  },
  {
    method: 'POST',
    path: '/api/dash/users/me/change-email/verify',
    handler: meChangeEmailVerify.POST,
    preAuth: 'ip-limit',
    auth: 'session',
    captcha: true,
    handlerRateLimit: true,
    body: 'json',
    response: 'envelope',
  },
  {
    method: 'POST',
    path: '/api/dash/users/me/change-password',
    handler: meChangePassword.POST,
    preAuth: 'ip-limit',
    auth: 'session',
    captcha: true,
    handlerRateLimit: true,
    body: 'json',
    response: 'envelope',
  },
  {
    method: 'POST',
    path: '/api/dash/users/me/change-phone',
    handler: meChangePhone.POST,
    preAuth: 'ip-limit',
    auth: 'session',
    captcha: true,
    handlerRateLimit: true,
    body: 'json',
    response: 'envelope',
  },
  {
    method: 'POST',
    path: '/api/dash/users/me/change-phone/verify',
    handler: meChangePhoneVerify.POST,
    preAuth: 'ip-limit',
    auth: 'session',
    captcha: true,
    handlerRateLimit: true,
    body: 'json',
    response: 'envelope',
  },

  // ---- dashboard: users ---------------------------------------------------
  {
    method: 'GET',
    path: '/api/dash/users',
    handler: dashUsers.GET,
    preAuth: 'ip-limit',
    auth: 'permission',
    captcha: false,
    handlerRateLimit: true,
    body: 'none',
    response: 'envelope',
    query: dataTableQuery('name, email, isActive, createdAt, updatedAt'),
  },
  {
    method: 'POST',
    path: '/api/dash/users',
    handler: dashUsers.POST,
    preAuth: 'ip-limit',
    auth: 'permission',
    captcha: false,
    handlerRateLimit: true,
    body: 'json',
    response: 'envelope',
  },
  {
    method: 'GET',
    path: '/api/dash/users/:id',
    handler: dashUsersId.GET,
    preAuth: 'ip-limit',
    auth: 'permission',
    captcha: false,
    handlerRateLimit: true,
    body: 'none',
    response: 'envelope',
  },
  {
    method: 'PUT',
    path: '/api/dash/users/:id',
    handler: dashUsersId.PUT,
    preAuth: 'ip-limit',
    auth: 'permission',
    captcha: false,
    handlerRateLimit: true,
    body: 'json',
    response: 'envelope',
  },
  {
    method: 'DELETE',
    path: '/api/dash/users/:id',
    handler: dashUsersId.DELETE,
    preAuth: 'ip-limit',
    auth: 'permission',
    captcha: false,
    handlerRateLimit: true,
    body: 'none',
    response: 'envelope',
  },
  {
    method: 'GET',
    path: '/api/dash/users/:id/sessions',
    handler: dashUsersIdSessions.GET,
    preAuth: 'ip-limit',
    auth: 'permission',
    captcha: false,
    handlerRateLimit: true,
    body: 'none',
    response: 'envelope',
    query: [
      {
        name: 'limit',
        required: false,
        description: 'Page size.',
        type: 'integer',
        minimum: 1,
        maximum: SESSIONS_MAX_PAGE_SIZE,
      },
      {
        name: 'cursor',
        required: false,
        description:
          'Cursor returned by the previous page: ISO-8601 UTC milliseconds, a pipe, then a UUIDv7.',
        maxLength: SESSION_CURSOR_MAX_LENGTH,
        pattern: SESSION_CURSOR_PATTERN,
      },
    ],
  },
  // The only DELETE with a body: it takes the session ids to revoke.
  {
    method: 'DELETE',
    path: '/api/dash/users/:id/sessions',
    handler: dashUsersIdSessions.DELETE,
    preAuth: 'ip-limit',
    auth: 'permission',
    captcha: false,
    handlerRateLimit: true,
    body: 'json',
    response: 'envelope',
  },

  // ---- upload -------------------------------------------------------------
  // The only `multipart` route, and the only one whose body is read lazily —
  // the handler authorises the caller and runs its own per-user limiter before
  // calling `readFormData()`.
  //
  // `ip-limit`, like every other authenticated surface: the handler now performs
  // a session lookup and a permissions read, so unauthenticated traffic must be
  // bounded before it can force either. Its own limiter is keyed per user, which
  // by definition cannot bound a caller that has no session yet.
  {
    method: 'POST',
    path: '/api/upload/image',
    handler: uploadImage.POST,
    preAuth: 'ip-limit',
    auth: 'permission',
    captcha: false,
    handlerRateLimit: true,
    body: 'multipart',
    response: 'envelope',
    // Required, and read from the query rather than the form because the
    // permission check on it has to run before the multipart body is parsed.
    query: [
      {
        name: 'resource',
        required: true,
        description:
          'Dashboard resource the image is for. The caller must hold create or edit on it.',
        enum: DASHBOARD_PAGE_NAMES,
      },
    ],
    // Image processing may outlast the global ceiling; timing out here drops
    // the connection without an error body.
    timeoutSeconds: 120,
  },

  // ---- operations ---------------------------------------------------------
  {
    method: 'GET',
    path: '/api/health/storage',
    handler: healthStorage.GET,
    preAuth: 'none',
    auth: 'public',
    captcha: false,
    handlerRateLimit: false,
    body: 'none',
    response: 'storage-health',
    query: [
      {
        name: 'deep',
        required: false,
        description:
          'Set to 1 to run SQLite integrity and write probes. Other values use the cheap probe.',
        example: '1',
      },
    ],
  },

  // ---- dev-only -----------------------------------------------------------
  // Present in the table, ABSENT from `REGISTERED_ROUTES` outside development —
  // see `toRegisteredRoutes`. It stays here so the registration scanner can see
  // its handler and so `bun run build` publishes the same filtered document
  // whatever the building machine's NODE_ENV is.
  {
    method: 'POST',
    path: '/api/dev/sign-up',
    handler: devSignUp.POST,
    preAuth: 'none',
    auth: 'public',
    captcha: false,
    handlerRateLimit: false,
    body: 'json',
    response: 'envelope',
  },

  // ---- contract ------------------------------------------------------------
  // In the table, not registered separately on the framework instance. A route
  // outside the table is invisible to everything the table drives: it got no
  // 405 boundary, no trailing-slash redirect and no route-aware OPTIONS, and it
  // would not have appeared in its own document. `ROUTES` is referenced lazily
  // inside the handler, which runs long after this array is built.
  {
    method: 'GET',
    path: '/openapi.json',
    handler: openApiRouteHandler(() => toPublishedManifest(REGISTERED_ROUTES)),
    preAuth: 'ip-limit',
    auth: 'permission',
    captcha: false,
    handlerRateLimit: false,
    body: 'none',
    response: 'openapi-document',
  },
];

/**
 * What `app.ts` actually serves.
 *
 * The environment decision is taken ONCE, here, rather than inside each
 * development-only handler: outside development those paths are not registered at
 * all, so they answer 404 on every method with no `Allow` and no OPTIONS answer,
 * exactly like any other unknown path.
 */
export const REGISTERED_ROUTES = toRegisteredRoutes(ROUTES);

/**
 * Better Auth owns its own sub-routing under `/api/auth`, so it is a prefix
 * rather than a set of routes.
 *
 * The reachable surface is exact in both dimensions — path AND method — from the
 * same table `lib/auth.ts` enforces and `lib/http/openapi.ts` publishes. Not the
 * whole prefix and not one method set for all of it: Better Auth 404s every path
 * outside the list and every method a path does not declare, so anything broader
 * made the 405 boundary claim operations the handler itself rejects.
 */
export const ROUTE_PREFIXES: readonly RoutePrefix[] = [
  {
    prefix: '/api/auth',
    paths: BETTER_AUTH_ENDPOINTS,
  },
];
