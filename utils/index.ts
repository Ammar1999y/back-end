/* eslint-disable unicorn/prefer-math-trunc */
import { MAX_ID } from '@/constants';
import { EntityID } from '@/types';


import { v7 as uuidv7 } from 'uuid';

export function normalizeArabicDigits(input: any): any {
  if (typeof input !== 'string') return input;
  const ARNums = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
  return input.replace(/[٠-٩]/g, (n) => String(ARNums.indexOf(n)));
}

export const humanReadableNumber = (
  value: number | string,
  numberOfDigits = 2
) =>
  returnNumber(value).toLocaleString('en', {
    maximumFractionDigits: numberOfDigits,
  });

export function sanitizeForLog(input: any, maxLength = 1024) {
  if (process.env.NODE_ENV === 'development') return input;
  let message = String(input?.message || input);
  message = message.replaceAll(/[\r\n\u2028\u2029]+/g, ' ');
  if (message.length > maxLength)
    message = message.slice(0, maxLength - 3) + '...';
  return message;
}

export const returnNumber = (value: string | undefined | number | null) => {
  const num = Number(value);
  return !Number.isNaN(num) ? num : 0;
};
export const returnNumberOrNull = (
  value: string | undefined | number | null
) => {
  const num = Number(value);
  return !Number.isNaN(num) ? num : null;
};

export const positiveInt = (val: any, maxValue = MAX_ID) => {
  const num = Number(val);
  if (!Number.isFinite(num) || num <= 0 || num > maxValue) return 0;
  return num | 0;
};

export function isUniqueViolation(e: unknown): boolean {
  const anyErr = e as any;
  // TODO: test this
  return (
    anyErr?.code === '23505' || anyErr?.cause?.code === '23505' /* ||
    /duplicate|unique/i.test(anyErr?.message ?? '') ||
    /duplicate|unique/i.test(anyErr?.cause?.message ?? '') */
  );
}

// PostgreSQL FK violation code: 23503
export function isForeignKeyViolation(e: unknown): boolean {
  const anyErr = e as any;
  return anyErr?.code === '23503' || anyErr?.cause?.code === '23503';
}

export function getConstraintName(e: unknown): string {
  const anyErr = e as any;
  return anyErr?.constraint ?? anyErr?.cause?.constraint ?? '';
}

export const formatDate = (date: string) =>
  new Date(date).toLocaleDateString('ar-EG', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

// UUID v7 validation regex
// Format: xxxxxxxx-xxxx-7xxx-xxxx-xxxxxxxxxxxx
const UUID_V7_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates if the given value is a valid UUID v7
 * @param val - Value to validate
 * @returns The valid UUID v7 string, or empty string if invalid
 */
export const validID = (val: any): string => {
  if (typeof val !== 'string') return '';
  const trimmed = val.trim();
  return UUID_V7_REGEX.test(trimmed) ? trimmed : '';
};

/**
 * Generates a UUID v7 (time-ordered UUID)
 * @returns A new UUID v7 string
 */
export const generateUUIDv7 = (): EntityID => {
  return uuidv7();
};

/**
 * Extracts EntityID from the end of a URL path
 * Supports UUID v7 format and numeric IDs
 * @param url - The URL to extract ID from
 * @returns The extracted ID string, or null if not found
 */
export const extractIdFromUrl = (url: string): string | null => {
  // Match UUID v7 (36 chars with hyphens) or numeric ID at the end
  const match = url.match(/\/([0-9a-f-]{36}|\d+)$/i);
  return match ? match[1] : null;
};

// export const validID = positiveInt;
// export const extractIdFromUrl = (url: string): number | null => {
//   const idMatch = url.match(/\/(\d+)$/);
//   const id = idMatch ? Number(idMatch[1]) : null;
//   return id;
// };