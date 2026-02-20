/**
 * File type accept configurations for file upload components
 * Based on react-dropzone accept prop format
 */

/**
 * Supported image formats
 * - JPEG/JPG: Universal image format
 * - PNG: Lossless compression with transparency
 * - WebP: Modern format with better compression
 * - HEIF/HEIC: High efficiency format (iOS default)
 */
export const ACCEPT_IMAGES: Record<string, string[]> = {
  'image/*': ['.jpeg', '.jpg', '.png', '.webp', '.heif', '.heic'],
};

/**
 * Images with SVG support
 * Use with caution - SVGs are sanitized and optimized before upload
 */
export const ACCEPT_IMAGES_WITH_SVG: Record<string, string[]> = {
  'image/*': ['.jpeg', '.jpg', '.png', '.webp', '.heif', '.heic', '.svg'],
};

/**
 * PDF documents only
 */
export const ACCEPT_PDF: Record<string, string[]> = {
  'application/pdf': [],
};

/**
 * Images and PDF combined
 * Common use case for document uploads with visual content
 */
export const ACCEPT_IMAGES_AND_PDF: Record<string, string[]> = {
  'image/*': ['.jpeg', '.jpg', '.png', '.webp', '.heif', '.heic'],
  'application/pdf': ['.pdf'],
};

/**
 * Images with SVG and PDF combined
 */
export const ACCEPT_IMAGES_SVG_AND_PDF: Record<string, string[]> = {
  'image/*': ['.jpeg', '.jpg', '.png', '.webp', '.heif', '.heic', '.svg'],
  'application/pdf': ['.pdf'],
};
