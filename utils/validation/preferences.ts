/**
 * ⚠️ Every field stays a closed set or a bounded number. The frontend
 * concatenates these values into the `style` attribute of `<html>`, so a free-form
 * string here is CSS the browser runs.
 */

import * as z from 'zod';

import { FONT_SCALE_MAX, FONT_SCALE_MIN, PRESET_NAME_MAX } from './constants';

export const preferencesValidationMsg = {
  presetTooLong: `اسم السمة يجب أن لا يتجاوز ${PRESET_NAME_MAX} حرفاً`,
  presetInvalid: 'اسم السمة يحتوي على أحرف غير مسموحة',
  fontScaleOutOfRange: `حجم الخط يجب أن يكون بين ${FONT_SCALE_MIN} و ${FONT_SCALE_MAX}`,
};

export const COLOR_MODES = ['light', 'dark', 'system'] as const;
export const THEME_LAYOUTS = ['vertical', 'horizontal', 'mini'] as const;

/** Admits every shipped preset id; nothing readable as CSS or `__proto__`. */
export const PRESET_NAME_PATTERN = '^[a-z0-9][a-z0-9-]*$';

/**
 * Not an enum of preset ids: the client owns that list and falls back to its
 * default for an unknown one. Not `slugSchema`: it normalises, and a value that
 * does not round-trip byte-for-byte turns the client's reconcile into a write
 * loop.
 */
const presetSchema = z
  .string()
  .max(PRESET_NAME_MAX, preferencesValidationMsg.presetTooLong)
  .regex(
    new RegExp(PRESET_NAME_PATTERN),
    preferencesValidationMsg.presetInvalid
  );

const colorModeSchema = z.enum(COLOR_MODES);
const themeLayoutSchema = z.enum(THEME_LAYOUTS);
// Range only. The 0.025 step in `FONT_SCALE_CONFIG` is a slider affordance, not
// an invariant, and no float arithmetic hits its multiples exactly.
const fontScaleSchema = z
  .number()
  .min(FONT_SCALE_MIN, preferencesValidationMsg.fontScaleOutOfRange)
  .max(FONT_SCALE_MAX, preferencesValidationMsg.fontScaleOutOfRange);
const containerStretchSchema = z.boolean();

export const preferencesSchema = z
  .object({
    preset: presetSchema,
    colorMode: colorModeSchema,
    themeLayout: themeLayoutSchema,
    fontScale: fontScaleSchema,
    containerStretch: containerStretchSchema,
  })
  .strict();

export type StoredPreferences = z.infer<typeof preferencesSchema>;

/** `'default'` is the client's sentinel for "no preset" (`getPresetThemeStyles`). */
export const DEFAULT_PREFERENCES: StoredPreferences = {
  preset: 'default',
  colorMode: 'system',
  themeLayout: 'vertical',
  fontScale: 1,
  containerStretch: false,
};

function orDefault<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

/**
 * Lenient where `preferencesSchema` is strict, on purpose: the column's
 * `fromDriver` is a pass-through, and a row older than a field or hand-edited
 * must read as the default for that field, not throw or drop the other four.
 * A new field gets its value for existing rows here, not by a data migration.
 */
export function sanitizePreferences(stored: unknown): StoredPreferences {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored))
    return { ...DEFAULT_PREFERENCES };

  const raw = stored as Record<string, unknown>;

  return {
    preset: orDefault(presetSchema, raw.preset, DEFAULT_PREFERENCES.preset),
    colorMode: orDefault(
      colorModeSchema,
      raw.colorMode,
      DEFAULT_PREFERENCES.colorMode
    ),
    themeLayout: orDefault(
      themeLayoutSchema,
      raw.themeLayout,
      DEFAULT_PREFERENCES.themeLayout
    ),
    fontScale: orDefault(
      fontScaleSchema,
      raw.fontScale,
      DEFAULT_PREFERENCES.fontScale
    ),
    containerStretch: orDefault(
      containerStretchSchema,
      raw.containerStretch,
      DEFAULT_PREFERENCES.containerStretch
    ),
  };
}
