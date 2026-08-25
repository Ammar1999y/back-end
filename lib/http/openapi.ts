/**
 * Generates a framework-independent contract from the route manifest and the
 * Zod schemas used by handlers. Route-attached Elysia schemas would duplicate
 * validation, while Better Auth's document would advertise blocked routes.
 */
import type { Handler } from './contract';
import type { RouteManifestEntry } from './route-manifest';

import { deleteSessionsSchema } from '@/app/api/dash/users/[id]/sessions/handler';
import { devSignUpSchema } from '@/app/api/dev/sign-up/handler';
import * as z from 'zod';
import {
  BETTER_AUTH_ALLOWED_PATH_SET,
  BETTER_AUTH_ALLOWED_PATHS,
} from '@/lib/auth/allowed-paths';

import { apiRaw } from '@/utils/api-response';
import {
  adminUpdateUserSchema,
  changeEmailSchema,
  changeEmailVerifySchema,
  changePasswordSchema,
  changePhoneSchema,
  changePhoneVerifySchema,
  createUserSchema,
  loginSchema,
  selfUpdateUserSchema,
} from '@/utils/validation/auth';
import {
  resetPasswordSchema,
  sendOtpSchema,
  verifyOtpSchema,
} from '@/utils/validation/otp';
import {
  adminUpdatePermissionSchema,
  createPermissionSchema,
} from '@/utils/validation/permissions';

type JsonSchema = Record<string, unknown>;

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
const REQUEST_BODIES: Record<string, z.ZodType | readonly z.ZodType[]> = {
  'POST /api/auth/forgot-password/reset': resetPasswordSchema,
  'POST /api/auth/forgot-password/send': sendOtpSchema,
  'POST /api/auth/otp/send': sendOtpSchema,
  'POST /api/auth/otp/verify': verifyOtpSchema,
  'POST /api/auth/passwordless/send': sendOtpSchema,
  'POST /api/dash/permissions': createPermissionSchema,
  'PUT /api/dash/permissions/:id': adminUpdatePermissionSchema,
  'POST /api/dash/users': createUserSchema,
  'PUT /api/dash/users/:id': [adminUpdateUserSchema, selfUpdateUserSchema],
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

/** Better Auth request bodies for the paths this deployment actually serves. */
const BETTER_AUTH_BODIES: Record<string, z.ZodType> = {
  '/sign-in/email': loginSchema,
};

/**
 * Zod → JSON Schema, or nothing.
 *
 * `unrepresentable: 'any'` rather than the default throw: several schemas use
 * `z.preprocess` and refinements that have no JSON Schema equivalent, and a
 * document missing one constraint is worth more than a route that 500s. The
 * per-schema catch is the same reasoning one level up — a future schema that
 * breaks the converter must not take the whole contract down with it.
 */
function toJsonSchema(schema: z.ZodType): JsonSchema | null {
  try {
    return z.toJSONSchema(schema, {
      io: 'input',
      unrepresentable: 'any',
    }) as JsonSchema;
  } catch {
    return null;
  }
}

function isJsonSchema(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function requestBody(
  schemas: z.ZodType | readonly z.ZodType[]
): JsonSchema | null {
  const list: readonly z.ZodType[] = Array.isArray(schemas)
    ? schemas
    : [schemas as z.ZodType];
  const converted = list
    .map((schema) => {
      const json = toJsonSchema(schema);
      return json === null ? null : withRequiredKeys(schema, json);
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
        schema: { type: 'string' },
      });
      return `{${name}}`;
    })
    .join('/');
  return { path: converted, parameters };
}

/**
 * The response envelope every application endpoint returns.
 *
 * Written here rather than derived from `HandlerEnvelope`, because that is a
 * TypeScript interface and types do not survive to runtime. It is the one piece
 * of this document that can drift from the code; `lib/http/contract.ts` is the
 * definition it must match.
 */
const ENVELOPE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
    data: {},
    meta: {
      type: 'object',
      properties: {
        page: { type: 'integer' },
        pageSize: { type: 'integer' },
        total: { type: 'integer' },
      },
    },
  },
  required: ['success', 'message', 'data'],
};

const ENVELOPE_RESPONSE = {
  description: 'The standard API envelope.',
  content: { 'application/json': { schema: ENVELOPE_SCHEMA } },
};

/**
 * Better Auth does NOT return this API's envelope.
 *
 * Its shapes are its own — a session object, `{ success: true }`, `null`, or
 * `{ message, code }` on an error — and claiming the envelope for them would
 * make the document actively wrong for the four paths a front-end depends on
 * most. The body is left unconstrained rather than guessed: Better Auth owns it,
 * its own documentation describes it, and an unconstrained schema is honest
 * where a fabricated one is not.
 */
const BETTER_AUTH_RESPONSES: JsonSchema = {
  '200': {
    description:
      "Better Auth's own response shape for this endpoint — not this API's envelope.",
    content: { 'application/json': { schema: {} } },
  },
  '404': {
    description:
      'Path outside the allowlist, or no such Better Auth endpoint. The body is Better Auth’s own error shape.',
    content: { 'application/json': { schema: {} } },
  },
};

/**
 * The responses every route can produce regardless of its handler, because the
 * server produces them: the 404/405 boundary, the pre-auth limiter, and the
 * fail-closed limiter store.
 */
function commonResponses(entry: RouteManifestEntry): JsonSchema {
  const success = CREATED_ROUTES.has(`${entry.method} ${entry.path}`)
    ? '201'
    : '200';
  const responses: JsonSchema = {
    [success]: ENVELOPE_RESPONSE,
    '404': ENVELOPE_RESPONSE,
    '405': {
      description: 'The path exists under a different method. See `Allow`.',
      content: { 'application/json': { schema: ENVELOPE_SCHEMA } },
    },
    '500': ENVELOPE_RESPONSE,
  };

  // A body route rejects an absent or malformed body with 400 (`requireJsonBody`,
  // `utils/api-response.ts`) before its schema ever runs. Documented because it
  // is the response a client gets for the mistake it is most likely to make.
  if (entry.body !== 'none')
    responses['400'] = {
      description: 'The request body is absent, empty or not parseable.',
      content: { 'application/json': { schema: ENVELOPE_SCHEMA } },
    };

  // 422 is the standard validation failure, and it is NOT limited to body
  // routes: every route with a path parameter validates it and answers 422 on a
  // malformed id (`app/api/dash/users/[id]/handler.ts`, `.../permissions/[id]`,
  // `.../sessions`). Both conditions are readable from the manifest, which is
  // why they belong here rather than in a per-route table.
  if (entry.body !== 'none' || entry.path.includes(':'))
    responses['422'] = {
      description:
        'Validation failed — a schema field, or a path parameter, was rejected.',
      content: { 'application/json': { schema: ENVELOPE_SCHEMA } },
    };

  if (entry.preAuth === 'ip-limit') {
    responses['429'] = {
      description: 'Per-IP admission limit. See `Retry-After`.',
      content: { 'application/json': { schema: ENVELOPE_SCHEMA } },
    };
    responses['503'] = {
      description:
        'The admission limiter store is unavailable and fails closed.',
      content: { 'application/json': { schema: ENVELOPE_SCHEMA } },
    };
  }

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

  // Catch schemas left behind after a route is renamed or removed.
  for (const key of Object.keys(REQUEST_BODIES))
    if (!keys.has(key))
      problems.push(`REQUEST_BODIES has '${key}', which is not a route`);
  for (const key of CREATED_ROUTES)
    if (!keys.has(key))
      problems.push(`CREATED_ROUTES has '${key}', which is not a route`);
  for (const key of Object.keys(BETTER_AUTH_BODIES))
    if (!BETTER_AUTH_ALLOWED_PATH_SET.has(key))
      problems.push(
        `BETTER_AUTH_BODIES has '${key}', which is not in BETTER_AUTH_ALLOWED_PATHS`
      );

  return problems;
}

/**
 * Builds the document. Called per request rather than at module load so a
 * conversion failure cannot prevent the server from booting.
 *
 * THROWS on an inconsistent document rather than serving one. A contract that is
 * confidently wrong is worse than one that is unavailable: a generator consumes
 * it without complaint and every client built from it is wrong in the same way.
 * The CI boot smoke test fetches this route and asserts 200, so the failure lands
 * before a deploy rather than in a client.
 */
function openApiDocument(
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
    for (const param of queryParams)
      parameters.push({
        name: param.name,
        in: 'query',
        required: param.required,
        description: param.description,
        schema: param.enum
          ? { type: 'string', enum: [...param.enum] }
          : { type: 'string' },
      });

    const operation: JsonSchema = {
      operationId: `${entry.method.toLowerCase()}${entry.path.replaceAll(/[^a-zA-Z0-9]/g, '_')}`,
      responses: commonResponses(entry),
    };
    if (parameters.length > 0) operation.parameters = parameters;

    const schemas = REQUEST_BODIES[`${entry.method} ${entry.path}`];
    if (schemas) {
      const body = requestBody(schemas);
      if (body) operation.requestBody = body;
    } else if (entry.body === 'multipart') {
      operation.requestBody = {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: {
                files: { type: 'string', format: 'binary' },
              },
              required: ['files'],
            },
          },
        },
      };
    }

    paths[path] = { ...paths[path], [entry.method.toLowerCase()]: operation };
  }

  for (const authPath of BETTER_AUTH_ALLOWED_PATHS) {
    const full = `/api/auth${authPath}`;
    const schema = BETTER_AUTH_BODIES[authPath];
    const slug = authPath.replaceAll(/[^a-zA-Z0-9]/g, '_');

    // A FRESH operation object per method, with the method in the id.
    // `operationId` must be unique across the whole document (OpenAPI 3.1
    // §4.8.10); sharing one object between `get` and `post` emitted four
    // duplicate ids and made the document invalid for every generator.
    const build = (method: 'get' | 'post'): JsonSchema => {
      const operation: JsonSchema = {
        operationId: `betterAuth_${method}${slug}`,
        description:
          'Served by Better Auth, which owns its own routing, validation and ' +
          'response shapes under this prefix. Every Better Auth path outside ' +
          'this list is answered 404 by the before-hook in lib/auth.ts.',
        responses: BETTER_AUTH_RESPONSES,
      };
      // Only the method that carries it. A documented request body on `GET`
      // describes a request no client can make.
      if (schema && method === 'post') {
        const body = requestBody(schema);
        if (body) operation.requestBody = body;
      }
      return operation;
    };

    // GET and POST are the only methods registered for the prefix; Better Auth
    // rejects the wrong one itself, so both are advertised.
    paths[full] = { get: build('get'), post: build('post') };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Dashboard API',
      version: '0.1.0',
      description:
        'Generated from the route manifest in `routes.ts` and the Zod schemas the handlers validate with. Not hand-maintained.',
    },
    paths,
  };
}

/**
 * The route that serves the document.
 *
 * Takes a getter rather than the manifest itself, so this module imports nothing
 * from `routes.ts` and the route table can pass its own manifest without a
 * cycle. Evaluated per request, which also means a schema-conversion failure
 * cannot prevent the server from booting.
 *
 * `apiRaw`, not the envelope: an OpenAPI document has a shape fixed by the spec,
 * and a client reading it expects that shape at the top level.
 */
export function openApiRouteHandler(
  getManifest: () => readonly RouteManifestEntry[]
): Handler {
  return () =>
    Promise.resolve(apiRaw({ body: openApiDocument(getManifest()) }));
}
