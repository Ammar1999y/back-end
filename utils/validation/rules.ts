import type { EntityID } from '@/types';

import * as z from 'zod';

import { normalizeArabicDigits, validID } from '..';
import { sanitizeSvg } from '../images/svg-optimizer';
import { safeDate } from '../time';
import {
  EMAIL_MAX,
  PASSWORD_MAX,
  PASSWORD_MIN,
  PHONE_NUMBER_MAX,
} from './constants';

export const sanitizeStrict = (v: unknown) =>
  typeof v === 'string'
    ? v
        .replaceAll(
          /[^\p{L}\p{M}\p{N}\p{Zs}\n\.,!?:/\\;\-+=\(\)\[\]''"؟،؛@#_&%]/gu,
          ''
        )
        .trim()
    : v;

export const sanitizeStrictSingleLine = (v: unknown) =>
  typeof v === 'string'
    ? v
        .replaceAll(
          /[^\p{L}\p{M}\p{N}\p{Zs}\n\.,!?:/\\;\-+=\(\)\[\]''"؟،؛@#_&%]/gu,
          ''
        )
        .replaceAll(/\s+/g, ' ')
        .trim()
    : v;

export const idRequired =
  'رقم المعرف غير صحيح، اعد تحميل الصفحة ثم حاول مرة اخرى';

/**
 * First-issue message for a failed `safeParse`, with a localized message for
 * `.strict()` rejections. Zod's built-in unknown-key message is English and
 * would be the only non-Arabic string a client ever sees; naming the offending
 * keys is also what turns a silently-stripped typo into an actionable 422.
 */
export function zodIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue?.code === 'unrecognized_keys')
    return `حقول غير معروفة في الطلب: ${reflectKeys(issue.keys)}`;
  return issue?.message ?? 'قم بالتحقق من البيانات المدخله';
}

/** How many unknown keys are worth naming, and how long each may be. */
const MAX_REFLECTED_KEYS = 5;
const MAX_REFLECTED_KEY_LENGTH = 40;

/**
 * The unknown keys, bounded.
 *
 * These are attacker-controlled JSON key names and they were interpolated whole:
 * measured against the real `selfUpdateUserSchema`, a key named
 * `<img src=x onerror=alert(1)>` came back verbatim and one 200 000-character
 * key produced a 200 026-character message. Every other client-facing message in
 * this API is a server-owned constant.
 *
 * Naming them is still worth doing — that is what turns a silently-stripped typo
 * into an actionable 422 — so they are truncated and counted rather than
 * dropped. The CRLF case was never exploitable (the body is JSON-escaped);
 * unbounded length is a defect regardless of what a front-end does with it.
 */
function reflectKeys(keys: readonly PropertyKey[]): string {
  const named = keys
    .slice(0, MAX_REFLECTED_KEYS)
    .map((key) => String(key).slice(0, MAX_REFLECTED_KEY_LENGTH));
  const hidden = keys.length - named.length;
  return hidden > 0 ? `${named.join('، ')} (+${hidden})` : named.join('، ');
}

function getIDSchema(
  props: {
    optional?: boolean;
  } = {}
) {
  const { optional = false } = props;

  // when EntityID is number
  // const schema = z.int(idRequired).min(1, idRequired).max(MAX_ID, idRequired);
  // when EntityID is UUID
  const schema = z.string(idRequired).min(1, idRequired);

  return z.preprocess(
    (v: EntityID) => validID(v) || (optional ? null : 0),

    optional ? schema.nullish() : schema
  );
}

export const idSchema = getIDSchema({ optional: false }) as z.ZodPipe<
  z.ZodTransform<EntityID, EntityID>,
  z.ZodString /* when EntityID is UUID, use ZodString, and when EntityID is number, use ZodInt */
>;

export const emailSchema = z.preprocess(
  (v: string) =>
    typeof v === 'string' ? v.replaceAll(/\s+/g, ' ').trim().toLowerCase() : '',
  z
    .email('يرجى إدخال بريد إلكتروني صحيح')
    .max(EMAIL_MAX, `يجب أن لا يتجاوز البريد الإلكتروني ${EMAIL_MAX} حرفاً`)
    .regex(
      /^[A-Za-z0-9._%+-]+@(?:gmail\.com|outlook\.com|hotmail\.com|live\.com|yahoo\.com)$/,
      'نعتذر، حالياً نقبل التسجيل فقط عبر بريد Gmail أو Outlook أو Hotmail أو Yahoo. يرجى استخدام أحد هذه العناوين.'
    )
);

/**
 * Canonical password form. `hashPassword` / `verifyPassword` NFKC-normalize
 * before hashing, so every other check has to see the SAME string: policy
 * validation, old-vs-new comparison and the HIBP breach lookup all run on the
 * schema output. Normalizing only at the storage layer let a
 * compatibility-equivalent input (e.g. U+FB01 "ﬁ" → "fi") pass a breach check
 * and then normalize into a breached credential. NFKC is idempotent, so the
 * storage-layer normalization stays as defense in depth for non-schema callers.
 */
const normalizePasswordInput = (v: string) =>
  typeof v === 'string' ? v.normalize('NFKC') : v;

export const passwordSchema = z.preprocess(
  normalizePasswordInput,
  z
    .string('كلمة المرور مطلوبة')
    .min(PASSWORD_MIN, `كلمة المرور يجب أن تكون ${PASSWORD_MIN} أحرف على الأقل`)
    .max(PASSWORD_MAX, `كلمة المرور يجب أن لا تتجاوز ${PASSWORD_MAX} حرفاً`)
    .refine(
      (val) =>
        /[a-z]/.test(val) &&
        /[A-Z]/.test(val) &&
        /[0-9]/.test(val) &&
        /[^a-zA-Z0-9]/.test(val),
      {
        error: 'تحقق من صحة كلمة المرور',
      }
    )
);

// Saudi phone: strips non-digits, accepts 966XXXXXXXXX / 05XXXXXXXX / 5XXXXXXXX
const phoneCleanupRegex = /[^\d]/g;
const saudiPhoneEmptyError = 'رقم الهاتف مطلوب';
const saudiPhoneFormatError = 'يرجى إدخال رقم هاتف سعودي صحيح';

export const phoneSchema = z.preprocess(
  (v) => {
    if (typeof v === 'number') v = String(v);
    if (typeof v !== 'string') return v;
    return normalizeArabicDigits(v).replaceAll(phoneCleanupRegex, '');
  },
  z
    .string(saudiPhoneEmptyError)
    .min(1, saudiPhoneEmptyError)
    .max(PHONE_NUMBER_MAX, saudiPhoneFormatError)
    .refine(
      (val) => {
        // 966XXXXXXXXX (12 digits), 05XXXXXXXX (10 digits), or 5XXXXXXXX (9 digits)
        if (val.startsWith('966')) return /^9665\d{8}$/.test(val);
        if (val.startsWith('05')) return /^05\d{8}$/.test(val);
        if (val.startsWith('5')) return /^5\d{8}$/.test(val);
        return false;
      },
      { message: saudiPhoneFormatError }
    )
    .transform((val) => {
      // Normalize to 9665XXXXXXXX
      if (val.startsWith('966')) return val;
      if (val.startsWith('05')) return '966' + val.slice(1);
      if (val.startsWith('5')) return '966' + val;
      return val;
    })
);

// Optional phone: empty string / null → no number (null); otherwise validated
// and normalized by phoneSchema. The key is always present (nullable, not
// optional) so the inferred input/output shapes stay consistent for
// react-hook-form resolvers — callers send `null` to mean "no number".
export const optionalPhoneSchema = z.preprocess(
  (v) => (v == null || (typeof v === 'string' && v.trim() === '') ? null : v),
  phoneSchema.nullable()
);

/** @knipignore */
export const trimed = (v: string) => (typeof v === 'string' ? v.trim() : '');
/** @knipignore */
export const richTextSchema = z.any();
/** @knipignore */
export const datePreprocess = (val: unknown) => {
  const accepted =
    typeof val === 'string' || typeof val === 'number' || val instanceof Date;
  const date = accepted ? safeDate(val) : null;
  return date ? date.toISOString() : null;
};
/** @knipignore */
export const fileUploadSchema = ({
  max,
  withPdf = false,
}: {
  /** Maximum file size in bytes */
  max: number;
  withPdf?: boolean;
}) =>
  z
    .file(`قم برفع صور ${withPdf ? 'أو ملف PDF' : ''} صحيحة`)
    .min(1000, `حجم الصورة  ${withPdf ? 'أو ملف PDF' : ''} صغير للغايه`)
    // A client may accept larger files only if it downsizes them before upload.
    .max(max, `حجم الصورة  ${withPdf ? 'أو ملف PDF' : ''} كبير للغايه`)
    .mime(['image/png', 'image/webp', ...(withPdf ? ['application/pdf'] : [])]);

// eslint-disable-next-line security/detect-unsafe-regex
const colorRegex = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;
const colorError = 'قم بادخال لون صحيح';

/** @knipignore */
export const getColorSchema = (
  props: {
    optional?: boolean;
  } = {}
) => {
  const { optional = false } = props;

  const schema = z.string(colorError).regex(colorRegex, colorError);

  return z.preprocess(
    (v: string | null | undefined) =>
      typeof v === 'string'
        ? v.replaceAll(/\s+/g, '').toUpperCase() || (optional ? null : '')
        : optional
          ? null
          : '',
    optional ? schema.nullish() : schema
  );
};

/**
 * Passes a non-string through rather than coercing it to `''`. Same defect as
 * `sanitizeStrict` above and the admin password field: `''` satisfies the inner
 * schema's `v === ''` escape hatches, so `slugSchema.safeParse(123)` succeeded.
 * Unreferenced today — which makes it a trap rather than a live bug, and the
 * reason to fix it with the class rather than after it becomes one.
 */
const slugPreprocess = (v: unknown) => {
  if (typeof v !== 'string') return v;

  return v
    .toLowerCase()
    .trim()
    .replaceAll(/\s+/g, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
};

export const slugSchema = z.preprocess(
  slugPreprocess,
  z
    .string()
    .max(150, 'الـ slug طويل جداً')
    .refine(
      (v) => v === '' || /^[a-z0-9-]+$/.test(v),
      'الـ slug يحتوي على أحرف غير مسموحة'
    )
    .refine(
      (v) => v === '' || /[a-z]/.test(v),
      'الـ slug لا يمكن أن يكون أرقام فقط'
    )
);
/** @knipignore */
export const SVGIconSchema = z
  .string()
  .min(1, 'الأيقونه مطلوبه')
  .refine((val) => sanitizeSvg(val).isValid, {
    message: 'أيقونة SVG غير صحيحة أو تحتوي على محتوى غير آمن',
  })
  .transform((val) => sanitizeSvg(val).cleanedSvg);
