// eslint-disable-next-line unicorn/prefer-node-protocol
import { randomBytes } from 'crypto';

/**
 * Sanitizes a filename by removing potentially dangerous characters.
 * Removes extension and dots for extra security.
 *
 * @param filename - The original filename to sanitize
 * @param maxLength - Maximum length for the sanitized name (default: 50)
 * @returns Sanitized filename safe for display
 */
export function sanitizeFilename(filename: string, maxLength = 50): string {
  if (!filename || typeof filename !== 'string') return 'unnamed';

  // Remove extension, then keep only safe chars, collapse spaces, trim
  const lastDot = filename.lastIndexOf('.');
  const nameWithoutExt = lastDot > 0 ? filename.slice(0, lastDot) : filename;

  const sanitized = nameWithoutExt
    .replaceAll('..', '')
    .replaceAll(/[^\p{L}\p{N}\p{Zs}_\-()]/gu, '')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);

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
