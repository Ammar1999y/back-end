import type { RouteDefinition } from '../route-manifest';

import { handleApiError } from '@/utils/api-response';

import { enforcePreAuthIpLimit } from '../pre-auth';
import { buildRequestMeta, withBodyPolicy } from '../request';
import { toWebResponse } from '../response';

/**
 * The subset of Elysia's route context this adapter reads.
 *
 * Declared structurally rather than imported from `elysia`: the exported
 * `Context` is generic over the whole instance's route/decorator/store
 * inference, so naming it here would drag the app's full type graph into every
 * handler module — and the adapter only ever touches three always-present
 * fields. Elysia's own context satisfies this, which the `app.ts` call sites
 * check.
 */
export interface ElysiaRouteContext {
  request: Request;
  params: Record<string, string>;
  /**
   * `null` outside a live listener (Elysia types it that way), so every use is
   * optional. Matches `Server['timeout']` in
   * `node_modules/elysia/dist/universal/server.d.ts:268`.
   */
  server: { timeout(request: Request, seconds: number): void } | null;
}

/**
 * Lifts a framework-agnostic `Handler` into an Elysia route handler.
 *
 * The ORDER below is the security-relevant part, and it is the inverse of what
 * this adapter did before:
 *
 *   1. read the request head — no body byte is touched
 *   2. run admission checks (the coarse per-IP limit) against that head
 *   3. extend the per-request timeout, if the route asked for one
 *   4. hand the handler LAZY readers, gated to the shape the route declared
 *
 * Nothing here parses a body. `withBodyPolicy` is synchronous and returns
 * readers; the handler calls one after its own checks. Previously the parse
 * happened at step 4, so an unauthenticated request had its body buffered
 * before anything decided whether it was allowed — and JSON-only routes parsed
 * attacker-supplied multipart data because the client's `Content-Type` chose
 * the parser. Moving the parse into the handler also covers the routes whose
 * only admission check is their own limiter rather than the adapter's.
 *
 * ⚠️ Every route registered with this MUST pass `parse: 'none'` (see
 * `elysiaRouteConfig`). Elysia parses the body into `ctx.body` by default,
 * which drains the stream this adapter reads — multipart uploads then fail with
 * `Body has already been used`.
 */
export function toElysiaHandler(route: RouteDefinition) {
  return async (ctx: ElysiaRouteContext): Promise<Response> => {
    try {
      const meta = buildRequestMeta(ctx.request, ctx.params ?? {});
      if (route.preAuth === 'ip-limit') await enforcePreAuthIpLimit(meta);
      if (route.timeoutSeconds !== undefined)
        ctx.server?.timeout(ctx.request, route.timeoutSeconds);
      return toWebResponse(
        await route.handler(withBodyPolicy(meta, route.body))
      );
    } catch (error) {
      return toWebResponse(handleApiError(error));
    }
  };
}

/**
 * Route config every adapter-registered route must spread in. `parse: 'none'`
 * is not optional — see the warning on `toElysiaHandler`.
 */
export const elysiaRouteConfig = { parse: 'none' } as const;
