import * as z from 'zod';

import {
  normalizeArabicDigits,
  UUID_V7_FRAGMENT,
  UUID_V7_REGEX,
  validID,
} from '..';
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

/**
 * What the two sanitizers above do, for the OpenAPI document.
 *
 * `z.toJSONSchema` sees neither preprocess, so every `min`/`max` on a sanitized
 * leaf describes the string AFTER stripping and trimming while the document
 * presents it as a rule about the raw input. Both sanitizers only ever SHORTEN,
 * which decides what each published keyword is worth:
 *
 *  - `minLength` cannot refuse a valid request — a raw value shorter than the
 *    floor cannot grow past it — so it stays. It is merely lax: `"a "` against
 *    `minLength: 2` passes the document and is refused by the server, which
 *    keeps one character.
 *  - `maxLength` can, and so it goes. A hundred and fifty characters plus two
 *    spaces is trimmed to 150 and ACCEPTED, while a validator measures 152
 *    against `maxLength: 150` and refuses a request the server would have
 *    answered — and the amount a strippable character or a space can shrink a
 *    value by is unbounded, so no finite ceiling is true of raw input. The
 *    number travels as prose instead (`strictTextMaximum`); the request is still
 *    bounded, by the body ceiling in `app.ts`.
 *
 * The stripped class cannot become a `pattern` either — a JSON Schema pattern
 * has no `u` flag, so `\p{L}` is inexpressible. Where a leaf's rule CAN be
 * written against raw input it is, and then the bound rides in the pattern: see
 * `otpCodeSchema` and the media names.
 */
export const STRICT_TEXT_DESCRIPTION =
  'Characters outside letters, marks, digits, spaces and `. , ! ? : / \\ ; - + = ( ) [ ] \' " ؟ ، ؛ @ # _ & %` are removed and the value is trimmed before the length rules apply, so it may be sent as typed';

/** `sanitizeStrictSingleLine` additionally folds every whitespace run to one space. */
export const STRICT_SINGLE_LINE_DESCRIPTION = `${STRICT_TEXT_DESCRIPTION}. Line breaks and repeated spaces are collapsed to a single space.`;

/**
 * The ceiling, as prose, for a leaf whose `maxLength` cannot be published — and
 * the marker that the omission is a decision rather than an oversight.
 */
export const strictTextMaximum = (max: number) =>
  `After that it must be at most ${max} characters.`;

export const idRequired =
  'رقم المعرف غير صحيح، اعد تحميل الصفحة ثم حاول مرة اخرى';

const MSG_CHECK_INPUT = 'قم بالتحقق من البيانات المدخله';

/**
 * A server-owned Arabic message per issue code, for every schema node that did
 * not author one.
 *
 * An issue code absent from this map takes `MSG_CHECK_INPUT` from the `??`
 * below, so `invalid_union` needs no entry — that is the message it would carry.
 *
 * Mapped HERE rather than at each node, because a node is exactly where it gets
 * forgotten. Measured across the dashboard write schemas, 14 client-facing
 * messages were Zod's ASCII defaults — `"Invalid input"` from every union,
 * `"Invalid input: expected boolean, received undefined"` from a `PUT
 * /api/dash/users/:id` that omits `isActive`, `"Too big: expected array to have
 * <=50 items"` — on the most common client mistakes, in an Arabic-locale
 * dashboard.
 */
const ISSUE_FALLBACKS: Readonly<Record<string, string>> = {
  invalid_type: 'قيمة الحقل مفقودة أو من نوع غير صحيح',
  invalid_value: 'قيمة الحقل غير مسموحة',
  invalid_format: 'تنسيق قيمة الحقل غير صحيح',
  invalid_key: 'أحد مفاتيح الطلب غير صالح',
  invalid_element: 'أحد عناصر القائمة غير صالح',
  too_big: 'القيمة أكبر من الحد المسموح',
  too_small: 'القيمة أصغر من الحد المسموح',
  not_multiple_of: 'القيمة غير صحيحة',
};

/**
 * Does this message come from this project, or from Zod?
 *
 * Every message this codebase writes is Arabic, and every Zod default is ASCII,
 * so the script is the discriminator — and it needs no per-schema bookkeeping,
 * which is what made the previous per-node fixes drift.
 */
const ARABIC_LETTER = /\p{Script=Arabic}/u;

/** Path segments come from schema keys and array indices, but bound them anyway. */
function reflectPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '';
  const named = path
    .slice(0, MAX_REFLECTED_KEYS)
    .map((key) => String(key).slice(0, MAX_REFLECTED_KEY_LENGTH))
    .join('.');
  return ` (${named})`;
}

/**
 * First-issue message for a failed `safeParse`, with a localized message for
 * `.strict()` rejections. Zod's built-in unknown-key message is English and
 * would be the only non-Arabic string a client ever sees; naming the offending
 * keys is also what turns a silently-stripped typo into an actionable 422.
 *
 * A message the schema authored wins. Anything else is replaced from
 * `ISSUE_FALLBACKS` and annotated with the field path, which Zod's own defaults
 * do not name.
 */
export function zodIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return MSG_CHECK_INPUT;
  if (issue.code === 'unrecognized_keys')
    return `حقول غير معروفة في الطلب: ${reflectKeys(issue.keys)}`;
  if (ARABIC_LETTER.test(issue.message)) return issue.message;
  return `${ISSUE_FALLBACKS[issue.code] ?? MSG_CHECK_INPUT}${reflectPath(issue.path)}`;
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

const ID_DESCRIPTION =
  'Surrounding whitespace is trimmed and the value lowercased before the pattern applies, so it may be sent as received.';

/**
 * The published rule for the RAW value, which is not `UUID_V7_PATTERN`: the
 * preprocess trims, so the anchored form refuses a padded id the server accepts.
 * Case needs nothing — the fragment already admits both.
 */
const ID_INPUT_PATTERN = String.raw`^\s*${UUID_V7_FRAGMENT}\s*$`;

function getIDSchema() {
  // when EntityID is number
  // const schema = z.int(idRequired).min(1, idRequired).max(MAX_ID, idRequired);
  // when EntityID is UUID
  const schema = z
    .string(idRequired)
    .regex(UUID_V7_REGEX, idRequired)
    .meta({ pattern: ID_INPUT_PATTERN, description: ID_DESCRIPTION });

  return z.preprocess(
    // The rejected sentinel has to be of the ID's own type, or a malformed ID
    // of the right type is answered as `invalid_type` instead of as a bad
    // format. when EntityID is number: `validID(v) || 0`.
    (v: unknown) => validID(v) || '',
    schema
  );
}

export const idSchema = getIDSchema();

/** For the id leaves outside this module, which normalise the same way. */
export { ID_DESCRIPTION, ID_INPUT_PATTERN };

/**
 * The consumer providers this deployment accepts, as data.
 *
 * As data because two things need the SAME list and were reading it out of a
 * regular expression: the runtime check below, and the pattern the document
 * publishes for the address the user typed. See `reports/should-ignore.md`
 * known issue 10 for why the allowlist exists.
 */
const EMAIL_PROVIDER_DOMAINS = [
  'gmail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
] as const;

/* eslint-disable-next-line security/detect-non-literal-regexp -- built from the
   module-local literal tuple above, which no caller can influence */
const EMAIL_ALLOWLIST_PATTERN = new RegExp(
  `^[A-Za-z0-9._%+-]+@(?:${EMAIL_PROVIDER_DOMAINS.map((domain) =>
    domain.replaceAll('.', String.raw`\.`)
  ).join('|')})$`
);

/**
 * One literal, spelled so a flagless pattern matches it case-insensitively.
 *
 * JSON Schema patterns are ECMA-262 with no flags, so `i` is not available and
 * the insensitivity has to live in the character classes.
 */
function caseInsensitiveLiteral(literal: string): string {
  return [...literal]
    .map((character) => {
      const lower = character.toLowerCase();
      const upper = character.toUpperCase();
      if (lower !== upper) return `[${lower}${upper}]`;
      return /[a-zA-Z0-9]/.test(character) ? character : `\\${character}`;
    })
    .join('');
}

/**
 * The published rule for the RAW address, which is none of the three constraints
 * the converter emits from the schema below.
 *
 * The preprocess collapses whitespace, trims and lowercases, so the allowlist
 * pattern (case-sensitive) refuses `User@Gmail.com` and the anchors refuse
 * ` user@gmail.com ` — both of which the server accepts. The length bound is the
 * same problem in the other direction, and `.max()` cannot describe raw input at
 * all once unbounded padding is legal — so the bound moves INTO the pattern as
 * the longest local part any allowed domain leaves room for, and `maxLength` is
 * dropped. That is exact in the direction that matters: every address the server
 * accepts matches, and the only thing left unbounded is surrounding whitespace.
 *
 * Generated from `EMAIL_PROVIDER_DOMAINS` rather than typed out, so the document
 * cannot fall behind the allowlist.
 */
const EMAIL_LOCAL_MAX =
  EMAIL_MAX - 1 - Math.min(...EMAIL_PROVIDER_DOMAINS.map((d) => d.length));

const EMAIL_INPUT_PATTERN = String.raw`^\s*[A-Za-z0-9._%+-]{1,${EMAIL_LOCAL_MAX}}@(?:${EMAIL_PROVIDER_DOMAINS.map(
  (domain) => caseInsensitiveLiteral(domain)
).join('|')})\s*$`;

export const emailSchema = z.preprocess(
  (v: string) =>
    typeof v === 'string' ? v.replaceAll(/\s+/g, ' ').trim().toLowerCase() : '',
  z
    .email('يرجى إدخال بريد إلكتروني صحيح')
    .max(EMAIL_MAX, `يجب أن لا يتجاوز البريد الإلكتروني ${EMAIL_MAX} حرفاً`)
    .regex(
      EMAIL_ALLOWLIST_PATTERN,
      'نعتذر، حالياً نقبل التسجيل فقط عبر بريد Gmail أو Outlook أو Hotmail أو Yahoo. يرجى استخدام أحد هذه العناوين.'
    )
    // The document's whole request rule for this field: `pattern` REPLACES the
    // `allOf` the two checks above convert to. See `EMAIL_INPUT_PATTERN`.
    //
    // ⚠️ No `format: 'email'`, deliberately, and it is not an oversight that it
    // is absent where the RESPONSE schemas carry it. `format` asserts under a
    // validator configured to assert it (Ajv does by default), and
    // ` user@gmail.com ` is not an email address by that rule — while this
    // schema trims and accepts it. A response carries the stored value, which is
    // already normalised, so there it is true and stays.
    .meta({
      maxLength: undefined,
      allOf: undefined,
      pattern: EMAIL_INPUT_PATTERN,
      description:
        `Email address. Whitespace is collapsed and trimmed and the address is lowercased before validation, so it may be sent as typed; after that it must be at most ${EMAIL_MAX} characters. Only these providers are accepted: ` +
        EMAIL_PROVIDER_DOMAINS.join(', ') +
        '.',
    })
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

/**
 * The whole rule as prose, because the normalisation below leaves no published
 * keyword true of raw input — and in the runtime's own terms rather than a
 * paraphrase. Rounding any clause to "a letter" or "a character" describes a
 * schema that refuses passwords this one accepts.
 */
const PASSWORD_DESCRIPTION = `Unicode-normalised (NFKC) before validation, so it may be sent as typed and every rule below measures the normalised form: ${PASSWORD_MIN} to ${PASSWORD_MAX} characters counted as Unicode code points, containing at least one ASCII lowercase letter (a-z), one ASCII uppercase letter (A-Z), one ASCII digit (0-9), and at least one character outside those three ranges. A character that NFKC folds into one of those ranges counts as it. The line terminators U+000A, U+000D, U+2028 and U+2029 are rejected anywhere in the value.`;

export const passwordSchema = z.preprocess(
  normalizePasswordInput,
  z
    .string('كلمة المرور مطلوبة')
    .min(PASSWORD_MIN, `كلمة المرور يجب أن تكون ${PASSWORD_MIN} أحرف على الأقل`)
    .max(PASSWORD_MAX, `كلمة المرور يجب أن لا تتجاوز ${PASSWORD_MAX} حرفاً`)
    .regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])(?=.*[^a-zA-Z0-9]).*$/, {
      error: 'تحقق من صحة كلمة المرور',
    })
    // ⚠️ Nothing of the four rules above survives into the document, and every
    // one of them was refusing requests this schema accepts. NFKC folds an
    // unbounded, non-enumerable set of characters into the ASCII classes — a
    // fullwidth or mathematical capital, the Kelvin sign — so no published
    // class can be true of raw input; and it changes LENGTH in both directions
    // — a ligature expands one character into three, a combining sequence
    // composes two into one — so neither bound can be either. Measured: six
    // passwords the server accepts and the published leaf refused.
    //
    // Same conclusion as the sanitized leaves reach for the same reason
    // (`STRICT_TEXT_DESCRIPTION`), and the rules travel as prose. The request
    // stays bounded by the body ceiling in `app.ts`, and `.max()` above still
    // refuses an over-long password before anything hashes it.
    .meta({
      minLength: undefined,
      maxLength: undefined,
      pattern: undefined,
      description: PASSWORD_DESCRIPTION,
    })
);

// Carried forward rather than replaced: a description on the wrapper is the one
// the converter emits, so `.describe()` alone published the window note and
// dropped every password rule with it.
export const reauthPasswordSchema = passwordSchema
  .optional()
  .describe(
    `${PASSWORD_DESCRIPTION} May be omitted while this session has an open password/passkey reauthentication window. Otherwise omission returns 401 REAUTH_REQUIRED.`
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
    .regex(/^(?:9665\d{8}|05\d{8}|5\d{8})$/, saudiPhoneFormatError)
    .transform((val) => {
      // Normalize to 9665XXXXXXXX
      if (val.startsWith('966')) return val;
      if (val.startsWith('05')) return '966' + val.slice(1);
      if (val.startsWith('5')) return '966' + val;
      return val;
    })
    // The bounds above describe the value AFTER separators are stripped, so
    // publishing them would reject input this schema accepts: `+966 51 234
    // 5678` is 16 characters against a cap meant for the 12 digits left.
    // `minLength: 1` survives that — no preprocess turns `''` into a number.
    .meta({
      type: undefined,
      minLength: undefined,
      maxLength: undefined,
      pattern: undefined,
      anyOf: [{ type: 'string', minLength: 1 }, { type: 'number' }],
      description:
        'Saudi mobile number. Strings may contain separators or Arabic digits; numbers are also accepted. Normalized output is 9665XXXXXXXX.',
    })
);

// Optional phone: empty string / null → no number (null); otherwise validated
// and normalized by phoneSchema. The key is always present (nullable, not
// optional) so the inferred input/output shapes stay consistent for
// react-hook-form resolvers — callers send `null` to mean "no number".
export const optionalPhoneSchema = z
  .preprocess(
    (v) => (v == null || (typeof v === 'string' && v.trim() === '') ? null : v),
    phoneSchema.nullable()
  )
  // Must NOT inherit `phoneSchema`'s `minLength: 1`: the preprocess here runs
  // first and maps `''` to `null`, which is how a caller clears the number.
  .meta({
    anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }],
    description:
      'Saudi mobile number, as accepted by the required form. `null` or an empty string clears it; omitting the key on an update leaves it unchanged.',
  });

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
/** The slug ceiling, named because the document now carries it as prose. */
const SLUG_MAX = 150;

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
    .max(SLUG_MAX, 'الـ slug طويل جداً')
    .meta({
      maxLength: undefined,
      description: `Lowercased, trimmed, and whitespace and repeated hyphens collapsed to single hyphens before validation, so it may be sent as typed. ${strictTextMaximum(SLUG_MAX)}`,
    })
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
