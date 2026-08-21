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
 * Every row states BOTH policies explicitly. `preAuth` and `body` are required
 * fields, so a new route cannot silently inherit "no pre-auth limit" or "parse
 * whatever the client sent" by omitting an argument — the omission does not
 * compile.
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
import * as dashUsers from '@/app/api/dash/users/handler';
import * as meChangeEmail from '@/app/api/dash/users/me/change-email/handler';
import * as meChangeEmailVerify from '@/app/api/dash/users/me/change-email/verify/handler';
import * as meChangePassword from '@/app/api/dash/users/me/change-password/handler';
import * as meChangePhone from '@/app/api/dash/users/me/change-phone/handler';
import * as meChangePhoneVerify from '@/app/api/dash/users/me/change-phone/verify/handler';
import * as devEmailTestFixed from '@/app/api/dev/email-test/fixed/handler';
import * as devSignUp from '@/app/api/dev/sign-up/handler';
import * as healthStorage from '@/app/api/health/storage/handler';
import * as internalDbSweep from '@/app/api/internal/db-sweep/handler';
import * as internalSqliteSweep from '@/app/api/internal/sqlite-sweep/handler';
import * as uploadImage from '@/app/api/upload/image/handler';
import { BETTER_AUTH_ALLOWED_PATHS } from '@/lib/auth/allowed-paths';
import { openApiRouteHandler } from '@/lib/http/openapi';
import { toManifest } from '@/lib/http/route-manifest';
// A plain frozen object of page keys — no server library, so the framework-free
// property above holds.
import { DASHBOARD_PAGE_NAMES } from '@/lib/permissions/constants';

export const ROUTES: readonly RouteDefinition[] = [
  // ---- auth ---------------------------------------------------------------
  {
    method: 'POST',
    path: '/api/auth/forgot-password/reset',
    handler: authForgotReset.POST,
    preAuth: 'ip-limit',
    body: 'json',
  },
  {
    method: 'POST',
    path: '/api/auth/forgot-password/send',
    handler: authForgotSend.POST,
    preAuth: 'ip-limit',
    body: 'json',
  },
  // No pre-auth limit: the OTP endpoints carry their own per-identifier and
  // per-destination budgets, which are tighter than the coarse per-IP one.
  {
    method: 'POST',
    path: '/api/auth/otp/send',
    handler: authOtpSend.POST,
    preAuth: 'none',
    body: 'json',
  },
  {
    method: 'POST',
    path: '/api/auth/otp/verify',
    handler: authOtpVerify.POST,
    preAuth: 'none',
    body: 'json',
  },
  {
    method: 'POST',
    path: '/api/auth/passwordless/send',
    handler: authPasswordlessSend.POST,
    preAuth: 'ip-limit',
    body: 'json',
  },

  // ---- dashboard: permissions & roles -------------------------------------
  {
    method: 'GET',
    path: '/api/dash/permissions',
    handler: dashPermissions.GET,
    preAuth: 'ip-limit',
    body: 'none',
  },
  {
    method: 'POST',
    path: '/api/dash/permissions',
    handler: dashPermissions.POST,
    preAuth: 'ip-limit',
    body: 'json',
  },
  {
    method: 'GET',
    path: '/api/dash/permissions/:id',
    handler: dashPermissionsId.GET,
    preAuth: 'ip-limit',
    body: 'none',
  },
  {
    method: 'PUT',
    path: '/api/dash/permissions/:id',
    handler: dashPermissionsId.PUT,
    preAuth: 'ip-limit',
    body: 'json',
  },
  {
    method: 'DELETE',
    path: '/api/dash/permissions/:id',
    handler: dashPermissionsId.DELETE,
    preAuth: 'ip-limit',
    body: 'none',
  },
  {
    method: 'GET',
    path: '/api/dash/roles',
    handler: dashRoles.GET,
    preAuth: 'ip-limit',
    body: 'none',
  },

  // ---- dashboard: self-service (static, so it wins over /:id) -------------
  {
    method: 'POST',
    path: '/api/dash/users/me/change-email',
    handler: meChangeEmail.POST,
    preAuth: 'ip-limit',
    body: 'json',
  },
  {
    method: 'POST',
    path: '/api/dash/users/me/change-email/verify',
    handler: meChangeEmailVerify.POST,
    preAuth: 'ip-limit',
    body: 'json',
  },
  {
    method: 'POST',
    path: '/api/dash/users/me/change-password',
    handler: meChangePassword.POST,
    preAuth: 'ip-limit',
    body: 'json',
  },
  {
    method: 'POST',
    path: '/api/dash/users/me/change-phone',
    handler: meChangePhone.POST,
    preAuth: 'ip-limit',
    body: 'json',
  },
  {
    method: 'POST',
    path: '/api/dash/users/me/change-phone/verify',
    handler: meChangePhoneVerify.POST,
    preAuth: 'ip-limit',
    body: 'json',
  },

  // ---- dashboard: users ---------------------------------------------------
  {
    method: 'GET',
    path: '/api/dash/users',
    handler: dashUsers.GET,
    preAuth: 'ip-limit',
    body: 'none',
  },
  {
    method: 'POST',
    path: '/api/dash/users',
    handler: dashUsers.POST,
    preAuth: 'ip-limit',
    body: 'json',
  },
  {
    method: 'GET',
    path: '/api/dash/users/:id',
    handler: dashUsersId.GET,
    preAuth: 'ip-limit',
    body: 'none',
  },
  {
    method: 'PUT',
    path: '/api/dash/users/:id',
    handler: dashUsersId.PUT,
    preAuth: 'ip-limit',
    body: 'json',
  },
  {
    method: 'DELETE',
    path: '/api/dash/users/:id',
    handler: dashUsersId.DELETE,
    preAuth: 'ip-limit',
    body: 'none',
  },
  {
    method: 'GET',
    path: '/api/dash/users/:id/sessions',
    handler: dashUsersIdSessions.GET,
    preAuth: 'ip-limit',
    body: 'none',
    query: [
      {
        name: 'limit',
        required: false,
        description: 'Page size. Clamped server-side.',
      },
      {
        name: 'cursor',
        required: false,
        description: 'Opaque cursor from a previous page.',
      },
    ],
  },
  // The only DELETE with a body: it takes the session ids to revoke.
  {
    method: 'DELETE',
    path: '/api/dash/users/:id/sessions',
    handler: dashUsersIdSessions.DELETE,
    preAuth: 'ip-limit',
    body: 'json',
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
    body: 'multipart',
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
    // Image processing, two parallel R2 operations and a database insert can
    // exceed the server-wide ceiling on a small VPS, and the client then sees a
    // dropped connection rather than an error body. NOT measured on the target
    // host yet — see TODO.md; this is a deliberately generous ceiling, to be
    // replaced by a measured one.
    timeoutSeconds: 120,
  },

  // ---- operations ---------------------------------------------------------
  {
    method: 'GET',
    path: '/api/health/storage',
    handler: healthStorage.GET,
    preAuth: 'none',
    body: 'none',
    query: [
      {
        name: 'deep',
        required: false,
        description:
          'Set to 1 to probe the object store, not just process state.',
        enum: ['1'],
      },
    ],
  },
  // `body: 'none'` is load-bearing on both: the token check runs against a
  // request whose body was never touched.
  {
    method: 'POST',
    path: '/api/internal/sqlite-sweep',
    handler: internalSqliteSweep.POST,
    preAuth: 'none',
    body: 'none',
  },
  {
    method: 'POST',
    path: '/api/internal/db-sweep',
    handler: internalDbSweep.POST,
    preAuth: 'none',
    body: 'none',
    // Retention over four tables, batched, plus one R2 delete per abandoned
    // upload. The default ceiling is for request/response work, not for a
    // scheduled job that walks a backlog.
    timeoutSeconds: 120,
  },

  // ---- dev-only -----------------------------------------------------------
  // TODO: remove both endpoints in production
  {
    method: 'POST',
    path: '/api/dev/sign-up',
    handler: devSignUp.POST,
    preAuth: 'none',
    body: 'json',
  },
  {
    method: 'GET',
    path: '/api/dev/email-test/fixed',
    handler: devEmailTestFixed.GET,
    preAuth: 'none',
    body: 'none',
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
    handler: openApiRouteHandler(() => toManifest(ROUTES)),
    preAuth: 'none',
    body: 'none',
  },
];

/**
 * Better Auth owns its own sub-routing under `/api/auth`, so it is a prefix
 * rather than a set of routes.
 *
 * GET and POST only. The App Router mounted it through
 * `toNextJsHandler(auth.handler)`, which exports exactly those two, so a `PUT`
 * under `/api/auth` never reached Better Auth. Registering the prefix for every
 * method let unsupported ones in to consume Better Auth's own rate-limit budget
 * before it rejected them.
 */
export const ROUTE_PREFIXES: readonly RoutePrefix[] = [
  {
    prefix: '/api/auth',
    methods: ['GET', 'POST'],
    // The exact reachable surface, from the same set `lib/auth.ts` enforces.
    // Not the whole prefix: Better Auth 404s every path outside this list, so
    // advertising the prefix made the 405 boundary claim paths existed that the
    // handler itself rejects.
    paths: [...BETTER_AUTH_ALLOWED_PATHS],
  },
];
