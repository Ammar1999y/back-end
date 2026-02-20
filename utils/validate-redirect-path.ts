/**
 * Validates redirect path to prevent Open Redirect attacks.
 * Allows complex query params like: /dash/languages?sort=%5B%7B"id"...
 *
 * @security Defense layers:
 * 1. Basic validation (type, length, format)
 * 2. Control & invisible character blocking (including Unicode)
 * 3. Multi-decode to catch %2F%2F, %252F%252F attacks
 * 4. URL API validation with pathname normalization check
 */
export function validateRedirectPath(path: string, fallback = '/dash'): string {
  // 1. Basic validation
  if (!path || typeof path !== 'string') return fallback;

  // 2. Block control chars & dangerous Unicode BEFORE any processing
  // Includes: control chars, zero-width, soft hyphen, bidirectional, BOM,
  // fullwidth @, Unicode slashes that may normalize
  // prettier-ignore
  // eslint-disable-next-line security/detect-non-literal-regexp
  const dangerousCharsPattern = new RegExp([
    '[\u0000-\u001F\u007F]',       // Control characters
    '[\u00AD]',                     // Soft hyphen (invisible)
    '[\u200B-\u200F]',              // Zero-width chars
    '[\u2028-\u202F]',              // Line/paragraph separators, bidirectional
    '[\uFEFF]',                     // BOM
    '[\uFF20]',                     // Fullwidth @ (＠)
    '[\u2215\u2044\uFF0F\u29F8]',   // Unicode slashes (∕, ⁄, ／, ⧸)
  ].join('|'));
  if (dangerousCharsPattern.test(path)) return fallback;

  const trimmed = path.trim();
  if (!trimmed || trimmed.length > 2048) return fallback;

  // 3. Must be relative path (starts with / but not //)
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return fallback;

  // 4. Block backslashes (browsers may interpret \ as /)
  if (trimmed.includes('\\')) return fallback;

  // 5. Decode to catch encoded attacks (%2F%2F = //, %252F = %2F)
  let decoded = trimmed;
  try {
    let prev = '';
    for (let i = 0; i < 5 && decoded !== prev; i++) {
      prev = decoded;
      decoded = decodeURIComponent(decoded);
    }
  } catch {
    decoded = trimmed;
  }

  // 6. Validate decoded version
  const protocolPattern = /^[a-z][a-z0-9+.-]*:/i;
  if (
    decoded.startsWith('//') ||
    decoded.includes('\\') ||
    decoded.includes('@') ||
    protocolPattern.test(decoded) ||
    dangerousCharsPattern.test(decoded)
  ) {
    return fallback;
  }

  // 7. URL API validation - CRITICAL: check normalized pathname
  try {
    const url = new URL(trimmed, 'http://localhost');

    // Origin check
    if (url.origin !== 'http://localhost') return fallback;

    // CRITICAL: Path traversal can normalize to //evil.com
    // e.g., /..//evil.com -> pathname becomes //evil.com (protocol-relative!)
    // Only block // at START of pathname (middle // like /test//file is safe)
    if (url.pathname.startsWith('//')) return fallback;

    // Check hash for dangerous protocols
    if (url.hash && protocolPattern.test(url.hash.slice(1))) return fallback;

    // Check hash for // at start (could be used with JS that reads hash)
    if (url.hash.startsWith('#//')) return fallback;
  } catch {
    return fallback;
  }

  return trimmed;
}
