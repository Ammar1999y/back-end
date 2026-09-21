/**
 * `utils/validation/preferences.ts`: the strict write schema and the lenient
 * read boundary, pinned as a pair so a "share one schema" refactor has to break
 * this file on purpose.
 */
import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_PREFERENCES,
  preferencesSchema,
  sanitizePreferences,
} from '@/utils/validation/preferences';

const VALID = {
  preset: 'modern-minimal',
  colorMode: 'dark',
  themeLayout: 'mini',
  fontScale: 1.05,
  containerStretch: true,
} as const;

describe('preferencesSchema', () => {
  test('accepts the shape the customizer emits', () => {
    const parsed = preferencesSchema.safeParse(VALID);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({ ...VALID });
  });

  test('accepts the defaults it ships', () => {
    expect(preferencesSchema.safeParse(DEFAULT_PREFERENCES).success).toBe(true);
  });

  test('rejects an unknown key rather than dropping it', () => {
    const parsed = preferencesSchema.safeParse({ ...VALID, styles: {} });
    expect(parsed.success).toBe(false);
    expect(parsed.success || parsed.error.issues[0]?.code).toBe(
      'unrecognized_keys'
    );
  });

  test('rejects a partial document — PUT replaces, it does not patch', () => {
    const { fontScale: _dropped, ...partial } = VALID;
    expect(preferencesSchema.safeParse(partial).success).toBe(false);
  });

  // Each of these reaches a CSS custom property on the client if it is stored.
  test.each([
    ['a declaration terminator', 'blue; background: url(https://x)'],
    ['a var() reference', 'var(--primary)'],
    ['an uppercase name the client would not resolve', 'Blue'],
    ['a leading hyphen', '-blue'],
    ['whitespace', 'modern minimal'],
    ['an object prototype key', '__proto__'],
  ])('rejects a preset carrying %s', (_label, preset) => {
    expect(preferencesSchema.safeParse({ ...VALID, preset }).success).toBe(
      false
    );
  });

  test('bounds the preset length', () => {
    const parsed = preferencesSchema.safeParse({
      ...VALID,
      preset: 'a'.repeat(51),
    });
    expect(parsed.success).toBe(false);
  });

  test.each([
    ['below the floor', 0.8],
    ['above the ceiling', 1.5],
    ['infinite', Infinity],
    ['not a number', '1'],
  ])('rejects a fontScale that is %s', (_label, fontScale) => {
    expect(preferencesSchema.safeParse({ ...VALID, fontScale }).success).toBe(
      false
    );
  });

  test.each([
    ['colorMode', 'colour'],
    ['themeLayout', 'sidebar'],
  ])('rejects a %s outside its closed set', (field, value) => {
    expect(
      preferencesSchema.safeParse({ ...VALID, [field]: value }).success
    ).toBe(false);
  });
});

describe('sanitizePreferences', () => {
  test.each([
    ['null', null],
    ['undefined — the row that does not exist yet', undefined],
    ['a jsonb string scalar, which the pass-through mapper admits', '{}'],
    ['an array', []],
    ['a number', 7],
  ])('returns the defaults for %s', (_label, stored) => {
    expect(sanitizePreferences(stored)).toEqual(DEFAULT_PREFERENCES);
  });

  test('round-trips a document this schema wrote', () => {
    expect(sanitizePreferences(VALID)).toEqual({ ...VALID });
  });

  test('fills a field a previous shape never wrote', () => {
    const { containerStretch: _absent, ...older } = VALID;
    expect(sanitizePreferences(older)).toEqual({
      ...VALID,
      containerStretch: DEFAULT_PREFERENCES.containerStretch,
    });
  });

  test('replaces one unreadable field and keeps the other four', () => {
    expect(sanitizePreferences({ ...VALID, fontScale: 99 })).toEqual({
      ...VALID,
      fontScale: DEFAULT_PREFERENCES.fontScale,
    });
  });

  test('drops an unknown key instead of returning it', () => {
    const result = sanitizePreferences({ ...VALID, styles: { light: {} } });
    const byText = (a: string, b: string) => (a === b ? 0 : a < b ? -1 : 1);
    expect(Object.keys(result).toSorted(byText)).toEqual(
      Object.keys(DEFAULT_PREFERENCES).toSorted(byText)
    );
  });

  test('reads a document the write schema would refuse', () => {
    const hostile = { ...VALID, preset: 'var(--x); background: red' };
    expect(preferencesSchema.safeParse(hostile).success).toBe(false);
    expect(sanitizePreferences(hostile)).toEqual({
      ...VALID,
      preset: DEFAULT_PREFERENCES.preset,
    });
  });
});
