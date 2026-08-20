/**
 * The single parse of the public origin.
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
const ORIGIN_ENV_NAMES = /** @type {const} */ ([
  'PUBLIC_URL',
  'NEXT_PUBLIC_URL',
]);

/**
 * Resolve the configured value and the name it came from.
 *
 * Both names set to DIFFERENT values is rejected rather than resolved by
 * precedence: that state is always an incomplete rename, and picking a winner
 * silently would deploy the origin the operator did not mean.
 *
 * @returns {{ name: string, value: string }}
 */
function readOriginEnv() {
  /** @type {{ name: string, value: string }[]} */
  const present = [];
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
 *
 * @param {string} raw
 * @param {string} name
 * @returns {string}
 */
function parseOrigin(raw, name) {
  /** @type {URL} */
  let url;
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
