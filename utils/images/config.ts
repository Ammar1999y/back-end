import type { Config } from 'svgo';

export const svgoConfig: Config = {
  multipass: true,
  plugins: [
    {
      name: 'preset-default',
      params: {
        overrides: {
          cleanupIds: {
            minify: true,
            preserve: [],
          },
        },
      },
    },
    'removeScripts',
    'removeRasterImages',
    'removeTitle',
  ],
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SVG Sanitizer Config
// ─────────────────────────────────────────────────────────────────────────────

export interface SanitizeResult {
  isValid: boolean;
  cleanedSvg: string;
  errors: string[];
}

export const SVG_MAX_ELEMENTS = 500;

export const DANGEROUS_ELEMENTS = [
  'script',
  'object',
  'embed',
  'iframe',
  'link',
  'meta',
  'foreignObject',
  'a',
] as const;

/**
 * A CSS escape: a backslash followed by 1-6 hex digits and one optional
 * whitespace, or a backslash followed by any other single character.
 *
 * CSS reads `@\69mport` as `@import` and `u\72l(` as `url(`, so a literal regex
 * over the raw text matches neither — measured, both reached the stored document
 * with their external reference intact. Every check below therefore runs against
 * the DECODED form.
 */
const CSS_ESCAPE = /\\(?:([0-9a-f]{1,6})[ \t\n\f\r]?|([\s\S]))/gi;

function decodeCssEscapes(value: string): string {
  return value.replaceAll(
    CSS_ESCAPE,
    (_match, hex: string | undefined, raw: string | undefined) => {
      if (hex === undefined) return raw ?? '';
      const code = Number.parseInt(hex, 16);
      // Null, surrogates and out-of-range are what a CSS parser replaces.
      if (!code || (code >= 0xd8_00 && code <= 0xdf_ff) || code > 0x10_ff_ff)
        return '\u{FFFD}';
      return String.fromCodePoint(code);
    }
  );
}

/**
 * Does any `url(...)` here point OUTSIDE the document?
 *
 * The target is PARSED, not approximated with a lookahead. The lookahead form
 * backtracks: for `url( #g)` the engine tries the branch where the whitespace
 * class consumed nothing, finds itself sitting on a space rather than `#`, and
 * reports a match — so `url( #g)` and `url('#g')` were both destroyed while the
 * escaped forms above got through.
 *
 * The allowlist is the whole rule: a same-document `#fragment`, or a `data:`
 * URI. Anything else — absolute, protocol-relative or root-relative — is a fetch
 * the VIEWER performs at view time, from a document the uploader controls.
 */
const URL_FUNCTION = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\)?/gi;

function hasExternalUrlReference(value: string): boolean {
  for (const match of decodeCssEscapes(value).matchAll(URL_FUNCTION)) {
    const target = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!target.startsWith('#') && !target.toLowerCase().startsWith('data:'))
      return true;
  }
  return false;
}

export const DANGEROUS_ATTRIBUTES = [
  'onload',
  'onerror',
  'onclick',
  'onmouseover',
  'onmouseout',
  'onmousemove',
  'onmouseenter',
  'onmouseleave',
  'onfocus',
  'onblur',
  'onchange',
  'onsubmit',
  'onkeydown',
  'onkeyup',
  'onkeypress',
  'onanimationstart',
  'onanimationend',
  'ontransitionend',
  'onanimationiteration',
  'onbegin',
  'onend',
  'onrepeat',
] as const;

// Malformed escapes remain unchanged so validation can reject them downstream.
export function safeDecodeURI(value: string): string {
  try {
    let decoded = decodeURIComponent(value);
    if (decoded !== value) {
      decoded = decodeURIComponent(decoded);
    }
    return decoded;
  } catch {
    return value;
  }
}

/**
 * Normalise once, so every check below sees the same text a CSS parser would.
 *
 * Both decodes are needed and neither substitutes for the other: `safeDecodeURI`
 * undoes percent-encoding (the attribute arrived through a URL), `decodeCssEscapes`
 * undoes CSS escapes (`u\72l(` is `url(` to a stylesheet, and to nothing else).
 */
function normalizeForDangerCheck(value: string): string {
  return decodeCssEscapes(safeDecodeURI(value)).toLowerCase().trim();
}

/**
 * No CSS-directive checks (`@import`, `@font-face`) live here on purpose:
 * `sanitizeSvg` deletes every `<style>` element and every `style` attribute
 * before serialising, so no stylesheet reaches a stored document to check.
 * This runs on the ATTRIBUTE values that survive.
 */
export function isDangerousValue(value: string): boolean {
  const normalized = normalizeForDangerCheck(value);
  return (
    normalized.includes('javascript:') ||
    normalized.includes('vbscript:') ||
    normalized.includes('data:text/html') ||
    normalized.includes('<script') ||
    normalized.includes('alert(') ||
    normalized.includes('eval(') ||
    hasExternalUrlReference(normalized)
  );
}
