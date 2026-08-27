import type { SanitizeResult } from './config';

import { sanitize } from 'isomorphic-dompurify';

import { SERVER_MAX_IMAGE_SIZE } from '@/utils/validation/constants';

import {
  DANGEROUS_ATTRIBUTES,
  DANGEROUS_ELEMENTS,
  isDangerousValue,
  safeDecodeURI,
  SVG_MAX_ELEMENTS,
} from './config';

// Supporting animation would require updating both the sanitizer and SVGO policy.

const REFERENCE_ATTRIBUTES = ['href', 'xlink:href'] as const;

const LOCAL_FRAGMENT = /^#[^\s#"'<>]+$/u;

const SAFE_DATA_URI =
  /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[\w+/=]+$/i;

interface SanitizeSvgOptions {
  convertColor?: boolean;
  parser?: DOMParser;
  serializer?: XMLSerializer;
}

function isSingleSvgRoot(markup: string, parser: DOMParser): boolean {
  const doc = parser.parseFromString(markup, 'image/svg+xml');
  if (doc.querySelector('parsererror')) return false;
  const root = doc.documentElement;
  return (
    root?.localName?.toLowerCase() === 'svg' &&
    root.namespaceURI === 'http://www.w3.org/2000/svg'
  );
}

/**
 * Client-side SVG sanitizer
 * For server-side usage, use sanitizeSvgServer from './server'
 */
export function sanitizeSvg(
  svgContent: string,
  { convertColor = false, parser, serializer }: SanitizeSvgOptions = {}
): SanitizeResult {
  const errors: string[] = [];
  let trimmed = svgContent.trim();

  if (!trimmed) {
    return { isValid: false, cleanedSvg: '', errors: ['محتوى SVG فارغ'] };
  }

  const maxSize = SERVER_MAX_IMAGE_SIZE * 2 * 1024 * 1024;
  const contentSize = new Blob([trimmed]).size;
  if (contentSize > maxSize) {
    return {
      isValid: false,
      cleanedSvg: '',
      errors: [
        `حجم المحتوى كبير جداً (الحد الأقصى ${SERVER_MAX_IMAGE_SIZE * 2}MB)`,
      ],
    };
  }

  if (trimmed.includes('<!--')) {
    trimmed = trimmed.replaceAll(/<!--[\s\S]*?-->/g, '');
    errors.push('تم إزالة XML comments');
  }

  if (trimmed.includes('<![CDATA[')) {
    trimmed = trimmed.replaceAll(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
    errors.push('تم إزالة CDATA sections');
  }

  if (trimmed.includes('<?')) {
    trimmed = trimmed.replaceAll(/<\?[\s\S]*?\?>/g, '');
    errors.push('تم إزالة Processing Instructions');
  }

  // XML entities expand synchronously inside `parseFromString`. Reject the DTD
  // before the parser can turn a small upload into an unbounded document.
  if (/<!doctype\b/i.test(trimmed) || /<!entity\b/i.test(trimmed)) {
    return {
      isValid: false,
      cleanedSvg: '',
      errors: ['تعريفات XML الخارجية غير مسموح بها'],
    };
  }

  if (!trimmed.includes('<svg')) {
    return {
      isValid: false,
      cleanedSvg: '',
      errors: ['الملف لا يحتوي على عنصر SVG صالح'],
    };
  }

  const elementCount = (trimmed.match(/<[^>]+>/g) || []).length;
  if (elementCount > SVG_MAX_ELEMENTS) {
    return {
      isValid: false,
      cleanedSvg: '',
      errors: [
        `SVG يحتوي على ${elementCount} عنصر (الحد الأقصى ${SVG_MAX_ELEMENTS})`,
      ],
    };
  }

  try {
    const domParser = parser ?? new DOMParser();
    const xmlSerializer = serializer ?? new XMLSerializer();
    const doc = domParser.parseFromString(trimmed, 'image/svg+xml');

    const parserError = doc.querySelector('parsererror');
    if (parserError) {
      return {
        isValid: false,
        cleanedSvg: '',
        errors: ['بنية SVG غير صالحة'],
      };
    }

    const svgElement = doc.querySelector('svg');
    if (!svgElement) {
      return {
        isValid: false,
        cleanedSvg: '',
        errors: ['لم يتم العثور على عنصر SVG'],
      };
    }

    // Remove dangerous elements
    DANGEROUS_ELEMENTS.forEach((tagName) => {
      const allElements = doc.querySelectorAll('*');
      const matchingElements: Element[] = [];

      allElements.forEach((element) => {
        const fullName = element.tagName.toLowerCase();
        const localName = element.localName?.toLowerCase() || fullName;

        const decodedFullName = safeDecodeURI(fullName).toLowerCase();
        const decodedLocalName = safeDecodeURI(localName).toLowerCase();
        const targetTag = tagName.toLowerCase();

        if (
          localName === targetTag ||
          fullName === targetTag ||
          decodedLocalName === targetTag ||
          decodedFullName === targetTag ||
          fullName.endsWith(`:${targetTag}`) ||
          decodedFullName.endsWith(`:${targetTag}`)
        ) {
          matchingElements.push(element);
        }
      });

      matchingElements.forEach((el, index) => {
        errors.push(
          `تم إزالة عنصر خطير #${index + 1}: <${el.tagName.toLowerCase()}>`
        );
        el.remove();
      });
    });

    const allElements = doc.querySelectorAll('*');
    allElements.forEach((element) => {
      if (element.hasAttribute('style')) {
        errors.push('تم إزالة خاصية style');
        element.removeAttribute('style');
      }

      DANGEROUS_ATTRIBUTES.forEach((attr) => {
        if (!element.hasAttribute(attr)) {
          return;
        }

        errors.push(`تم إزالة خاصية خطيرة: ${attr}`);
        element.removeAttribute(attr);
      });

      [...element.attributes].forEach((attr) => {
        const name = attr.name;
        const value = attr.value;

        const decodedName = safeDecodeURI(name).toLowerCase();

        if (decodedName.startsWith('on')) {
          errors.push(`تم إزالة خاصية خطيرة: ${attr.name}`);
          element.removeAttribute(attr.name);
          return;
        }

        if (value && isDangerousValue(value)) {
          errors.push(`تم إزالة محتوى خطير من: ${attr.name}`);
          element.removeAttribute(attr.name);
        }
      });

      // `href` / `xlink:href` on the two elements that DEREFERENCE them.
      //
      // `<image>` is the reason this is not `use`-only: an `<image>` pointing at
      // an absolute URL is fetched by the VIEWER when the stored object renders,
      // which beacons their IP, User-Agent and Referer and lets the picture
      // change after review. DOMPurify does not help — `image` is in its
      // `DEFAULT_DATA_URI_TAGS`, so the attribute survives.
      //
      // `use` may only reference a same-document fragment. `image` may also
      // carry a self-contained `data:` URI, which is how a legitimately inlined
      // raster arrives; `isDangerousValue` above has already rejected
      // `data:text/html` and the script-bearing SVG data URI.
      const localName = element.localName?.toLowerCase();
      if (localName === 'use' || localName === 'image') {
        const allowsDataUri = localName === 'image';
        let hasLocalReference = false;
        for (const name of REFERENCE_ATTRIBUTES) {
          const raw = element.getAttribute(name);
          if (raw === null) continue;
          const reference = raw.trim();
          if (
            LOCAL_FRAGMENT.test(reference) ||
            (allowsDataUri && SAFE_DATA_URI.test(reference))
          ) {
            element.setAttribute(name, reference);
            hasLocalReference = true;
          } else {
            errors.push(`تم إزالة مرجع خارجي من: ${name}`);
            element.removeAttribute(name);
          }
        }
        if (!hasLocalReference) {
          errors.push(`تم إزالة عنصر ${localName} بدون مرجع محلي`);
          element.remove();
        }
      }
    });

    const shouldConvertColor = (value: string | null | undefined): boolean => {
      if (!value || !convertColor) return false;
      const normalized = value.toLowerCase().trim();
      return !(
        !normalized ||
        normalized === 'currentcolor' ||
        normalized === 'inherit' ||
        normalized === 'transparent' ||
        normalized === 'none' ||
        normalized.startsWith('url(')
      );
    };

    doc.querySelectorAll('style').forEach((styleEl) => {
      errors.push('تم إزالة عنصر style');
      styleEl.remove();
    });

    const allElementsWithColors = svgElement.querySelectorAll('*');
    allElementsWithColors.forEach((element) => {
      ['fill', 'stroke'].forEach((attr) => {
        if (!element.hasAttribute(attr)) return;

        if (shouldConvertColor(element.getAttribute(attr)))
          element.setAttribute(attr, 'currentColor');
      });
    });

    ['fill', 'stroke'].forEach((attr) => {
      if (!svgElement.hasAttribute(attr)) return;

      if (shouldConvertColor(svgElement.getAttribute(attr)))
        svgElement.setAttribute(attr, 'currentColor');
    });

    const cleanedSvg = xmlSerializer.serializeToString(svgElement);
    const sanitized = sanitize(cleanedSvg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      ADD_TAGS: ['use'],
      FORBID_TAGS: ['style'],
      FORBID_ATTR: ['style'],
    });

    // STRUCTURAL, not a substring test.
    //
    // The sweep above ran on an XML tree, where `<p>` is an ordinary child of
    // `<svg>`. DOMPurify then re-parses the serialized string as HTML, where the
    // breakout tags (`p`, `div`, `table`, `h1`, `pre`, …) TERMINATE foreign
    // content — so those nodes come back out sitting AFTER `</svg>`.
    // `includes('<svg')` cannot see that, and returned `isValid: true` for two
    // shapes that both escaped this function's own contract: a 55-byte input
    // whose output made svgo throw `SvgoParserError` (an unauthenticated,
    // deterministic 500), and a two-root document that was stored and served as
    // `image/svg+xml` and which no browser XML parser will render.
    //
    // Re-parsing as XML answers exactly the question the contract makes: is this
    // ONE well-formed SVG root with no sibling content? Text or an element after
    // `</svg>` is a parse error, and so is a second root.
    if (!sanitized || !isSingleSvgRoot(sanitized, domParser))
      return {
        isValid: false,
        cleanedSvg: '',
        errors: ['فشل في تنظيف SVG'],
      };

    if (new Blob([sanitized]).size > maxSize)
      return {
        isValid: false,
        cleanedSvg: '',
        errors: [
          `حجم المحتوى كبير جداً بعد المعالجة (الحد الأقصى ${SERVER_MAX_IMAGE_SIZE * 2}MB)`,
        ],
      };

    return {
      isValid: true,
      cleanedSvg: sanitized,
      errors,
    };
  } catch (error) {
    return {
      isValid: false,
      cleanedSvg: '',
      errors: [`فشل في معالجة SVG: ${error}`],
    };
  }
}
export function validateSvgFile(file: File): string | null {
  if (!file) return 'لم يتم اختيار ملف';

  if (file.type !== 'image/svg+xml' && !file.name.endsWith('.svg'))
    return 'الرجاء اختيار ملف SVG فقط';

  const maxSize = SERVER_MAX_IMAGE_SIZE * 2 * 1024 * 1024;
  if (file.size > maxSize)
    return `حجم الملف كبير جداً (الحد الأقصى ${SERVER_MAX_IMAGE_SIZE * 2}MB)`;

  return null;
}
