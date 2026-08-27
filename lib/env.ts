/**
 * The single parse of the public origin.
 *
 * TypeScript, not JavaScript. It was `.js` so `next.config.js` could import it,
 * and Next is gone — but `tsconfig.json` sets `allowJs` WITHOUT `checkJs` and
 * this file carried no `// @ts-check`, so being in the program was not being
 * checked: `bun run lint` and `bun run build` both stayed green with an
 * arbitrary type error in it. The `@param`/`@returns` annotations it used to
 * carry were decorative, which is the worst state for the module that parses
 * `PUBLIC_ORIGIN` — the CORS allowlist, Better Auth's `baseURL`, and therefore
 * the origin cookies are signed against.
 *
 * One value, one parse, one canonical form — read by BOTH consumers that used
 * to disagree: `@elysia/cors` in `app.ts` and Better Auth's `baseURL` in
 * `lib/auth.ts`. Before this, CORS received a value canonicalised down to
 * scheme + hostname while Better Auth received the raw environment string, so
 * a path, a query, a fragment or embedded credentials were discarded by one
 * consumer and kept as input by the other. Security behaviour could not be
 * predicted from the configuration file alone.
 *
 * The rules are deliberately strict rather than forgiving. This value is an
 * ORIGIN: it is compared byte-for-byte against a browser `Origin` header and it
 * is the base Better Auth signs cookies against. Anything a browser would never
 * send in `Origin` — a path, a query, a fragment, `user:pass@` — is a
 * configuration mistake, and repairing it silently is how the two consumers
 * drifted apart in the first place.
 */

/** Hostnames browsers treat as a secure context regardless of scheme. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Accepted names, in precedence order. `NEXT_PUBLIC_URL` is the legacy name. */
const ORIGIN_ENV_NAMES = ['PUBLIC_URL', 'NEXT_PUBLIC_URL'] as const;

interface ConfiguredOrigin {
  name: string;
  value: string;
}

function readOriginEnv(): ConfiguredOrigin {
  const present: ConfiguredOrigin[] = [];
  for (const name of ORIGIN_ENV_NAMES) {
    const value = process.env[name]?.trim();
    if (value) present.push({ name, value });
  }

  if (present.length === 0)
    throw new Error(
      `⚠️ Missing required environment variable: ${ORIGIN_ENV_NAMES[0]} (legacy name: ${ORIGIN_ENV_NAMES[1]}). ` +
        'It must be an absolute origin, e.g. "https://app.example.com".'
    );

  const [first, ...rest] = present;
  // `present.length === 0` is rejected above, so this only narrows the type.
  if (!first) throw new Error('unreachable: no configured origin');
  for (const other of rest)
    if (other.value !== first.value)
      throw new Error(
        `⚠️ ${first.name} and ${other.name} are both set to different values. ` +
          `Unset ${other.name} and keep ${first.name}.`
      );

  return first;
}

/**
 * Parse the value into a canonical origin, rejecting everything an origin
 * cannot contain.
 *
 * No scheme is inferred. The previous parser prepended `https://` to a bare
 * host and then forced the scheme to `https` regardless of what was written,
 * so `http://localhost:3000` silently became `https://localhost` — a value no
 * browser would ever match. An explicit scheme is required instead.
 */
function parseOrigin(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `⚠️ ${name} is not an absolute URL. Received: "${raw}". ` +
        'Write the full origin including the scheme, e.g. "https://app.example.com".'
    );
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error(
      `⚠️ ${name} must use http: or https:. Received scheme: "${url.protocol}".`
    );

  if (url.username || url.password)
    throw new Error(
      `⚠️ ${name} must not contain credentials. Remove the "user:password@" part.`
    );

  if (url.pathname !== '/' && url.pathname !== '')
    throw new Error(
      `⚠️ ${name} must be an origin with no path. Received path: "${url.pathname}".`
    );

  if (url.search)
    throw new Error(`⚠️ ${name} must not contain a query string.`);

  if (url.hash) throw new Error(`⚠️ ${name} must not contain a fragment.`);

  // HTTPS is not merely recommended in production: the session cookie is
  // `Secure`, so an http: origin would deploy an application that cannot hold a
  // session. Localhost is exempt because browsers treat it as a secure context.
  const insecureInProduction =
    url.protocol !== 'https:' &&
    !LOCAL_HOSTNAMES.has(url.hostname) &&
    process.env.NODE_ENV === 'production';
  if (insecureInProduction)
    throw new Error(
      `⚠️ ${name} must use https: in production. Received: "${raw}".`
    );

  return url.origin;
}

const configured = readOriginEnv();

/**
 * The browser origin, WITH its port — `https://example.com`,
 * `http://localhost:3000`.
 *
 * This is the ONLY exported form of the setting. It is what the browser sends
 * in `Origin`, what `@elysia/cors` matches against, and what Better Auth signs
 * cookies against, so all three agree by construction.
 *
 * If the browser origin and the API origin ever need to differ, add a SECOND
 * variable and configure Better Auth `trustedOrigins` explicitly — do not
 * reintroduce a second derivation of this one.
 */
export const PUBLIC_ORIGIN = parseOrigin(configured.value, configured.name);
