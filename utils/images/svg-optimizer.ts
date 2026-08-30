import type { SanitizeResult } from './config';

import { sanitize } from 'isomorphic-dompurify';

import {
  MAX_IMAGE_EDGE,
  MAX_IMAGE_PIXELS,
  SERVER_MAX_IMAGE_SIZE,
} from '@/utils/validation/constants';

import {
  ANIMATION_ELEMENTS,
  DANGEROUS_ATTRIBUTES,
  DANGEROUS_ELEMENTS,
  decodeCssEscapes,
  isDangerousValue,
  safeDecodeURI,
  SVG_MAX_ELEMENTS,
  SVG_MAX_RENDERED_NODES,
} from './config';
import {
  isAnimatedRaster,
  matchesMagicBytes,
  rasterDimensions,
} from './raster-bytes';

// Animation is not a supported upload: `ANIMATION_ELEMENTS` is refused here and
// the byte checks in `lib/r2/upload-helper.ts` refuse animated WebP and APNG.

const XLINK_NS = 'http://www.w3.org/1999/xlink';

const LOCAL_FRAGMENT = /^#[^\s#"'<>]+$/u;

/**
 * A self-contained raster, restricted to the types this application would admit
 * as an upload in its own right (`ALLOWED_IMAGE_TYPES`).
 *
 * It used to admit `gif`, `jpeg` and `avif` as well — none of which the upload
 * route accepts — so an SVG was a way to store a format the door refuses, and an
 * ANIMATED one at that: `removeRasterImages` only ever matched the `xlink:href`
 * spelling (svgo 4.1.0, verified), so an animated GIF on the modern `href` was
 * stored and served animated from the public bucket while the same bytes
 * uploaded directly were refused by the byte checks. The payload is decoded and
 * held to those same checks below.
 */
const SAFE_DATA_URI = /^data:(image\/(?:png|webp));base64,([\w+/=]+)$/i;

const MSG_ANIMATION_UNSUPPORTED = 'الصور المتحركة غير مدعومة';
const MSG_RASTER_TOO_LARGE =
  'الصورة المضمّنة داخل ملف SVG تتجاوز الحد المسموح للأبعاد';

/**
 * Every attribute on `element` that DEREFERENCES a URL, whatever prefix it
 * arrived under.
 *
 * The namespace clause is not redundant with the two literal spellings: the
 * xlink prefix is chosen by whoever wrote the file, and Sketch and OmniGraffle
 * bind it to `xl`. A qualified-name lookup never saw `xl:href`, so a bare
 * `https:` value on it survived this sweep — closed only by DOMPurify dropping
 * an attribute in a namespace it does not recognise, which is exactly the
 * dependency the note on the sweep says not to lean on. The same blindness
 * deleted a legitimate Sketch-exported `<use xl:href="#a"/>` as reference-less.
 */
function referenceAttributeNames(element: Element): string[] {
  const names: string[] = [];
  for (const attribute of element.attributes) {
    const qualified = attribute.name.toLowerCase();
    if (
      qualified === 'href' ||
      qualified === 'xlink:href' ||
      (attribute.namespaceURI === XLINK_NS &&
        attribute.localName?.toLowerCase() === 'href')
    )
      names.push(attribute.name);
  }
  return names;
}

interface InlineRaster {
  bytes: Uint8Array;
  height: number;
  mimeType: string;
  width: number;
}

/** The declared type and decoded bytes of an inline raster, or `null`. */
function decodeInlineRaster(
  reference: string
): { mimeType: string; bytes: Uint8Array } | null {
  const match = SAFE_DATA_URI.exec(reference);
  if (!match) return null;
  const [, declared = '', payload = ''] = match;

  try {
    const binary = atob(payload);
    return {
      mimeType: declared.toLowerCase(),
      bytes: Uint8Array.from(
        binary,
        (character) => character.codePointAt(0) ?? 0
      ),
    };
  } catch {
    return null;
  }
}

function analyzeInlineRaster(reference: string): InlineRaster | null {
  const decoded = decodeInlineRaster(reference);
  if (decoded === null || !matchesMagicBytes(decoded.bytes, decoded.mimeType))
    return null;
  const dimensions = rasterDimensions(decoded.bytes, decoded.mimeType);
  return dimensions === null ? null : { ...decoded, ...dimensions };
}

/**
 * Does this element inline a raster whose BYTES are animated?
 *
 * Separate from the sweep because the disposition is separate. Stripping an
 * animated raster returns a 200 and a document with the picture silently gone —
 * verbatim the failure `ANIMATION_ELEMENTS` refuses rather than strips, and the
 * same failure the WebP and APNG byte checks exist to remove. One policy, one
 * answer: an animated APNG reaches this application three ways — uploaded
 * directly, declared with SMIL, or inlined here — and all three now answer 400
 * with `animatedNotAllowed`.
 *
 * An unsupported TYPE is a different axis and keeps the reference answer: a
 * `data:image/gif` is refused for being a type `ALLOWED_IMAGE_TYPES` does not
 * carry, exactly as an `https:` reference is, and never reaches the bytes. That
 * is why an animated GIF is stripped where an APNG is refused — the GIF never
 * got as far as being asked about animation.
 */
type RasterLimitViolation = 'edge-too-long' | 'too-many-pixels';

function rasterLimitViolation(
  element: Element,
  analyze: (reference: string) => InlineRaster | null
): RasterLimitViolation | null {
  for (const name of referenceAttributeNames(element)) {
    const raw = element.getAttribute(name);
    if (raw === null) continue;
    const size = analyze(raw.trim());
    if (size === null) continue;
    if (size.width * size.height > MAX_IMAGE_PIXELS) return 'too-many-pixels';
    if (size.width > MAX_IMAGE_EDGE || size.height > MAX_IMAGE_EDGE)
      return 'edge-too-long';
  }
  return null;
}

function carriesAnimatedRaster(
  element: Element,
  analyze: (reference: string) => InlineRaster | null
): boolean {
  for (const name of referenceAttributeNames(element)) {
    const raw = element.getAttribute(name);
    if (raw === null) continue;
    const decoded = analyze(raw.trim());
    if (decoded !== null && isAnimatedRaster(decoded.bytes, decoded.mimeType))
      return true;
  }
  return false;
}

/**
 * Does this element carry `tagName`, whatever spelling it arrived in?
 *
 * One matcher for the dangerous-element sweep and the animation gate, because a
 * second copy is a second chance to forget the namespace-prefixed and
 * percent-encoded forms: `<s:script>` binds the SVG namespace to a prefix, and
 * an encoded name decodes to the same thing.
 */
function matchesTag(element: Element, tagName: string): boolean {
  const fullName = element.tagName.toLowerCase();
  const localName = element.localName?.toLowerCase() || fullName;
  const decodedFullName = safeDecodeURI(fullName).toLowerCase();
  const decodedLocalName = safeDecodeURI(localName).toLowerCase();
  const target = tagName.toLowerCase();

  return (
    localName === target ||
    fullName === target ||
    decodedLocalName === target ||
    decodedFullName === target ||
    fullName.endsWith(`:${target}`) ||
    decodedFullName.endsWith(`:${target}`)
  );
}

/**
 * Markers instantiate a resource once per VERTEX of the element that references
 * them, and `marker` is the shorthand for all three positions.
 */
const MARKER_ATTRIBUTES = [
  'marker',
  'marker-start',
  'marker-mid',
  'marker-end',
] as const;

/**
 * `marker-start` / `marker-end` render once PER REFERENCING ELEMENT; the other
 * two render once per vertex of it. Neither renders once per document — a
 * hundred paths naming one `marker-start` instantiate it a hundred times.
 */
const SINGLE_SITE_MARKERS = new Set<string>(['marker-start', 'marker-end']);

const LOCAL_URL_FUNCTION = /^url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\)$/i;
const MARKER_KEYWORDS = new Set([
  'inherit',
  'initial',
  'none',
  'revert',
  'revert-layer',
  'unset',
]);

function markerReference(value: string): string | null {
  const parsed = LOCAL_URL_FUNCTION.exec(decodeCssEscapes(value.trim()));
  if (!parsed) return null;
  const reference = safeDecodeURI(
    (parsed[1] ?? parsed[2] ?? parsed[3] ?? '').trim()
  );
  return LOCAL_FRAGMENT.test(reference) ? reference : null;
}

function canonicalMarkerReference(reference: string): string {
  return `url("${reference.replaceAll('\\', '\\\\')}")`;
}

/**
 * Numbers, in the grammar `d` and `points` share.
 *
 * Deliberately unambiguous — no two quantifiers here can match the same
 * character — so there is nothing to backtrack over. Sign and exponent are left
 * out because this only ever COUNTS: `1e5` reads as two, which is the direction
 * an upper bound may err in. `[0-9.]+` would be simpler and WRONG: `.1.1.1…` is
 * one token to it and n/2 vertices to a renderer, and under-counting is the one
 * direction a ceiling may not err in.
 */
// eslint-disable-next-line security/detect-unsafe-regex -- star height 2 is the rule's whole heuristic; the inner `+` cannot match a character the outer one can, so no input backtracks. Measured: 400k digits 0.32 ms, 133k numbers 3.9 ms.
const COORDINATE = /[0-9]+(?:\.[0-9]+)?/g;

/**
 * An UPPER BOUND on the vertices of one geometry element.
 *
 * Every path command consumes at least one number per vertex — `h`/`v` take
 * exactly one, everything else more — so the count of numeric tokens can only
 * over-state the vertex count, which is the direction a ceiling has to err in.
 * Counting command LETTERS instead would under-state it badly: `M0 0 1 1 2 2 …`
 * is an implicit `lineto` per pair under a single `M`.
 */
function vertexUpperBound(element: Element): number {
  const name = element.localName?.toLowerCase();
  if (name === 'line') return 2;
  if (['rect', 'circle', 'ellipse'].includes(name ?? '')) return 8;
  if (!['path', 'polyline', 'polygon'].includes(name ?? '')) return 0;

  const geometry =
    element.getAttribute('d') ?? element.getAttribute('points') ?? '';
  if (!geometry) return 1;
  return Math.max(1, geometry.match(COORDINATE)?.length ?? 1);
}

/**
 * How many nodes this document RENDERS, following every reference that
 * instantiates one.
 *
 * `SVG_MAX_ELEMENTS` bounds the source text; nothing bounded the tree a renderer
 * builds from it. Two multipliers reach it and both are counted here:
 *
 * - **`<use>`**, whose target is instantiated in place. The fragment is resolved
 *   PERCENT-DECODED, because that is what a renderer resolves (Chromium's
 *   `SVGURLReferenceResolver` runs `DecodeUrlEscapeSequences` before
 *   `getElementById`) and `LOCAL_FRAGMENT` admits `%`. Resolving it raw made
 *   `<use href="#%61"/>` cost ONE node here and instantiate `id="a"` in the
 *   viewer — measured, a 20-level chain of them was stored intact while the
 *   identical document spelled `#a` was correctly refused.
 * - **`marker`, `marker-start`, `marker-mid`, `marker-end`**, whose target is
 *   instantiated once per vertex of the referencing geometry — and the vertex
 *   count lives in one `d` attribute, which costs one element against the
 *   source ceiling however many vertices it names.
 *
 * Bounded at `limit + 1` at every step so an astronomically large count cannot
 * overflow into a finite-looking number, and a reference CYCLE returns
 * `Infinity`, which is over any limit.
 *
 * Runs after the attribute sweep, so every surviving `href` is already a
 * same-document fragment.
 */
function renderedNodeCount(
  doc: Document,
  root: Element,
  limit: number
): number {
  const byId = new Map<string, Element>();
  for (const element of doc.querySelectorAll('[id]')) {
    const id = element.getAttribute('id');
    if (id && !byId.has(id)) byId.set(id, element);
  }

  /** The element a `#fragment` names, resolved the way a renderer resolves it. */
  const resolve = (raw: string | null): Element | undefined => {
    if (raw === null) return undefined;
    const fragment = safeDecodeURI(raw.trim());
    return fragment.startsWith('#') ? byId.get(fragment.slice(1)) : undefined;
  };

  const memo = new Map<Element, number>();
  const visiting = new Set<Element>();

  const markerSiteMemo = {
    all: new Map<Element, number>(),
    single: new Map<Element, number>(),
  };
  const markerSiteVisiting = {
    all: new Set<Element>(),
    single: new Set<Element>(),
  };

  const markerSites = (element: Element, single: boolean): number => {
    const kind = single ? 'single' : 'all';
    const cached = markerSiteMemo[kind].get(element);
    if (cached !== undefined) return cached;
    if (markerSiteVisiting[kind].has(element)) return Infinity;
    markerSiteVisiting[kind].add(element);

    const vertices = vertexUpperBound(element);
    let total = vertices > 0 ? (single ? 1 : vertices) : 0;
    if (element.localName?.toLowerCase() === 'use') {
      const [name] = referenceAttributeNames(element);
      const target = resolve(
        name === undefined ? null : element.getAttribute(name)
      );
      if (target) total += markerSites(target, single);
    }
    for (const child of element.children) {
      if (total > limit) break;
      total += markerSites(child, single);
    }

    markerSiteVisiting[kind].delete(element);
    const bounded = Number.isNaN(total)
      ? limit + 1
      : Math.min(total, limit + 1);
    markerSiteMemo[kind].set(element, bounded);
    return bounded;
  };

  const cost = (element: Element): number => {
    const cached = memo.get(element);
    if (cached !== undefined) return cached;
    if (visiting.has(element)) return Infinity;
    visiting.add(element);

    let total = 1;
    if (element.localName?.toLowerCase() === 'use') {
      const [name] = referenceAttributeNames(element);
      const target = resolve(
        name === undefined ? null : element.getAttribute(name)
      );
      if (target) total += cost(target);
    }

    for (const attribute of MARKER_ATTRIBUTES) {
      if (total > limit) break;
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      const target = resolve(markerReference(value));
      if (!target) continue;
      // EVERY site is charged. The previous `sites - 1` credited one
      // instantiation back against the definition's own place in the tree walk,
      // which is sound for a single reference and wrong for N: the definition is
      // walked once for the document while each reference instantiates it again.
      // With `marker-start`/`marker-end` pinned at one site that credit also
      // cancelled the whole charge, so a hundred referencing elements cost
      // nothing. Over-counting the definition by one is the safe direction.
      const sites = markerSites(element, SINGLE_SITE_MARKERS.has(attribute));
      // Skipped, not multiplied by zero: `cost` returns `Infinity` for a
      // reference cycle, and `0 * Infinity` is `NaN`, which compares false
      // against every limit.
      if (sites < 1) continue;
      total += sites * cost(target);
    }

    for (const child of element.children) {
      if (total > limit) break;
      total += cost(child);
    }

    visiting.delete(element);
    // `NaN` is over EVERY limit here, not under it. A ceiling whose arithmetic
    // can produce one must say which way that reads, or a single stray `NaN`
    // silently admits the document the ceiling exists to refuse.
    const bounded = Number.isNaN(total)
      ? limit + 1
      : Math.min(total, limit + 1);
    memo.set(element, bounded);
    return bounded;
  };

  return cost(root);
}

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

    const rasterCache = new Map<string, InlineRaster | null>();
    const analyzeRaster = (reference: string): InlineRaster | null => {
      const cached = rasterCache.get(reference);
      if (cached !== undefined) return cached;
      const analyzed = analyzeInlineRaster(reference);
      rasterCache.set(reference, analyzed);
      return analyzed;
    };

    // Refused, not stripped — see `ANIMATION_ELEMENTS`. Before any mutation, so
    // the caller gets an untouched document and one clear reason.
    //
    // Both forms animation takes in an SVG are asked in ONE pass: the declared
    // SMIL elements, and a raster inlined on a reference attribute whose own
    // bytes animate. The second used to fall through to the attribute sweep,
    // which strips — so an APNG inside an `<image>` answered 200 with the
    // picture silently removed while the same bytes uploaded directly answered
    // 400. See `carriesAnimatedRaster`.
    if (
      [...doc.querySelectorAll('*')].some(
        (element) =>
          ANIMATION_ELEMENTS.some((tag) => matchesTag(element, tag)) ||
          (element.localName?.toLowerCase() === 'image' &&
            carriesAnimatedRaster(element, analyzeRaster))
      )
    )
      return {
        isValid: false,
        cleanedSvg: '',
        errors: [MSG_ANIMATION_UNSUPPORTED],
        reason: 'animated',
      };

    // Its own sweep and its own reason: an oversized inline raster is a
    // decompression bomb, not an animation, and the direct upload path answers
    // it with the pixel ceiling rather than the animation message. Refused, not
    // stripped, for the reason `carriesAnimatedRaster` gives — a 200 carrying a
    // document with the picture silently gone is the failure this policy exists
    // to remove.
    const rasterLimit = [...doc.querySelectorAll('*')]
      .filter((element) => element.localName?.toLowerCase() === 'image')
      .map((element) => rasterLimitViolation(element, analyzeRaster))
      .find((violation) => violation !== null);
    if (rasterLimit)
      return {
        isValid: false,
        cleanedSvg: '',
        errors: [MSG_RASTER_TOO_LARGE],
        reason: rasterLimit,
      };

    // Remove dangerous elements
    DANGEROUS_ELEMENTS.forEach((tagName) => {
      const matchingElements = [...doc.querySelectorAll('*')].filter(
        (element) => matchesTag(element, tagName)
      );

      matchingElements.forEach((el, index) => {
        errors.push(
          `تم إزالة عنصر خطير #${index + 1}: <${el.tagName.toLowerCase()}>`
        );
        el.remove();
      });
    });

    let embeddedRasterPixels = 0;
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

      // `href` / `xlink:href` on EVERY element, not only the two whose purpose
      // is obviously to dereference one.
      //
      // These two attributes are how a URL is resolved throughout SVG:
      // `feImage`, `mpath`, `textPath`, gradients, patterns and filters all read
      // them, and the generic value check above passes an ordinary `https:`
      // value — so `<feImage href="https://attacker/pixel"/>` survived
      // sanitisation AND svgo with `isValid: true` and no warning. An external
      // reference is fetched by the VIEWER when the stored object renders, which
      // beacons their IP, User-Agent and Referer and lets the picture change
      // after review. DOMPurify does not help — `image` is in its
      // `DEFAULT_DATA_URI_TAGS`, so the attribute survives there too.
      //
      // The allowlist is the whole rule: a same-document fragment, plus a
      // self-contained `data:` raster on `image`, which is how a legitimately
      // inlined bitmap arrives — held to the same declared-type, signature and
      // animation checks an uploaded file gets (`isSafeInlineRaster`).
      // `isDangerousValue` above has already rejected `data:text/html` and the
      // script-bearing SVG data URI.
      const localName = element.localName?.toLowerCase();
      const allowsDataUri = localName === 'image';
      let keptReference = false;
      for (const name of referenceAttributeNames(element)) {
        const raw = element.getAttribute(name);
        if (raw === null) continue;
        const reference = raw.trim();
        const raster = allowsDataUri ? analyzeRaster(reference) : null;
        if (raster !== null || LOCAL_FRAGMENT.test(reference)) {
          element.setAttribute(name, reference);
          keptReference = true;
          if (raster !== null)
            embeddedRasterPixels += raster.width * raster.height;
        } else {
          errors.push(`تم إزالة مرجع خارجي من: ${name}`);
          element.removeAttribute(name);
        }
      }
      // Only `use` and `image` are removed outright: both render nothing without
      // a reference while still consuming the element budget. Every other
      // element survives losing one — a gradient stripped of its template href
      // is still a gradient.
      if (!keptReference && (localName === 'use' || localName === 'image')) {
        errors.push(`تم إزالة عنصر ${localName} بدون مرجع محلي`);
        element.remove();
      }

      for (const attribute of MARKER_ATTRIBUTES) {
        const raw = element.getAttribute(attribute);
        if (raw === null) continue;
        const reference = markerReference(raw);
        if (reference !== null) {
          element.setAttribute(attribute, canonicalMarkerReference(reference));
          continue;
        }

        const keyword = decodeCssEscapes(raw).trim().toLowerCase();
        if (MARKER_KEYWORDS.has(keyword))
          element.setAttribute(attribute, keyword);
        else {
          errors.push(`تم إزالة مرجع marker غير صالح من: ${attribute}`);
          element.removeAttribute(attribute);
        }
      }
    });

    if (embeddedRasterPixels > MAX_IMAGE_PIXELS)
      return {
        isValid: false,
        cleanedSvg: '',
        errors: [MSG_RASTER_TOO_LARGE],
        reason: 'too-many-pixels',
      };

    // Bounds what a renderer INSTANTIATES, which the source element count above
    // does not — see `SVG_MAX_RENDERED_NODES`.
    const renderedNodes = renderedNodeCount(
      doc,
      svgElement,
      SVG_MAX_RENDERED_NODES
    );
    if (renderedNodes > SVG_MAX_RENDERED_NODES)
      return {
        isValid: false,
        cleanedSvg: '',
        errors: [
          `SVG يتوسع إلى عناصر أكثر من الحد المسموح (${SVG_MAX_RENDERED_NODES})`,
        ],
      };

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
      embeddedRasterMegapixels: Math.ceil(embeddedRasterPixels / 1_000_000),
    };
  } catch (error) {
    return {
      isValid: false,
      cleanedSvg: '',
      errors: [`فشل في معالجة SVG: ${error}`],
    };
  }
}
