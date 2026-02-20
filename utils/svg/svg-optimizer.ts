import DOMPurify from 'isomorphic-dompurify';

import { SERVER_MAX_IMAGE_SIZE } from '@/utils/validation/constants';

import {
  DANGEROUS_ATTRIBUTES,
  DANGEROUS_CSS_PATTERNS,
  DANGEROUS_ELEMENTS,
  isDangerousValue,
  safeDecodeURI,
  SVG_MAX_ELEMENTS,
  type SanitizeResult,
} from './config';

export { SVG_MAX_ELEMENTS, type SanitizeResult } from './config';

// 🟥 اذا مستقبلا قررت اسمح للانميشن انه يتم تمريره، اقوم بفك التعليق الخاص بالانميشن، واخلي المكتبه تسمح بمرور الانميشن

interface SanitizeSvgOptions {
  convertColor?: boolean;
  parser?: DOMParser;
  serializer?: XMLSerializer;
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
    trimmed = trimmed.replace(/<!--[\s\S]*?-->/g, '');
    errors.push('تم إزالة XML comments');
  }

  if (trimmed.includes('<![CDATA[')) {
    trimmed = trimmed.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
    errors.push('تم إزالة CDATA sections');
  }

  if (trimmed.includes('<?')) {
    trimmed = trimmed.replace(/<\?[\s\S]*?\?>/g, '');
    errors.push('تم إزالة Processing Instructions');
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
      DANGEROUS_ATTRIBUTES.forEach((attr) => {
        if (element.hasAttribute(attr)) {
          errors.push(`تم إزالة خاصية خطيرة: ${attr}`);
          element.removeAttribute(attr);
        }
      });

      Array.from(element.attributes).forEach((attr) => {
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
    });

    const shouldConvertColor = (value: string | null | undefined): boolean => {
      if (!value || !convertColor) return false;
      const normalized = value.toLowerCase().trim();
      if (
        !normalized ||
        normalized.startsWith('url(') ||
        normalized === 'currentcolor' ||
        normalized === 'inherit' ||
        normalized === 'transparent' ||
        normalized === 'none'
      )
        return false;
      return true;
    };

    const styleElements = doc.querySelectorAll('style');
    styleElements.forEach((styleEl) => {
      let cssContent = styleEl.textContent || '';

      const decodedCSS = safeDecodeURI(cssContent);

      const hasDangerousCSS =
        DANGEROUS_CSS_PATTERNS.some((pattern) => pattern.test(cssContent)) ||
        DANGEROUS_CSS_PATTERNS.some((pattern) => pattern.test(decodedCSS));

      if (hasDangerousCSS) {
        errors.push('تم إزالة style يحتوي على كود خطير');
        styleEl.remove();
        return;
      }

      cssContent = cssContent.replace(
        /(fill|stroke)\s*:\s*([^;}]+?)(?=\s*[;}])/gi,
        (_match, property, value) => {
          if (!shouldConvertColor(value)) {
            return `${property}: ${value}`;
          }
          return `${property}: currentColor`;
        }
      );

      styleEl.textContent = cssContent;
    });

    const allElementsWithColors = svgElement.querySelectorAll('*');
    allElementsWithColors.forEach((element) => {
      ['fill', 'stroke'].forEach((attr) => {
        if (element.hasAttribute(attr)) {
          const value = element.getAttribute(attr);
          if (shouldConvertColor(value)) {
            element.setAttribute(attr, 'currentColor');
          }
        }
      });
    });

    ['fill', 'stroke'].forEach((attr) => {
      if (svgElement.hasAttribute(attr)) {
        const value = svgElement.getAttribute(attr);
        if (shouldConvertColor(value)) {
          svgElement.setAttribute(attr, 'currentColor');
        }
      }
    });

    const cleanedSvg = xmlSerializer.serializeToString(svgElement);
    const sanitized = DOMPurify.sanitize(cleanedSvg, {
      USE_PROFILES: { svg: true, svgFilters: true },
    });

    if (!sanitized || !sanitized.includes('<svg')) {
      return {
        isValid: false,
        cleanedSvg: '',
        errors: ['فشل في تنظيف SVG'],
      };
    }

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
  if (!file) {
    return 'لم يتم اختيار ملف';
  }

  if (file.type !== 'image/svg+xml' && !file.name.endsWith('.svg')) {
    return 'الرجاء اختيار ملف SVG فقط';
  }

  const maxSize = SERVER_MAX_IMAGE_SIZE * 2 * 1024 * 1024;
  if (file.size > maxSize) {
    return `حجم الملف كبير جداً (الحد الأقصى ${SERVER_MAX_IMAGE_SIZE * 2}MB)`;
  }

  return null;
}
