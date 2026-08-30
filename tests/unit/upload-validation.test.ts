/**
 * The two halves of the upload door: `validateMagicBytes` on the bytes, and
 * `sanitizeSvg` on the one type the byte check deliberately waves through.
 *
 * Neither had an assertion before this file, and the gap is structural rather
 * than accidental: `tests/integration/upload-auth-gate.test.ts` uploads a benign
 * `<svg><rect/></svg>` precisely *because* SVG is exempt from the magic-byte
 * check (`lib/r2/upload-helper.ts:99`), so the one fixture that reaches the
 * pipeline is the one fixture that exercises neither guard.
 *
 * Why the SVG half is a security test and not a formatting test: the sanitised
 * output is written to the **public** bucket with `ContentType: image/svg+xml`
 * and `Content-Disposition: inline` (`upload-helper.ts:313-320`), so a browser
 * renders it as a document on the CDN origin. Anything that survives
 * `sanitizeSvg` is stored XSS surface. That is why every hostile row below
 * asserts the **cleaned output does not contain the payload** — a sanitiser that
 * returns `isValid: true` and passes the payload through is the exact failure
 * mode, and `expect(result.isValid).toBe(true)` would call it a pass.
 *
 * Everything runs through `sanitizeSvgServer`, not `sanitizeSvg` directly. That
 * wrapper is four lines that inject jsdom's `DOMParser`/`XMLSerializer`, it is
 * what `processImage` calls (`upload-helper.ts:206`), and calling it means the
 * assertions cover both parsers — the XML one the app sweeps on and the HTML one
 * DOMPurify re-parses with. Several payloads below are stopped by the second and
 * not the first, which a test of `sanitizeSvg` in isolation could not tell you.
 *
 * **No `test.failing` here.** Two groups used to record live defects that way —
 * the metadata-only `validateSvgFile` and the zero-length RIFF chunk. Both are
 * resolved: the first function is gone (the server pipeline is the single
 * validation boundary) and the second is a passing regression case below.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import zlib from 'node:zlib';

import {
  UPLOAD_MEGAPIXEL_BUDGET,
  UPLOAD_REQUEST_UNIT,
} from '@/app/api/upload/image/handler';
import { uploadMsg } from '@/app/api/upload/image/messages';
import { measureEncodeCost, optimizeImage } from '@/lib/r2/optimize-image';
import {
  ALLOWED_IMAGE_TYPES,
  isAllowedImageType,
  validateMagicBytes,
  validateSvgUpload,
} from '@/lib/r2/upload-helper';

import { HTTP_STATUS } from '@/utils/api-messages';
import {
  ANIMATION_ELEMENTS,
  DANGEROUS_ATTRIBUTES,
  DANGEROUS_ELEMENTS,
  isDangerousValue,
  safeDecodeURI,
  SVG_MAX_ELEMENTS,
  SVG_MAX_RENDERED_NODES,
} from '@/utils/images/config';
import { rasterDimensions } from '@/utils/images/raster-bytes';
import { sanitizeSvgServer, svgOptimizerServer } from '@/utils/images/server';
import { sanitizeSvg } from '@/utils/images/svg-optimizer';
import {
  MAX_IMAGE_EDGE,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SIZE,
  SERVER_MAX_IMAGE_SIZE,
} from '@/utils/validation/constants';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/** The byte ceiling `sanitizeSvg` applies to its own input. */
const SVG_SIZE_CAP = SERVER_MAX_IMAGE_SIZE * 2 * 1024 * 1024;

const svg = (inner: string, rootAttributes = '') =>
  `<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}" width="8" height="8"` +
  `${rootAttributes}>${inner}</svg>`;

const clean = (markup: string) => sanitizeSvgServer(markup);

/**
 * The assertion every hostile row makes.
 *
 * "Neutralised" has exactly two acceptable shapes and this insists on one of
 * them: the sanitiser refused outright (and then `cleanedSvg` must be empty, not
 * a partially-cleaned document), or it accepted and the payload is gone from the
 * output. The output is compared after `safeDecodeURI` because a percent-encoded
 * survivor is a survivor.
 */
function expectNeutralised(markup: string, forbidden: readonly string[]) {
  const result = clean(markup);

  if (!result.isValid) {
    expect(result.cleanedSvg).toBe('');
    return result;
  }

  const stored = safeDecodeURI(result.cleanedSvg).toLowerCase();
  for (const token of forbidden)
    expect(stored).not.toInclude(token.toLowerCase());
  // The module's own oracle, applied to the whole stored document rather than to
  // one attribute: whatever `isDangerousValue` would refuse in a value must not
  // be sitting in the file that reaches the CDN.
  expect(isDangerousValue(result.cleanedSvg)).toBe(false);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// GAP 4 — hostile SVG, the payloads that ARE neutralised
// ─────────────────────────────────────────────────────────────────────────────

const HOSTILE: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  [
    'inline <script>',
    svg('<script>alert(1)</script><rect width="8" height="8"/>'),
    ['<script', 'alert('],
  ],
  [
    'uppercase <SCRIPT>, which the tag sweep lowercases before comparing',
    svg('<SCRIPT>alert(1)</SCRIPT><rect width="8" height="8"/>'),
    ['<script', 'alert('],
  ],
  [
    'an onload= attribute on a child',
    svg('<rect width="8" height="8" onload="alert(1)"/>'),
    ['onload', 'alert('],
  ],
  [
    'an onload= attribute on the svg root itself',
    svg('<rect width="8" height="8"/>', ' onload="alert(1)"'),
    ['onload', 'alert('],
  ],
  [
    'a handler DANGEROUS_ATTRIBUTES does not list (onpointerdown)',
    svg('<rect width="8" height="8" onpointerdown="alert(1)"/>'),
    ['onpointerdown', 'alert('],
  ],
  [
    'a javascript: href',
    svg('<a href="javascript:alert(1)"><rect width="8" height="8"/></a>'),
    ['javascript:', 'alert('],
  ],
  [
    'a javascript: xlink:href',
    svg('<a xlink:href="javascript:alert(1)"><rect width="8" height="8"/></a>'),
    ['javascript:', 'alert('],
  ],
  [
    // The reason `safeDecodeURI` exists. `isDangerousValue` decodes before
    // matching, so `javascript%3A` has to lose to the same branch as the literal.
    'a percent-encoded javascript: href',
    svg('<image href="javascript%3Aalert(1)" width="8" height="8"/>'),
    ['javascript:', 'javascript%3a', 'alert('],
  ],
  [
    // `safeDecodeURI` decodes twice, so the double-encoded form is covered too.
    'a double percent-encoded javascript: href',
    svg('<image href="javascript%253Aalert(1)" width="8" height="8"/>'),
    ['javascript:', 'javascript%3a', 'alert('],
  ],
  [
    'a javascript: href on an element the <a> sweep does not remove',
    svg('<image xlink:href="javascript:alert(1)" width="8" height="8"/>'),
    ['javascript:', 'alert('],
  ],
  [
    // `isDangerousValue` misses this one — a tab inside the scheme defeats
    // `includes('javascript:')` — and DOMPurify's URI allowlist is what stops
    // it. Asserted end to end for exactly that reason: the guarantee is a
    // property of the pipeline, not of either layer alone.
    'a tab-split javascript: scheme',
    svg('<image href="java&#9;script:location=1" width="8" height="8"/>'),
    ['javascript:', 'java\tscript:'],
  ],
  [
    'a data:text/html href',
    svg(
      '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="><rect width="8" height="8"/></a>'
    ),
    ['data:text/html'],
  ],
  [
    'a data:text/html href on an element that survives the tag sweep',
    svg('<image href="data:text/html,x" width="8" height="8"/>'),
    ['data:text/html'],
  ],
  [
    '<foreignObject>, the HTML escape hatch',
    svg(
      '<foreignObject width="8" height="8"><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject><rect width="8" height="8"/>'
    ),
    ['foreignobject', '<div'],
  ],
  [
    'an HTML event handler smuggled inside <foreignObject>',
    svg(
      '<foreignObject width="8" height="8"><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/></div></foreignObject><rect width="8" height="8"/>'
    ),
    ['foreignobject', 'onerror', 'alert('],
  ],
  [
    'a CSS @import in its functional url() form',
    svg(
      '<style>@import url("https://evil.example/x.css");</style><rect width="8" height="8"/>'
    ),
    ['@import', 'evil.example'],
  ],
  [
    'a javascript: URL inside a <style> block',
    svg(
      '<style>rect{fill:url("javascript:alert(1)")}</style><rect width="8" height="8"/>'
    ),
    ['javascript:', 'alert('],
  ],
  [
    'a javascript: URL inside a style= attribute',
    svg('<path style="fill:url(javascript:alert(1))" d="M0 0"/>'),
    ['javascript:', 'alert('],
  ],
  [
    'an onbegin handler on <animate>',
    svg(
      '<rect width="8" height="8"><animate attributeName="x" onbegin="alert(1)"/></rect>'
    ),
    ['onbegin', 'alert('],
  ],
  [
    'a <set> rewriting href to javascript:',
    svg(
      '<a><set attributeName="href" to="javascript:alert(1)"/><rect width="8" height="8"/></a>'
    ),
    ['javascript:', 'alert('],
  ],
];

describe('hostile SVG, neutralised', () => {
  test.each([...HOSTILE])('%s', (_name, markup, forbidden) => {
    expectNeutralised(markup, forbidden);
  });

  test('a namespace-prefixed <script> is refused outright rather than cleaned', () => {
    // `<s:script>` binds the SVG namespace to a prefix, which the tag sweep
    // catches by `endsWith(':script')` — and DOMPurify then rejects the whole
    // serialisation. `isValid: false` with an empty `cleanedSvg` is the safe
    // direction, so this is recorded as behaviour rather than as a bug.
    const result = clean(
      `<svg xmlns="${SVG_NS}" xmlns:s="${SVG_NS}"><s:script>alert(1)</s:script><rect width="8" height="8"/></svg>`
    );

    expect(result.isValid).toBe(false);
    expect(result.cleanedSvg).toBe('');
  });

  test.each([...DANGEROUS_ELEMENTS])(
    'a <%s> element never reaches the cleaned output',
    (tag) => {
      const result = expectNeutralised(
        svg(`<${tag}/><rect width="8" height="8"/>`),
        [`<${tag}`]
      );
      if (result.isValid)
        expect(result.errors.join('\n')).toInclude(`<${tag.toLowerCase()}>`);
    }
  );

  test.each([...DANGEROUS_ATTRIBUTES])(
    'a %s= attribute never reaches the cleaned output',
    (attribute) => {
      expectNeutralised(
        svg(`<rect width="8" height="8" ${attribute}="alert(1)"/>`),
        [attribute, 'alert(']
      );
    }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// GAP 4 — the structural gates
// ─────────────────────────────────────────────────────────────────────────────

describe('the structural gates on an SVG', () => {
  /** What `sanitizeSvg:74` counts: every `<…>` run in the post-strip text. */
  const tagCount = (markup: string) => (markup.match(/<[^>]+>/g) || []).length;

  const withTags = (total: number) =>
    // Two of the count are the svg open and close tags.
    `<svg xmlns="${SVG_NS}">${'<rect width="1" height="1"/>'.repeat(total - 2)}</svg>`;

  test('the ceiling is exactly SVG_MAX_ELEMENTS, and one over is refused', () => {
    const atCeiling = withTags(SVG_MAX_ELEMENTS);
    const overCeiling = withTags(SVG_MAX_ELEMENTS + 1);

    expect(tagCount(atCeiling)).toBe(SVG_MAX_ELEMENTS);
    expect(tagCount(overCeiling)).toBe(SVG_MAX_ELEMENTS + 1);

    expect(clean(atCeiling).isValid).toBe(true);

    const refused = clean(overCeiling);
    expect(refused.isValid).toBe(false);
    expect(refused.cleanedSvg).toBe('');
    expect(refused.errors.join('')).toInclude(String(SVG_MAX_ELEMENTS + 1));
  });

  test('comments are stripped before the count, so they cannot exhaust it', () => {
    const result = clean(
      `<svg xmlns="${SVG_NS}">${'<!-- c -->'.repeat(SVG_MAX_ELEMENTS + 100)}<rect width="1" height="1"/></svg>`
    );

    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).not.toInclude('<!--');
  });

  test('content over the size cap is refused before it is parsed', () => {
    const oversize = `<svg xmlns="${SVG_NS}"><desc>${'A'.repeat(SVG_SIZE_CAP)}</desc></svg>`;

    const result = clean(oversize);
    expect(result.isValid).toBe(false);
    expect(result.cleanedSvg).toBe('');
  });

  test('the SVG cap is the binding one, so it bounds what an SVG upload can carry', () => {
    // `app/api/upload/image/handler.ts:21` rejects above `MAX_IMAGE_SIZE`; the
    // sanitiser rejects above half of that. Load-bearing for the entity-expansion
    // arithmetic below — the input budget for a bomb is the smaller number.
    expect(SVG_SIZE_CAP).toBeLessThan(MAX_IMAGE_SIZE * 1024 * 1024);
  });

  test.each([
    ['empty', ''],
    ['whitespace only', '   \n\t '],
    ['HTML with no svg root', '<html><body>hi</body></html>'],
    ['an <svg> that only exists inside a comment', '<!-- <svg> --><rect/>'],
    ['raster bytes read as text', 'PNG\r\n\n'],
  ])('%s is refused with an empty cleanedSvg', (_name, input) => {
    const result = clean(input);
    expect(result.isValid).toBe(false);
    expect(result.cleanedSvg).toBe('');
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('sanitizeSvg fails closed when no DOMParser is supplied', () => {
    // Bun has no global `DOMParser`, and `sanitizeSvg`'s parser argument is
    // optional. `utils/validation/rules.ts:246` (`SVGIconSchema`) calls it with
    // no parser — on the server that path therefore rejects every SVG, valid or
    // not. Recorded here because "fails closed" is the safe direction and the
    // caller is not otherwise covered.
    expect(typeof DOMParser).toBe('undefined');

    const result = sanitizeSvg(svg('<rect width="8" height="8"/>'));
    expect(result.isValid).toBe(false);
    expect(result.cleanedSvg).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GAP 4 — entity expansion (audit §2). No timing assertion: the property is
// structural, and a wall-clock threshold on a shared runner is a flake.
// ─────────────────────────────────────────────────────────────────────────────

/** One entity declaration, referenced `references` times. */
const entityBomb = (bodyLength: number, references: number) =>
  `<!DOCTYPE svg [<!ENTITY a "${'A'.repeat(bodyLength)}">]>` +
  `<svg xmlns="${SVG_NS}"><desc>${'&a;'.repeat(references)}</desc>` +
  `<rect width="8" height="8"/></svg>`;

describe('entity expansion', () => {
  const bomb = entityBomb(2048, 512);

  test('the pre-parse gate refuses a payload below both structural ceilings', () => {
    expect(bomb.length).toBeLessThan(SVG_SIZE_CAP);
    expect((bomb.match(/<[^>]+>/g) || []).length).toBeLessThan(
      SVG_MAX_ELEMENTS
    );

    const result = clean(bomb);
    expect(result.isValid).toBe(false);
    expect(result.cleanedSvg).toBe('');
  });

  test('nested entities are refused before parser behavior can matter', () => {
    const nested =
      `<!DOCTYPE svg [<!ENTITY inner "AAAAAAAA"><!ENTITY outer "&inner;&inner;&inner;&inner;">]>` +
      `<svg xmlns="${SVG_NS}"><desc>${'&outer;'.repeat(8)}</desc></svg>`;

    const result = clean(nested);
    expect(result.isValid).toBe(false);
    expect(result.cleanedSvg).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GAP 4 — external references. These were live defects (`test.failing`) until
// CSS reference checks were extended to cover directives and URL functions,
// and the element guard was extended from `use` to `image`. They assert the fix.
// ─────────────────────────────────────────────────────────────────────────────

const EXTERNAL_REFERENCES: ReadonlyArray<readonly [string, string]> = [
  [
    // The string form of the directive `@import url(...)` already blocked — this
    // was the bypass.
    'a CSS @import in its string form',
    svg(
      '<style>@import "https://evil.example/x.css";</style><rect width="8" height="8"/>'
    ),
  ],
  [
    'a @font-face src pointing off-origin',
    svg(
      '<style>@font-face{font-family:x;src:url(https://evil.example/f.woff)}</style><rect width="8" height="8"/>'
    ),
  ],
  [
    'an external xlink:href',
    svg(
      '<image xlink:href="https://evil.example/p.svg" width="8" height="8"/>'
    ),
  ],
  [
    'an external href',
    svg('<image href="https://evil.example/p.svg" width="8" height="8"/>'),
  ],
  [
    'an off-origin url() in a style= attribute',
    svg('<path style="fill:url(https://evil.example/t.svg#g)" d="M0 0"/>'),
  ],
  [
    // Protocol-relative: no scheme to blocklist, still an external fetch.
    'a protocol-relative url() in a style= attribute',
    svg('<path style="fill:url(//evil.example/t.svg#g)" d="M0 0"/>'),
  ],
  [
    'an off-origin url() inside a <style> rule',
    svg(
      '<style>.a{fill:url(https://evil.example/g.svg#x)}</style><path class="a" d="M0 0"/>'
    ),
  ],
  [
    'an image-set() reference in a style attribute',
    svg(
      '<path style="mask-image:image-set(https://evil.example/mask.png 1x)" d="M0 0"/>'
    ),
  ],
  [
    'an image() reference in a style element',
    svg(
      '<style>.a{mask-image:image("https://evil.example/mask.png")}</style><path class="a" d="M0 0"/>'
    ),
  ],
  // Everything below is an element OTHER than `image`/`use` that dereferences
  // `href`. The guard used to name those two, and the generic value check passes
  // an ordinary `https:` value — so each of these reached the public bucket with
  // its reference intact and `isValid: true`, nothing even stripped.
  [
    'an feImage href, which SVG 2 defines as an external-resource reference',
    svg(
      '<filter id="f"><feImage href="https://evil.example/pixel.png"/></filter><rect width="8" height="8" filter="url(#f)"/>'
    ),
  ],
  [
    'a textPath href',
    svg(
      '<text><textPath href="https://evil.example/x.svg#p">hi</textPath></text>'
    ),
  ],
  [
    'a gradient template href',
    svg(
      '<linearGradient id="g" href="https://evil.example/g.svg#h"/><rect width="8" height="8" fill="url(#g)"/>'
    ),
  ],
  [
    'a pattern template xlink:href',
    svg(
      '<pattern id="p" xlink:href="https://evil.example/p.svg#q"/><rect width="8" height="8" fill="url(#p)"/>'
    ),
  ],
  [
    'a filter href',
    svg(
      '<filter id="f" href="https://evil.example/f.svg#g"/><rect width="8" height="8" filter="url(#f)"/>'
    ),
  ],
];

/**
 * The forms that MUST survive. Without these the entry above is satisfiable by
 * a sanitiser that strips every reference, which would silently blank every
 * gradient, mask, clip-path and sprite the application stores.
 */
const LOCAL_REFERENCES: ReadonlyArray<readonly [string, string]> = [
  [
    'a same-document use reference',
    svg('<defs><symbol id="a"><circle r="4"/></symbol></defs><use href="#a"/>'),
  ],
  [
    'a self-contained data: image',
    svg(
      '<image width="8" height="8" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="/>'
    ),
  ],
  [
    'a fill referencing a local gradient',
    svg(
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs><rect width="8" height="8" fill="url(#g)"/>'
    ),
  ],
  [
    'a local clip-path reference',
    svg(
      '<defs><clipPath id="c"><circle r="5"/></clipPath></defs><rect width="8" height="8" clip-path="url(#c)"/>'
    ),
  ],
];

describe('external references in SVG', () => {
  test.each([...EXTERNAL_REFERENCES])('%s is stripped', (_name, markup) => {
    // The sanitizer's external-reference invariant is that external CSS is
    // refused. Each of these is otherwise stored verbatim on the public bucket
    // as `image/svg+xml` + `inline`, so it renders as a DOCUMENT and the
    // reference is fetched at VIEW time — a beacon for every future viewer's IP,
    // UA and Referer, changeable remotely after review.
    //
    // No script execution in any of them; this is the tracking and
    // remote-mutation half of the surface, not XSS.
    const result = clean(markup);
    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).not.toInclude('evil.example');
  });

  test.each([...LOCAL_REFERENCES])('%s survives', (_name, markup) => {
    const result = clean(markup);
    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).toInclude('<svg');
  });

  test('CSS is removed even when it contains only local references', () => {
    const result = clean(
      svg(
        '<style>.a{fill:url(#g)}</style><rect class="a" style="fill:url(#g)"/>'
      )
    );
    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).not.toMatch(/<style\b|\sstyle=/i);
  });

  test('content outside the svg root is refused', () => {
    // The app sweeps an XML tree where `<p>` is a child of `<svg>`; DOMPurify
    // re-parses the serialisation as HTML, where `p` terminates foreign content,
    // so the node lands AFTER `</svg>`. `sanitized.includes('<svg')` could not
    // see that: 55 bytes in produced `isValid: true` and
    // `<svg xmlns="…"></svg>hi`, which made svgo throw `SvgoParserError` and the
    // request a 500. The gate is structural now — one SVG root, no siblings.
    const result = clean(`<svg xmlns="${SVG_NS}"><p>hi</p></svg>`);

    expect(result.isValid).toBe(false);
  });

  test('whatever §13 produces, a malformed document is never STORED', () => {
    // The half of §13 that holds today and must keep holding after a fix: the
    // pipeline either refuses, or throws in svgo, but it does not hand R2 a
    // two-root document. Written as the invariant rather than as the current
    // outcome so a fix does not turn this red.
    for (const markup of [
      `<svg xmlns="${SVG_NS}"><p>hi</p></svg>`,
      `<svg xmlns="${SVG_NS}"><div><style>a{fill:red}</style></div></svg>`,
    ]) {
      const result = clean(markup);
      if (!result.isValid) continue;

      let optimized: string | null = null;
      try {
        optimized = svgOptimizerServer({ data: result.cleanedSvg });
      } catch {
        // svgo refused it; nothing is stored.
        continue;
      }

      expect(optimized.match(/<svg[\s>]/g) ?? []).toHaveLength(1);
      expect(optimized.trimEnd()).toEndWith('>');
    }
  });

  test('a local <use> sprite survives sanitisation', () => {
    const sprite = `<svg xmlns="${SVG_NS}" viewBox="0 0 24 24"><symbol id="i"><rect width="8" height="8"/></symbol><use href="#i"/></svg>`;

    const result = clean(sprite);
    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).toInclude('<use');
    expect(result.cleanedSvg).toInclude('href="#i"');
  });

  test('a <use> element cannot opt into an external reference', () => {
    const external = `<svg xmlns="${SVG_NS}"><use href="https://evil.example/i.svg#i"/></svg>`;

    const result = clean(external);
    expect(result.cleanedSvg).not.toInclude('evil.example');
    expect(result.cleanedSvg).not.toInclude('<use');
  });

  test('the external reference is gone from the STORED bytes, not only the cleaned ones', () => {
    // svgo runs after the sanitiser (`processImage`), and the earlier defect was
    // measured on the svgo output: the reference survived both stages. Asserted
    // end to end so a future sanitiser change cannot be judged on `cleanedSvg`
    // alone.
    for (const [, markup] of EXTERNAL_REFERENCES) {
      const result = clean(markup);
      expect(result.isValid).toBe(true);
      expect(svgOptimizerServer({ data: result.cleanedSvg })).not.toInclude(
        'evil.example'
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Animation — refused for every format the route admits, not stripped
// ─────────────────────────────────────────────────────────────────────────────

describe('animation in an SVG', () => {
  test.each([...ANIMATION_ELEMENTS])(
    'a <%s> element makes the whole document a refusal, not a silent flatten',
    (tag) => {
      const result = clean(
        svg(`<rect width="8" height="8"/><${tag} attributeName="x"/>`)
      );

      expect(result.isValid).toBe(false);
      expect(result.cleanedSvg).toBe('');
      // The reason is what `processImage` branches on to produce the same
      // "animated uploads are not supported" message an animated WebP gets.
      expect(result.reason).toBe('animated');
    }
  );

  test('a namespace-prefixed animation element is refused too', () => {
    const result = clean(
      `<svg xmlns="${SVG_NS}" xmlns:s="${SVG_NS}"><rect width="8" height="8"/><s:animateTransform attributeName="transform"/></svg>`
    );

    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('animated');
  });

  test('a still document is untouched by the animation gate', () => {
    const result = clean(svg('<rect width="8" height="8"/>'));

    expect(result.isValid).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Expansion — what a renderer instantiates, which the element count does not bound
// ─────────────────────────────────────────────────────────────────────────────

describe('the <use> expansion bound', () => {
  /** `levels` nested groups, each instantiating the previous one twice. */
  const useChain = (levels: number) => {
    const parts: string[] = [];
    for (let i = 0; i < levels; i++)
      parts.push(
        i === 0
          ? '<g id="l0"><rect width="1" height="1"/></g>'
          : `<g id="l${i}"><use href="#l${i - 1}"/><use href="#l${i - 1}"/></g>`
      );
    return `<svg xmlns="${SVG_NS}">${parts.join('')}<use href="#l${levels - 1}"/></svg>`;
  };

  test('a nested <use> chain inside every other ceiling is refused', () => {
    const bomb = useChain(123);

    // The point of the finding: it passes both structural gates the sanitiser
    // had. 2^123 rendered nodes from 6.5 KB of source.
    expect(new Blob([bomb]).size).toBeLessThan(SVG_SIZE_CAP);
    expect((bomb.match(/<[^>]+>/g) ?? []).length).toBeLessThan(
      SVG_MAX_ELEMENTS
    );

    const result = clean(bomb);
    expect(result.isValid).toBe(false);
    expect(result.cleanedSvg).toBe('');
    expect(result.errors.join('')).toInclude(String(SVG_MAX_RENDERED_NODES));
  });

  test('a reference cycle is refused rather than followed', () => {
    const result = clean(
      `<svg xmlns="${SVG_NS}"><g id="a"><use href="#a"/></g><use href="#a"/></svg>`
    );

    expect(result.isValid).toBe(false);
    expect(result.cleanedSvg).toBe('');
  });

  test('an ordinary sprite sheet stays well inside the bound', () => {
    // Without this the entry above is satisfiable by refusing every `<use>`.
    const sprite = `<svg xmlns="${SVG_NS}"><defs><symbol id="i"><rect width="8" height="8"/><circle r="2"/></symbol></defs>${'<use href="#i"/>'.repeat(40)}</svg>`;

    const result = clean(sprite);
    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).toInclude('<use');
  });

  /**
   * The same chain with the SECOND reference of each level percent-encoded.
   *
   * A renderer resolves a fragment DECODED — Chromium's
   * `SVGURLReferenceResolver` runs `DecodeUrlEscapeSequences` before
   * `getElementById` — while `LOCAL_FRAGMENT` admits `%`, so `#%6c0` reached the
   * stored document intact and cost ONE node against the ceiling while
   * instantiating `id="l0"` in every viewer. Measured before the fix: 20 levels
   * accepted with all 20 encoded references preserved through svgo.
   */
  const encodedUseChain = (levels: number, encode: boolean) => {
    const parts = ['<g id="l0"><rect width="1" height="1"/></g>'];
    for (let i = 1; i < levels; i++) {
      const second = encode ? `#%6c${i - 1}` : `#l${i - 1}`;
      parts.push(
        `<g id="l${i}"><use href="#l${i - 1}"/><use href="${second}"/></g>`
      );
    }
    return `<svg xmlns="${SVG_NS}">${parts.join('')}<use href="#l${levels - 1}"/></svg>`;
  };

  test('a percent-encoded fragment is counted, not waved through', () => {
    const plain = clean(encodedUseChain(20, false));
    const encoded = clean(encodedUseChain(20, true));

    // The control: the identical document with plain fragments is refused, so
    // the encoded one differs only in spelling.
    expect(plain.isValid).toBe(false);
    expect(encoded.isValid).toBe(false);
    expect(encoded.errors.join('')).toInclude(String(SVG_MAX_RENDERED_NODES));
  });

  test('a percent-encoded fragment that resolves is still a legitimate reference', () => {
    // Counting it must not mean refusing it: `#%69` names `id="i"` and renders.
    const result = clean(
      `<svg xmlns="${SVG_NS}"><defs><symbol id="i"><rect width="8" height="8"/></symbol></defs><use href="#%69"/></svg>`
    );

    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).toInclude('<use');
  });

  /**
   * `<marker>` content is instantiated once per VERTEX of the path referencing
   * it, and the vertex count lives in one `d` attribute — which costs a single
   * element against `SVG_MAX_ELEMENTS` however many vertices it names. Following
   * `<use>` alone therefore counted a 100-element marker once and missed the
   * multiplier entirely.
   */
  const markerBomb = (elements: number, vertices: number) => {
    const marker = `<marker id="m" markerWidth="4" markerHeight="4"><g>${'<rect width="1" height="1"/>'.repeat(elements)}</g></marker>`;
    let d = 'M0 0';
    for (let i = 0; i < vertices; i++) d += ` L${i} ${i}`;
    return `<svg xmlns="${SVG_NS}"><defs>${marker}</defs><path d="${d}" marker-mid="url(#m)"/></svg>`;
  };

  test('a marker applied at every vertex of a long path is refused', () => {
    const bomb = markerBomb(100, 3000);

    // Inside every other ceiling: a few hundred tags, well under the byte cap.
    expect(new Blob([bomb]).size).toBeLessThan(SVG_SIZE_CAP);
    expect((bomb.match(/<[^>]+>/g) ?? []).length).toBeLessThan(
      SVG_MAX_ELEMENTS
    );

    const result = clean(bomb);
    expect(result.isValid).toBe(false);
    expect(result.errors.join('')).toInclude(String(SVG_MAX_RENDERED_NODES));
  });

  test('a marker reference cycle cannot launder a <use> bomb', () => {
    // `cost` answers `Infinity` for a cycle, and the marker charge multiplies it
    // by the number of EXTRA instantiation sites — which is zero for
    // `marker-start`. `0 * Infinity` is `NaN`, and `NaN > limit` is false, so a
    // single-site marker pointing at its own subtree turned this bomb from
    // refused into accepted. The ceiling has to read a `NaN` as OVER the limit,
    // never under it.
    const chain = ['<g id="l0"><rect width="1" height="1"/></g>'];
    for (let i = 1; i < 20; i++)
      chain.push(
        `<g id="l${i}"><use href="#l${i - 1}"/><use href="#l${i - 1}"/></g>`
      );
    const cycle =
      '<defs><marker id="m"><path d="M0 0" marker-start="url(#m)"/></marker></defs>' +
      '<path d="M0 0" marker-start="url(#m)"/>';
    const laundered = `<svg xmlns="${SVG_NS}">${cycle}${chain.join('')}<use href="#l19"/></svg>`;

    expect(clean(laundered).isValid).toBe(false);
    // And the cycle alone is refused too, rather than counted as one node.
    expect(
      clean(
        `<svg xmlns="${SVG_NS}"><defs><marker id="m"><path d="M0 0 L1 1 L2 2" marker-mid="url(#m)"/></marker></defs><path d="M0 0 L1 1 L2 2" marker-mid="url(#m)"/></svg>`
      ).isValid
    ).toBe(false);
  });

  test('an ordinary marker on an ordinary path survives', () => {
    // Without this the entry above is satisfiable by refusing every marker.
    const result = clean(
      `<svg xmlns="${SVG_NS}"><defs><marker id="m"><circle r="1"/></marker></defs><path d="M0 0 L1 1 L2 2 L3 3" marker-start="url(#m)" marker-mid="url(#m)" marker-end="url(#m)"/></svg>`
    );

    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).toInclude('marker-mid');
  });

  /**
   * `marker-start` and `marker-end` render once per REFERENCING ELEMENT, so a
   * hundred elements naming one marker instantiate it a hundred times. The
   * counter credited one instantiation back per element instead of once per
   * document, which at one site cancelled the whole charge — a hundred
   * references cost nothing at all.
   */
  const repeatedMarker = (users: number, elements: number, attribute: string) =>
    `<svg xmlns="${SVG_NS}"><defs><marker id="m">${'<rect width="1" height="1"/>'.repeat(elements)}</marker></defs>${`<path d="M0 0 L1 1" ${attribute}="url(#m)"/>`.repeat(users)}</svg>`;

  test.each(['marker-start', 'marker-end'])(
    'a marker named by a hundred elements through %s is refused',
    (attribute) => {
      const bomb = repeatedMarker(100, 100, attribute);

      expect((bomb.match(/<[^>]+>/g) ?? []).length).toBeLessThan(
        SVG_MAX_ELEMENTS
      );
      expect(clean(bomb).isValid).toBe(false);
    }
  );

  test('a marker inherited from a group reaches every path under it', () => {
    // The property is inherited, so the declaration sits on the `<g>` while the
    // instantiations happen on its children. Reading only the element the
    // attribute is written on counted none of them.
    const inherited = `<svg xmlns="${SVG_NS}"><defs><marker id="m">${'<rect width="1" height="1"/>'.repeat(100)}</marker></defs><g marker-start="url(#m)">${'<path d="M0 0 L1 1"/>'.repeat(100)}</g></svg>`;

    expect((inherited.match(/<[^>]+>/g) ?? []).length).toBeLessThan(
      SVG_MAX_ELEMENTS
    );
    expect(clean(inherited).isValid).toBe(false);
  });

  test('line references are charged, including a marker containing nested uses', () => {
    const chain = ['<g id="l0"><rect width="1" height="1"/></g>'];
    for (let i = 1; i < 8; i++)
      chain.push(
        `<g id="l${i}"><use href="#l${i - 1}"/><use href="#l${i - 1}"/></g>`
      );
    const bomb = `<svg xmlns="${SVG_NS}"><defs>${chain.join('')}<marker id="m"><use href="#l7"/></marker></defs>${'<line x2="1" marker-start="url(#m)"/>'.repeat(20)}</svg>`;

    expect((bomb.match(/<[^>]+>/g) ?? []).length).toBeLessThan(
      SVG_MAX_ELEMENTS
    );
    expect(clean(bomb).isValid).toBe(false);
  });

  test('an inherited marker reaches geometry instantiated by use', () => {
    const inherited = `<svg xmlns="${SVG_NS}"><defs><line id="line" x2="1"/><marker id="m">${'<rect width="1" height="1"/>'.repeat(100)}</marker></defs><g marker-start="url(#m)">${'<use href="#line"/>'.repeat(100)}</g></svg>`;

    expect(clean(inherited).isValid).toBe(false);
  });

  test('CSS-escaped marker URLs are canonicalised before they are counted', () => {
    const line = String.raw`<line x2="1" marker-start="u\72l(#\6d )"/>`;
    const escaped = `<svg xmlns="${SVG_NS}"><defs><marker id="m">${'<rect width="1" height="1"/>'.repeat(100)}</marker></defs>${line.repeat(100)}</svg>`;

    expect(clean(escaped).isValid).toBe(false);
  });

  test('an ordinary marker on a line survives', () => {
    const result = clean(
      `<svg xmlns="${SVG_NS}"><defs><marker id="m"><circle r="1"/></marker></defs><line x2="8" marker-start="url(#m)" marker-end="url(#m)"/></svg>`
    );

    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).toInclude('marker-start');
  });

  test('a handful of elements sharing a small marker still survives', () => {
    // The bound above is satisfiable by refusing every repeated reference.
    expect(clean(repeatedMarker(20, 2, 'marker-start')).isValid).toBe(true);
  });
});

describe('the xlink namespace, however it is spelled', () => {
  /** Sketch and OmniGraffle bind the xlink namespace to `xl`, not `xlink`. */
  const withPrefix = (inner: string) =>
    `<svg xmlns="${SVG_NS}" xmlns:xl="${XLINK_NS}" width="8" height="8">${inner}</svg>`;

  test('an external reference under a foreign prefix is stripped', () => {
    // A qualified-name lookup never saw `xl:href`, so a bare `https:` value —
    // which `isDangerousValue` passes — survived this sweep, closed only by
    // DOMPurify dropping an attribute in a namespace it does not recognise.
    const result = clean(
      withPrefix(
        '<image width="8" height="8" xl:href="https://evil.example/p.png"/>'
      )
    );

    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).not.toInclude('evil.example');
  });

  test('a same-document reference under a foreign prefix survives', () => {
    // The other half of the same blindness: no reference was FOUND on
    // `<use xl:href="#a"/>`, so a legitimate Sketch-exported sprite lost every
    // `<use>` to the reference-less removal.
    const result = clean(
      withPrefix('<symbol id="a"><circle r="1"/></symbol><use xl:href="#a"/>')
    );

    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).toInclude('use');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GAP 4 — validateSvgFile
// ─────────────────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

describe('the SVG content boundary', () => {
  // `validateSvgFile` used to live here: an exported helper that read `file.type`,
  // `file.name` and `file.size` and never opened the file, so PNG bytes named
  // `payload.svg` came back as valid. It had no caller outside this block, and
  // the server pipeline already refuses the same input by CONTENT — so the
  // weaker parallel boundary is gone rather than repaired, leaving one authority.
  test('a non-SVG carrying an .svg name is refused by content', () => {
    // `processImage` decodes the buffer as UTF-8 and hands it to
    // `sanitizeSvgServer`; no `<svg` substring means a 400, whatever the name
    // said.
    const asText = Buffer.from(PNG_SIGNATURE).toString('utf8');

    const result = clean(asText);
    expect(result.isValid).toBe(false);
    expect(result.cleanedSvg).toBe('');
  });

  test('the size ceiling belongs to the sanitiser, and applies to content', () => {
    const at = `<svg xmlns="${SVG_NS}"><desc>${'A'.repeat(SVG_SIZE_CAP - 200)}</desc><rect width="1" height="1"/></svg>`;
    const over = `<svg xmlns="${SVG_NS}"><desc>${'A'.repeat(SVG_SIZE_CAP)}</desc></svg>`;

    expect(new Blob([at]).size).toBeLessThanOrEqual(SVG_SIZE_CAP);
    expect(clean(at).isValid).toBe(true);
    expect(clean(over).isValid).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GAP 4 — the two helpers, exercised directly
// ─────────────────────────────────────────────────────────────────────────────

describe('safeDecodeURI and isDangerousValue', () => {
  test('safeDecodeURI decodes twice, so one layer of re-encoding buys nothing', () => {
    expect(safeDecodeURI('javascript%3Aalert(1)')).toBe('javascript:alert(1)');
    expect(safeDecodeURI('javascript%253Aalert(1)')).toBe(
      'javascript:alert(1)'
    );
  });

  test('safeDecodeURI returns the input rather than throwing on a bad escape', () => {
    // A lone `%` is a `URIError` from `decodeURIComponent`. Returning the raw
    // value is what keeps `isDangerousValue` matching on something.
    expect(safeDecodeURI('%')).toBe('%');
    expect(safeDecodeURI('100%25 %E0%A4%A')).toBe('100%25 %E0%A4%A');
  });

  test.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '   javascript:x',
    'javascript%3Aalert(1)',
    'javascript%253Aalert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<b>',
    '<script>alert(1)</script>',
    'window.eval("x")',
  ])('isDangerousValue refuses %p', (value) => {
    expect(isDangerousValue(value)).toBe(true);
  });

  test.each([
    'https://cdn.example.com/a.png',
    '#gradient',
    'currentColor',
    'url(#clip)',
    'M0 0h8v8H0z',
    '',
  ])('isDangerousValue admits %p', (value) => {
    expect(isDangerousValue(value)).toBe(false);
  });

  test('isDangerousValue is a substring match, so a split scheme slips past it', () => {
    // Recorded, not filed as a defect: DOMPurify's URI allowlist catches this
    // downstream (asserted in the hostile table above), so the pipeline holds.
    // It is here so that a change moving the decision back onto this function
    // has to confront the gap.
    expect(isDangerousValue('java\tscript:location=1')).toBe(false);
    expect(isDangerousValue('&#106;avascript:location=1')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GAP 5 — fixtures. Every byte is derived here, with each chunk named.
// ─────────────────────────────────────────────────────────────────────────────

/** `length | type | data | CRC-32(type ++ data)`, per PNG spec §5.3. */
function pngChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 'ascii');

  const crc = Buffer.alloc(4);
  // `Bun.hash.crc32` is the same CRC-32 the PNG spec names (checked against the
  // standard `"123456789"` -> 0xcbf43926 vector and against `crc32("IEND")`).
  crc.writeUInt32BE(
    Bun.hash.crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0,
    0
  );
  return Buffer.concat([header, data, crc]);
}

/**
 * A real RGBA PNG: signature, IHDR, one IDAT, IEND.
 *
 * `flat` fills every pixel identically. The gradient below is the useful default
 * for format checks, but it defeats zlib: a 1000x20000 gradient is 13 MiB, and
 * the dimension fixture has to stay UNDER the 1 MiB file limit to prove that
 * limit does not already catch it.
 */
function buildPng(size: number, height = size, flat = false): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type 6: truecolour with alpha

  const stride = 1 + size * 4; // one filter byte per row
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const pixel = row + 1 + x * 4;
      raw[pixel] = flat ? 0x40 : (x * 37) & 0xff;
      raw[pixel + 1] = flat ? 0x40 : (y * 53) & 0xff;
      raw[pixel + 2] = 0x40;
      raw[pixel + 3] = 0xff;
    }
  }

  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    pngChunk('IHDR', ihdr),
    // `node:zlib`, not `Bun.deflateSync`: measured on Bun 1.4.0, the latter emits
    // RAW deflate even with `windowBits: 15`, and an IDAT stream is zlib-framed.
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A RIFF sub-chunk: `FourCC | uint32le size | payload | pad to even`. */
function riffChunk(fourcc: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(fourcc, 0, 'ascii');
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([
    header,
    payload,
    payload.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0),
  ]);
}

/** `RIFF | uint32le size | <body starting with the "WEBP" FourCC>`. */
function riffContainer(body: Buffer): Buffer {
  const out = Buffer.alloc(8 + body.length);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(body.length, 4);
  body.copy(out, 8);
  return out;
}

/** 24-bit little-endian, the width/height encoding VP8X and ANMF both use. */
function uint24(value: number): Buffer {
  const out = Buffer.alloc(3);
  out.writeUIntLE(value, 0, 3);
  return out;
}

function findRiffChunk(container: Buffer, fourcc: string): Buffer | null {
  let offset = 12; // past `RIFF<size>WEBP`
  while (offset + 8 <= container.length) {
    const id = container.toString('ascii', offset, offset + 4);
    const size = container.readUInt32LE(offset + 4);
    if (id === fourcc) return container.subarray(offset + 8, offset + 8 + size);
    if (size <= 0) break;
    offset += 8 + size + (size % 2);
  }
  return null;
}

const IMAGE_SIZE = 8;
const realPng = buildPng(IMAGE_SIZE);

/**
 * A genuine still WebP — `Bun.Image`'s own encoder output, not a forgery.
 *
 * That matters for one assertion in particular: "a still WebP is still
 * accepted". A hand-forged `RIFF….WEBP` with a junk payload would satisfy the
 * checker by construction and prove nothing about a real encoder's chunk layout.
 * This one round-trips: `Bun.Image(stillWebp).metadata()` reads it back.
 */
const stillWebp = Buffer.from(
  await new Bun.Image(realPng).webp({ quality: 80 }).bytes()
);
const losslessWebp = Buffer.from(
  await new Bun.Image(realPng).webp({ lossless: true }).bytes()
);

/** The compressed frame out of the real still, reused by every forgery below. */
const realFrame = findRiffChunk(stillWebp, 'VP8 ');
if (!realFrame) throw new Error('fixture: the encoder emitted no VP8 chunk');

/** VP8X: `uint8 flags | 3 reserved | uint24 width-1 | uint24 height-1`. */
function vp8xChunk(flags: number): Buffer {
  const payload = Buffer.alloc(10);
  payload[0] = flags;
  uint24(IMAGE_SIZE - 1).copy(payload, 4);
  uint24(IMAGE_SIZE - 1).copy(payload, 7);
  return payload;
}

/** ANIM: `uint32le background | uint16le loop count`. */
const animChunk = (() => {
  const payload = Buffer.alloc(6);
  payload.writeUInt32LE(0xff_ff_ff_ff, 0);
  payload.writeUInt16LE(0, 4); // loop forever
  return payload;
})();

/** ANMF: frame origin, size, duration, flags, then the frame's own chunk. */
const animationFrame = riffChunk(
  'ANMF',
  Buffer.concat([
    uint24(0),
    uint24(0),
    uint24(IMAGE_SIZE - 1),
    uint24(IMAGE_SIZE - 1),
    uint24(100), // duration, ms
    Buffer.from([0]),
    riffChunk('VP8 ', realFrame),
  ])
);

const WEBP_ANIMATION_FLAG = 0x02;

/** Extended-format still: VP8X present, animation bit clear. */
const extendedStillWebp = riffContainer(
  Buffer.concat([
    Buffer.from('WEBP', 'ascii'),
    riffChunk('VP8X', vp8xChunk(0x00)),
    riffChunk('VP8 ', realFrame),
  ])
);

test('the shared dimension reader covers PNG and every WebP encoding', () => {
  expect(findRiffChunk(stillWebp, 'VP8 ')).not.toBeNull();
  expect(findRiffChunk(losslessWebp, 'VP8L')).not.toBeNull();
  expect(findRiffChunk(extendedStillWebp, 'VP8X')).not.toBeNull();

  for (const [mimeType, bytes] of [
    ['image/png', realPng],
    ['image/webp', stillWebp],
    ['image/webp', losslessWebp],
    ['image/webp', extendedStillWebp],
  ] as const)
    expect(rasterDimensions(bytes, mimeType)).toEqual({
      width: IMAGE_SIZE,
      height: IMAGE_SIZE,
    });
});

/** Animated: VP8X with the animation bit, ANIM, two ANMF frames. */
const animatedWebp = riffContainer(
  Buffer.concat([
    Buffer.from('WEBP', 'ascii'),
    riffChunk('VP8X', vp8xChunk(WEBP_ANIMATION_FLAG)),
    riffChunk('ANIM', animChunk),
    animationFrame,
    animationFrame,
  ])
);

/** Animated by an ANIM chunk alone, with no VP8X flag to agree with it. */
const animatedWithoutVp8x = riffContainer(
  Buffer.concat([
    Buffer.from('WEBP', 'ascii'),
    riffChunk('ANIM', animChunk),
    animationFrame,
  ])
);

/** The same animation, behind one zero-length chunk. */
const animatedBehindEmptyChunk = riffContainer(
  Buffer.concat([
    Buffer.from('WEBP', 'ascii'),
    riffChunk('XMP ', Buffer.alloc(0)),
    riffChunk('VP8X', vp8xChunk(WEBP_ANIMATION_FLAG)),
    riffChunk('ANIM', animChunk),
    animationFrame,
  ])
);

/**
 * An APNG: `acTL` before the first `IDAT`, plus one `fcTL`/`fdAT` pair.
 *
 * Built rather than borrowed so the chunk ORDER is the property under test — an
 * `acTL` after `IDAT` is ignored by decoders and must not count as animated.
 */
function buildApng(acTlBeforeIdat: boolean): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(IMAGE_SIZE, 0);
  ihdr.writeUInt32BE(IMAGE_SIZE, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const acTl = Buffer.alloc(8);
  acTl.writeUInt32BE(2, 0); // num_frames
  acTl.writeUInt32BE(0, 4); // num_plays: forever

  const fcTl = Buffer.alloc(26);
  fcTl.writeUInt32BE(0, 0); // sequence number
  fcTl.writeUInt32BE(IMAGE_SIZE, 4);
  fcTl.writeUInt32BE(IMAGE_SIZE, 8);

  const stride = 1 + IMAGE_SIZE * 4;
  const frame = zlib.deflateSync(Buffer.alloc(IMAGE_SIZE * stride));
  const fdAt = Buffer.concat([Buffer.alloc(4), frame]);

  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    pngChunk('IHDR', ihdr),
    ...(acTlBeforeIdat ? [pngChunk('acTL', acTl)] : []),
    pngChunk('fcTL', fcTl),
    pngChunk('IDAT', frame),
    ...(acTlBeforeIdat ? [] : [pngChunk('acTL', acTl)]),
    pngChunk('fdAT', fdAt),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const apng = buildApng(true);
const apngWithLateAcTl = buildApng(false);

/** A GIF header with markup behind it — the classic upload polyglot. */
const gifPolyglot = Buffer.concat([
  Buffer.from('GIF89a', 'ascii'),
  Buffer.from('<script>alert(1)</script>', 'utf8'),
]);

// ─────────────────────────────────────────────────────────────────────────────
// GAP 5 — validateMagicBytes
// ─────────────────────────────────────────────────────────────────────────────

describe('validateMagicBytes fixtures are real images', () => {
  test('the hand-built PNG and the derived WebPs decode', async () => {
    // Without this the rest of the section is circular: it would assert that
    // bytes built to satisfy the checker satisfy the checker.
    expect(await new Bun.Image(realPng).metadata()).toMatchObject({
      width: IMAGE_SIZE,
      height: IMAGE_SIZE,
      format: 'png',
    });
    expect(await new Bun.Image(stillWebp).metadata()).toMatchObject({
      width: IMAGE_SIZE,
      height: IMAGE_SIZE,
      format: 'webp',
    });
    expect(await new Bun.Image(animatedWebp).metadata()).toMatchObject({
      format: 'webp',
    });
  });

  test('the animated forgery is exactly what optimizeImage cannot handle', async () => {
    // The stated reason the branch exists: `Bun.Image` cannot decode animated
    // WebP, so without the refusal this input reaches `optimizeImage` and
    // becomes a 500 four layers down.
    expect(new Bun.Image(animatedWebp).webp().bytes()).rejects.toThrow();
    expect(await new Bun.Image(stillWebp).webp().bytes()).toBeInstanceOf(
      Uint8Array
    );
  });
});

describe('H4 - one side over what WebP can hold', () => {
  // 20 MP, so `MAX_IMAGE_PIXELS` (25 MP) admits it, and ~100 KiB, so the 1 MiB
  // per-file limit admits it too. WebP's ceiling is 16 383 per side, and the
  // encoder's `ERR_IMAGE_ENCODE_FAILED` reached the caller as a 500 — a server
  // fault reported for input the server simply cannot accept.
  const tall = buildPng(1000, 20_000, true);

  test('the fixture really is inside every other limit', async () => {
    expect(tall.length).toBeLessThan(1024 * 1024);
    expect(1000 * 20_000).toBeLessThan(MAX_IMAGE_PIXELS);
    expect(await new Bun.Image(tall).metadata()).toMatchObject({
      width: 1000,
      height: 20_000,
    });
  });

  test('optimizeImage refuses it as 422, from the header', async () => {
    await expect(optimizeImage(tall)).rejects.toMatchObject({
      status: HTTP_STATUS.UNPROCESSABLE,
      message: uploadMsg.edgeTooLong(MAX_IMAGE_EDGE),
    });
  });

  test('a square inside the edge limit still optimises', async () => {
    const out = await optimizeImage(buildPng(64));
    expect(out.format).toBe('webp');
    expect(out.width).toBe(64);
  });

  test('an unattainable byte target is refused instead of returning oversized output', async () => {
    await expect(
      optimizeImage(buildPng(64), { targetSize: 1 })
    ).rejects.toMatchObject({
      status: HTTP_STATUS.UNPROCESSABLE,
      message: uploadMsg.targetUnreachable,
    });
  });

  test('initialWidth is a longest-edge ceiling for portrait output', async () => {
    const out = await optimizeImage(buildPng(100, 300, true), {
      initialWidth: 80,
      minWidth: 20,
      targetSize: 1024 * 1024,
    });
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(80);
  });

  test('encoder admission bounds concurrent work and its queue', async () => {
    const input = buildPng(256, 256, true);
    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, () => optimizeImage(input))
    );
    const rejected = settled.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: {
        status: HTTP_STATUS.SERVICE_UNAVAILABLE,
        message: uploadMsg.processingBusy,
      },
    });
  });
});

describe('validateMagicBytes', () => {
  test('a real PNG passes', () => {
    expect(validateMagicBytes(realPng, 'image/png')).toEqual({ valid: true });
  });

  test('a real still WebP passes', () => {
    expect(validateMagicBytes(stillWebp, 'image/webp')).toEqual({
      valid: true,
    });
  });

  test('SVG is exempt by design, and the sanitiser is what closes the hole', () => {
    // `validateMagicBytes` says yes to any bytes declared `image/svg+xml`,
    // including the polyglot. That is not a defect on its own — the check that
    // runs on this branch is `sanitizeSvgServer` — but the pair only holds if
    // both halves do. Asserted together for that reason.
    expect(validateMagicBytes(gifPolyglot, 'image/svg+xml')).toEqual({
      valid: true,
    });
    expect(validateMagicBytes(Buffer.alloc(0), 'image/svg+xml')).toEqual({
      valid: true,
    });

    expect(clean(gifPolyglot.toString('utf8')).isValid).toBe(false);
    expect(
      clean(
        Buffer.concat([
          Buffer.from('GIF89a', 'ascii'),
          Buffer.from(
            svg('<script>alert(1)</script><rect width="8" height="8"/>')
          ),
        ]).toString('utf8')
      ).isValid
    ).toBe(false);
  });

  test('the bytes decide, not the filename or the extension', () => {
    // A PNG named `.jpg` never reaches this function under a jpeg type —
    // `isAllowedImageType` refuses first — so the assertion that matters is that
    // the verdict is a pure function of the buffer and the declared type. The
    // name is not an argument at all, which is the property being pinned.
    const pngNamedJpg = new File([Uint8Array.from(realPng)], 'photo.jpg', {
      type: 'image/png',
    });
    expect(pngNamedJpg.name.endsWith('.jpg')).toBe(true);
    expect(validateMagicBytes(realPng, pngNamedJpg.type)).toEqual({
      valid: true,
    });

    // The same bytes with a jpeg declaration are refused at the door instead.
    expect(isAllowedImageType('image/jpeg')).toBe(false);
  });

  test('a GIF/<script> polyglot is refused under every raster declaration', () => {
    expect(validateMagicBytes(gifPolyglot, 'image/png')).toEqual({
      valid: false,
    });
    expect(validateMagicBytes(gifPolyglot, 'image/webp')).toEqual({
      valid: false,
    });
    // And `image/gif` never gets that far.
    expect(isAllowedImageType('image/gif')).toBe(false);
  });

  test.each([
    ['PNG truncated mid-signature', 4, 'image/png'],
    ['PNG truncated to one byte', 1, 'image/png'],
    ['WebP truncated to the RIFF FourCC', 4, 'image/webp'],
    ['WebP truncated before the WEBP FourCC', 8, 'image/webp'],
  ] as const)('%s is refused rather than throwing', (_name, length, type) => {
    const source = type === 'image/png' ? realPng : stillWebp;
    expect(validateMagicBytes(source.subarray(0, length), type)).toEqual({
      valid: false,
    });
  });

  test('an empty buffer is refused for every magic-checked type', () => {
    expect(validateMagicBytes(Buffer.alloc(0), 'image/png')).toEqual({
      valid: false,
    });
    expect(validateMagicBytes(Buffer.alloc(0), 'image/webp')).toEqual({
      valid: false,
    });
  });

  test('every type isAllowedImageType admits is magic-checked, or is SVG', () => {
    // The real list, imported rather than restated — a copy here would keep
    // passing for a type added to production and nowhere else, which is exactly
    // the case this invariant exists to catch. The invariant keeps the fail-open
    // default at `upload-helper.ts:102` safe: an allowed type with no signature
    // entry would pass unchecked, silently.
    const admitted = [...ALLOWED_IMAGE_TYPES];

    // The predicate and the list must agree in both directions, or the walk
    // below is over the wrong set.
    for (const type of admitted) expect(isAllowedImageType(type)).toBe(true);
    for (const type of [
      'image/jpeg',
      'image/gif',
      'image/avif',
      'text/html',
      'application/octet-stream',
      '',
    ])
      expect(isAllowedImageType(type)).toBe(false);

    for (const type of admitted) {
      if (type === 'image/svg+xml') continue;
      // Junk bytes must be refused, which is only possible if a signature exists.
      expect(validateMagicBytes(Buffer.alloc(64, 0x41), type)).toEqual({
        valid: false,
      });
    }
  });
});

describe('validateMagicBytes — the animated-WebP branch', () => {
  test('an animated WebP is refused with { valid: false, animated: true }', () => {
    expect(validateMagicBytes(animatedWebp, 'image/webp')).toEqual({
      valid: false,
      animated: true,
    });
  });

  test('an ANIM chunk with no VP8X flag is treated as animated too', () => {
    expect(validateMagicBytes(animatedWithoutVp8x, 'image/webp')).toEqual({
      valid: false,
      animated: true,
    });
  });

  test('a still WebP is still accepted, simple and extended alike', () => {
    // The regression this guards: a chunk walk that over-matches — on `VP8X`
    // presence rather than on the flag bit, say — rejects every extended WebP,
    // and every WebP carrying alpha or an ICC profile is extended. Both shapes
    // are asserted because only one of them has a VP8X chunk at all.
    expect(findRiffChunk(stillWebp, 'VP8X')).toBeNull();
    expect(findRiffChunk(extendedStillWebp, 'VP8X')).not.toBeNull();

    expect(validateMagicBytes(stillWebp, 'image/webp')).toEqual({
      valid: true,
    });
    expect(validateMagicBytes(extendedStillWebp, 'image/webp')).toEqual({
      valid: true,
    });
  });

  test('a PNG declared image/webp is refused with `animated` ABSENT', () => {
    const verdict = validateMagicBytes(realPng, 'image/webp');

    expect(verdict).toEqual({ valid: false });
    // `toEqual` treats `{ animated: undefined }` as equal to `{}`, and the
    // handler branches on truthiness, so the key's absence is asserted directly.
    expect('animated' in verdict).toBe(false);
    expect(verdict.animated).toBeUndefined();
  });

  test('the two rejection reasons produce two different messages', () => {
    // The consequence the branch exists for: `handler.ts:127-133` picks the
    // message off `magicValidation.animated`. If a content mismatch carried
    // `animated: true`, a user uploading a mislabelled PNG would be told their
    // still image is an animation.
    const messageFor = (buffer: Buffer) => {
      const verdict = validateMagicBytes(buffer, 'image/webp');
      return verdict.animated
        ? uploadMsg.animatedNotAllowed('f.webp')
        : uploadMsg.contentMismatch('f.webp');
    };

    expect(messageFor(animatedWebp)).toBe(
      uploadMsg.animatedNotAllowed('f.webp')
    );
    expect(messageFor(realPng)).toBe(uploadMsg.contentMismatch('f.webp'));
    expect(messageFor(animatedWebp)).not.toBe(messageFor(realPng));
  });

  test('a truncated animated WebP does not throw', () => {
    // The chunk walk reads `readUInt32LE(offset + 4)` and indexes
    // `buffer[offset + 8]`; a buffer that ends inside a chunk header must not
    // become a `RangeError` four layers below the route.
    for (let length = 12; length <= animatedWebp.length; length += 3)
      expect(() =>
        validateMagicBytes(animatedWebp.subarray(0, length), 'image/webp')
      ).not.toThrow();
  });

  test('a chunk declaring a size past the end of the buffer does not throw', () => {
    const header = Buffer.alloc(8);
    header.write('VP8 ', 0, 'ascii');
    header.writeUInt32LE(0xff_ff_ff_f0, 4);
    const lying = riffContainer(
      Buffer.concat([Buffer.from('WEBP', 'ascii'), header, Buffer.alloc(8)])
    );

    expect(() => validateMagicBytes(lying, 'image/webp')).not.toThrow();
  });

  test('a zero-length chunk before VP8X does not hide the animation flag', () => {
    // The walk used to bail on the first `size <= 0` chunk, so one empty (and
    // legal) `XMP ` ahead of VP8X made the animation flag unreachable: the file
    // was admitted as a still and then rejected by `optimizeImage` as corrupt,
    // with a generic 422 instead of the animation-specific 400 this branch
    // exists to provide.
    expect(validateMagicBytes(animatedBehindEmptyChunk, 'image/webp')).toEqual({
      valid: false,
      animated: true,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateMagicBytes — the APNG branch. Same policy as WebP, and it has to be:
// an APNG is conventionally named `.png` and declared `image/png`, so before
// this it was admitted and silently flattened to its first frame with a 200.
// ─────────────────────────────────────────────────────────────────────────────

describe('validateMagicBytes — the animated-PNG branch', () => {
  test('an APNG is refused with { valid: false, animated: true }', () => {
    expect(validateMagicBytes(apng, 'image/png')).toEqual({
      valid: false,
      animated: true,
    });
  });

  test('a still PNG is still accepted', () => {
    expect(validateMagicBytes(realPng, 'image/png')).toEqual({ valid: true });
  });

  test('an acTL AFTER the first IDAT is not animation', () => {
    // Position is the rule, not presence: a decoder ignores `acTL` there, so
    // treating it as animated would refuse a still PNG carrying a stray chunk.
    expect(validateMagicBytes(apngWithLateAcTl, 'image/png')).toEqual({
      valid: true,
    });
  });

  test('a truncated APNG does not throw', () => {
    for (let length = 8; length <= apng.length; length += 3)
      expect(() =>
        validateMagicBytes(apng.subarray(0, length), 'image/png')
      ).not.toThrow();
  });

  test('a PNG chunk declaring a size past the end of the buffer does not throw', () => {
    const lying = Buffer.concat([
      Buffer.from(PNG_SIGNATURE),
      (() => {
        const header = Buffer.alloc(8);
        header.writeUInt32BE(0xff_ff_ff_f0, 0);
        header.write('tEXt', 4, 'ascii');
        return header;
      })(),
      Buffer.alloc(8),
    ]);

    expect(() => validateMagicBytes(lying, 'image/png')).not.toThrow();
  });

  test('every admitted raster format is covered by an animation check', () => {
    // The class this finding was an instance of: three formats admitted, all
    // three with a standard animation form, and only one checked. SVG is the
    // exemption — it carries no magic bytes and `sanitizeSvg` refuses its
    // animation elements instead.
    const rasterTypes = ALLOWED_IMAGE_TYPES.filter(
      (type) => type !== 'image/svg+xml'
    );

    expect(rasterTypes.length).toBeGreaterThan(0);
    for (const type of rasterTypes) {
      const animatedFixture = type === 'image/png' ? apng : animatedWebp;
      expect(validateMagicBytes(animatedFixture, type)).toEqual({
        valid: false,
        animated: true,
      });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The per-user upload budget, in megapixels
// ─────────────────────────────────────────────────────────────────────────────

describe('the upload budget is charged in megapixels', () => {
  /**
   * The unit the limiter spends, and the two ceilings it derives.
   *
   * The budget is a MEGAPIXEL count, not a request count, because the encoder is
   * process-global and serialized while `MAX_IMAGE_PIXELS` admits 25 MP — so a
   * request count sized for thumbnails is 91 s of exclusive encoder demand per
   * minute when every request is a pixel bomb. Neither number had an assertion,
   * and between them they decide both ceilings.
   */
  test('one request costs at least the floor, so the request ceiling is explicit', () => {
    // `BUDGET / UNIT` is the per-user request rate, whatever the pixels. At a
    // floor of 1 it was 100/min — a silent five-fold widening of a limit nobody
    // meant to move, because most uploads are far under a megapixel and an SVG
    // never reaches `measureEncodeCost` at all.
    expect(UPLOAD_MEGAPIXEL_BUDGET / UPLOAD_REQUEST_UNIT).toBe(20);
  });

  test('a maximum-size image still fits in one window', () => {
    // `rateLimit` refuses `cost > limit` WITHOUT a write, so a budget under the
    // cost of one legal upload is a permanent 429 rather than a slow path.
    // `app/api/upload/image/handler.ts` throws at load if this stops holding;
    // importing it above is what runs that check, and this states the number.
    const worstCase = Math.max(
      UPLOAD_REQUEST_UNIT,
      Math.ceil(MAX_IMAGE_PIXELS / 1_000_000)
    );

    expect(worstCase).toBeLessThanOrEqual(UPLOAD_MEGAPIXEL_BUDGET);
    // And the worst case really is bounded: four such uploads per window.
    expect(Math.floor(UPLOAD_MEGAPIXEL_BUDGET / worstCase)).toBe(4);
  });

  test.each([
    ['a thumbnail', 8, 8, 1],
    ['exactly one megapixel', 1000, 1000, 1],
    ['just over one megapixel', 1001, 1000, 2],
    ['four megapixels', 2000, 2000, 4],
  ])(
    '%s costs %s units',
    async (_label, width, height, expected) => {
      // Rounded UP and floored at one: a fractional charge would let a stream of
      // sub-megapixel requests cost nothing.
      const png = buildPng(width, height, true);
      expect(await measureEncodeCost(png)).toBe(expected);
    },
    30_000
  );

  test('the cost comes from the HEADER, not from a decode', async () => {
    // The reason it can run before the encoder slot is taken. A PNG truncated to
    // its IHDR costs exactly what the whole file costs, while ENCODING the same
    // bytes fails — so the charge demonstrably never decoded a pixel.
    const full = buildPng(1200, 900, true);
    const headerOnly = full.subarray(0, 100);

    expect(await measureEncodeCost(full)).toBe(2);
    expect(await measureEncodeCost(headerOnly)).toBe(2);
    expect(new Bun.Image(headerOnly).webp().bytes()).rejects.toThrow();
  }, 30_000);

  test('a pixel bomb is refused here rather than inside the encoder', async () => {
    // `MAX_IMAGE_PIXELS` is enforced by `Bun.Image`'s own `maxPixels`, which
    // `measureEncodeCost` passes — so the rejection lands before the request is
    // charged and before it queues for the encoder.
    const edge = Math.ceil(Math.sqrt(MAX_IMAGE_PIXELS)) + 1;
    const bomb = buildPng(edge, edge, true);

    expect(measureEncodeCost(bomb)).rejects.toMatchObject({
      status: HTTP_STATUS.UNPROCESSABLE,
      message: uploadMsg.tooManyPixels(
        Math.floor(MAX_IMAGE_PIXELS / 1_000_000)
      ),
    });
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// A raster inlined into an SVG obeys the same policy as one uploaded directly
// ─────────────────────────────────────────────────────────────────────────────

describe('an inline data: raster is held to the upload policy', () => {
  const inline = (mimeType: string, bytes: Buffer) =>
    svg(
      `<image width="8" height="8" href="data:${mimeType};base64,${bytes.toString('base64')}"/>`
    );

  test.each([
    ['a still PNG', 'image/png', () => realPng],
    ['a still WebP', 'image/webp', () => stillWebp],
  ])('%s survives', (_label, mimeType, bytes) => {
    // The capability this allowance exists for: a legitimately inlined bitmap.
    const result = clean(inline(mimeType, bytes()));

    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).toInclude('data:');
  });

  test.each([
    ['an APNG', 'image/png', () => apng],
    ['an animated WebP', 'image/webp', () => animatedWebp],
  ])(
    '%s is REFUSED with the same reason the direct upload gives',
    (_label, mimeType, bytes) => {
      // The class: `removeRasterImages` matched `xlink:href` only (svgo 4.1.0), so
      // the modern spelling stored and served an animated raster from the public
      // bucket while the same bytes uploaded directly were refused by the byte
      // checks. Both boundaries read the same predicate now.
      expect(validateMagicBytes(bytes(), mimeType)).toEqual({
        valid: false,
        animated: true,
      });

      // Refused, NOT stripped — and that is the half a security fix alone would
      // have missed. Stripping answers 200 with the picture silently gone, which
      // is verbatim the failure `ANIMATION_ELEMENTS` refuses rather than strips
      // and the one the APNG byte check exists to remove. The bytes never
      // reached the bucket either way; the policy did not answer the same twice.
      const result = clean(inline(mimeType, bytes()));
      expect(result.isValid).toBe(false);
      expect(result.reason).toBe('animated');
      expect(result.cleanedSvg).toBe('');
    }
  );

  test('all three routes animation takes answer alike', () => {
    // Uploaded directly, declared with SMIL, or inlined on a reference — one
    // policy, one disposition. `processImage` maps `reason: 'animated'` to the
    // same `animatedNotAllowed` message the byte check produces.
    expect(validateMagicBytes(apng, 'image/png')).toMatchObject({
      valid: false,
      animated: true,
    });
    expect(
      clean(svg('<rect><animate attributeName="x"/></rect>'))
    ).toMatchObject({ isValid: false, reason: 'animated' });
    expect(clean(inline('image/png', apng))).toMatchObject({
      isValid: false,
      reason: 'animated',
    });
  });

  test('a type the upload route does not admit is stripped, not refused', () => {
    // The OTHER axis, and it keeps the reference answer. GIF is not in
    // `ALLOWED_IMAGE_TYPES`, so it is refused for its TYPE — exactly as an
    // `https:` reference is — and its bytes are never reached, which is why an
    // animated GIF is stripped here where an APNG is refused. Stripping an
    // unsupported reference is the contract every other unsupported reference
    // in this file gets.
    const gif = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64');
    expect(isAllowedImageType('image/gif')).toBe(false);

    const result = clean(inline('image/gif', gif));
    expect(result.isValid).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.cleanedSvg).not.toInclude('data:');
  });

  test('a payload that is not what it declares is stripped', () => {
    // A declared type nothing verifies is the same hole the magic-byte check
    // closes on the direct path. Stripped rather than refused: a mismatched
    // payload is a broken reference, not an animated upload.
    const result = clean(inline('image/png', stillWebp));

    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).not.toInclude('data:');
  });

  test('a signature without readable dimensions is stripped', () => {
    const result = clean(inline('image/png', Buffer.from(PNG_SIGNATURE)));

    expect(result.isValid).toBe(true);
    expect(result.cleanedSvg).not.toInclude('data:');
  });

  test('svgo does not delete a raster the sanitiser kept', () => {
    // `removeRasterImages` used to answer this question by attribute SPELLING —
    // deleting an `xlink:href` bitmap and keeping the identical `href` one. The
    // sanitiser is the single authority now, so the post-svgo bytes have to
    // agree with it.
    const result = clean(inline('image/png', realPng));
    expect(result.isValid).toBe(true);

    const stored = svgOptimizerServer({ data: result.cleanedSvg });
    expect(stored).toInclude('data:image/png;base64,');
  });

  /**
   * Dimensions come out of the header, so a fixture needs a real IHDR and
   * nothing else — `buildPng` would allocate the raster, and 25 MP of RGBA is
   * 100 MB for a test that never decodes a pixel.
   */
  const pngHeader = (width: number, height: number) => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return Buffer.concat([
      Buffer.from(PNG_SIGNATURE),
      pngChunk('IHDR', ihdr),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
  };

  test.each([
    [
      'over MAX_IMAGE_PIXELS',
      5001,
      5001,
      'too-many-pixels',
      uploadMsg.tooManyPixels(Math.floor(MAX_IMAGE_PIXELS / 1_000_000)),
    ],
    [
      'over MAX_IMAGE_EDGE',
      MAX_IMAGE_EDGE + 1,
      2,
      'edge-too-long',
      uploadMsg.edgeTooLong(MAX_IMAGE_EDGE),
    ],
  ] as const)(
    'an inline raster %s is refused, as the direct path refuses it',
    (_label, width, height, reason, message) => {
      // The gap this closes: the direct path answers 422 on these bytes while
      // wrapping them in an SVG stored them, so the SVG was a way to pay the
      // floor for a raster the pixel ceiling exists to reject.
      const result = clean(inline('image/png', pngHeader(width, height)));

      expect(result.isValid).toBe(false);
      expect(result.reason).toBe(reason);

      const logged = spyOn(console, 'error').mockImplementation(() => {});
      try {
        validateSvgUpload(
          Buffer.from(inline('image/png', pngHeader(width, height))),
          'bomb.svg'
        );
        throw new Error('expected validateSvgUpload to reject');
      } catch (error) {
        expect(error).toMatchObject({
          status: HTTP_STATUS.UNPROCESSABLE,
          message,
        });
      } finally {
        logged.mockRestore();
      }
    }
  );

  test('a legal inline raster survives, and is charged its megapixels', () => {
    const document = inline('image/png', pngHeader(4000, 4000));

    expect(4000 * 4000).toBeLessThan(MAX_IMAGE_PIXELS);
    expect(clean(document).isValid).toBe(true);
    const result = clean(document);
    expect(result.isValid).toBe(true);
    if (!result.isValid) throw new Error('expected valid SVG');
    expect(result.embeddedRasterMegapixels).toBe(16);
  });

  test('XML character references cannot hide an admitted raster from metering', () => {
    const escaped = inline('image/png', pngHeader(4000, 4000)).replace(
      'data:image/png;base64,',
      'data:image/png&#59;base64,'
    );
    const result = clean(escaped);

    expect(result.isValid).toBe(true);
    if (!result.isValid) throw new Error('expected valid SVG');
    expect(result.cleanedSvg).toInclude('data:image/png;base64,');
    expect(result.embeddedRasterMegapixels).toBe(16);
  });

  test('every embedded raster is charged, not just the first', () => {
    // The flat floor priced all three the same as an empty icon.
    const three = svg(
      `<image href="data:image/png;base64,${pngHeader(2000, 2000).toString('base64')}"/>`.repeat(
        3
      )
    );

    const result = clean(three);
    expect(result.isValid).toBe(true);
    if (!result.isValid) throw new Error('expected valid SVG');
    expect(result.embeddedRasterMegapixels).toBe(12);
  });

  test('the aggregate embedded pixels cannot exceed the one-file ceiling', () => {
    const aggregateBomb = svg(
      `<image href="data:image/png;base64,${pngHeader(4000, 4000).toString('base64')}"/>`.repeat(
        2
      )
    );

    const result = clean(aggregateBomb);
    expect(result.isValid).toBe(false);
    expect(result.reason).toBe('too-many-pixels');
  });

  test('a document with no raster is charged nothing', () => {
    const result = clean(svg('<path d="M0 0h8v8H0z"/>'));
    expect(result.isValid).toBe(true);
    if (!result.isValid) throw new Error('expected valid SVG');
    expect(result.embeddedRasterMegapixels).toBe(0);
  });
});
