import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { RouteManifestEntry } from '@/lib/http/route-manifest';
import type { PaginationMeta } from '@/utils/api-response';

import { ROUTES } from '@/routes';
import { auth } from '@/lib/auth';
import {
  BETTER_AUTH_ENDPOINTS,
  betterAuthServes,
} from '@/lib/auth/allowed-paths';
import {
  memoiseOpenApiDocument,
  openApiDocument,
  resolveOpenApiDocument,
} from '@/lib/http/openapi';
import {
  toManifest,
  toPublishedManifest,
  toRegisteredRoutes,
} from '@/lib/http/route-manifest';

const REPO_ROOT = path.join(import.meta.dir, '..', '..');

/** Locale-independent string ordering, so a sorted comparison is stable. */
const byText = (a: string, b: string) => (a === b ? 0 : a < b ? -1 : 1);

/** The status codes one operation declares, sorted. */
function statusesOf(document: unknown, path: string, method: string): string[] {
  const paths = (document as { paths: Record<string, unknown> }).paths;
  const entry = paths[path];
  if (!entry) throw new Error(`${path} is not in the document`);
  const operation = (entry as Record<string, unknown>)[method];
  if (!operation) throw new Error(`${method} ${path} is not in the document`);
  const responses = (operation as { responses: Record<string, unknown> })
    .responses;
  return Object.keys(responses).toSorted(byText);
}

function pathsOf(document: unknown): string[] {
  const paths =
    typeof document === 'object' &&
    document !== null &&
    'paths' in document &&
    typeof document.paths === 'object' &&
    document.paths !== null
      ? document.paths
      : {};
  return Object.keys(paths);
}

function operationOf(
  document: unknown,
  pathName: string,
  method: string
): Record<string, unknown> {
  const paths = (document as { paths: Record<string, unknown> }).paths;
  const pathItem = paths[pathName];
  if (!pathItem || typeof pathItem !== 'object')
    throw new Error(`${pathName} is not in the document`);
  const operation = (pathItem as Record<string, unknown>)[method];
  if (!operation || typeof operation !== 'object')
    throw new Error(`${method} ${pathName} is not in the document`);
  return operation as Record<string, unknown>;
}

describe('the OpenAPI document', () => {
  test('builds from the full route table without throwing', () => {
    const paths = pathsOf(openApiDocument(toManifest(ROUTES)));
    expect(paths.length).toBeGreaterThan(0);
  });

  test('builds from the published manifest too', () => {
    const paths = pathsOf(openApiDocument(toPublishedManifest(ROUTES)));
    expect(paths.length).toBeGreaterThan(0);
  });

  test('builds under the PRODUCTION filter, which the running deployment uses', () => {
    // The case a development-only check cannot reach: the published manifest
    // withholds `/api/dev/*`, and the leftover-schema check read those schemas
    // as pointing at routes that do not exist. `openApiDocument` threw, so
    // `/openapi.json` answered every authorised caller with a 500 in production
    // while passing here. `bun run build` now fails on the same condition.
    const paths = pathsOf(openApiDocument(toPublishedManifest(ROUTES, true)));

    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((path) => path.startsWith('/api/dev'))).toEqual([]);
  });

  test('names no /api/internal path — those routes no longer exist', () => {
    const paths = pathsOf(openApiDocument(toManifest(ROUTES)));
    expect(paths.filter((path) => path.startsWith('/api/internal'))).toEqual(
      []
    );
  });

  test('names every route in the manifest it was built from', () => {
    const manifest = toPublishedManifest(ROUTES);
    const documented = new Set(pathsOf(openApiDocument(manifest)));

    for (const entry of manifest) {
      const expected = entry.path.replaceAll(/:(\w+)/g, '{$1}');
      expect(documented).toContain(expected);
    }
  });
});

describe('memoisation', () => {
  test('the manifest getter is invoked exactly once, however many builds are asked for', () => {
    let calls = 0;
    const document = memoiseOpenApiDocument(() => {
      calls++;
      return toPublishedManifest(ROUTES);
    });

    const first = document();
    for (let i = 0; i < 5; i++) expect(document()).toBe(first);

    expect(calls).toBe(1);
  });

  test('a build failure is cached too, and rethrown rather than retried', () => {
    let calls = 0;
    const document = memoiseOpenApiDocument(() => {
      calls++;
      throw new Error('conversion failed');
    });

    const failures: string[] = [];
    for (let i = 0; i < 3; i++) {
      try {
        document();
      } catch (error) {
        failures.push((error as Error).message);
      }
    }

    expect(calls).toBe(1);
    expect(failures).toEqual([
      'conversion failed',
      'conversion failed',
      'conversion failed',
    ]);
  });
});

describe('artifact resolution', () => {
  test('production fails closed when build/openapi.json is absent', () => {
    let generated = false;
    expect(() =>
      resolveOpenApiDocument(
        null,
        () => {
          generated = true;
          return {};
        },
        true
      )
    ).toThrow('build/openapi.json is required in production');
    expect(generated).toBe(false);
  });

  test('development may generate when no artifact exists', () => {
    const document = { openapi: '3.1.0' };
    expect(resolveOpenApiDocument(null, () => document, false)).toBe(document);
  });
});

describe('the production filter', () => {
  const withEnv = <T>(value: string, run: () => T): T => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = value;
    try {
      return run();
    } finally {
      process.env.NODE_ENV = previous;
    }
  };

  test('drops /api/dev/* in production and keeps it elsewhere', () => {
    const inProduction = withEnv('production', () =>
      toPublishedManifest(ROUTES)
    ).map((entry) => entry.path);

    // The explicit flag and the ambient environment must agree, or the build
    // artefact and the running server describe different servers.
    expect(toPublishedManifest(ROUTES, true).map((e) => e.path)).toEqual(
      inProduction
    );
    const inDevelopment = withEnv('development', () =>
      toPublishedManifest(ROUTES)
    ).map((entry) => entry.path);

    expect(inDevelopment.some((path) => path.startsWith('/api/dev/'))).toBe(
      true
    );
    expect(inProduction.some((path) => path.startsWith('/api/dev/'))).toBe(
      false
    );

    expect(inProduction.length).toBeGreaterThan(0);
    expect(new Set(inProduction).isSubsetOf(new Set(inDevelopment))).toBe(true);
  });
});

describe('the envelope schema against the shape handlers actually emit', () => {
  /**
   * `ENVELOPE_SCHEMA` is written by hand — `HandlerEnvelope` is a TypeScript
   * interface and types do not survive to runtime — so it is the one part of this
   * document that can drift from the code, and it HAD: `meta` declared
   * `pageSize`, a name that appears nowhere else in the repository, and omitted
   * `pageCount`. Both paginated endpoints emit `PaginationMeta`, so a generated
   * client read `undefined` for the page size and could not build a pager.
   *
   * Compared against a REAL `PaginationMeta` value rather than a copied list, so
   * a field added to that type without the document fails here.
   */
  const meta: PaginationMeta = {
    page: 1,
    perPage: 10,
    total: 0,
    pageCount: 1,
  };

  function metaProperties(): string[] {
    const document = openApiDocument(toManifest(ROUTES));
    const paths = (document as { paths: Record<string, unknown> }).paths;
    const operation = (paths['/api/dash/users'] as Record<string, unknown>)
      .get as Record<string, unknown>;
    const responses = operation.responses as Record<string, unknown>;
    const ok = responses['200'] as Record<string, unknown>;
    const content = ok.content as Record<string, unknown>;
    const json = content['application/json'] as Record<string, unknown>;
    const schema = json.schema as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown>;
    const metaSchema = properties.meta as Record<string, unknown>;
    return Object.keys(metaSchema.properties as Record<string, unknown>);
  }

  test('meta declares exactly the keys of a PaginationMeta value', () => {
    expect(metaProperties().toSorted(byText)).toEqual(
      Object.keys(meta).toSorted(byText)
    );
  });
});

describe('the Better Auth surface, per endpoint', () => {
  function operationsFor(authPath: string): string[] {
    const document = openApiDocument(toManifest(ROUTES));
    const paths = (document as { paths: Record<string, unknown> }).paths;
    const entry = paths[`/api/auth${authPath}`];
    if (!entry) throw new Error(`${authPath} is not in the document`);
    return Object.keys(entry as Record<string, unknown>).toSorted(byText);
  }

  test('every documented path declares exactly the methods the table declares', () => {
    // The document used to emit `get` AND `post` for all four, so a generated
    // client believed `GET /sign-out`, `GET /sign-in/email` and
    // `GET /passwordless/verify` were supported. Measured against installed
    // better-auth: the first and third answer 404 and the second reaches the
    // captcha plugin's processing before its method is rejected.
    for (const endpoint of BETTER_AUTH_ENDPOINTS)
      expect(operationsFor(endpoint.path)).toEqual(
        endpoint.methods.map((method) => method.toLowerCase()).toSorted(byText)
      );
  });

  test('a POST-only auth path documents no GET operation', () => {
    expect(operationsFor('/sign-out')).toEqual(['post']);
    expect(operationsFor('/sign-in/email')).toEqual(['post']);
    expect(operationsFor('/passwordless/verify')).toEqual(['post']);
  });

  test('the passwordless POST documents the body it actually validates', () => {
    // `lib/auth/passwordless.ts` parses `verifyOtpSchema`; the document listed no
    // body at all, so a client generated from it sent none and got a 422.
    const document = openApiDocument(toManifest(ROUTES));
    const paths = (document as { paths: Record<string, unknown> }).paths;
    const post = (
      paths['/api/auth/passwordless/verify'] as Record<string, unknown>
    ).post as Record<string, unknown>;

    expect(post.requestBody).toBeDefined();
  });

  test('Better Auth response schemas come from its generated contract', () => {
    const document = openApiDocument(toManifest(ROUTES));
    const signIn = operationOf(document, '/api/auth/sign-in/email', 'post');
    const responses = signIn.responses as Record<string, unknown>;

    for (const status of ['200', '400', '401', '403', '404', '500']) {
      const response = responses[status] as Record<string, unknown>;
      const content = response.content as Record<string, unknown>;
      const json = content['application/json'] as Record<string, unknown>;
      expect(
        Object.keys(json.schema as Record<string, unknown>).length
      ).toBeGreaterThan(0);
    }

    const ok = responses['200'] as Record<string, unknown>;
    const content = ok.content as Record<string, unknown>;
    const json = content['application/json'] as Record<string, unknown>;
    const schema = json.schema as Record<string, unknown>;
    expect(Object.keys(schema.properties as Record<string, unknown>)).toContain(
      'token'
    );

    const components = (document as { components: Record<string, unknown> })
      .components;
    const schemas = components.schemas as Record<string, unknown>;
    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining(['Session', 'User'])
    );
  });

  test('local auth hooks keep their narrower body contract and captcha is a header', () => {
    const document = openApiDocument(toManifest(ROUTES));
    const signIn = operationOf(document, '/api/auth/sign-in/email', 'post');
    const requestBody = signIn.requestBody as Record<string, unknown>;
    const content = requestBody.content as Record<string, unknown>;
    const json = content['application/json'] as Record<string, unknown>;
    const schema = json.schema as Record<string, unknown>;

    expect(schema.required).toEqual(['email', 'password']);
    expect(
      Object.keys(schema.properties as Record<string, unknown>)
    ).not.toContain('captcha');
    expect(signIn.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'x-captcha-response',
          in: 'header',
          required: true,
        }),
      ])
    );

    const signOut = operationOf(document, '/api/auth/sign-out', 'post');
    expect(signOut.requestBody).toMatchObject({ required: false });

    for (const endpoint of BETTER_AUTH_ENDPOINTS) {
      const operation = operationOf(
        document,
        `/api/auth${endpoint.path}`,
        endpoint.methods[0]?.toLowerCase() ?? ''
      );
      const parameters = Array.isArray(operation.parameters)
        ? operation.parameters
        : [];
      expect(
        parameters.some(
          (parameter) =>
            typeof parameter === 'object' &&
            parameter !== null &&
            'name' in parameter &&
            parameter.name === 'x-captcha-response'
        )
      ).toBe(endpoint.captcha);
    }
  });

  test('the custom passwordless success body has a concrete schema', () => {
    const document = openApiDocument(toManifest(ROUTES));
    const operation = operationOf(
      document,
      '/api/auth/passwordless/verify',
      'post'
    );
    const responses = operation.responses as Record<string, unknown>;
    const response = responses['200'] as Record<string, unknown>;
    const content = response.content as Record<string, unknown>;
    const json = content['application/json'] as Record<string, unknown>;
    const schema = json.schema as Record<string, unknown>;
    expect(Object.keys(schema.properties as Record<string, unknown>)).toEqual(
      expect.arrayContaining(['success', 'message', 'data'])
    );
  });

  test('betterAuthServes answers on the method, not only the path', () => {
    // The predicate the 405 boundary in `app.ts` uses.
    expect(betterAuthServes('/sign-out', 'POST')).toBe(true);
    expect(betterAuthServes('/sign-out', 'GET')).toBe(false);
    expect(betterAuthServes('/get-session', 'GET')).toBe(true);
    // Measured: better-auth's own handler throws METHOD_NOT_ALLOWED for a POST
    // here unless `session.deferSessionRefresh` is enabled, which it is not.
    expect(betterAuthServes('/get-session', 'POST')).toBe(false);
    expect(betterAuthServes('/not-an-endpoint', 'GET')).toBe(false);
  });
});

describe('the refusals an operation declares for its own authorisation', () => {
  /**
   * No authenticated operation declared a 401 or a 403 at all, so a generated
   * client could not represent the two failures its users hit most: any
   * dashboard call before sign-in, and any call by someone whose role lacks the
   * grant. Measured unauthenticated through `app.handle` on a throwaway
   * environment, `GET /api/dash/users`, `PUT /api/dash/users/abc`,
   * `POST /api/dash/users/me/change-password`, `POST /api/upload/image` and
   * `GET /openapi.json` all answer 401 while the document offered 404/405/500.
   *
   * Driven off the manifest and not off a list of paths, so a route added under
   * the wrong `auth` policy fails here instead of shipping a contract that omits
   * its own refusals.
   */
  const manifest = toManifest(ROUTES);
  const label = (entry: RouteManifestEntry) => `${entry.method} ${entry.path}`;

  const sourceOf = (entry: RouteManifestEntry) =>
    path.join(
      REPO_ROOT,
      'app',
      entry.path.replace('/api', 'api').replaceAll(/:(\w+)/g, '[$1]'),
      'handler.ts'
    );

  const reads = (file: string) =>
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- built from the route table in `routes.ts`, never from a request
    existsSync(file) ? readFileSync(file, 'utf8') : null;

  const of = (auth: RouteManifestEntry['auth']) =>
    manifest.filter((entry) => entry.auth === auth);

  /** The entries whose declared statuses fail `holds`, named for the failure. */
  function offenders(
    auth: RouteManifestEntry['auth'],
    holds: (statuses: readonly string[]) => boolean
  ): string[] {
    const document = openApiDocument(manifest);
    return of(auth)
      .filter(
        (entry) =>
          !holds(
            statusesOf(
              document,
              entry.path.replaceAll(/:(\w+)/g, '{$1}'),
              entry.method.toLowerCase()
            )
          )
      )
      .map(label);
  }

  test('the table carries routes under every policy, so none of these passes vacuously', () => {
    expect(of('permission').length).toBeGreaterThan(0);
    expect(of('session').length).toBeGreaterThan(0);
    expect(of('public').length).toBeGreaterThan(0);
  });

  test('a permission route declares 401 AND 403', () => {
    expect(
      offenders(
        'permission',
        (statuses) => statuses.includes('401') && statuses.includes('403')
      )
    ).toEqual([]);
  });

  test('a session route declares 401', () => {
    // Not 403: `requireSession` answers only 401, and the field states the
    // authorisation policy rather than everything the handler can refuse.
    expect(
      offenders('session', (statuses) => statuses.includes('401'))
    ).toEqual([]);
  });

  test('authenticated operations declare the real Better Auth session cookie', async () => {
    const document = openApiDocument(manifest);
    const components = (document as { components: Record<string, unknown> })
      .components;
    const securitySchemes = components.securitySchemes as Record<
      string,
      unknown
    >;
    const sessionCookie = securitySchemes.sessionCookie as Record<
      string,
      unknown
    >;
    const context = await auth.$context;

    expect(sessionCookie).toEqual({
      type: 'apiKey',
      in: 'cookie',
      name: context.authCookies.sessionToken.name,
    });

    for (const entry of manifest) {
      const operation = operationOf(
        document,
        entry.path.replaceAll(/:(\w+)/g, '{$1}'),
        entry.method.toLowerCase()
      );
      expect(operation.security).toEqual(
        entry.auth === 'public' ? undefined : [{ sessionCookie: [] }]
      );
    }
  });

  test('no dashboard route is public', () => {
    // The independent half. Everything above proves the document agrees with the
    // field, which a mistyped field satisfies too — flipping `GET
    // /api/dash/roles` to `public` passed all of them. The path is the check the
    // field cannot supply: `/api/dash/*` and the document route itself are
    // behind a session (each measured 401 unauthenticated), so `public` there is
    // a typo rather than a decision.
    expect(
      manifest
        .filter(
          (entry) =>
            entry.auth === 'public' &&
            (entry.path.startsWith('/api/dash/') ||
              entry.path === '/openapi.json')
        )
        .map(label)
    ).toEqual([]);
  });

  /**
   * The same independence the test above supplies for `auth`. `captcha` decides
   * a 403, and a document that merely agrees with a wrong field is wrong twice
   * rather than caught — so the field is checked against the handler that has to
   * answer it, not against the document derived from it.
   */
  test('captcha is set exactly where the handler verifies one', () => {
    const wrong = manifest.filter((entry) => {
      const source = reads(sourceOf(entry));
      return (
        source !== null &&
        source.includes('verifyTurnstileRequest') !== entry.captcha
      );
    });

    expect(wrong.map(label)).toEqual([]);
    // Non-vacuous: the mapping has to actually reach the handlers.
    expect(
      manifest.filter((entry) => reads(sourceOf(entry)) !== null).length
    ).toBeGreaterThan(20);

    const document = openApiDocument(manifest);
    for (const entry of manifest) {
      const operation = operationOf(
        document,
        entry.path.replaceAll(/:(\w+)/g, '{$1}'),
        entry.method.toLowerCase()
      );
      const parameters = Array.isArray(operation.parameters)
        ? operation.parameters
        : [];
      expect(
        parameters.some(
          (parameter) =>
            typeof parameter === 'object' &&
            parameter !== null &&
            'name' in parameter &&
            parameter.name === 'x-captcha-response'
        )
      ).toBe(entry.captcha);
    }
  });

  test('a public envelope route declares no 401, and a 403 only for its captcha', () => {
    // `public` is about SESSIONS. A captcha refusal is a 403 on a route no
    // session guards — measured, `POST /api/auth/otp/send` with no
    // `x-captcha-response` answers 403 in this envelope — so the two fields
    // decide 403 together and only `auth` decides 401.
    const document = openApiDocument(manifest);
    expect(
      of('public')
        .filter((entry) => entry.response === 'envelope')
        .filter((entry) =>
          statusesOf(
            document,
            entry.path.replaceAll(/:(\w+)/g, '{$1}'),
            entry.method.toLowerCase()
          ).includes('401')
        )
        .map(label)
    ).toEqual([]);
    expect(
      of('public')
        .filter(
          (entry) =>
            statusesOf(
              document,
              entry.path.replaceAll(/:(\w+)/g, '{$1}'),
              entry.method.toLowerCase()
            ).includes('403') !== entry.captcha
        )
        .map(label)
    ).toEqual([]);
  });

  test('permission-only refusals do not claim a captcha failure', () => {
    const document = openApiDocument(manifest);
    const operation = operationOf(document, '/api/dash/permissions', 'get');
    const responses = operation.responses as Record<string, unknown>;
    const forbidden = responses['403'] as { description: string };
    expect(forbidden.description.toLowerCase()).not.toContain('captcha');
  });

  test('handler rate-limit policy matches the handlers and publishes 429/503', () => {
    const document = openApiDocument(manifest);
    const wrong = ROUTES.filter((route) => {
      const source = reads(sourceOf(route));
      return (
        source !== null &&
        source.includes('enforceRateLimit(') !== route.handlerRateLimit
      );
    });
    expect(wrong.map(label)).toEqual([]);

    const handlerLimited = manifest.filter((route) => route.handlerRateLimit);
    for (const entry of handlerLimited) {
      const statuses = statusesOf(
        document,
        entry.path.replaceAll(/:(\w+)/g, '{$1}'),
        entry.method.toLowerCase()
      );
      expect(statuses).toContain('429');
      expect(statuses).toContain('503');
    }
  });

  test('response policy matches every handler that returns a raw body', () => {
    const wrong = ROUTES.filter((route) => {
      const source = reads(sourceOf(route));
      return (
        source !== null &&
        source.includes('apiRaw(') !== (route.response !== 'envelope')
      );
    });

    expect(wrong.map(label)).toEqual([]);
    expect(
      ROUTES.find((route) => route.path === '/openapi.json')?.response
    ).toBe('openapi-document');
  });

  test('the document route publishes its raw success shape and envelope failures', () => {
    const document = openApiDocument(manifest);
    const operation = operationOf(document, '/openapi.json', 'get');
    const responses = operation.responses as Record<string, unknown>;
    const ok = responses['200'] as Record<string, unknown>;
    const content = ok.content as Record<string, unknown>;
    const json = content['application/json'] as Record<string, unknown>;
    const schema = json.schema as Record<string, unknown>;

    expect(schema.required).toEqual(['openapi', 'info', 'paths']);
    expect(statusesOf(document, '/openapi.json', 'get')).toEqual([
      '200',
      '401',
      '403',
      '404',
      '405',
      '429',
      '500',
      '503',
    ]);
  });

  test('handler-level 400 and 409 responses are not hidden by generic policy', () => {
    const document = openApiDocument(manifest);
    const conflicts = [
      'POST /api/dash/permissions',
      'PUT /api/dash/permissions/:id',
      'POST /api/dash/users',
      'PUT /api/dash/users/:id',
      'POST /api/dash/users/me/change-email',
      'POST /api/dash/users/me/change-email/verify',
      'POST /api/dash/users/me/change-phone',
      'POST /api/dash/users/me/change-phone/verify',
      'POST /api/dev/sign-up',
    ];

    for (const key of conflicts) {
      const separator = key.indexOf(' ');
      const method = key.slice(0, separator).toLowerCase();
      const routePath = key.slice(separator + 1).replaceAll(/:(\w+)/g, '{$1}');
      expect(statusesOf(document, routePath, method)).toContain('409');
    }

    for (const routePath of [
      '/api/dash/permissions/{id}',
      '/api/dash/users/{id}',
    ])
      expect(statusesOf(document, routePath, 'delete')).toContain('400');
  });

  test('storage health declares its raw bodies and conditional authorization', () => {
    const document = openApiDocument(manifest);
    const operation = operationOf(document, '/api/health/storage', 'get');
    expect(
      Object.keys(operation.responses as Record<string, unknown>).toSorted(
        byText
      )
    ).toEqual(['200', '401', '404', '405', '500', '503']);

    const responses = operation.responses as Record<string, unknown>;
    const ok = responses['200'] as Record<string, unknown>;
    const content = ok.content as Record<string, unknown>;
    const json = content['application/json'] as Record<string, unknown>;
    const schema = json.schema as Record<string, unknown>;
    expect(Object.keys(schema.properties as Record<string, unknown>)).toEqual([
      'status',
      'checks',
    ]);
    expect(operation.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'x-maintenance-token',
          in: 'header',
          required: false,
        }),
      ])
    );
  });

  test('the refusal bodies are the envelope, not an unconstrained schema', () => {
    // A client told only the status has been told nothing it can render, which
    // is the half of the defect a status code alone leaves open.
    const document = openApiDocument(manifest);
    const paths = (document as { paths: Record<string, unknown> }).paths;
    const operation = (paths['/api/dash/users'] as Record<string, unknown>)
      .get as { responses: Record<string, unknown> };

    for (const status of ['401', '403']) {
      const response = operation.responses[status] as Record<string, unknown>;
      const content = response.content as Record<string, unknown>;
      const json = content['application/json'] as Record<string, unknown>;
      const schema = json.schema as Record<string, unknown>;
      expect(
        Object.keys(schema.properties as Record<string, unknown>)
      ).toContain('message');
    }
  });
});

describe('the statuses each Better Auth operation declares', () => {
  /**
   * MEASURED through `app.handle` against installed better-auth 1.7.1, on a
   * throwaway environment with no real database, rather than copied from the
   * dependency's `openAPI()` plugin — whose declarations describe the library
   * and not this deployment (it calls `/get-session` `["GET","POST"]`, where
   * POST answers 405). What each observation was:
   *
   *   400  POST /sign-in/email with no `x-captcha-response`; POST /sign-out with
   *        a body Better Auth's own validation refuses
   *   401  POST /sign-in/email on rejected credentials (`lib/auth.ts` maps
   *        `LoginRejected`) and from the `session.create` hook both
   *        session-issuing paths run — asserted against a real database in
   *        `tests/integration/sign-in-controls.test.ts`
   *   403  POST /sign-out from an untrusted origin; captcha VERIFICATION_FAILED
   *        and the unverified-contact gates on the session-issuing paths
   *   404  the allowlist `before` hook, and an endpoint whose channel is off
   *   422  POST /sign-in/email with a body `loginSchema` rejects
   *   429  the 301st GET /get-session from one IP (its `preAuthLimit` is 300)
   *   500  POST /sign-in/email once the request reaches an unreachable database
   *   503  any allowlisted path with no trusted client-IP header — the admission
   *        limiter fails closed
   *
   * `/get-session` is the one that has to differ: an absent session is a 200
   * carrying `null`, and Better Auth's origin check does not run on a GET.
   */
  const MEASURED: Record<string, readonly string[]> = {
    '/get-session': ['200', '404', '429', '500', '503'],
    '/sign-out': ['200', '400', '403', '404', '429', '500', '503'],
    '/sign-in/email': [
      '200',
      '400',
      '401',
      '403',
      '404',
      '422',
      '429',
      '500',
      '503',
    ],
    '/passwordless/verify': [
      '200',
      '400',
      '401',
      '403',
      '404',
      '422',
      '429',
      '500',
      '503',
    ],
  };

  test('every allowlisted path declares exactly what was measured on it', () => {
    // Walks the endpoint table, so a path added to the allowlist without being
    // probed fails here rather than publishing refusals nobody checked.
    const document = openApiDocument(toManifest(ROUTES));

    for (const endpoint of BETTER_AUTH_ENDPOINTS)
      for (const method of endpoint.methods)
        expect([
          endpoint.path,
          statusesOf(
            document,
            `/api/auth${endpoint.path}`,
            method.toLowerCase()
          ),
        ]).toEqual([
          endpoint.path,
          [...(MEASURED[endpoint.path] ?? [])].toSorted(byText),
        ]);
  });
});

describe('development-only routes are not registered outside development', () => {
  test('a production route table contains no /api/dev path', () => {
    // The decision is taken once, in `toRegisteredRoutes`, so the path is
    // genuinely unrouted rather than guarded inside its handler: 404 on every
    // method, no `Allow`, no OPTIONS answer. Measured before the change with
    // `NODE_ENV=production`: `POST` answered 403 with its distinctive body,
    // `GET` answered `405 Allow: POST, OPTIONS`, `OPTIONS` answered 204 — which
    // confirms the endpoint's existence to any unauthenticated caller.
    const registered = toRegisteredRoutes(ROUTES, false).map(
      (route) => route.path
    );

    expect(registered.length).toBeGreaterThan(0);
    expect(registered.filter((path) => path.startsWith('/api/dev'))).toEqual(
      []
    );
    // And the table itself still carries it, so the registration scanner and the
    // build's production document can both see the handler.
    expect(ROUTES.some((route) => route.path.startsWith('/api/dev'))).toBe(
      true
    );
  });

  test('development keeps it, so the seeding path stays reachable', () => {
    const registered = toRegisteredRoutes(ROUTES, true).map(
      (route) => route.path
    );

    expect(registered.some((path) => path.startsWith('/api/dev'))).toBe(true);
  });
});
