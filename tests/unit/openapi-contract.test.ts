import { describe, expect, test } from 'bun:test';

import { ROUTES } from '@/routes';
import {
  memoiseOpenApiDocument,
  openApiDocument,
  resolveOpenApiDocument,
} from '@/lib/http/openapi';
import { toManifest, toPublishedManifest } from '@/lib/http/route-manifest';

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
