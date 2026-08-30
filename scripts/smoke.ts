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
 * What it proves: the process starts, the route table builds, every SQLite
 * readiness check passes (so the volume opened, migrated, and reported the
 * PRAGMAs this build expects), the security headers are attached, an unrouted
 * path produces the API envelope rather than a framework default, Better Auth is
 * mounted, and both authenticated surfaces refuse an anonymous caller.
 *
 * What it does NOT prove: that PostgreSQL is reachable. Readiness now includes a
 * bounded `SELECT 1`, and CI runs this against a deliberately unreachable host —
 * so the SQLite checks are asserted individually and the aggregate `status` is
 * asserted to be CONSISTENT with `checks` rather than pinned to `ok`. Pinning it
 * would make this a database test, which is what the tiered suites are for.
 */
// The LEAF, not `@/lib/audit`: that module pulls `db/schema`, zod and the OTP
// config into this parent for one constant, and printed the OTP-disabled notice
// into the smoke output whenever `NEXT_PUBLIC_ENABLED_OTP_CHANNELS` was unset.
import { TRUSTED_IP_HEADERS } from '@/lib/audit/constants';
import { SECURITY_HEADERS } from '@/lib/http/security-headers';

const PORT = Number(process.env.SMOKE_PORT ?? 3999);
const BASE = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

/**
 * The trusted edge header every real request carries.
 *
 * Sent on every probe below because `ipIdentifier` fails CLOSED without it: in
 * production `getClientIp` has no development fallback, so each `preAuth:
 * 'ip-limit'` route answers 503 and the boundary the check is aiming at is never
 * reached. Omitting it makes a production-posture run assert nothing about
 * routing or authorisation — it tests a deployment shape this application does
 * not support. Harmless in development, where the same admission path runs with
 * a loopback fallback.
 */
const EDGE_HEADERS: Record<string, string> = {
  [TRUSTED_IP_HEADERS[0]]: '203.0.113.7',
};

const probe = (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...EDGE_HEADERS, ...init.headers },
  });

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
      return await probe('/api/health/storage');
    } catch {
      await Bun.sleep(POLL_INTERVAL_MS);
    }
  }
  return null;
}

async function runChecks(health: Response): Promise<Check[]> {
  const healthBody = (await health.json()) as {
    status?: string;
    checks?: Record<string, boolean>;
  };
  const checks = healthBody.checks ?? {};
  // Everything except `postgres`, which this environment may deliberately lack.
  const storageChecks = Object.entries(checks).filter(
    ([name]) => name !== 'postgres'
  );
  const failedStorage = storageChecks
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  const expectedStatus = Object.values(checks).every(Boolean)
    ? 'ok'
    : 'degraded';
  const missing = await probe('/api/definitely-not-a-route');
  const missingBody = (await missing.json()) as { success?: boolean };
  // Rejected by Better Auth's own path allowlist, so 404 is the expected
  // answer. A 500 or a connection error is the failure this catches.
  const authProbe = await probe('/api/auth/not-an-endpoint');
  // The `/api/internal/*` prefix must be unrouted, not merely guarded.
  const internal = await probe('/api/internal/sqlite-sweep', {
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
  const upload = await probe('/api/upload/image?resource=users', {
    method: 'POST',
    body: uploadForm,
  });
  // The CONSISTENCY gate moved to `tests/unit/openapi-contract.test.ts` when this
  // route became authenticated — it needed no server, so it was always the
  // stronger place for it. What is left to check here is the access boundary,
  // which only a real request can show: the document maps every path, method,
  // status code and query parameter this server serves, and an anonymous caller
  // must not receive it.
  const contract = await probe('/openapi.json');
  const contractText = await contract.text();

  const wrongHeaders = Object.entries(SECURITY_HEADERS)
    .filter(([name, expected]) => health.headers.get(name) !== expected)
    .map(
      ([name, expected]) =>
        `${name}=${health.headers.get(name)} want ${expected}`
    );

  return [
    {
      // Every SQLite check individually, because that is what a BOOT test can
      // actually prove: the volume opened, migrated, and reported the PRAGMAs
      // this build expects.
      name: 'every storage readiness check passes',
      ok: storageChecks.length > 0 && failedStorage.length === 0,
      detail:
        storageChecks.length === 0
          ? 'readiness reported no checks at all'
          : `${storageChecks.length} checked, failed=[${failedStorage.join(', ')}]`,
    },
    {
      // Consistency, not a pinned value. CI points `DATABASE_URL` at an
      // unreachable host on purpose, so `postgres: false` is the CORRECT answer
      // there and `degraded` is the correct aggregate — while a deployment with
      // a real database must still report `ok`. Pinning `ok` would either make
      // this a database test or force readiness to ignore PostgreSQL, and the
      // second is the defect that put `SELECT 1` there.
      name: 'readiness status agrees with its own checks',
      ok:
        healthBody.status === expectedStatus &&
        health.status === (expectedStatus === 'ok' ? 200 : 503),
      detail: `HTTP ${health.status} status=${healthBody.status} expected=${expectedStatus} postgres=${String(checks.postgres)}`,
    },
    {
      // By VALUE, not by presence. This checked
      // `content-security-policy !== null`, which a regression to
      // `default-src *` passes — and weakening a CSP is far likelier than
      // deleting one. Compared against the production constant rather than a
      // copy, which would drift and keep passing.
      //
      // Every header, not only the CSP: `X-Frame-Options`, `Referrer-Policy`
      // and the cross-origin trio had no assertion anywhere. The child server
      // inherits this process's environment, so its `isProduction` — and
      // therefore whether HSTS is in the set — matches the constant here.
      name: 'security headers present, with their exact values',
      ok: wrongHeaders.length === 0,
      detail:
        wrongHeaders.length === 0
          ? `all ${Object.keys(SECURITY_HEADERS).length} headers match`
          : wrongHeaders.join('; '),
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
      // The routes this used to probe are gone: both sweeps run in-process
      // (`lib/schedule.ts`). What replaces the assertion is that the prefix is
      // no longer served at all.
      name: 'no /api/internal route is served',
      ok: internal.status === 404,
      detail: `HTTP ${internal.status}`,
    },
    {
      name: 'image upload rejects an unauthenticated request',
      ok: upload.status === 401,
      detail: `HTTP ${upload.status}`,
    },
    {
      name: 'the OpenAPI contract is not served to an anonymous caller',
      // 401, and no path names in the body whatever the status was.
      ok: contract.status === 401 && !contractText.includes('"paths"'),
      detail: `HTTP ${contract.status} bodyLen=${contractText.length}`,
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
