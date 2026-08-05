import { EntityID } from '@/types';
import * as z from 'zod';

import { normalizeArabicDigits, positiveInt, validID } from '..';
import { sanitizeSvg } from '../images/svg-optimizer';
import { safeDate } from '../time';
import {
  EMAIL_MAX,
  PASSWORD_MAX,
  PASSWORD_MIN,
  PHONE_NUMBER_MAX,
} from './constants';

export const NAME_MAX = 150;
export const DIST_MAX = 100;

export const sanitizeStrict = (v: string) =>
  typeof v === 'string'
    ? v
        .replace(
          /[^\p{L}\p{M}\p{N}\p{Zs}\n\.,!?:/\\;\-+=\(\)\[\]''"؟،؛@#_&%]/gu,
          ''
        )
        .trim()
    : '';

export const sanitizeStrictSingleLine = (v: string) =>
  typeof v === 'string'
    ? v
        .replace(
          /[^\p{L}\p{M}\p{N}\p{Zs}\n\.,!?:/\\;\-+=\(\)\[\]''"؟،؛@#_&%]/gu,
          ''
        )
        .replace(/\s+/g, ' ')
        .trim()
    : '';

export const trimed = (v: string) => (typeof v === 'string' ? v.trim() : '');

export const safeStringRegex =
  /^[\p{L}\p{M}\p{N}\p{Zs}\n\.,!?:/\\;\-+=\(\)\[\]''"؟،؛@#_&%]*$/u;

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
    return `حقول غير معروفة في الطلب: ${issue.keys.join('، ')}`;
  return issue?.message ?? 'قم بالتحقق من البيانات المدخله';
}

export function getIDSchema(
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

export const richTextSchema = z.any();

export const datePreprocess = (val: any) => {
  const date = safeDate(val);
  return date ? date.toISOString() : null;
};

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
    .max(max, `حجم الصورة  ${withPdf ? 'أو ملف PDF' : ''} كبير للغايه`) // في الواجهه نسمح للمستخدم انه يرفع ملف اكبر عادي لاكن سوف نقوم بتصغيره قبل ارساله الى السيرفر
    .mime(['image/png', 'image/webp', ...(withPdf ? ['application/pdf'] : [])]);

// eslint-disable-next-line security/detect-unsafe-regex
const colorRegex = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;
const colorError = 'قم بادخال لون صحيح';

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
        ? v.replace(/\s+/g, '').toUpperCase() || (optional ? null : '')
        : optional
          ? null
          : '',
    optional ? schema.nullish() : schema
  );
};

export const slugPreprocess = (v: string) => {
  if (typeof v !== 'string') return '';

  return v
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
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

export const emailSchema = z.preprocess(
  (v: string) =>
    typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().toLowerCase() : '',
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
export const normalizePasswordInput = (v: string) =>
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

const itemOrderError = 'ترتيب العنصر يجب ان يكون رقم صحيحاً';

export const orderSchema = z.preprocess(
  (v: string | number) => positiveInt(v, 999),
  z.int(itemOrderError).min(0, itemOrderError).max(999, itemOrderError)
);

export const SVGIconSchema = z
  .string()
  .min(1, 'الأيقونه مطلوبه')
  .refine((val) => sanitizeSvg(val).isValid, {
    message: 'أيقونة SVG غير صحيحة أو تحتوي على محتوى غير آمن',
  })
  .transform((val) => sanitizeSvg(val).cleanedSvg);

// Saudi phone: strips non-digits, accepts 966XXXXXXXXX / 05XXXXXXXX / 5XXXXXXXX
const phoneCleanupRegex = /[^\d]/g;
const saudiPhoneEmptyError = 'رقم الهاتف مطلوب';
const saudiPhoneFormatError = 'يرجى إدخال رقم هاتف سعودي صحيح';

export const phoneSchema = z.preprocess(
  (v) => {
    if (typeof v === 'number') v = String(v);
    if (typeof v !== 'string') return v;
    return normalizeArabicDigits(v).replace(phoneCleanupRegex, '');
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
