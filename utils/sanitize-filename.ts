// eslint-disable-next-line unicorn/prefer-node-protocol
import { randomBytes } from 'crypto';

/**
 * Sanitizes a filename by removing potentially dangerous characters.
 * Removes extension and dots for extra security.
 *
 * `maxLength` counts CODE POINTS, not UTF-16 code units, and the trim runs
 * AFTER the truncation. Both were the other way round, and both were reachable
 * from a real upload:
 *
 * - The allowlist admits astral characters (`U+20000` is `\p{Lo}`), each two
 *   code units, so `.slice()` could cut a surrogate pair in half and emit a
 *   LONE SURROGATE. That name goes into the R2 object key, and a lone surrogate
 *   cannot be percent-encoded — `encodeURIComponent` throws `URIError`, which is
 *   not a `CustomError`, so the request became a deterministic 500 for
 *   attacker-chosen input after the server had already paid for buffering,
 *   `optimizeImage` and `generateBlurhash`.
 * - Trimming before slicing let the cut reintroduce a trailing space.
 *
 * @param filename - The original filename to sanitize
 * @param maxLength - Maximum length in code points (default: 50)
 * @returns Sanitized filename safe for display
 */
export function sanitizeFilename(filename: string, maxLength = 50): string {
  if (!filename || typeof filename !== 'string') return 'unnamed';

  const lastDot = filename.lastIndexOf('.');
  const nameWithoutExt = lastDot > 0 ? filename.slice(0, lastDot) : filename;

  const cleaned = nameWithoutExt
    .replaceAll('..', '')
    .replaceAll(/[^\p{L}\p{N}\p{Zs}_\-()]/gu, '')
    .replaceAll(/\s+/g, ' ');

  const sanitized = [...cleaned].slice(0, maxLength).join('').trim();

  return sanitized || 'unnamed';
}

/**
 * Generates a short cryptographically secure random ID.
 * Uses crypto.randomBytes for security and speed.
 *
 * @returns 16-character hex string
 */
export function generateShortId(): string {
  return randomBytes(8).toString('hex');
}
