/**
 * Build-time generation of the OpenAPI document.
 *
 * The document is a derived artefact: it changes only when the route table or a
 * request schema changes, so it belongs to the build, not to the first request
 * that happens to be authorised. Generating it here also means a route table
 * inconsistent with its schemas fails `bun run build` instead of surfacing as a
 * 500 on live traffic.
 *
 * Written under `build/`, which is git-ignored and served by nothing. The
 * document names every path, method and query parameter this server exposes, so
 * publishing it as a static asset would hand out the attack surface map that the
 * runtime authorisation check exists to withhold.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROUTES } from '@/routes';
import { OPENAPI_ARTIFACT_PATH, openApiDocument } from '@/lib/http/openapi';
import { toPublishedManifest } from '@/lib/http/route-manifest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, OPENAPI_ARTIFACT_PATH);

// The deployed document, whatever this machine's NODE_ENV is.
const manifest = toPublishedManifest(ROUTES, true);
const document = openApiDocument(manifest);

const paths = document.paths;
if (
  typeof paths !== 'object' ||
  paths === null ||
  Object.keys(paths).length === 0
)
  throw new Error(
    'OpenAPI document has no paths; the route manifest is empty.'
  );

// Asserting the outcome rather than the flag: this is what catches a dev-only
// prefix the manifest filter does not yet cover.
const leaked = Object.keys(paths).filter(
  (key) => key.startsWith('/api/dev') || key.startsWith('/api/internal')
);
if (leaked.length > 0)
  throw new Error(
    `OpenAPI document exposes non-production paths: ${leaked.join(', ')}`
  );

// eslint-disable-next-line security/detect-non-literal-fs-filename -- path is derived from this file's own location, not from input
mkdirSync(path.dirname(OUTPUT), { recursive: true });
// eslint-disable-next-line security/detect-non-literal-fs-filename -- same
writeFileSync(OUTPUT, JSON.stringify(document), 'utf8');

console.log(
  JSON.stringify({
    msg: 'openapi.built',
    output: OPENAPI_ARTIFACT_PATH,
    paths: Object.keys(paths).length,
  })
);
