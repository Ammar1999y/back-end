# Elysia Migration Implementation Verification

## Findings

1. **High: CI is currently broken.** `package.json` removed `@types/react`, but
   `bun.lock:36` still declares it at the workspace root. Both install jobs at
   `.github/workflows/ci.yml:23,84` fail with
   `error: lockfile had changes, but lockfile is frozen`. Therefore the "all
   gates green" claim in `reports/elysia-migration-review-response.md:6-8` is
   false for actual CI.

2. **High: the canonical origin fix did not reach Better Auth.**
   `lib/env.js:123-137` exports `PUBLIC_ORIGIN`, but `lib/auth.ts:84-86` still
   reads `process.env.NEXT_PUBLIC_URL`. With the exact CI environment,
   `PUBLIC_ORIGIN` was `http://localhost:3000` while `auth.options.baseURL` was
   `null`. This contradicts the response at lines 268-285 and the deployment
   contract at `reports/coolify-deployment.md:179`.

3. **High: body-before-admission remains reachable.** OTP routes declare
   `preAuth: 'none'` at `routes.ts:62-76`, so
   `lib/http/adapters/elysia.ts:54-60` parses JSON before the route-level IP
   limits at `app/api/auth/otp/send/handler.ts:50` and
   `app/api/auth/otp/verify/handler.ts:41`. Once those limits are exhausted,
   every rejected request can still force parsing of up to 8 MiB. Upload and
   maintenance were fixed, but finding 2 was not fully fixed.

4. **High: shutdown is not a reliable drain.** The server permits 120-second
   uploads at `routes.ts:223-233` but force-exits after 15 seconds at
   `server.ts:171-172,227-236`. Existing keep-alive connections also continued
   serving after `await app.stop()` in a live probe. Post-response work has a
   registration race: the observed order was `handler`, `stop`, `drain:true:0`,
   `hook`, `task-start`, `task-end`. Because `drainAfterResponse()` returns
   immediately when `inFlight` is empty at `lib/http/after-response.ts:147-149`,
   `server.ts:260` can exit before the hook registers its work.

5. **High: the replacement Next.js rollback report is stale and unusable.**
   `reports/next-migration.md:23-70` describes the removed `formData` contract,
   lines 697-736 use nonexistent `buildHandlerInput`, lines 703-705 instruct
   readers to uncomment files that were deleted, and line 397 says
   `next.config.js` remains retained. This report was supposed to replace the
   deleted rollback source.

6. **Medium: the OpenAPI document is materially inaccurate.** The numerical
   claim of 25 paths and 16 paths with bodies is reproducible, but two declared
   body routes are missing: `DELETE /api/dash/users/:id/sessions` and
   `POST /api/dev/sign-up`. Four Better Auth operation IDs are duplicated
   between GET and POST, Better Auth responses are documented as the application
   envelope although runtime responses are `null`, `{success:true}`, or
   `{message,code}`, and actual `201` responses are documented only as `200`.

7. **Medium: manifest-driven HTTP behavior is incomplete.** `/openapi.json` is
   registered separately at `app.ts:305-307`, so it bypasses the manifest's
   required policies and lookup. Runtime results were
   `POST /openapi.json -> 404`, `OPTIONS /openapi.json -> 404`, and
   `/openapi.json/ -> 404`, rather than the claimed 405, route-aware OPTIONS,
   and 308 behavior. Conversely, the broad auth prefix at
   `lib/http/route-manifest.ts:132-135` makes nonexistent `/api/auth/*` paths
   return `OPTIONS 204` and unsupported methods return 405 instead of remaining
   genuine 404s.

8. **Medium: the scanner does not prove registration.**
   `scripts/find-unused-files.ts:224-235` only verifies that `routes.ts` imports
   a handler module. A module imported but omitted from the `ROUTES` array, or
   an exported method never referenced by a route entry, still passes. The
   current route table is complete, but the claimed future gate is not.

## Verified

- `bun run lint`: passed.
- `bun run format:check`: passed.
- `bun run test`: 60 passed, 0 failed.
- `bun scripts/find-unused-files.ts`: passed under its current limited checks.
- `bun audit` and `actionlint`: passed.
- `bun run smoke`: 6/6 when supplied the exact CI environment.
- CORS now advertises `X-Captcha-Response` and `max-age: 600`.
- Main manifest routes correctly produce 405 responses and 308 trailing-slash
  redirects.
- The reported 28 route entries across 21 paths are accurate.
- SQLite ordering and deterministic statement finalization appear correctly
  implemented.

## Verdict

The implementation contains substantial correct work, but it is not ready to
accept as complete. The response and summary materially overstate the result,
especially around CI, Better Auth origin handling, admission ordering, shutdown,
OpenAPI, and the rollback report.

No source files were changed during verification. This report is the only file
created for the verification.
