/**
 * Boot smoke test — the CI gate that replaced `next build`.
 *
 * A Bun server has no build artefact, so nothing forces the module graph to be
 * evaluated before deploy. That matters here: `lib/env.server.ts` throws at
 * module load on missing configuration, `lib/auth.ts` constructs Better Auth at
 * load, and the SQLite stores open lazily on first use. Without this, the first
 * request in production would be what discovers a broken import, a missing
 * variable, or an unmounted volume.
 *
 * What it proves: the process starts, the route table builds, the readiness
 * endpoint answers `ok` (so the SQLite volume opened, migrated, and reported the
 * PRAGMAs this build expects), the security headers are attached, an unrouted
 * path produces the API envelope rather than a framework default, Better Auth is
 * mounted, and the maintenance surface fails closed without a token.
 *
 * What it does NOT prove: anything requiring PostgreSQL or the network. No
 * endpoint touched here opens a database connection.
 */
const PORT = Number(process.env.SMOKE_PORT ?? 3999);
const BASE = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const server = Bun.spawn(['bun', 'server.ts'], {
  env: { ...process.env, PORT: String(PORT) },
  stdout: 'inherit',
  stderr: 'inherit',
});

/** Polls readiness until the server answers, dies, or the deadline passes. */
async function waitForBoot(): Promise<Response | null> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) return null;
    try {
      return await fetch(`${BASE}/api/health/storage`);
    } catch {
      await Bun.sleep(POLL_INTERVAL_MS);
    }
  }
  return null;
}

async function runChecks(health: Response): Promise<Check[]> {
  const healthBody = (await health.json()) as { status?: string };
  const missing = await fetch(`${BASE}/api/definitely-not-a-route`);
  const missingBody = (await missing.json()) as { success?: boolean };
  // Rejected by Better Auth's own path allowlist, so 404 is the expected
  // answer. A 500 or a connection error is the failure this catches.
  const authProbe = await fetch(`${BASE}/api/auth/not-an-endpoint`);
  const sweep = await fetch(`${BASE}/api/internal/sqlite-sweep`, {
    method: 'POST',
  });
  const dbSweep = await fetch(`${BASE}/api/internal/db-sweep`, {
    method: 'POST',
  });
  // The upload route's authentication gate, checked here because it is the only
  // gate in the app that a request can reach WITHOUT a preflight: multipart is a
  // CORS-simple content type, so CORS does not stand in front of it. It must
  // answer 401 — and it must do so before reading the body, which is why the
  // request below sends a real multipart form. A 400 would mean the body was
  // parsed first; a 200 would mean this endpoint is open again.
  const uploadForm = new FormData();
  uploadForm.append(
    'files',
    new File(['x'], 'probe.png', { type: 'image/png' })
  );
  const upload = await fetch(`${BASE}/api/upload/image?resource=users`, {
    method: 'POST',
    body: uploadForm,
  });
  // `openApiDocument` THROWS when the route table and its three hand-maintained
  // maps disagree, which surfaces here as a 500. That is the point: a route that
  // declares `body: 'json'` with no schema, or a stale key left behind by a
  // rename, is a wrong contract, and this is the CI gate that catches it. Two
  // routes shipped with a missing request body before the check existed.
  const contract = await fetch(`${BASE}/openapi.json`);
  const contractBody: unknown = contract.ok ? await contract.json() : null;
  const paths =
    typeof contractBody === 'object' &&
    contractBody !== null &&
    'paths' in contractBody &&
    typeof contractBody.paths === 'object' &&
    contractBody.paths !== null
      ? Object.keys(contractBody.paths).length
      : 0;

  return [
    {
      name: 'readiness reports ok',
      ok: health.status === 200 && healthBody.status === 'ok',
      detail: `HTTP ${health.status} status=${healthBody.status}`,
    },
    {
      name: 'security headers present',
      ok:
        health.headers.get('x-content-type-options') === 'nosniff' &&
        health.headers.get('content-security-policy') !== null,
      detail: `csp=${health.headers.get('content-security-policy')}`,
    },
    {
      name: 'unknown route returns the API envelope',
      ok: missing.status === 404 && missingBody.success === false,
      detail: `HTTP ${missing.status} body=${JSON.stringify(missingBody)}`,
    },
    {
      name: 'better auth handler is mounted',
      ok: authProbe.status < 500,
      detail: `HTTP ${authProbe.status}`,
    },
    {
      name: 'sqlite sweep rejects a missing maintenance token',
      ok: sweep.status === 401,
      detail: `HTTP ${sweep.status}`,
    },
    {
      name: 'db sweep rejects a missing maintenance token',
      ok: dbSweep.status === 401,
      detail: `HTTP ${dbSweep.status}`,
    },
    {
      name: 'image upload rejects an unauthenticated request',
      ok: upload.status === 401,
      detail: `HTTP ${upload.status}`,
    },
    {
      name: 'the OpenAPI contract builds and agrees with the route table',
      ok: contract.status === 200 && paths > 0,
      detail: `HTTP ${contract.status} paths=${paths}`,
    },
  ];
}

async function main(): Promise<Check[]> {
  const health = await waitForBoot();
  if (health)
    return [
      { name: 'server boots', ok: true, detail: BASE },
      ...(await runChecks(health)),
    ];

  return [
    {
      name: 'server boots',
      ok: false,
      detail:
        server.exitCode === null
          ? `no response within ${BOOT_TIMEOUT_MS}ms`
          : `process exited ${server.exitCode}`,
    },
  ];
}

const checks = await main().catch((error: unknown) => [
  {
    name: 'smoke run completed',
    ok: false,
    detail: error instanceof Error ? error.message : String(error),
  },
]);

// After the results are collected, never in a `finally` callback: the kill must
// be awaited, and an async `finally` swallows a rejection from the await.
server.kill();
await server.exited;

for (const check of checks)
  console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name} — ${check.detail}`);

const failed = checks.filter((check) => !check.ok).length;
console.log(
  failed === 0 ? '\nsmoke: all checks passed' : `\nsmoke: ${failed} failed`
);

// `exitCode`, not `process.exit()`: the spawned server has already been killed
// above and stdout must flush before the process ends.
process.exitCode = failed === 0 ? 0 : 1;
