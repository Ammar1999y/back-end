/**
 * One egress boundary for the whole suite.
 *
 * Every outbound HTTP call in this codebase is a hardcoded absolute URL —
 * `challenges.cloudflare.com` (Turnstile), `apis.deewan.sa` (SMS),
 * `services.rmz.one` (WhatsApp), `api.pwnedpasswords.com` (HIBP) — so there is
 * no injected base URL to redirect and no per-provider seam to stub. Replacing
 * `globalThis.fetch` with a host router is the only place all of them meet.
 *
 * One mechanism, two properties:
 *
 * 1. **The fakes.** A scripted response per known host, so nothing in the suite
 *    depends on a third party being reachable.
 * 2. **The negative assertion.** An unexpected host FAILS the test rather than
 *    quietly erroring inside a `catch` that treats a network failure as
 *    "verification declined". That is exactly the defect class where an
 *    unreachable `/api/auth/*` path spent Turnstile quota — the response looked
 *    identical either way, and only the absence of a call distinguishes them.
 *
 * Callers here swallow their own failures by design (`verifyTurnstileToken`
 * fails closed, `checkPasswordCompromise` fails open, `processOtpSend` logs and
 * moves on), so a thrown rejection cannot be the whole mechanism: the violation
 * is RECORDED as well as thrown, and `assertNoEgressViolations` — registered as
 * a global `afterEach` by the base preload — is what turns it into a red test.
 *
 * Where a real socket is wanted (a timeout, a 5xx, a slow provider), point a
 * route at a `Bun.serve` instance instead of returning a synthetic `Response`:
 * loopback is passed through to the real `fetch` untouched.
 */

/** One recorded outbound attempt. */
export interface EgressCall {
  host: string;
  method: string;
  url: string;
  /** Present only for a request whose body was a string or `URLSearchParams`. */
  body?: string;
}

type EgressRoute = (request: Request) => Response | Promise<Response>;

/** Hosts whose traffic is a real socket the test itself opened. */
const PASSTHROUGH_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const calls: EgressCall[] = [];
const violations: string[] = [];
const overrides = new Map<string, EgressRoute>();

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/**
 * The default answer per host, chosen so the happy path is the default and a
 * test that wants a failure has to ask for it.
 *
 * The Turnstile body is `{ success: true }` and not merely a 200: `verifyTurnstileToken`
 * reads the field, so a 200 with the wrong shape is a rejection that looks like
 * a network problem.
 */
const DEFAULT_ROUTES: Record<string, EgressRoute> = {
  'challenges.cloudflare.com': () => json({ success: true }),
  // HIBP returns a text range. An empty body means "suffix not found", i.e. the
  // password is not breached — and `checkPasswordCompromise` splits on newlines,
  // so a JSON body here would read as one nonsense hash line rather than an error.
  'api.pwnedpasswords.com': () =>
    new Response('', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }),
  'apis.deewan.sa': () => json({ status: 'sent' }),
  // `sendOtpWhatsApp` requires a truthy `status` in the body, not just a 2xx.
  'services.rmz.one': () => json({ status: 'success' }),
};

/** Cloudflare R2, whose hostname carries the account id. */
function isR2Host(host: string): boolean {
  return host.endsWith('.r2.cloudflarestorage.com');
}

export function egressCalls(): readonly EgressCall[] {
  return calls;
}

/** Calls to one host, which is what most assertions actually want. */
export function egressCallsTo(host: string): readonly EgressCall[] {
  return calls.filter((call) => call.host === host);
}

export function resetEgress(): void {
  calls.length = 0;
  violations.length = 0;
  overrides.clear();
}

/**
 * Replaces the answer for one host for the rest of the test.
 *
 * Cleared by `resetEgress`, which the base preload runs in `beforeEach`, so an
 * override cannot outlive the test that installed it.
 */
export function scriptEgress(host: string, route: EgressRoute): void {
  overrides.set(host, route);
}

/**
 * Fails the current test if any request went to a host the suite does not know.
 *
 * Registered globally rather than per file: the property is "this code path made
 * no call it should not have", and a path only has to be forgotten once for a
 * per-file check to miss it.
 */
export function assertNoEgressViolations(): void {
  if (violations.length === 0) return;
  const seen = violations.join('\n  ');
  violations.length = 0;
  throw new Error(
    `unexpected outbound HTTP request(s) — no fake is installed for these hosts:\n  ${seen}\n` +
      'Either the code under test should not be calling out here, or the host ' +
      'belongs in tests/helpers/egress.ts.'
  );
}

async function bodyText(request: Request): Promise<string | undefined> {
  if (!request.body) return undefined;
  try {
    return await request.clone().text();
  } catch {
    return undefined;
  }
}

export function installEgressGuard(): void {
  const realFetch = fetch;

  const guarded = async (
    input: URL | RequestInfo,
    init?: RequestInit
  ): Promise<Response> => {
    const request = new Request(input as RequestInfo, init);
    const host = new URL(request.url).hostname;

    if (PASSTHROUGH_HOSTS.has(host))
      return realFetch(input as RequestInfo, init);

    calls.push({
      host,
      method: request.method,
      url: request.url,
      body: await bodyText(request),
    });

    const route =
      overrides.get(host) ??
      DEFAULT_ROUTES[host] ??
      (isR2Host(host) ? () => new Response(null, { status: 200 }) : undefined);

    if (route) return route(request);

    violations.push(`${request.method} ${request.url}`);
    throw new Error(`egress guard: no fake installed for host "${host}"`);
  };

  // Replacing the global IS the mechanism: every outbound call in this codebase
  // is a hardcoded absolute URL with no injected client, so there is no other
  // seam they all pass through. `preconnect` is carried over rather than
  // reimplemented — it is a no-op hint, and dropping it would change a
  // performance behaviour the suite is not testing.
  // eslint-disable-next-line unicorn/no-global-object-property-assignment -- installing the egress boundary is this function's entire purpose
  globalThis.fetch = Object.assign(guarded, {
    preconnect: realFetch.preconnect.bind(realFetch),
  });
}
