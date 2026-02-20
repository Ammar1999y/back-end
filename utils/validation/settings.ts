import type {
  ContactInfoItem,
  NavLinkItem,
  SocialAccountItem,
} from '@/types/settings';

import * as z from 'zod';

import { returnNumberOrNull } from '..';
import {
  getColorSchema,
  getIDSchema,
  idSchema,
  orderSchema,
  sanitizeStrict,
  sanitizeStrictSingleLine,
  slugPreprocess,
  trimed,
} from './rules';

// Constants
const SITE_TITLE_MAX = 100;
const DESCRIPTION_MAX = 500;
const COPYRIGHT_MAX = 200;

// Font constants
const MIN_LETTER_SPACING = -10;
const MAX_LETTER_SPACING = 50;
const MIN_LINE_HEIGHT = 0.5;
const MAX_LINE_HEIGHT = 5;
const MIN_FONT_SIZE_MULTIPLIER = 0.5;
const MAX_FONT_SIZE_MULTIPLIER = 3;

// Site title schema with sanitization and validation
const siteTitleSchema = z.preprocess(
  sanitizeStrictSingleLine,
  z
    .string()
    .max(
      SITE_TITLE_MAX,
      `عنوان الموقع يجب أن لا يتجاوز ${SITE_TITLE_MAX} حرفاً`
    )
);

// Site description schema (optional)
const siteDescriptionSchema = z.preprocess(
  sanitizeStrict,
  z
    .string()
    .max(
      DESCRIPTION_MAX,
      `وصف الموقع يجب أن لا يتجاوز ${DESCRIPTION_MAX} حرفاً`
    )
);

// Footer description schema (optional)
const footerDescriptionSchema = z.preprocess(
  sanitizeStrict,
  z
    .string()
    .max(
      DESCRIPTION_MAX,
      `وصف الفوتر يجب أن لا يتجاوز ${DESCRIPTION_MAX} حرفاً`
    )
);

// Copyright text schema (optional)
const copyrightTextSchema = z.preprocess(
  sanitizeStrictSingleLine,
  z
    .string()
    .max(COPYRIGHT_MAX, `نص الحقوق يجب أن لا يتجاوز ${COPYRIGHT_MAX} حرفاً`)
);

// Primary color schema (no alpha)
const primaryColorSchema = getColorSchema({ optional: true });

// Font schemas
const googleFontSchema = z
  .preprocess(trimed, z.string().max(100, 'اسم الخط طويل جداً').nullish())
  .nullish();

const letterSpacingSchema = z.preprocess(
  (v: string | undefined | number | null) => returnNumberOrNull(v) ?? 0,
  z
    .number()
    .min(
      MIN_LETTER_SPACING,
      `تباعد الأحرف يجب أن يكون أكبر من ${MIN_LETTER_SPACING}`
    )
    .max(
      MAX_LETTER_SPACING,
      `تباعد الأحرف يجب أن يكون أقل من ${MAX_LETTER_SPACING}`
    )
);

const lineHeightSchema = z.preprocess(
  (v: string | undefined | number | null) => returnNumberOrNull(v) ?? 1,
  z
    .number()
    .min(MIN_LINE_HEIGHT, `تباعد الأسطر يجب أن يكون أكبر من ${MIN_LINE_HEIGHT}`)
    .max(MAX_LINE_HEIGHT, `تباعد الأسطر يجب أن يكون أقل من ${MAX_LINE_HEIGHT}`)
);

const fontSizeMultiplierSchema = z.preprocess(
  (v: string | undefined | number | null) => returnNumberOrNull(v) ?? 1,
  z
    .number()
    .min(
      MIN_FONT_SIZE_MULTIPLIER,
      `مضاعف حجم الخط يجب أن يكون أكبر من ${MIN_FONT_SIZE_MULTIPLIER}`
    )
    .max(
      MAX_FONT_SIZE_MULTIPLIER,
      `مضاعف حجم الخط يجب أن يكون أقل من ${MAX_FONT_SIZE_MULTIPLIER}`
    )
);

// Settings fonts schema (simple, without language support for now)
// LANGUAGES-TODOS: When adding multi-language support, convert to array structure
const settingsFontsSchema = z
  .object({
    googleFont: googleFontSchema,
    letterSpacing: letterSpacingSchema,
    lineHeight: lineHeightSchema,
    fontSizeMultiplier: fontSizeMultiplierSchema,
  })
  .nullish();

// Item constants
const ITEM_TITLE_MAX = 100;
const ITEM_LINK_MAX = 500;
const MAX_ITEMS = 20;

// Item title schema
const itemTitleSchema = z.preprocess(
  sanitizeStrictSingleLine,
  z
    .string('العنوان مطلوب')
    .max(ITEM_TITLE_MAX, `العنوان يجب أن لا يتجاوز ${ITEM_TITLE_MAX} حرفاً`)
);

// Item link schema
const itemLinkSchema = z.preprocess(
  trimed,
  z
    .string('الرابط مطلوب')
    .max(ITEM_LINK_MAX, `الرابط يجب أن لا يتجاوز ${ITEM_LINK_MAX} حرفاً`)
);

export const keySchema = z.preprocess(
  slugPreprocess,
  z
    .string()
    .max(150, 'الـ key طويل جداً')
    .regex(/^[a-z0-9-]*$/, 'الـ key يحتوي على أحرف غير مسموحة')
);

// Social account item schema
const socialAccountItemSchema = z.object({
  id: idSchema,
  key: keySchema,
  title: itemTitleSchema,
  link: itemLinkSchema,
  isActive: z.boolean().default(true),
  order: orderSchema,
});

// Contact info item schema
const contactInfoItemSchema = z.object({
  id: idSchema,
  key: keySchema,
  title: itemTitleSchema,
  link: itemLinkSchema,
  isActive: z.boolean().default(true),
  order: orderSchema,
});

// Nav link item schema
const navLinkItemSchema = z.object({
  id: idSchema,
  key: keySchema,
  title: itemTitleSchema,
  link: itemLinkSchema,
  showInHeader: z.boolean().default(false),
  showInFooter: z.boolean().default(false),
  order: orderSchema,
});

// Social accounts array schema
const socialAccountsSchema = z
  .preprocess(
    (e: SocialAccountItem[] | null | undefined) => (e?.length ? e : null),
    z
      .array(socialAccountItemSchema, 'قم بإدخال حسابات التواصل بشكل صحيح')
      .max(MAX_ITEMS, `تجاوزت أكبر عدد للعناصر، وهو ${MAX_ITEMS} عنصراً`)
      .nullish()
  )
  .nullish();

// Contact info array schema
const contactInfoSchema = z
  .preprocess(
    (e: ContactInfoItem[] | null | undefined) => (e?.length ? e : null),
    z
      .array(contactInfoItemSchema, 'قم بإدخال بيانات التواصل بشكل صحيح')
      .max(MAX_ITEMS, `تجاوزت أكبر عدد للعناصر، وهو ${MAX_ITEMS} عنصراً`)
      .nullish()
  )
  .nullish();

// Nav links array schema
const navLinksSchema = z
  .preprocess(
    (e: NavLinkItem[] | null | undefined) => (e?.length ? e : null),
    z
      .array(navLinkItemSchema, 'قم بإدخال الروابط بشكل صحيح')
      .max(MAX_ITEMS, `تجاوزت أكبر عدد للعناصر، وهو ${MAX_ITEMS} عنصراً`)
      .nullish()
  )
  .nullish();

// Settings schema (for upsert - uses POST)
export const settingsSchema = z.object({
  id: getIDSchema({ optional: true }).nullish(),

  // Basic Info
  siteTitle: siteTitleSchema,
  siteDescription: siteDescriptionSchema,
  footerDescription: footerDescriptionSchema,
  copyrightText: copyrightTextSchema,
  primaryColor: primaryColorSchema,

  // Fonts
  fonts: settingsFontsSchema,

  // Social & Contact
  socialAccounts: socialAccountsSchema,
  contactInfo: contactInfoSchema,
  navLinks: navLinksSchema,
});

// Type inference
export type SettingsInput = z.input<typeof settingsSchema>;
export type SettingsOutput = z.output<typeof settingsSchema>;
