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

export const DANGEROUS_CSS_PATTERNS = [
  /javascript:/gi,
  /expression\s*\(/gi,
  /-moz-binding/gi,
  /behavior\s*:/gi,
  /@import\s+url\s*\(/gi,
  /url\s*\(\s*["']?\s*javascript:/gi,
  /url\s*\(\s*["']?\s*data:text\/html/gi,
  /url\s*\(\s*["']?\s*data:image\/svg\+xml[^)]*<script/gi,
];

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

// Helper: فك ترميز URL بأمان
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

// Helper: فحص إذا كانت القيمة خطيرة
export function isDangerousValue(value: string): boolean {
  const normalized = safeDecodeURI(value).toLowerCase().trim();
  return (
    normalized.includes('javascript:') ||
    normalized.includes('vbscript:') ||
    normalized.includes('data:text/html') ||
    normalized.includes('<script') ||
    normalized.includes('alert(') ||
    normalized.includes('eval(')
  );
}
