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
 * **Two `test.failing` groups record live defects, not flaky tests.** They are
 * findings 2 and 14 of `reports/claude-opus-autonomous-audit.md`, each asserted
 * in the direction a fix would take it, so the suite stays green while the
 * defect stands and Bun flags the test the moment it is fixed. Read them before
 * adding anything to this file. (Findings 12 and 13 were the same shape and are
 * now fixed — see `describe('external references in SVG')`.)
 */
import { describe, expect, test } from 'bun:test';
import zlib from 'node:zlib';

import { uploadMsg } from '@/app/api/upload/image/messages';
import { optimizeImage } from '@/lib/r2/optimize-image';
import {
  ALLOWED_IMAGE_TYPES,
  isAllowedImageType,
  validateMagicBytes,
} from '@/lib/r2/upload-helper';

import { HTTP_STATUS } from '@/utils/api-messages';
import {
  DANGEROUS_ATTRIBUTES,
  DANGEROUS_ELEMENTS,
  isDangerousValue,
  safeDecodeURI,
  SVG_MAX_ELEMENTS,
} from '@/utils/images/config';
import { sanitizeSvgServer, svgOptimizerServer } from '@/utils/images/server';
import { sanitizeSvg, validateSvgFile } from '@/utils/images/svg-optimizer';
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
      '<image width="8" height="8" href="data:image/png;base64,iVBORw0KGgo="/>'
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
});

// ─────────────────────────────────────────────────────────────────────────────
// GAP 4 — validateSvgFile
// ─────────────────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

describe('validateSvgFile', () => {
  test('refuses a missing file', () => {
    expect(validateSvgFile(undefined as unknown as File)).not.toBeNull();
  });

  test('refuses a file that is neither typed nor named as an SVG', () => {
    const wrong = new File([PNG_SIGNATURE], 'payload.png', {
      type: 'image/png',
    });
    expect(validateSvgFile(wrong)).not.toBeNull();
  });

  test('accepts up to the cap and refuses one byte past it', () => {
    const at = new File([new Uint8Array(SVG_SIZE_CAP)], 'a.svg', {
      type: 'image/svg+xml',
    });
    const over = new File([new Uint8Array(SVG_SIZE_CAP + 1)], 'a.svg', {
      type: 'image/svg+xml',
    });

    expect(validateSvgFile(at)).toBeNull();
    expect(validateSvgFile(over)).not.toBeNull();
  });

  test.failing('DEFECT: a non-SVG carrying an .svg name is refused', () => {
    // It is not. `validateSvgFile` reads `file.type`, `file.name` and
    // `file.size` and never opens the file, so PNG bytes named `payload.svg`
    // return `null` — accepted — under either declared type.
    //
    // Not currently exploitable, and the reason is the next test: nothing calls
    // this on the server path, and the content check that does run refuses the
    // same input. It is asserted because `reports/test-strategy.md:1274` claims
    // this function performs the check, and a future caller trusting that claim
    // is the hazard.
    expect(
      validateSvgFile(
        new File([PNG_SIGNATURE], 'payload.svg', { type: 'image/svg+xml' })
      )
    ).not.toBeNull();
  });

  test('the content check that actually refuses it is the sanitiser', () => {
    // `processImage` decodes the buffer as UTF-8 and hands it to
    // `sanitizeSvgServer` (`upload-helper.ts:205-213`); no `<svg` substring
    // means a 400, whatever the name said.
    const asText = Buffer.from(PNG_SIGNATURE).toString('utf8');

    const result = clean(asText);
    expect(result.isValid).toBe(false);
    expect(result.cleanedSvg).toBe('');
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

  test.failing(
    'DEFECT: a zero-length chunk before VP8X does not hide the animation flag',
    () => {
      // `isAnimatedWebp` bails the walk on the first `size <= 0` chunk, so one
      // empty (and legal) chunk ahead of VP8X makes the animation flag
      // unreachable and the file is accepted as a still. It then reaches
      // `optimizeImage`, which rejects it as corrupt with a generic 422 instead
      // of the animation-specific 400 this branch exists to provide.
      //
      // Fix shape: skip a zero-length chunk (`offset += 8`) instead of returning.
      expect(
        validateMagicBytes(animatedBehindEmptyChunk, 'image/webp')
      ).toEqual({ valid: false, animated: true });
    }
  );
});
