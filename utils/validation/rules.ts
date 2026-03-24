import { MAX_ID } from '@/constants';
import { EntityID } from '@/types';
import * as z from 'zod';

import { positiveInt, validID } from '..';
import { sanitizeSvg } from '../images/svg-optimizer';
import { safeDate } from '../time';
import { EMAIL_MAX, PASSWORD_MAX, PASSWORD_MIN } from './constants';

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

export function getIDSchema(
  props: {
    optional?: boolean;
  } = {}
) {
  const { optional = false } = props;

  // when EntityID is number
  const schema = z.int(idRequired).min(1, idRequired).max(MAX_ID, idRequired);
  // when EntityID is UUID
  // const schema = z.string(idRequired).min(1, idRequired);

  return z.preprocess(
    (v: EntityID) => validID(v) || (optional ? null : 0),

    optional ? schema.nullish() : schema
  );
}

export const idSchema = getIDSchema({ optional: false }) as z.ZodPipe<
  z.ZodTransform<EntityID, EntityID>,
  z.ZodInt /* when EntityID is UUID, use ZodString, and when EntityID is number, use ZodInt */
>;

export const richTextSchema = z.any();

export const datePreprocess = (val: any) => {
  const date = safeDate(val);
  return date ? date.toISOString() : null;
};

export const fileUploadSchema = ({ max, withPdf = false }) =>
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

export const passwordSchema = z
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
