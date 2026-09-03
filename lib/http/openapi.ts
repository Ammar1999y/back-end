/**
 * Generates a framework-independent contract from the route manifest and the
 * Zod schemas used by handlers. Route-attached Elysia schemas would duplicate
 * validation, while Better Auth's document would advertise blocked routes.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Handler } from './contract';
import type { HttpMethod, RouteManifestEntry } from './route-manifest';

import { deleteSessionsSchema } from '@/app/api/dash/users/[id]/sessions/handler';
import { SESSION_CURSOR_PATTERN } from '@/app/api/dash/users/[id]/sessions/pagination';
import { devSignUpSchema } from '@/app/api/dev/sign-up/handler';
import { UUID_V7_PATTERN } from '@/utils';
import * as z from 'zod';
import { auth } from '@/lib/auth';
import {
  BETTER_AUTH_ALLOWED_PATH_SET,
  BETTER_AUTH_ENDPOINTS,
  BETTER_AUTH_KNOWN_PATHS,
  betterAuthServes,
} from '@/lib/auth/allowed-paths';
import { CAPTCHA_TOKEN_MAX_LENGTH } from '@/lib/captcha';
import {
  DASHBOARD_PAGE_NAMES,
  PERMISSION_ACTIONS,
} from '@/lib/permissions/constants';
import { ALLOWED_IMAGE_TYPES } from '@/lib/r2/upload-helper';

import { apiRaw } from '@/utils/api-response';
import { PHONE_ENABLED, PHONE_REQUIRED } from '@/utils/config';
import {
  adminReauthSchema,
  adminUpdateUserBodySchema,
  changeEmailSchema,
  changeEmailVerifySchema,
  changePasswordSchema,
  changePhoneSchema,
  changePhoneVerifySchema,
  createUserSchema,
  loginSchema,
  selfUpdateUserBodySchema,
} from '@/utils/validation/auth';
import {
  MAX_IMAGE_EDGE,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SIZE,
} from '@/utils/validation/constants';
import {
  isChannelEnabled,
  passwordlessVerifySchema,
  recoveryCompleteSchema,
  recoverySecondFactorSendSchema,
  resetPasswordSchema,
  sendOtpSchema,
  verifyOtpSchema,
} from '@/utils/validation/otp';
import {
  adminUpdatePermissionBodySchema,
  createPermissionSchema,
} from '@/utils/validation/permissions';
import {
  ownedRowSchema,
  twoFactorMethodDisableSchema,
  twoFactorMethodOptionSchema,
  twoFactorOtpSendSchema,
  twoFactorOtpVerifySchema,
  twoFactorPasskeyVerifySchema,
  twoFactorPasswordSchema,
  twoFactorTotpConfirmSchema,
} from '@/utils/validation/two-factor';

import { isDevelopmentOnlyPath } from './route-manifest';
import { requireDashboardAccess } from './session';

type JsonSchema = Record<string, unknown>;

const BETTER_AUTH_OPENAPI = await auth.api.generateOpenAPISchema();
const BETTER_AUTH_CONTEXT = await auth.$context;

/**
 * Request bodies, keyed by `METHOD path` exactly as the manifest spells them.
 *
 * An explicit map rather than inference: the handler is what chooses the schema,
 * and two routes pick theirs at runtime (`PUT /api/dash/users/:id` validates
 * with the admin schema or the self schema depending on who the caller is), so
 * nothing static can derive this. A key that does not match a manifest entry is
 * reported by `openApiDocument`'s own consistency check rather than silently
 * ignored.
 */
export const REQUEST_BODIES: Record<string, z.ZodType | readonly z.ZodType[]> =
  {
    'POST /api/auth/forgot-password/reset': resetPasswordSchema,
    'POST /api/auth/forgot-password/second-factor/send':
      recoverySecondFactorSendSchema,
    'POST /api/auth/forgot-password/complete': recoveryCompleteSchema,
    'POST /api/auth/forgot-password/send': sendOtpSchema,
    'POST /api/auth/otp/send': sendOtpSchema,
    'POST /api/auth/otp/verify': verifyOtpSchema,
    'POST /api/auth/passwordless/send': sendOtpSchema,
    'POST /api/dash/auth/reauth': adminReauthSchema,
    'POST /api/dash/permissions': createPermissionSchema,
    'PUT /api/dash/permissions/:id': adminUpdatePermissionBodySchema,
    'POST /api/dash/users': createUserSchema,
    'PUT /api/dash/users/:id': [
      adminUpdateUserBodySchema,
      selfUpdateUserBodySchema,
    ],
    'POST /api/dash/users/me/change-email': changeEmailSchema,
    'POST /api/dash/users/me/change-email/verify': changeEmailVerifySchema,
    'POST /api/dash/users/me/change-password': changePasswordSchema,
    'POST /api/dash/users/me/change-phone': changePhoneSchema,
    'POST /api/dash/users/me/change-phone/verify': changePhoneVerifySchema,
    'DELETE /api/dash/users/:id/sessions': deleteSessionsSchema,
    'POST /api/dev/sign-up': devSignUpSchema,
  };

/**
 * Routes whose success status is not 200.
 *
 * Hardcoding 200 for everything made the document wrong for the three handlers
 * that return `HTTP_STATUS.CREATED` — a client generated from it would treat a
 * successful creation as unexpected.
 */
const CREATED_ROUTES = new Set([
  'POST /api/dash/permissions',
  'POST /api/dash/users',
  'POST /api/dev/sign-up',
]);

/** Routes whose database constraint mapping can return a deliberate 409. */
const CONFLICT_ROUTES = new Set([
  'POST /api/dash/permissions',
  'PUT /api/dash/permissions/:id',
  'POST /api/dash/users',
  'PUT /api/dash/users/:id',
  'POST /api/dash/users/me/change-email',
  'POST /api/dash/users/me/change-email/verify',
  'POST /api/dash/users/me/change-phone',
  'POST /api/dash/users/me/change-phone/verify',
  'POST /api/dev/sign-up',
]);

/** Bodyless operations with a reachable handler-level 400. */
const BODYLESS_BAD_REQUEST_ROUTES = new Set([
  'DELETE /api/dash/permissions/:id',
  'DELETE /api/dash/users/:id',
]);

/** Correct-method operations whose own handler can deliberately answer 404. */
const NOT_FOUND_ROUTES = new Set([
  'POST /api/auth/forgot-password/reset',
  'POST /api/auth/forgot-password/second-factor/send',
  'POST /api/auth/forgot-password/complete',
  'POST /api/auth/forgot-password/send',
  'POST /api/auth/otp/send',
  'POST /api/auth/otp/verify',
  'POST /api/auth/passwordless/send',
  'GET /api/dash/permissions/:id',
  'PUT /api/dash/permissions/:id',
  'DELETE /api/dash/permissions/:id',
  'POST /api/dash/users/me/change-email',
  'POST /api/dash/users/me/change-phone',
  'POST /api/dash/users/me/change-phone/verify',
  'GET /api/dash/users/:id',
  'PUT /api/dash/users/:id',
  'DELETE /api/dash/users/:id',
  'GET /api/dash/users/:id/sessions',
  'DELETE /api/dash/users/:id/sessions',
]);

/** Bodyless routes whose query parser can reject a supplied value with 422. */
const QUERY_VALIDATION_ROUTES = new Set([
  'GET /api/dash/permissions',
  'GET /api/dash/users',
  'GET /api/dash/users/:id/sessions',
]);

/**
 * Routes that answer 503 when no OTP channel can carry their confirmation code
 * — a second producer of the status the rate limiter owns, and the only one a
 * client cannot retry its way out of.
 */
const CHANNEL_UNAVAILABLE_ROUTES = new Set([
  'POST /api/dash/users/me/change-email',
  'POST /api/dash/users/me/change-phone',
]);

const OPERATION_DOCS: Record<string, { summary: string; tag: string }> = {
  'POST /api/auth/forgot-password/reset': {
    summary: 'Reset a forgotten password',
    tag: 'Authentication',
  },
  'POST /api/auth/forgot-password/send': {
    summary: 'Send a password-reset code',
    tag: 'Authentication',
  },
  'POST /api/auth/forgot-password/second-factor/send': {
    summary: 'Send the second-factor code for a password reset',
    tag: 'Authentication',
  },
  'POST /api/auth/forgot-password/complete': {
    summary: 'Finish a password reset with a proven second factor',
    tag: 'Authentication',
  },
  'POST /api/auth/otp/send': {
    summary: 'Send a one-time code',
    tag: 'Authentication',
  },
  'POST /api/auth/otp/verify': {
    summary: 'Verify a one-time code',
    tag: 'Authentication',
  },
  'POST /api/auth/passwordless/send': {
    summary: 'Send a passwordless sign-in code',
    tag: 'Authentication',
  },
  'POST /api/dash/auth/reauth': {
    summary: 'Open the administrator re-authentication window',
    tag: 'Authentication',
  },
  'GET /api/dash/permissions': {
    summary: 'List roles and permission counts',
    tag: 'Permissions',
  },
  'POST /api/dash/permissions': {
    summary: 'Create a role and permission matrix',
    tag: 'Permissions',
  },
  'GET /api/dash/permissions/:id': {
    summary: 'Get a role permission matrix',
    tag: 'Permissions',
  },
  'PUT /api/dash/permissions/:id': {
    summary: 'Update a role permission matrix',
    tag: 'Permissions',
  },
  'DELETE /api/dash/permissions/:id': {
    summary: 'Delete a role',
    tag: 'Permissions',
  },
  'GET /api/dash/roles': {
    summary: 'List assignable roles',
    tag: 'Permissions',
  },
  'POST /api/dash/users/me/change-email': {
    summary: 'Start an email-address change',
    tag: 'Account',
  },
  'POST /api/dash/users/me/change-email/verify': {
    summary: 'Verify and commit an email-address change',
    tag: 'Account',
  },
  'POST /api/dash/users/me/change-password': {
    summary: 'Change the current password',
    tag: 'Account',
  },
  'POST /api/dash/users/me/change-phone': {
    summary: 'Start a phone-number change',
    tag: 'Account',
  },
  'POST /api/dash/users/me/change-phone/verify': {
    summary: 'Verify and commit a phone-number change',
    tag: 'Account',
  },
  'GET /api/dash/users': {
    summary: 'List dashboard users',
    tag: 'Users',
  },
  'POST /api/dash/users': {
    summary: 'Create a dashboard user',
    tag: 'Users',
  },
  'GET /api/dash/users/:id': {
    summary: 'Get a dashboard user',
    tag: 'Users',
  },
  'PUT /api/dash/users/:id': {
    summary: 'Update a dashboard user',
    tag: 'Users',
  },
  'DELETE /api/dash/users/:id': {
    summary: 'Delete a dashboard user',
    tag: 'Users',
  },
  'GET /api/dash/users/:id/sessions': {
    summary: 'List a user’s active sessions',
    tag: 'Sessions',
  },
  'DELETE /api/dash/users/:id/sessions': {
    summary: 'Revoke a user’s sessions',
    tag: 'Sessions',
  },
  'POST /api/dash/users/:id/two-factor/reset': {
    summary: 'Clear a user’s two-factor enrolment',
    tag: 'Users',
  },
  'POST /api/upload/image': {
    summary: 'Upload an image',
    tag: 'Uploads',
  },
  'GET /api/health/storage': {
    summary: 'Check storage readiness',
    tag: 'Operations',
  },
  'POST /api/dev/sign-up': {
    summary: 'Create a development system user',
    tag: 'Development',
  },
  'GET /openapi.json': {
    summary: 'Get this API contract',
    tag: 'Contract',
  },
};

const BETTER_AUTH_SUMMARIES: Record<string, string> = {
  'GET /get-session': 'Get the current Better Auth session',
  'POST /sign-out': 'Sign out the current session',
  'POST /sign-in/email': 'Sign in with email and password',
  'POST /passwordless/verify': 'Verify a passwordless sign-in code',
  'POST /two-factor/disable': 'Disable two-factor authentication',
  'POST /two-factor/get-totp-uri': 'Get the TOTP enrolment URI',
  'POST /two-factor/totp/start': 'Begin authenticator-app enrolment',
  'POST /two-factor/totp/confirm': 'Confirm authenticator-app enrolment',
  'POST /two-factor/verify-totp': 'Verify a TOTP code',
  'POST /two-factor/generate-backup-codes': 'Generate new backup codes',
  'POST /two-factor/verify-backup-code': 'Verify a backup code',
  'POST /two-factor/otp/send': 'Send a second-factor code',
  'POST /two-factor/otp/verify': 'Verify a second-factor code',
  'POST /two-factor/passkey/options': 'Start a passkey second-factor ceremony',
  'POST /two-factor/passkey/verify': 'Verify a passkey second factor',
  'POST /two-factor/trust-device': 'Trust this device for two-factor',
  'GET /two-factor/trusted-devices': 'List trusted devices',
  'POST /two-factor/trusted-devices/revoke': 'Revoke a trusted device',
  'GET /two-factor/methods': 'List enrolled second factors',
  'POST /two-factor/methods/disable': 'Remove one second factor',
  'POST /two-factor/methods/default': 'Choose the default second factor',
  'POST /two-factor/passkey/grant': 'Re-authenticate before a passkey ceremony',
  'POST /two-factor/backup-codes/acknowledge':
    'Confirm the backup codes were saved',
  'GET /passkey/generate-register-options': 'Start passkey registration',
  'POST /passkey/verify-registration': 'Complete passkey registration',
  'GET /passkey/list-user-passkeys': 'List the user’s passkeys',
  'POST /passkey/delete-passkey': 'Delete a passkey',
  'POST /passkey/update-passkey': 'Rename a passkey',
};

/**
 * Better Auth request bodies for the paths this deployment actually serves.
 *
 * `/passwordless/verify` is here because its body is OURS, not Better Auth's:
 * `lib/auth/passwordless.ts` validates `verifyOtpSchema`. Omitting it published
 * a POST with no documented body for an endpoint that rejects an empty one.
 * `/sign-out` and `/get-session` take no body, so they have no entry.
 */
const BETTER_AUTH_BODIES: Record<string, z.ZodType> = {
  '/sign-in/email': loginSchema.omit({ captcha: true }),
  '/passwordless/verify': passwordlessVerifySchema,
  // This deployment's own two-factor endpoints declare `z.record` to Better
  // Call and parse these; publishing the same schemas is what keeps the
  // document and the handler from drifting apart.
  '/two-factor/disable': twoFactorPasswordSchema,
  '/two-factor/totp/start': twoFactorPasswordSchema,
  '/two-factor/totp/confirm': twoFactorTotpConfirmSchema,
  '/two-factor/generate-backup-codes': twoFactorPasswordSchema,
  '/two-factor/backup-codes/acknowledge': twoFactorPasswordSchema,
  '/two-factor/passkey/grant': twoFactorPasswordSchema,
  '/two-factor/otp/send': twoFactorOtpSendSchema,
  '/two-factor/otp/verify': twoFactorOtpVerifySchema,
  '/two-factor/passkey/verify': twoFactorPasskeyVerifySchema,
  '/two-factor/methods/disable': twoFactorMethodDisableSchema,
  '/two-factor/methods/default': twoFactorMethodOptionSchema,
  '/two-factor/trusted-devices/revoke': ownedRowSchema,
  '/passkey/delete-passkey': ownedRowSchema,
};

/**
 * Zod → JSON Schema, or nothing.
 *
 * `unrepresentable: 'any'` rather than the default throw: several schemas use
 * `z.preprocess` and refinements that have no JSON Schema equivalent, and a
 * document missing one constraint is worth more than a route that 500s. The
 * per-schema catch is the same reasoning one level up — a future schema that
 * breaks the converter must not take the whole contract down with it.
 *
 * `$schema` is dropped because these results are spliced in as SUBSCHEMAS, and
 * under 2020-12 that keyword belongs to a schema RESOURCE root — which a
 * `oneOf` branch with no `$id` is not.
 */
function toJsonSchema(schema: z.ZodType): JsonSchema | null {
  try {
    const { $schema: _dialect, ...converted } = z.toJSONSchema(schema, {
      io: 'input',
      unrepresentable: 'any',
    }) as JsonSchema;
    return converted;
  } catch {
    return null;
  }
}

function isJsonSchema(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Repair Better Auth's OpenAPI-3.0-era schema fragments for a 3.1 document. */
function normalizeOpenApi31(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeOpenApi31);
  if (!isJsonSchema(value)) return value;

  const normalized = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'nullable')
      .map(([key, child]) => [key, normalizeOpenApi31(child)])
  ) as JsonSchema;

  if (normalized.type === 'json') {
    normalized.type = 'object';
    normalized.additionalProperties = true;
  }

  if (value.nullable === true) {
    if (typeof normalized.type === 'string')
      normalized.type = [normalized.type, 'null'];
    else if (Array.isArray(normalized.type)) {
      if (!normalized.type.includes('null'))
        normalized.type = [...normalized.type, 'null'];
    } else return { anyOf: [normalized, { type: 'null' }] };
  }

  if (normalized.default === '{}' && normalized.type === 'object')
    normalized.default = {};

  return normalized;
}

/** The key a converted union puts its branches under, or null if it is not one. */
function branchKey(converted: JsonSchema): 'oneOf' | 'anyOf' | null {
  if (Array.isArray(converted.oneOf)) return 'oneOf';
  if (Array.isArray(converted.anyOf)) return 'anyOf';
  return null;
}

/**
 * Rewrites a converted schema's top-level `required` from the Zod schema itself.
 *
 * Neither `io` setting produces the right answer for a REQUEST body, measured on
 * the installed `zod@4.4.3` against `createUserSchema`:
 *
 *   io: 'input'   required: []                                   ← what we asked for
 *   io: 'output'  required: [email, password, name, isActive, roleId, phoneNumber]
 *   truth         required: [email, password, name, roleId]
 *
 * `io: 'input'` drops a key whose field is a `z.preprocess` — the input type is
 * `unknown`, which admits `undefined` as far as the converter can tell — and
 * `emailSchema`/`passwordSchema` are both preprocessed, so `POST /api/dash/users`
 * advertised seven optional properties for a body that rejects `{}` with a 422.
 * `io: 'output'` over-corrects: a defaulted or transformed key is always present
 * AFTER parsing, so `isActive` and `phoneNumber` become required in a request
 * where they are genuinely optional.
 *
 * The property shapes must still come from the input side — that is what the
 * client sends — so only `required` is recomputed, by asking each field the
 * question the document is actually making a claim about: does omitting this key
 * fail? That is exactly `safeParse(undefined)`, and it gets defaults, optionals
 * and preprocessed-but-required fields all right at once.
 */
// `schema` is `unknown` rather than `z.ZodType`: `ZodUnion#options` is declared
// as the core `$ZodType[]`, which carries neither `safeParse` nor `shape`, so the
// recursion cannot honestly claim the richer type. The `instanceof` checks below
// are what earn it.
function withRequiredKeys(schema: unknown, converted: JsonSchema): JsonSchema {
  if (schema instanceof z.ZodObject) {
    if (!isJsonSchema(converted.properties)) return converted;

    const required = Object.entries(schema.shape)
      .filter(([, field]) => !field.safeParse(undefined).success)
      .map(([key]) => key);

    // Omitted rather than emitted empty: OpenAPI 3.1 inherits JSON Schema's rule
    // that `required` must be a non-empty array of unique strings.
    if (required.length === 0) {
      const { required: _dropped, ...rest } = converted;
      return rest;
    }
    return { ...converted, required };
  }

  // Unions have to recurse or the fix reaches almost none of the OTP surface:
  // `sendOtpSchema`, `verifyOtpSchema` and `resetPasswordSchema` are all
  // `ZodDiscriminatedUnion`, and every branch listed only `channel` as required
  // while the runtime also demanded `code`, `newPassword` and the destination.
  //
  // Branch order is taken to match `.options` order — measured to hold on
  // `zod@4.4.3` — and the length guard means a converter that ever stops
  // preserving it leaves the understated `required` alone rather than attaching
  // one branch's rules to another's.
  if (schema instanceof z.ZodUnion) {
    const key = branchKey(converted);
    const branches = key === null ? null : converted[key];
    if (key === null || !Array.isArray(branches)) return converted;
    const options: readonly unknown[] = schema.options;
    if (branches.length !== options.length) return converted;

    return {
      ...converted,
      [key]: branches.map((branch, index) => {
        const option = options[index];
        return option !== undefined && isJsonSchema(branch)
          ? withRequiredKeys(option, branch)
          : branch;
      }),
    };
  }

  return converted;
}

function permissionDependencyRule(
  actions: readonly string[],
  requiredReadActions: readonly string[]
): JsonSchema {
  const anyTrue = (names: readonly string[]): JsonSchema => {
    const branches = names.map((action) => ({
      properties: { [action]: { const: true } },
      required: [action],
    }));
    return branches.length === 1 && branches[0]
      ? branches[0]
      : { anyOf: branches };
  };
  return {
    if: {
      properties: {
        permissions: anyTrue(actions),
      },
      required: ['permissions'],
    },
    // eslint-disable-next-line unicorn/no-thenable -- `then` is a JSON Schema conditional keyword
    then: {
      properties: {
        permissions: anyTrue(requiredReadActions),
      },
    },
  };
}

function addPagePermissionRules(schema: JsonSchema): JsonSchema {
  if (!isJsonSchema(schema.properties)) return schema;
  const permissions = schema.properties.permissions;
  if (!isJsonSchema(permissions)) return schema;
  const items = permissions.items;
  if (!isJsonSchema(items)) return schema;

  permissions.description =
    'Page names must be unique. Unsupported actions may be omitted or false, never true.';
  permissions['x-unique-by'] = 'name';
  items.allOf = [
    permissionDependencyRule(['edit', 'delete'], ['view']),
    permissionDependencyRule(['editOwn', 'deleteOwn'], ['view', 'viewOwn']),
    {
      if: {
        properties: { name: { const: 'home' } },
        required: ['name'],
      },
      // eslint-disable-next-line unicorn/no-thenable -- `then` is a JSON Schema conditional keyword
      then: {
        properties: {
          permissions: {
            properties: Object.fromEntries(
              Object.keys(PERMISSION_ACTIONS)
                .filter((action) => action !== 'view')
                .map((action) => [action, { const: false }])
            ),
          },
        },
      },
    },
  ];
  return schema;
}

function addUserRoleRules(schema: JsonSchema, update: boolean): JsonSchema {
  const customThen: JsonSchema = {
    properties: { permissions: { minItems: 1 } },
    ...(!update && { required: ['permissions'] }),
  };
  const rules: JsonSchema[] = [
    {
      if: {
        properties: { roleId: { const: 'custom' } },
        required: ['roleId'],
      },
      // eslint-disable-next-line unicorn/no-thenable -- `then` is a JSON Schema conditional keyword
      then: customThen,
      else: { properties: { permissions: { maxItems: 0 } } },
    },
  ];

  if (!PHONE_ENABLED)
    rules.push({
      properties: {
        phoneNumber: {
          description: 'Phone input is disabled; omit this field or clear it.',
        },
      },
    });
  else if (PHONE_REQUIRED)
    rules.push({
      properties: {
        phoneNumber: { not: { type: 'null' } },
      },
      ...(!update && { required: ['phoneNumber'] }),
    });

  return {
    ...schema,
    allOf: [...(Array.isArray(schema.allOf) ? schema.allOf : []), ...rules],
  };
}

/**
 * The routes whose schema carries `channelEnabledRefine`. Not the verifies:
 * those deliberately accept a channel disabled since the code was delivered, so
 * narrowing them would publish a refusal the runtime does not make.
 */
const OTP_SEND_ROUTES = new Set([
  'POST /api/auth/forgot-password/send',
  'POST /api/auth/otp/send',
  'POST /api/auth/passwordless/send',
]);

/**
 * Drops the union branches whose channel this deployment does not accept.
 *
 * The refinement is the half `z.toJSONSchema` cannot see, so a disabled channel
 * was published as a valid body that answers 422. Same deployment-shaped
 * narrowing `addUserRoleRules` already does for `PHONE_ENABLED`.
 */
function restrictToEnabledChannels(schema: JsonSchema): JsonSchema {
  const key = branchKey(schema);
  const branches = key === null ? null : schema[key];
  if (key === null || !Array.isArray(branches)) return schema;

  const kept = branches.filter((branch) => {
    if (!isJsonSchema(branch) || !isJsonSchema(branch.properties)) return true;
    const channel = branch.properties.channel;
    if (!isJsonSchema(channel) || typeof channel.const !== 'string')
      return true;
    return isChannelEnabled(channel.const);
  });

  // Nothing left means `OTP_ENABLED` is false and the route 404s before it
  // reads a body — no request for a narrowed schema to describe, and an empty
  // `oneOf` is not a valid schema.
  if (kept.length === 0 || kept.length === branches.length) return schema;
  return { ...schema, [key]: kept };
}

function applyRequestContractRules(
  key: string | undefined,
  schema: JsonSchema,
  branch: number
): JsonSchema {
  let result = addPagePermissionRules(schema);
  if (key === 'POST /api/dash/users') result = addUserRoleRules(result, false);
  if (key === 'PUT /api/dash/users/:id' && branch === 0)
    result = addUserRoleRules(result, true);
  if (key !== undefined && OTP_SEND_ROUTES.has(key))
    result = restrictToEnabledChannels(result);
  return result;
}

function requestBody(
  schemas: z.ZodType | readonly z.ZodType[],
  key?: string
): JsonSchema | null {
  const list: readonly z.ZodType[] = Array.isArray(schemas)
    ? schemas
    : [schemas as z.ZodType];
  const converted = list
    .map((schema, index) => {
      const json = toJsonSchema(schema);
      return json === null
        ? null
        : applyRequestContractRules(key, withRequiredKeys(schema, json), index);
    })
    .filter((s): s is JsonSchema => s !== null);
  if (converted.length === 0) return null;

  const schema = converted.length === 1 ? converted[0] : { oneOf: converted };

  return {
    required: true,
    content: { 'application/json': { schema } },
  };
}

/** `/api/dash/users/:id` → `/api/dash/users/{id}`, and the parameter list. */
function toOpenApiPath(path: string): {
  path: string;
  parameters: JsonSchema[];
} {
  const parameters: JsonSchema[] = [];
  const converted = path
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment;
      const name = segment.slice(1);
      parameters.push({
        name,
        in: 'path',
        required: true,
        schema: name === 'id' ? UUID_SCHEMA : { type: 'string' },
      });
      return `{${name}}`;
    })
    .join('/');
  return { path: converted, parameters };
}

const UUID_SCHEMA: JsonSchema = {
  type: 'string',
  format: 'uuid',
  pattern: UUID_V7_PATTERN,
};
const DATE_TIME_SCHEMA: JsonSchema = { type: 'string', format: 'date-time' };
const NULL_SCHEMA: JsonSchema = { type: 'null' };
const NULLABLE_STRING_SCHEMA: JsonSchema = { type: ['string', 'null'] };
const NULLABLE_CURSOR_SCHEMA: JsonSchema = {
  type: ['string', 'null'],
  pattern: SESSION_CURSOR_PATTERN,
};

const PAGINATION_META_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    page: { type: 'integer', minimum: 1 },
    perPage: { type: 'integer', minimum: 1 },
    total: { type: 'integer', minimum: 0 },
    pageCount: { type: 'integer', minimum: 0 },
  },
  required: ['page', 'perPage', 'total', 'pageCount'],
  additionalProperties: false,
};

const ERROR_ENVELOPE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    success: { const: false },
    message: { type: 'string' },
    data: NULL_SCHEMA,
  },
  required: ['success', 'message', 'data'],
  additionalProperties: false,
};

function successEnvelopeSchema(
  data: JsonSchema,
  paginated = false
): JsonSchema {
  return {
    type: 'object',
    properties: {
      success: { const: true },
      message: { type: 'string' },
      data,
      ...(paginated && { meta: PAGINATION_META_SCHEMA }),
    },
    required: ['success', 'message', 'data', ...(paginated ? ['meta'] : [])],
    additionalProperties: false,
  };
}

const ERROR_RESPONSE: JsonSchema = {
  description: 'The standard API error envelope.',
  content: { 'application/json': { schema: ERROR_ENVELOPE_SCHEMA } },
};

const PERMISSION_ACTION_PROPERTIES = Object.fromEntries(
  Object.keys(PERMISSION_ACTIONS).map((action) => [action, { type: 'boolean' }])
);
const PARTIAL_ACTIONS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: PERMISSION_ACTION_PROPERTIES,
  additionalProperties: false,
};
const COMPLETE_ACTIONS_SCHEMA: JsonSchema = {
  ...PARTIAL_ACTIONS_SCHEMA,
  required: Object.keys(PERMISSION_ACTIONS),
};
const PAGE_PERMISSION_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', enum: [...DASHBOARD_PAGE_NAMES] },
    permissions: PARTIAL_ACTIONS_SCHEMA,
  },
  required: ['name', 'permissions'],
  additionalProperties: false,
};
const USER_PERMISSION_MATRIX_SCHEMA: JsonSchema = {
  type: 'object',
  properties: Object.fromEntries(
    DASHBOARD_PAGE_NAMES.map((page) => [page, COMPLETE_ACTIONS_SCHEMA])
  ),
  additionalProperties: false,
};
const ROLE_SUMMARY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: UUID_SCHEMA,
    roleName: { type: 'string' },
  },
  required: ['id', 'roleName'],
  additionalProperties: false,
};
const NULLABLE_ROLE_SUMMARY_SCHEMA: JsonSchema = {
  anyOf: [ROLE_SUMMARY_SCHEMA, NULL_SCHEMA],
};
const ROLE_ID_SCHEMA: JsonSchema = {
  anyOf: [UUID_SCHEMA, { const: 'custom' }],
};
const NULLABLE_ROLE_ID_SCHEMA: JsonSchema = {
  anyOf: [UUID_SCHEMA, { const: 'custom' }, NULL_SCHEMA],
};
const SESSION_SUMMARY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: UUID_SCHEMA,
    ipAddress: NULLABLE_STRING_SCHEMA,
    userAgent: NULLABLE_STRING_SCHEMA,
    createdAt: DATE_TIME_SCHEMA,
    isCurrent: { type: 'boolean' },
  },
  required: ['id', 'ipAddress', 'userAgent', 'createdAt', 'isCurrent'],
  additionalProperties: false,
};
const UPDATED_AT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { updatedAt: DATE_TIME_SCHEMA },
  required: ['updatedAt'],
  additionalProperties: false,
};
const CREATED_ID_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { id: UUID_SCHEMA },
  required: ['id'],
  additionalProperties: false,
};
const OTP_SENT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { nextAllowedIn: { const: 30 } },
  required: ['nextAllowedIn'],
  additionalProperties: false,
};
const VERIFIED_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { verified: { const: true } },
  required: ['verified'],
  additionalProperties: false,
};
const CONTACT_CHANGE_SCHEMA: JsonSchema = {
  oneOf: [
    {
      type: 'object',
      properties: { autoVerified: { const: true } },
      required: ['autoVerified'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { otpSent: { const: true } },
      required: ['otpSent'],
      additionalProperties: false,
    },
  ],
};

/**
 * The two ends of a reset. An account with a second factor never gets `reset:
 * true` from `/reset` — it gets a grant, and the password is written by
 * `/complete` against a proven factor. Published as a union so a generated
 * client can represent both, rather than treating the challenge branch as a
 * completed reset.
 */
const RECOVERY_OPTION_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    method: { type: 'string', enum: ['totp', 'otp', 'backup_code'] },
    contactKind: {
      anyOf: [{ type: 'string', enum: ['email', 'phone'] }, { type: 'null' }],
    },
    channel: {
      anyOf: [
        { type: 'string', enum: ['email', 'sms', 'whatsapp'] },
        { type: 'null' },
      ],
    },
  },
  required: ['id', 'method', 'contactKind', 'channel'],
  additionalProperties: false,
};

const RESET_OUTCOME_SCHEMA: JsonSchema = {
  anyOf: [
    {
      type: 'object',
      properties: { reset: { const: true } },
      required: ['reset'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        reset: { const: false },
        twoFactorRequired: { const: true },
        grant: { type: 'string' },
        options: { type: 'array', items: RECOVERY_OPTION_SCHEMA },
        defaultMethod: {
          anyOf: [{ type: 'string' }, { type: 'null' }],
        },
      },
      required: [
        'reset',
        'twoFactorRequired',
        'grant',
        'options',
        'defaultMethod',
      ],
      additionalProperties: false,
    },
  ],
};

const SUCCESS_DATA_SCHEMAS: Record<string, JsonSchema> = {
  'POST /api/auth/forgot-password/reset': RESET_OUTCOME_SCHEMA,
  'POST /api/auth/forgot-password/second-factor/send': OTP_SENT_SCHEMA,
  'POST /api/auth/forgot-password/complete': {
    type: 'object',
    properties: { reset: { const: true } },
    required: ['reset'],
    additionalProperties: false,
  },
  'POST /api/auth/forgot-password/send': OTP_SENT_SCHEMA,
  'POST /api/auth/otp/send': OTP_SENT_SCHEMA,
  'POST /api/auth/otp/verify': VERIFIED_SCHEMA,
  'POST /api/auth/passwordless/send': OTP_SENT_SCHEMA,
  'POST /api/dash/auth/reauth': {
    type: 'object',
    properties: {
      expiresIn: {
        type: 'integer',
        description:
          'Seconds the window lasts. It is bound to THIS session — there is no token to send back, the same cookie carries it.',
      },
    },
    required: ['expiresIn'],
    additionalProperties: false,
  },
  'GET /api/dash/permissions': {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: UUID_SCHEMA,
        roleName: { type: 'string' },
        description: NULLABLE_STRING_SCHEMA,
        isActive: { type: 'boolean' },
        createdAt: DATE_TIME_SCHEMA,
        updatedAt: DATE_TIME_SCHEMA,
        usersCount: { type: 'integer', minimum: 0 },
      },
      required: [
        'id',
        'roleName',
        'description',
        'isActive',
        'createdAt',
        'updatedAt',
        'usersCount',
      ],
      additionalProperties: false,
    },
  },
  'POST /api/dash/permissions': CREATED_ID_SCHEMA,
  'GET /api/dash/permissions/:id': {
    type: 'object',
    properties: {
      id: UUID_SCHEMA,
      roleName: { type: 'string' },
      description: NULLABLE_STRING_SCHEMA,
      isActive: { type: 'boolean' },
      permissions: { type: 'array', items: PAGE_PERMISSION_SCHEMA },
    },
    required: ['id', 'roleName', 'description', 'isActive', 'permissions'],
    additionalProperties: false,
  },
  'PUT /api/dash/permissions/:id': UPDATED_AT_SCHEMA,
  'DELETE /api/dash/permissions/:id': NULL_SCHEMA,
  'GET /api/dash/roles': { type: 'array', items: ROLE_SUMMARY_SCHEMA },
  'POST /api/dash/users/me/change-email': CONTACT_CHANGE_SCHEMA,
  'POST /api/dash/users/me/change-email/verify': VERIFIED_SCHEMA,
  'POST /api/dash/users/:id/two-factor/reset': NULL_SCHEMA,
  'POST /api/dash/users/me/change-password': NULL_SCHEMA,
  'POST /api/dash/users/me/change-phone': CONTACT_CHANGE_SCHEMA,
  'POST /api/dash/users/me/change-phone/verify': VERIFIED_SCHEMA,
  'GET /api/dash/users': {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: UUID_SCHEMA,
        name: { type: 'string' },
        email: { type: 'string', format: 'email' },
        isActive: { type: 'boolean' },
        roleId: ROLE_ID_SCHEMA,
        createdAt: DATE_TIME_SCHEMA,
        updatedAt: DATE_TIME_SCHEMA,
        role: ROLE_SUMMARY_SCHEMA,
      },
      required: [
        'id',
        'name',
        'email',
        'isActive',
        'roleId',
        'createdAt',
        'updatedAt',
        'role',
      ],
      additionalProperties: false,
    },
  },
  'POST /api/dash/users': CREATED_ID_SCHEMA,
  'GET /api/dash/users/:id': {
    type: 'object',
    properties: {
      id: UUID_SCHEMA,
      name: { type: 'string' },
      email: { type: 'string', format: 'email' },
      emailVerified: { type: 'boolean' },
      phoneNumber: NULLABLE_STRING_SCHEMA,
      phoneNumberVerified: { type: 'boolean' },
      isActive: { type: 'boolean' },
      roleId: NULLABLE_ROLE_ID_SCHEMA,
      role: NULLABLE_ROLE_SUMMARY_SCHEMA,
      createdAt: DATE_TIME_SCHEMA,
      updatedAt: DATE_TIME_SCHEMA,
      // The role's rows, mapped exactly as `GET /api/dash/permissions/:id` maps
      // them. NOT `USER_PERMISSION_MATRIX_SCHEMA` — that is the page-keyed
      // shape the SESSION metadata carries.
      permissions: { type: 'array', items: PAGE_PERMISSION_SCHEMA },
      sessions: { type: 'array', items: SESSION_SUMMARY_SCHEMA },
      sessionsHasMore: { type: 'boolean' },
      sessionsNextCursor: NULLABLE_CURSOR_SCHEMA,
    },
    required: [
      'id',
      'name',
      'email',
      'emailVerified',
      'phoneNumber',
      'phoneNumberVerified',
      'isActive',
      'roleId',
      'role',
      'createdAt',
      'updatedAt',
      'permissions',
    ],
    dependentRequired: {
      sessions: ['sessionsHasMore', 'sessionsNextCursor'],
      sessionsHasMore: ['sessions', 'sessionsNextCursor'],
      sessionsNextCursor: ['sessions', 'sessionsHasMore'],
    },
    additionalProperties: false,
  },
  'PUT /api/dash/users/:id': UPDATED_AT_SCHEMA,
  'DELETE /api/dash/users/:id': NULL_SCHEMA,
  'GET /api/dash/users/:id/sessions': {
    type: 'object',
    properties: {
      sessions: { type: 'array', items: SESSION_SUMMARY_SCHEMA },
      nextCursor: NULLABLE_CURSOR_SCHEMA,
    },
    required: ['sessions', 'nextCursor'],
    additionalProperties: false,
  },
  'DELETE /api/dash/users/:id/sessions': {
    type: 'object',
    properties: {
      revoked: { type: 'array', items: UUID_SCHEMA, uniqueItems: true },
    },
    required: ['revoked'],
    additionalProperties: false,
  },
  'POST /api/upload/image': { type: 'array', items: { type: 'string' } },
  'POST /api/dev/sign-up': CREATED_ID_SCHEMA,
};

const PAGINATED_SUCCESS_ROUTES = new Set([
  'GET /api/dash/permissions',
  'GET /api/dash/users',
]);

/**
 * Routes whose success calls `refreshSessionCookies`. A client that ignores the
 * new `Set-Cookie` keeps presenting a token the change just invalidated.
 */
const SESSION_COOKIE_ROUTES = new Set([
  'POST /api/dash/users/me/change-email',
  'POST /api/dash/users/me/change-email/verify',
]);

const SET_COOKIE_HEADER: JsonSchema = {
  'Set-Cookie': {
    description:
      'Re-issued session cookie. The token presented on this request is no longer valid.',
    schema: { type: 'string' },
  },
};

function successResponseFor(key: string): JsonSchema {
  const data = SUCCESS_DATA_SCHEMAS[key];
  if (!data) throw new Error(`No success data schema for ${key}`);
  return {
    description: 'Success.',
    ...(SESSION_COOKIE_ROUTES.has(key) && { headers: SET_COOKIE_HEADER }),
    content: {
      'application/json': {
        schema: successEnvelopeSchema(data, PAGINATED_SUCCESS_ROUTES.has(key)),
      },
    },
  };
}

const STORAGE_CHECKS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    journalModeWal: { type: 'boolean' },
    schemaVersion: { type: 'boolean' },
    busyTimeout: { type: 'boolean' },
    synchronousNormal: { type: 'boolean' },
    postgres: { type: 'boolean' },
    quickCheck: { type: 'boolean' },
    writable: { type: 'boolean' },
  },
  required: [
    'journalModeWal',
    'schemaVersion',
    'busyTimeout',
    'synchronousNormal',
    'postgres',
  ],
  additionalProperties: false,
};

const STORAGE_RESPONSES: JsonSchema = {
  '200': {
    description: 'Every configured storage readiness check passed.',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            status: { const: 'ok' },
            checks: STORAGE_CHECKS_SCHEMA,
          },
          required: ['status', 'checks'],
          additionalProperties: false,
        },
      },
    },
  },
  '401': {
    description:
      'The deep probe was requested without the configured maintenance token.',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: { status: { const: 'unauthorized' } },
          required: ['status'],
          additionalProperties: false,
        },
      },
    },
  },
  '503': {
    description: 'A readiness check failed or the storage probe errored.',
    content: {
      'application/json': {
        schema: {
          oneOf: [
            {
              type: 'object',
              properties: {
                status: { const: 'degraded' },
                checks: STORAGE_CHECKS_SCHEMA,
              },
              required: ['status', 'checks'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: { status: { const: 'error' } },
              required: ['status'],
              additionalProperties: false,
            },
          ],
        },
      },
    },
  },
};

const OPENAPI_DOCUMENT_RESPONSE: JsonSchema = {
  description: 'The OpenAPI 3.1 contract for this deployment.',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          openapi: { const: '3.1.1' },
          info: { type: 'object' },
          servers: { type: 'array' },
          tags: { type: 'array' },
          components: { type: 'object' },
          paths: { type: 'object' },
        },
        required: ['openapi', 'info', 'servers', 'tags', 'components', 'paths'],
        additionalProperties: true,
      },
    },
  },
};

/**
 * The two responses the pre-auth admission limiter produces.
 *
 * Shared, because the limiter is: `enforcePreAuthIpLimit` runs for every
 * `preAuth: 'ip-limit'` route AND for every path under the Better Auth prefix
 * (`app.ts`), and both call sites hand the failure to `handleApiError` — so the
 * body is this API's envelope even where the handler's own body is not.
 */
const PRE_AUTH_RESPONSES: JsonSchema = {
  '429': {
    description: 'Per-IP admission limit. See `Retry-After`.',
    headers: {
      'Retry-After': {
        description: 'Seconds until the caller should retry.',
        schema: { type: 'integer', minimum: 1 },
      },
      'X-RateLimit-Limit': {
        description: 'Request or cost budget for the active window.',
        schema: { type: 'integer', minimum: 1 },
      },
      'X-RateLimit-Remaining': {
        description: 'Budget remaining in the active window.',
        schema: { type: 'integer', minimum: 0 },
      },
    },
    content: { 'application/json': { schema: ERROR_ENVELOPE_SCHEMA } },
  },
  '503': {
    description: 'The admission limiter store is unavailable and fails closed.',
    headers: {
      'Retry-After': {
        description: 'Seconds until the caller should retry.',
        schema: { type: 'integer', minimum: 1 },
      },
    },
    content: { 'application/json': { schema: ERROR_ENVELOPE_SCHEMA } },
  },
};

const BETTER_AUTH_STATUS_DESCRIPTIONS = {
  '404':
    'The Better Auth endpoint is unavailable in the current feature configuration.',
  '500': 'Better Auth, or one of its dependencies, failed.',
  '400': 'Required request input was absent or invalid for this endpoint.',
  '401':
    'Credentials refused, or the session this request would create is not allowed to exist (inactive user, inactive role).',
  '403':
    'Captcha verification failed, the request origin is not trusted, or the account has an unverified contact channel.',
  '422':
    'The submitted fields failed this project’s own schema for the endpoint.',
  '409':
    'The request would leave the account in a state this application refuses — removing the only enrolled second factor.',
} as const;

function generatedBetterAuthOperation(
  path: string,
  method: HttpMethod
): JsonSchema | null {
  const pathItem = BETTER_AUTH_OPENAPI.paths[path];
  if (!isJsonSchema(pathItem)) return null;
  const operation = pathItem[method.toLowerCase()];
  return isJsonSchema(operation) ? operation : null;
}

function generatedBetterAuthResponse(
  path: string,
  method: HttpMethod,
  status: string
): JsonSchema | null {
  const operation = generatedBetterAuthOperation(path, method);
  if (!operation || !isJsonSchema(operation.responses)) return null;
  const response = operation.responses[status];
  if (!isJsonSchema(response)) return null;
  const normalized = normalizeOpenApi31(response);
  return isJsonSchema(normalized) ? normalized : null;
}

/**
 * Statuses reachable on SOME allowlisted paths only.
 *
 * Per path, keyed exactly like `BETTER_AUTH_BODIES`, because the reachable set
 * genuinely differs. `/get-session` is a GET, so the origin check that produces
 * 403 does not apply and an absent session is a 200 carrying `null`, not a 401;
 * `/sign-in/email` and `/passwordless/verify` both create a session and so run
 * the `session.create` database hook in `lib/auth.ts`, which is what can refuse
 * 401 or 403. One set for all four would advertise refusals `/get-session`
 * cannot make.
 */
const BETTER_AUTH_PATH_STATUSES: Record<
  string,
  readonly (keyof typeof BETTER_AUTH_STATUS_DESCRIPTIONS)[]
> = {
  '/sign-in/email': ['400', '401', '403', '422'],
  '/sign-out': ['400', '403'],
  '/passwordless/verify': ['400', '401', '403', '422'],
  // 403 across the POST paths is Better Auth's own origin check, which engages
  // on any request carrying a cookie (`validateOrigin`) and so refuses a
  // session-bearing call with no `origin` header before the handler runs. It is
  // absent from the GET paths, where that check is skipped.
  '/two-factor/disable': ['401', '403', '422'],
  '/two-factor/get-totp-uri': ['401', '403', '422'],
  // 409 is the refusal to replace an authenticator that already works.
  '/two-factor/totp/start': ['401', '403', '404', '409', '422'],
  '/two-factor/totp/confirm': ['400', '401', '403', '404', '409', '422'],
  '/two-factor/verify-totp': ['400', '403', '422'],
  '/two-factor/generate-backup-codes': ['401', '403', '404', '422'],
  '/two-factor/verify-backup-code': ['400', '403', '422'],
  '/two-factor/otp/send': ['400', '401', '403', '422'],
  '/two-factor/otp/verify': ['400', '401', '403', '422'],
  '/two-factor/passkey/options': ['400', '401', '403', '422'],
  '/two-factor/passkey/verify': ['400', '401', '403', '422'],
  '/two-factor/trust-device': ['401', '403', '422'],
  '/two-factor/trusted-devices': ['401'],
  '/two-factor/trusted-devices/revoke': ['401', '403', '422'],
  '/two-factor/methods': ['401'],
  // 409 is the last-method refusal.
  '/two-factor/methods/disable': ['401', '403', '404', '409', '422'],
  '/two-factor/methods/default': ['401', '403', '404', '422'],
  '/two-factor/passkey/grant': ['401', '403', '404', '422'],
  '/two-factor/backup-codes/acknowledge': ['401', '403', '422'],
  '/passkey/generate-register-options': ['401'],
  '/passkey/verify-registration': ['400', '401', '403', '422'],
  '/passkey/list-user-passkeys': ['401'],
  // 404 is a passkey that is not the caller's; 409 the last-method refusal.
  '/passkey/delete-passkey': ['400', '401', '403', '404', '409', '422'],
  '/passkey/update-passkey': ['400', '401', '403', '422'],
};

/** What an `APIError` serialises to. `code` is not required — the shape is the dependency's. */
const BETTER_AUTH_ERROR_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { message: { type: 'string' }, code: { type: 'string' } },
  required: ['message'],
};

/**
 * Paths that throttle from INSIDE the endpoint as well as from the wildcard's
 * admission limiter, and so answer 429/503 in two body shapes: the wildcard's
 * goes to `handleApiError` (envelope), an inner `CustomError` goes to
 * `toAuthApiError`. Only `/passwordless/verify` has an inner limiter, and
 * Better Auth's own `rateLimit` is disabled.
 */
const BETTER_AUTH_LOCAL_THROTTLE_PATHS = new Set([
  '/passwordless/verify',
  // Both reach `enforceOtpSurfaceSendQuota` / `enforceOtpVerifyQuota`, whose
  // `CustomError` becomes a 429 with `Retry-After` — or a 503 when the limiter
  // store itself is unavailable — through `toAuthApiError`.
  '/two-factor/otp/send',
  '/two-factor/otp/verify',
]);

/** Widen one admission-limiter response to admit Better Call's shape too. */
function withBetterAuthErrorShape(
  response: unknown,
  detail: string
): JsonSchema {
  if (!isJsonSchema(response)) return BETTER_AUTH_ERROR_SCHEMA;
  const content = isJsonSchema(response.content) ? response.content : {};
  const json = isJsonSchema(content['application/json'])
    ? content['application/json']
    : {};
  return {
    ...response,
    description: `${String(response.description ?? '')} ${detail}`.trim(),
    content: {
      ...content,
      'application/json': {
        ...json,
        // `anyOf`: the envelope satisfies the Better Call shape too, so
        // exactly-one would fail on the body the limiter actually sends.
        schema: { anyOf: [json.schema, BETTER_AUTH_ERROR_SCHEMA] },
      },
    },
  };
}

/**
 * The second 200 both first-factor endpoints can answer.
 *
 * ⚠️ Neither is derivable from Better Auth's generated contract: the plugin's own
 * challenge hook is replaced (`twoFactorSignInGuard`), and `/passwordless/verify`
 * is this project's endpoint. A client generated from a document without this
 * reads the challenge branch as a completed session and treats a user who has
 * NOT finished signing in as signed in.
 */
const TWO_FACTOR_OPTION_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description:
        'Stable option identity: `totp`, `backup_code`, `passkey`, `otp:email` or `otp:phone`.',
    },
    method: {
      type: 'string',
      enum: ['totp', 'otp', 'backup_code', 'passkey'],
    },
    contactKind: {
      anyOf: [{ type: 'string', enum: ['email', 'phone'] }, { type: 'null' }],
    },
    channel: {
      anyOf: [
        { type: 'string', enum: ['email', 'sms', 'whatsapp'] },
        { type: 'null' },
      ],
    },
    nextAllowedIn: {
      type: 'integer',
      minimum: 0,
      description:
        '`otp` options only: seconds before a code may be sent to this contact. `0` means a send is allowed now.',
    },
  },
  required: ['id', 'method', 'contactKind', 'channel'],
};

const TWO_FACTOR_CHALLENGE_SCHEMA: JsonSchema = {
  type: 'object',
  description:
    'The first factor succeeded and the login is NOT complete: no session cookie is set, and one of the options below has to be verified next.',
  properties: {
    twoFactorRedirect: { const: true },
    twoFactorMethods: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['totp', 'otp', 'backup_code', 'passkey'],
      },
      description:
        'Distinct method names. Two OTP channels collapse into one entry here, so it cannot drive a choice — use `twoFactorOptions`.',
    },
    twoFactorOptions: { type: 'array', items: TWO_FACTOR_OPTION_SCHEMA },
    defaultMethod: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description:
        '`null` means ask: only recovery material is left, and a backup code is never auto-routed to.',
    },
  },
  required: [
    'twoFactorRedirect',
    'twoFactorMethods',
    'twoFactorOptions',
    'defaultMethod',
  ],
};

/** The paths whose 200 is a union of "signed in" and "challenged". */
const TWO_FACTOR_CHALLENGE_PATHS: ReadonlySet<string> = new Set([
  '/sign-in/email',
  '/passwordless/verify',
]);

/** Widens one 200 to admit the challenge branch alongside the completed one. */
function withTwoFactorChallengeBranch(response: unknown): JsonSchema {
  if (!isJsonSchema(response))
    return {
      content: {
        'application/json': { schema: TWO_FACTOR_CHALLENGE_SCHEMA },
      },
    };
  const content = isJsonSchema(response.content) ? response.content : {};
  const json = isJsonSchema(content['application/json'])
    ? content['application/json']
    : {};
  return {
    ...response,
    description:
      `${String(response.description ?? '')} A two-factor account is answered with the challenge branch instead, and no session cookie.`.trim(),
    content: {
      ...content,
      'application/json': {
        ...json,
        // `anyOf`: the two shapes share no required key, so a client can tell
        // them apart on `twoFactorRedirect` alone.
        schema: { anyOf: [json.schema, TWO_FACTOR_CHALLENGE_SCHEMA] },
      },
    },
  };
}

function betterAuthResponses(path: string, method: HttpMethod): JsonSchema {
  const statuses = [
    '200',
    '404',
    '500',
    ...(BETTER_AUTH_PATH_STATUSES[path] ?? []),
  ];
  const responses: JsonSchema = { ...PRE_AUTH_RESPONSES };

  if (BETTER_AUTH_LOCAL_THROTTLE_PATHS.has(path)) {
    responses['429'] = withBetterAuthErrorShape(
      responses['429'],
      'The endpoint’s own per-destination verify quota answers here too, in Better Auth’s error shape.'
    );
    responses['503'] = withBetterAuthErrorShape(
      responses['503'],
      'That quota is fail-closed, so a degraded limiter store refuses here in Better Auth’s error shape.'
    );
  }

  for (const status of statuses) {
    const generated = generatedBetterAuthResponse(
      path,
      method,
      status === '422' ? '400' : status
    );
    responses[status] = {
      ...generated,
      ...(status in BETTER_AUTH_STATUS_DESCRIPTIONS && {
        description:
          BETTER_AUTH_STATUS_DESCRIPTIONS[
            status as keyof typeof BETTER_AUTH_STATUS_DESCRIPTIONS
          ],
      }),
    };
  }

  if (method === 'POST' && TWO_FACTOR_CHALLENGE_PATHS.has(path))
    responses['200'] = withTwoFactorChallengeBranch(responses['200']);

  return responses;
}

/**
 * Responses derived from route policy and the handler-level status inventory.
 * A wrong method is a different request, so 405 belongs to the routing boundary,
 * not to every correctly selected operation.
 */
function commonResponses(entry: RouteManifestEntry): JsonSchema {
  if (entry.response === 'storage-health') return { ...STORAGE_RESPONSES };

  const key = `${entry.method} ${entry.path}`;
  const success = CREATED_ROUTES.has(key) ? '201' : '200';
  const responses: JsonSchema = {
    '500': {
      ...ERROR_RESPONSE,
      description: 'An unexpected server or dependency failure occurred.',
    },
    [success]:
      entry.response === 'openapi-document'
        ? OPENAPI_DOCUMENT_RESPONSE
        : successResponseFor(key),
  };

  if (NOT_FOUND_ROUTES.has(key))
    responses['404'] = {
      ...ERROR_RESPONSE,
      description:
        'The target does not exist, is outside the caller’s visible scope, or the feature is disabled.',
    };

  // A body route rejects an absent or malformed body with 400 (`requireJsonBody`,
  // `utils/api-response.ts`) before its schema ever runs. Documented because it
  // is the response a client gets for the mistake it is most likely to make.
  if (entry.body !== 'none' || BODYLESS_BAD_REQUEST_ROUTES.has(key))
    responses['400'] = {
      description:
        entry.body === 'none'
          ? 'The operation violates a handler-level business rule.'
          : 'The request body is absent, empty, not parseable, or violates a handler-level business rule.',
      content: { 'application/json': { schema: ERROR_ENVELOPE_SCHEMA } },
    };

  if (CONFLICT_ROUTES.has(key))
    responses['409'] = {
      description: 'A unique value or permission assignment already exists.',
      content: { 'application/json': { schema: ERROR_ENVELOPE_SCHEMA } },
    };

  // 422 is the standard validation failure, and it is NOT limited to body
  // routes: every route with a path parameter validates it and answers 422 on a
  // malformed id (`app/api/dash/users/[id]/handler.ts`, `.../permissions/[id]`,
  // `.../sessions`). Both conditions are readable from the manifest, which is
  // why they belong here rather than in a per-route table.
  if (
    entry.body === 'json' ||
    entry.path.includes(':') ||
    QUERY_VALIDATION_ROUTES.has(key)
  )
    responses['422'] = {
      description:
        'Validation failed — a schema field, or a path parameter, was rejected.',
      content: { 'application/json': { schema: ERROR_ENVELOPE_SCHEMA } },
    };

  // The refusals the route's own authorisation produces, from the one field that
  // states them. Measured unauthenticated, every one of `GET /api/dash/users`,
  // `POST /api/dash/users/me/change-password`, `POST /api/upload/image` and
  // `GET /openapi.json` answers 401 — and none of them said so.
  if (entry.auth !== 'public') {
    responses['401'] = {
      description: 'No session, or the session row is no longer live.',
      content: { 'application/json': { schema: ERROR_ENVELOPE_SCHEMA } },
    };
  }

  // Two unrelated routes to the same status, so it is derived from both fields.
  // A captcha refusal reaches `public` routes that no session guards at all —
  // measured, `POST /api/auth/otp/send` with no `x-captcha-response` answers 403
  // in this envelope — and the five `/api/dash/users/me/*` routes answer it
  // after their session check passes.
  if (entry.auth === 'permission' || entry.captcha)
    responses['403'] = {
      description:
        entry.auth === 'permission'
          ? entry.captcha
            ? 'The caller lacks the required authority or failed the required captcha.'
            : 'The caller lacks the grant, scope or role authority this route requires.'
          : 'The captcha this route requires was absent or rejected.',
      content: { 'application/json': { schema: ERROR_ENVELOPE_SCHEMA } },
    };

  if (entry.preAuth === 'ip-limit' || entry.handlerRateLimit)
    Object.assign(responses, PRE_AUTH_RESPONSES);

  // AFTER the limiter block, which owns the same status and would overwrite it.
  const throttle = responses['503'];
  if (CHANNEL_UNAVAILABLE_ROUTES.has(key) && isJsonSchema(throttle))
    responses['503'] = {
      ...throttle,
      description:
        'The admission limiter store is unavailable and fails closed, or no OTP channel able to verify this contact is enabled.',
    };

  return responses;
}

function openApiConsistencyProblems(
  manifest: readonly RouteManifestEntry[]
): string[] {
  const problems: string[] = [];
  const keys = new Set(
    manifest.map((entry) => `${entry.method} ${entry.path}`)
  );

  for (const entry of manifest) {
    const key = `${entry.method} ${entry.path}`;
    if (!(key in OPERATION_DOCS))
      problems.push(`${key} has no OPERATION_DOCS entry`);
    if (entry.response === 'envelope' && !(key in SUCCESS_DATA_SCHEMAS))
      problems.push(`${key} has no concrete success data schema`);
    // Multipart schemas come from route policy; JSON schemas are explicit.
    if (entry.body === 'json' && !(key in REQUEST_BODIES))
      problems.push(
        `${key} declares body: 'json' but has no REQUEST_BODIES entry`
      );
    if (entry.body !== 'json' && key in REQUEST_BODIES)
      problems.push(
        `${key} has a REQUEST_BODIES entry but declares body: '${entry.body}'`
      );
  }

  // Catch schemas left behind after a route is renamed or removed. Keys for
  // routes the production filter withholds are not leftovers — the route still
  // exists, it is only unpublished — so they are exempt rather than reported.
  const isLeftover = (key: string): boolean =>
    !keys.has(key) && !isDevelopmentOnlyPath(key.slice(key.indexOf(' ') + 1));

  for (const key of Object.keys(REQUEST_BODIES))
    if (isLeftover(key))
      problems.push(`REQUEST_BODIES has '${key}', which is not a route`);
  for (const key of CREATED_ROUTES)
    if (isLeftover(key))
      problems.push(`CREATED_ROUTES has '${key}', which is not a route`);
  for (const key of CONFLICT_ROUTES)
    if (isLeftover(key))
      problems.push(`CONFLICT_ROUTES has '${key}', which is not a route`);
  for (const key of BODYLESS_BAD_REQUEST_ROUTES)
    if (isLeftover(key))
      problems.push(
        `BODYLESS_BAD_REQUEST_ROUTES has '${key}', which is not a route`
      );
  for (const key of NOT_FOUND_ROUTES)
    if (isLeftover(key))
      problems.push(`NOT_FOUND_ROUTES has '${key}', which is not a route`);
  for (const key of QUERY_VALIDATION_ROUTES)
    if (isLeftover(key))
      problems.push(
        `QUERY_VALIDATION_ROUTES has '${key}', which is not a route`
      );
  for (const key of CHANNEL_UNAVAILABLE_ROUTES)
    if (isLeftover(key))
      problems.push(
        `CHANNEL_UNAVAILABLE_ROUTES has '${key}', which is not a route`
      );
  for (const key of SESSION_COOKIE_ROUTES)
    if (isLeftover(key))
      problems.push(`SESSION_COOKIE_ROUTES has '${key}', which is not a route`);
  for (const key of OTP_SEND_ROUTES)
    if (isLeftover(key))
      problems.push(`OTP_SEND_ROUTES has '${key}', which is not a route`);
  for (const key of Object.keys(OPERATION_DOCS))
    if (isLeftover(key))
      problems.push(`OPERATION_DOCS has '${key}', which is not a route`);
  for (const key of Object.keys(SUCCESS_DATA_SCHEMAS))
    if (isLeftover(key))
      problems.push(`SUCCESS_DATA_SCHEMAS has '${key}', which is not a route`);
  for (const key of PAGINATED_SUCCESS_ROUTES)
    if (isLeftover(key))
      problems.push(
        `PAGINATED_SUCCESS_ROUTES has '${key}', which is not a route`
      );
  // A body belongs to a POST, but most of these paths are gated on a method
  // flag, so the enabled table cannot be the reference: under an empty
  // `NEXT_PUBLIC_ENABLED_2FA_METHODS` every two-factor body would be reported
  // as a defect. Same distinction the statuses check below makes — existence
  // against the servable-under-any-configuration set, and the method dimension
  // only where the current configuration actually serves the path.
  for (const key of Object.keys(BETTER_AUTH_BODIES)) {
    if (!BETTER_AUTH_KNOWN_PATHS.has(key))
      problems.push(
        `BETTER_AUTH_BODIES has '${key}', which is not a Better Auth endpoint`
      );
    else if (
      BETTER_AUTH_ALLOWED_PATH_SET.has(key) &&
      !betterAuthServes(key, 'POST')
    )
      problems.push(
        `BETTER_AUTH_BODIES has '${key}', which is served but not under POST`
      );
  }
  // Against the paths servable under ANY configuration: a documented path a
  // method flag switched off is correct, one that exists nowhere is a typo.
  for (const key of Object.keys(BETTER_AUTH_PATH_STATUSES))
    if (!BETTER_AUTH_KNOWN_PATHS.has(key))
      problems.push(
        `BETTER_AUTH_PATH_STATUSES has '${key}', which is not a Better Auth endpoint`
      );

  // The catalogue must cover the enabled set, or the leftover checks above stop
  // meaning anything.
  for (const endpoint of BETTER_AUTH_ENDPOINTS)
    if (!BETTER_AUTH_KNOWN_PATHS.has(endpoint.path))
      problems.push(
        `BETTER_AUTH_KNOWN_PATHS is missing '${endpoint.path}', which is served`
      );

  for (const endpoint of BETTER_AUTH_ENDPOINTS)
    for (const method of endpoint.methods) {
      if (!(`${method} ${endpoint.path}` in BETTER_AUTH_SUMMARIES))
        problems.push(
          `Better Auth ${method} ${endpoint.path} has no summary entry`
        );
      const operation = generatedBetterAuthOperation(endpoint.path, method);
      if (operation) {
        for (const status of ['200', '400', '404', '500'])
          if (!generatedBetterAuthResponse(endpoint.path, method, status))
            problems.push(
              `Better Auth's generated schema has no ${status} response for ${method} ${endpoint.path}`
            );
      } else
        problems.push(
          `Better Auth's generated schema has no ${method} ${endpoint.path}`
        );
    }

  for (const key of Object.keys(BETTER_AUTH_SUMMARIES)) {
    const path = key.slice(key.indexOf(' ') + 1);
    if (!BETTER_AUTH_KNOWN_PATHS.has(path))
      problems.push(
        `BETTER_AUTH_SUMMARIES has '${key}', which is not a Better Auth endpoint`
      );
  }

  return problems;
}

function referencedBetterAuthSchemas(paths: JsonSchema): JsonSchema {
  const normalized = normalizeOpenApi31(BETTER_AUTH_OPENAPI.components.schemas);
  if (!isJsonSchema(normalized)) return {};

  const referenced = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isJsonSchema(value)) return;
    const ref = value.$ref;
    if (typeof ref === 'string') {
      const match = /^#\/components\/schemas\/(.+)$/.exec(ref);
      if (match?.[1] && !referenced.has(match[1])) {
        referenced.add(match[1]);
        visit(normalized[match[1]]);
      }
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(paths);

  const selected = Object.fromEntries(
    [...referenced]
      .filter((name) => isJsonSchema(normalized[name]))
      .map((name) => [name, normalized[name]])
  ) as JsonSchema;

  const user = selected.User;
  if (isJsonSchema(user) && isJsonSchema(user.properties)) {
    const properties = Object.fromEntries(
      // Configured `returned: false`; the upstream generator does not honour it.
      Object.entries(user.properties).filter(([name]) => name !== 'roleName')
    );
    selected.User = {
      ...user,
      properties: {
        ...properties,
        id: UUID_SCHEMA,
        email: { type: 'string', format: 'email' },
        image: { type: ['string', 'null'] },
        roleId: {
          type: ['string', 'null'],
          pattern: UUID_V7_PATTERN,
        },
      },
    };
  }

  const session = selected.Session;
  if (isJsonSchema(session) && isJsonSchema(session.properties)) {
    selected.Session = {
      ...session,
      properties: {
        ...session.properties,
        id: UUID_SCHEMA,
        userId: UUID_SCHEMA,
        ipAddress: NULLABLE_STRING_SCHEMA,
        userAgent: NULLABLE_STRING_SCHEMA,
        metadata: {
          type: 'object',
          properties: {
            roleId: { type: ['string', 'null'], pattern: UUID_V7_PATTERN },
            roleName: NULLABLE_STRING_SCHEMA,
            roleScope: {
              type: ['string', 'null'],
              enum: ['system', 'standard', 'custom', null],
            },
            permissions: USER_PERMISSION_MATRIX_SCHEMA,
          },
          additionalProperties: false,
          default: {},
          readOnly: true,
        },
      },
    };
  }

  return selected;
}

/**
 * Builds the document. Called per request rather than at module load so a
 * conversion failure cannot prevent the server from booting.
 *
 * THROWS on an inconsistent document rather than serving one. A contract that is
 * confidently wrong is worse than one that is unavailable: a generator consumes
 * it without complaint and every client built from it is wrong in the same way.
 *
 * Exported for `tests/unit/openapi-contract.test.ts`, which is the gate that
 * catches it. That used to be the boot smoke test asserting 200 on the route —
 * which stopped working when the route became authenticated, and was the weaker
 * gate anyway: it needed a running server and a deploy to fail, where the unit
 * test fails on `bun run test`.
 */
export function openApiDocument(
  manifest: readonly RouteManifestEntry[] = []
): JsonSchema {
  const problems = openApiConsistencyProblems(manifest);
  if (problems.length > 0)
    throw new Error(
      `OpenAPI document is inconsistent with the route table:\n  ${problems.join('\n  ')}`
    );

  const paths: Record<string, JsonSchema> = {};

  for (const entry of manifest) {
    const { path, parameters } = toOpenApiPath(entry.path);
    // Query parameters come from the route table, not from the path. They are the
    // one part of a request that no other artefact reveals, and the upload route's
    // `resource` is required — a client that omits it gets a 400 it could not have
    // anticipated from this document.
    const queryParams = entry.query ?? [];
    for (const param of queryParams) {
      const schema: JsonSchema = {
        type: param.type ?? 'string',
        ...(param.enum && { enum: [...param.enum] }),
        ...(param.minimum !== undefined && { minimum: param.minimum }),
        ...(param.maximum !== undefined && { maximum: param.maximum }),
        ...(param.minLength !== undefined && { minLength: param.minLength }),
        ...(param.maxLength !== undefined && { maxLength: param.maxLength }),
        ...(param.pattern !== undefined && { pattern: param.pattern }),
      };
      parameters.push({
        name: param.name,
        in: 'query',
        required: param.required,
        description: param.description,
        schema,
        ...(param.example !== undefined && { example: param.example }),
      });
    }
    if (entry.captcha)
      parameters.push({
        name: 'x-captcha-response',
        in: 'header',
        required: true,
        description: 'Cloudflare Turnstile response token.',
        schema: {
          type: 'string',
          minLength: 1,
          maxLength: CAPTCHA_TOKEN_MAX_LENGTH,
        },
      });
    if (entry.response === 'storage-health')
      parameters.push({
        name: 'x-maintenance-token',
        in: 'header',
        required: false,
        description: 'Required when `deep=1`; ignored by the cheap probe.',
        schema: { type: 'string', minLength: 1 },
      });

    const key = `${entry.method} ${entry.path}`;
    const docs = OPERATION_DOCS[key];
    if (!docs) throw new Error(`No operation documentation for ${key}`);
    const operation: JsonSchema = {
      operationId: `${entry.method.toLowerCase()}${entry.path.replaceAll(/[^a-zA-Z0-9]/g, '_')}`,
      summary: docs.summary,
      tags: [docs.tag],
      responses: commonResponses(entry),
      security: entry.auth === 'public' ? [] : [{ sessionCookie: [] }],
    };
    if (parameters.length > 0) operation.parameters = parameters;

    const schemas = REQUEST_BODIES[key];
    if (schemas) {
      const body = requestBody(schemas, key);
      if (body) operation.requestBody = body;
    } else if (entry.body === 'multipart') {
      operation.requestBody = {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: {
                files: {
                  type: 'string',
                  format: 'binary',
                  'x-allowed-content-types': [...ALLOWED_IMAGE_TYPES],
                  maxLength: MAX_IMAGE_SIZE * 1024 * 1024,
                  description:
                    `Exactly one PNG, WebP or SVG file. Maximum ${MAX_IMAGE_SIZE} MiB, ` +
                    `${MAX_IMAGE_PIXELS.toLocaleString('en-US')} decoded pixels, and ${MAX_IMAGE_EDGE.toLocaleString('en-US')} pixels on either edge.`,
                },
              },
              required: ['files'],
              additionalProperties: false,
            },
          },
        },
      };
    }

    paths[path] = { ...paths[path], [entry.method.toLowerCase()]: operation };
  }

  for (const endpoint of BETTER_AUTH_ENDPOINTS) {
    const full = `/api/auth${endpoint.path}`;
    const schema = BETTER_AUTH_BODIES[endpoint.path];
    const slug = endpoint.path.replaceAll(/[^a-zA-Z0-9]/g, '_');

    // A FRESH operation object per method, with the method in the id.
    // `operationId` must be unique across the whole document (OpenAPI 3.1
    // §4.8.10); sharing one object between `get` and `post` emitted four
    // duplicate ids and made the document invalid for every generator.
    const build = (method: HttpMethod): JsonSchema => {
      const generated = generatedBetterAuthOperation(endpoint.path, method);
      const summary =
        BETTER_AUTH_SUMMARIES[`${method} ${endpoint.path}`] ??
        `Better Auth ${method} ${endpoint.path}`;
      const operation: JsonSchema = {
        operationId: `betterAuth_${method.toLowerCase()}${slug}`,
        summary,
        tags: ['Authentication'],
        description:
          'Served by Better Auth, which owns its own routing, validation and ' +
          'response shapes under this prefix. Every Better Auth path outside ' +
          'this list is answered 404 by the before-hook in lib/auth.ts.',
        responses: betterAuthResponses(endpoint.path, method),
        security:
          endpoint.path === '/get-session' || endpoint.path === '/sign-out'
            ? [{}, { sessionCookie: [] }]
            : [],
      };
      const parameters: JsonSchema[] = [];
      if (method === 'GET' && endpoint.path === '/get-session')
        parameters.push(
          {
            name: 'disableCookieCache',
            in: 'query',
            required: false,
            description:
              'Read the database-backed session instead of the signed cookie cache.',
            schema: { type: 'boolean' },
          },
          {
            name: 'disableRefresh',
            in: 'query',
            required: false,
            description: 'Do not refresh session expiry during this read.',
            schema: { type: 'boolean' },
          }
        );
      if (endpoint.captcha)
        parameters.push({
          name: 'x-captcha-response',
          in: 'header',
          required: true,
          description: 'Cloudflare Turnstile response token.',
          schema: {
            type: 'string',
            minLength: 1,
            maxLength: CAPTCHA_TOKEN_MAX_LENGTH,
          },
        });
      if (parameters.length > 0) operation.parameters = parameters;
      // Only the method that carries it. A documented request body on `GET`
      // describes a request no client can make.
      if (schema && method === 'POST') {
        const body = requestBody(schema);
        if (body) operation.requestBody = body;
      } else if (method === 'POST' && isJsonSchema(generated?.requestBody)) {
        const normalized = normalizeOpenApi31(generated.requestBody);
        if (isJsonSchema(normalized)) operation.requestBody = normalized;
      }
      return operation;
    };

    // Only the methods this path DECLARES. Emitting `get` and `post` for all of
    // them told generated clients that `GET /sign-out`, `GET /sign-in/email` and
    // `GET /passwordless/verify` were supported operations; the first and third
    // answer 404 and the second reaches the captcha plugin before its method is
    // rejected.
    paths[full] = Object.fromEntries(
      endpoint.methods.map((method) => {
        // `toLowerCase()` on a literal union widens to `string`, so the type has
        // to be restated. `Lowercase<HttpMethod>` rather than `'get' | 'post'`:
        // `methods` admits PUT and DELETE, and the narrower cast made a future
        // entry silently MISLABELLED in the published document instead of
        // failing the build.
        const verb = method.toLowerCase() as Lowercase<HttpMethod>;
        return [verb, build(method)];
      })
    );
  }

  return {
    openapi: '3.1.1',
    info: {
      title: 'Dashboard API',
      version: '0.1.0',
      license: {
        name: 'Private; redistribution is not licensed',
        identifier: 'LicenseRef-Proprietary',
      },
      description:
        'Generated from the route manifest in `routes.ts` and the Zod schemas the handlers validate with. Not hand-maintained.',
    },
    servers: [
      {
        url: '/',
        description: 'The same origin that served this document.',
      },
    ],
    tags: [
      {
        name: 'Authentication',
        description: 'Sign-in, sign-out, password recovery, and OTP flows.',
      },
      {
        name: 'Account',
        description: 'Authenticated self-service account changes.',
      },
      {
        name: 'Permissions',
        description: 'Dashboard roles and permission matrices.',
      },
      { name: 'Users', description: 'Dashboard user administration.' },
      {
        name: 'Sessions',
        description: 'User session inspection and revocation.',
      },
      { name: 'Uploads', description: 'Authorized dashboard media uploads.' },
      { name: 'Operations', description: 'Deployment readiness probes.' },
      {
        name: 'Development',
        description: 'Endpoints registered only in development mode.',
      },
      { name: 'Contract', description: 'The generated OpenAPI document.' },
    ],
    components: {
      schemas: referencedBetterAuthSchemas(paths),
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: BETTER_AUTH_CONTEXT.authCookies.sessionToken.name,
        },
      },
    },
    paths,
  };
}

/**
 * Where `scripts/build-openapi.ts` writes the document, relative to the repo
 * root. Under `build/`, which is git-ignored and served by nothing: this
 * document is a map of the whole reachable surface, so it must stay behind the
 * same authorisation the routes themselves are behind.
 */
export const OPENAPI_ARTIFACT_PATH = 'build/openapi.json';

/**
 * Wraps a manifest getter in a build-once cache.
 *
 * Exported separately from the handler because the handler runs the ACCESS
 * check first — correctly, since a refused caller must not pay for a build —
 * which makes the memoisation unobservable through the handler without a
 * session. This is the piece worth asserting, so it is the piece that is
 * addressable.
 *
 * `getManifest` stays lazy: `routes.ts` calls the handler factory while it is
 * still building `ROUTES`, so the array does not exist yet at that point.
 */
export function memoiseOpenApiDocument(
  getManifest: () => readonly RouteManifestEntry[]
): () => JsonSchema {
  let built: { document: JsonSchema } | { error: unknown } | null = null;

  return () => {
    built ??= (() => {
      try {
        return { document: openApiDocument(getManifest()) };
      } catch (error) {
        return { error };
      }
    })();

    if ('error' in built) throw built.error;
    return built.document;
  };
}

/**
 * The build artefact, or `null` when there is none.
 *
 * Absent is normal in development and under test, where regenerating from the
 * live route table is what makes an edit visible without a build step. In a
 * deployment the artefact is present, so the generator never runs on a request
 * and a route/schema inconsistency has already failed `bun run build`.
 */
function prebuiltDocument(): JsonSchema | null {
  const file = path.resolve(import.meta.dir, '..', '..', OPENAPI_ARTIFACT_PATH);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved from this module's own location, never from input
  if (!existsSync(file)) return null;

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- same
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!isJsonSchema(parsed))
    throw new Error(`${OPENAPI_ARTIFACT_PATH} is not a JSON object.`);
  return parsed;
}

export function resolveOpenApiDocument(
  prebuilt: JsonSchema | null,
  generate: () => JsonSchema,
  production = process.env.NODE_ENV === 'production'
): JsonSchema {
  if (prebuilt) return prebuilt;
  if (production)
    throw new Error(`${OPENAPI_ARTIFACT_PATH} is required in production.`);
  return generate();
}

/**
 * The route that serves the document.
 *
 * Takes a getter rather than the manifest itself, so this module imports nothing
 * from `routes.ts` and the route table can pass its own manifest without a
 * cycle. `ROUTES` is still being built when this is called, so the getter is
 * invoked on FIRST REQUEST, not here.
 *
 * **Built exactly once and then frozen.** It used to be rebuilt per request:
 * `z.toJSONSchema` over ~20 schemas plus a `safeParse(undefined)` per object
 * field, measured at **9.11 ms/req against 0.095 ms for a 404** — a 96× cost
 * ratio, ~110 req/s per core, on a route with no admission gate. Bun runs one
 * JS thread per process and this deployment runs one process, so that was the
 * whole server. `lib/http/response.ts` also stamps `cache-control: no-store`, so
 * neither a browser nor Cloudflare absorbed any of it.
 *
 * The manifest is static for the life of the process, so nothing about the
 * document can change after the first build. A conversion failure is cached too,
 * and rethrown on every subsequent request: retrying it per request would only
 * restore the amplification for a document that cannot start working.
 *
 * `apiRaw`, not the envelope: an OpenAPI document has a shape fixed by the spec,
 * and a client reading it expects that shape at the top level.
 */
export function openApiRouteHandler(
  getManifest: () => readonly RouteManifestEntry[]
): Handler {
  const generate = memoiseOpenApiDocument(getManifest);
  // Not `??=` on the document itself: "no artefact" is a legitimate resolution,
  // and a nullish assignment would re-stat the filesystem on every request.
  let resolved: { document: JsonSchema } | null = null;

  return async (ctx) => {
    // The document names every path, method, status code and query parameter
    // this server serves. That is a map of the whole attack surface, so it is
    // for people who already hold dashboard access — not for anyone who can
    // reach the origin. `requireDashboardAccess` is the same live-session and
    // role check every dashboard read performs.
    //
    // BEFORE the document is resolved, so a refused caller pays for a session
    // lookup and nothing else.
    await requireDashboardAccess(ctx);

    resolved ??= {
      document: resolveOpenApiDocument(prebuiltDocument(), generate),
    };
    return apiRaw({ body: resolved.document });
  };
}
