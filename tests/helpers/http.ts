import { BASE_URL } from './env';

export interface ApiResponse<T = unknown> {
  status: number;
  body: {
    success?: boolean;
    message?: string;
    data?: T;
    meta?: unknown;
    [k: string]: unknown;
  };
  headers: Headers;
  cookies: string[];
  rawBody: string;
}

interface ApiRequestInit {
  method?: string;
  body?: unknown;
  /** Raw string body — overrides `body` JSON encoding. Used for malformed-JSON tests. */
  rawBody?: string;
  headers?: Record<string, string>;
  /** Cookies to send (string of `name=value; name=value`). */
  cookie?: string;
  /** Synthetic client IP placed into the trusted proxy header. Keep unique per
   *  request to avoid Upstash rate-limit bleed between unrelated tests. */
  ip?: string;
  /** Set to true to skip the default test captcha header. */
  noCaptcha?: boolean;
  /** Override default `x-captcha-response: test`. Pass empty string to send blank. */
  captcha?: string;
}

// Each request gets a unique synthetic IP unless one is supplied, so the
// per-IP rate limiters don't conflate independent tests.
let ipCounter = 0;
export function nextIp(): string {
  ipCounter += 1;
  // 10.x.y.z block, deterministic-ish but unique inside a run.
  const a = (ipCounter >> 16) & 0xff;
  const b = (ipCounter >> 8) & 0xff;
  const c = ipCounter & 0xff;
  return `10.${a}.${b}.${c}`;
}

/** Send a request to the running Next dev server and decode the response. */
export async function api<T = unknown>(
  path: string,
  init: ApiRequestInit = {}
): Promise<ApiResponse<T>> {
  const method = init.method ?? (init.body || init.rawBody ? 'POST' : 'GET');
  const ip = init.ip ?? nextIp();
  const headers: Record<string, string> = {
    'user-agent': 'bun-test',
    // Our handlers read IP from cf-connecting-ip (see lib/audit.ts).
    'cf-connecting-ip': ip,
    // Better Auth's rate-limit plugin reads from x-forwarded-for; keep them
    // in sync so per-IP limiters apply to the same bucket across both stacks.
    'x-forwarded-for': ip,
    // Better Auth enforces CSRF by requiring the request Origin to match the
    // configured baseURL. Without this header, sign-out (and other mutating
    // routes) reject with 403 MISSING_OR_NULL_ORIGIN.
    origin: BASE_URL,
    ...(init.headers ?? {}),
  };

  if (!init.noCaptcha && !('x-captcha-response' in headers))
    headers['x-captcha-response'] = init.captcha ?? 'test-captcha-token';

  if (init.cookie) headers.cookie = init.cookie;

  let body: BodyInit | undefined;
  if (init.rawBody !== undefined) {
    body = init.rawBody;
    if (!('content-type' in headers) && method !== 'GET' && method !== 'HEAD')
      headers['content-type'] = 'application/json';
  } else if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    if (!('content-type' in headers))
      headers['content-type'] = 'application/json';
  }

  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body });
  const text = await res.text();
  let parsed: ApiResponse<T>['body'] = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text } as Record<string, unknown>;
  }

  return {
    status: res.status,
    body: parsed as ApiResponse<T>['body'],
    headers: res.headers,
    cookies: res.headers.getSetCookie(),
    rawBody: text,
  };
}

/**
 * Wait for the dev server to respond before running tests.
 * Polls a cheap endpoint; gives up after `timeoutMs`.
 */
export async function waitForServer(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/auth/get-session`, {
        method: 'GET',
        headers: { 'cf-connecting-ip': '127.0.0.1' },
      });
      // Any HTTP response = server is up (even 401/404).
      if (res.status > 0) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `tests: server at ${BASE_URL} not ready after ${timeoutMs}ms (last error: ${String(lastErr)})`
  );
}

/** Extract `better-auth.session_token=<value>` from a Set-Cookie array. */
export function extractSessionCookie(setCookie: string[]): string | null {
  const acc: string[] = [];
  for (const line of setCookie) {
    const first = line.split(';')[0]?.trim();
    if (!first) continue;
    if (first.startsWith('better-auth.session_token=') && !first.endsWith('='))
      acc.push(first);
    else if (
      first.startsWith('better-auth.session_data=') &&
      !first.endsWith('=')
    )
      acc.push(first);
  }
  return acc.length ? acc.join('; ') : null;
}
