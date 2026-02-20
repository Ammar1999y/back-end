import * as z from 'zod';

import { returnNumberOrNull } from '..';
import { idSchema, trimed } from './rules';

// Constants
const MIN_LETTER_SPACING = -10;
const MAX_LETTER_SPACING = 50;
const MIN_LINE_HEIGHT = 0.5;
const MAX_LINE_HEIGHT = 5;
const MIN_FONT_SIZE_MULTIPLIER = 0.5;
const MAX_FONT_SIZE_MULTIPLIER = 3;

// Google font name schema
const googleFontSchema = z
  .preprocess(trimed, z.string().max(100, 'اسم الخط طويل جداً').nullish())
  .nullish();

// Letter spacing schema (in px, 0 = normal)
const letterSpacingSchema = z.preprocess(
  (v: string | undefined | number | null) => returnNumberOrNull(v) ?? 0,
  z
    .number('تباعد الأحرف يجب أن يكون رقماً')
    .min(
      MIN_LETTER_SPACING,
      `تباعد الأحرف يجب أن يكون أكبر من ${MIN_LETTER_SPACING}`
    )
    .max(
      MAX_LETTER_SPACING,
      `تباعد الأحرف يجب أن يكون أقل من ${MAX_LETTER_SPACING}`
    )
);

// Line height schema (multiplier, 1 = 100%)
const lineHeightSchema = z.preprocess(
  (v: string | undefined | number | null) => returnNumberOrNull(v) ?? 1,
  z
    .number('تباعد الأسطر يجب أن يكون رقماً')
    .min(MIN_LINE_HEIGHT, `تباعد الأسطر يجب أن يكون أكبر من ${MIN_LINE_HEIGHT}`)
    .max(MAX_LINE_HEIGHT, `تباعد الأسطر يجب أن يكون أقل من ${MAX_LINE_HEIGHT}`)
);

// Font size multiplier schema (1 = 100%)
const fontSizeMultiplierSchema = z.preprocess(
  (v: string | undefined | number | null) => returnNumberOrNull(v) ?? 1,
  z
    .number('مضاعف حجم الخط يجب أن يكون رقماً')
    .min(
      MIN_FONT_SIZE_MULTIPLIER,
      `مضاعف حجم الخط يجب أن يكون أكبر من ${MIN_FONT_SIZE_MULTIPLIER}`
    )
    .max(
      MAX_FONT_SIZE_MULTIPLIER,
      `مضاعف حجم الخط يجب أن يكون أقل من ${MAX_FONT_SIZE_MULTIPLIER}`
    )
);

// Language font settings schema
const languageFontSettingsSchema = z.object({
  languageId: idSchema,
  googleFont: googleFontSchema,
  letterSpacing: letterSpacingSchema,
  lineHeight: lineHeightSchema,
  fontSizeMultiplier: fontSizeMultiplierSchema,
});

// Font settings schema (for update - single global record)
export const fontSettingsSchema = z.object({
  id: idSchema,
  languages: z
    .array(languageFontSettingsSchema, 'إعدادات اللغات غير صحيحة')
    .min(1, 'يجب إضافة إعدادات لغة واحدة على الأقل'),
});

// Create font settings schema (without id)
export const createFontSettingsSchema = z.object({
  languages: z
    .array(languageFontSettingsSchema, 'إعدادات اللغات غير صحيحة')
    .min(1, 'يجب إضافة إعدادات لغة واحدة على الأقل'),
});

// Type inference
export type LanguageFontSettingsInput = z.input<
  typeof languageFontSettingsSchema
>;
export type LanguageFontSettingsOutput = z.output<
  typeof languageFontSettingsSchema
>;
export type FontSettingsInput = z.input<typeof fontSettingsSchema>;
export type FontSettingsOutput = z.output<typeof fontSettingsSchema>;
export type CreateFontSettingsInput = z.input<typeof createFontSettingsSchema>;
export type CreateFontSettingsOutput = z.output<
  typeof createFontSettingsSchema
>;
