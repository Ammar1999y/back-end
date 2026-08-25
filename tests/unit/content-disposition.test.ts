/**
 * `getContentDisposition` — RFC 6266 conformance.
 *
 * The header used to interpolate the filename straight into `filename="…"`. A
 * header value travels as Latin-1, so a non-ASCII name did not survive, and it
 * did not survive *consistently*: measured in `bench/s3`, `@aws-sdk/client-s3`
 * replaces each non-ASCII code point with `U+FFFD` while Bun's S3 client sends
 * the raw UTF-8 bytes. Two clients, two different stored headers, neither of them
 * the filename. Reachable from an ordinary upload, because `sanitizeFilename`
 * keeps `\p{L}` and `uploadImagesToR2` feeds the resulting key straight into this
 * function.
 *
 * The value is also caller-supplied, and this is a header: `"`, `\`, CR and LF
 * are asserted below because a `Content-Disposition` built from an unsanitised
 * name is a response-splitting primitive, not merely a cosmetic problem.
 */
import { describe, expect, test } from 'bun:test';

import { getContentDisposition } from '@/lib/r2/client';

import { sanitizeFilename } from '@/utils/sanitize-filename';

/** Everything after `filename*=UTF-8''`. */
const extValue = (header: string) =>
  /filename\*=UTF-8''(.*)$/.exec(header)?.[1] ?? '';

/** The quoted `filename="…"` parameter. */
const asciiValue = (header: string) =>
  /filename="([^"]*)"/.exec(header)?.[1] ?? '';

describe('shape', () => {
  test('attachment by default, inline on request', () => {
    expect(getContentDisposition({ filename: 'a.webp' })).toStartWith(
      'attachment; '
    );
    expect(
      getContentDisposition({ filename: 'a.webp', inline: true })
    ).toStartWith('inline; ');
  });

  test('both parameters are always present', () => {
    const header = getContentDisposition({ filename: 'photo name (1).webp' });
    expect(header).toBe(
      'attachment; filename="photo name (1).webp"; ' +
        "filename*=UTF-8''photo%20name%20%281%29.webp"
    );
  });
});

describe('the ASCII parameter', () => {
  test('is pure ASCII even when the filename is not', () => {
    const header = getContentDisposition({ filename: 'Ünïcode nàme.webp' });

    expect(asciiValue(header)).toBe('_n_code n_me.webp');
    // The whole header, not just the parameter: a single non-ASCII code point
    // anywhere in it is what the two S3 clients disagreed about.
    for (const character of header)
      expect((character.codePointAt(0) ?? 0) < 0x80).toBe(true);
  });

  test('never contains a quote or a backslash that could end the parameter early', () => {
    const header = getContentDisposition({
      filename: String.raw`a"b\c.webp`,
    });

    expect(asciiValue(header)).toBe('abc.webp');
    // One `filename="…"` parameter, not two fragments a parser could re-split.
    expect(header.match(/"/g)).toHaveLength(2);
  });

  test('never contains CR or LF, so the value cannot become a second header', () => {
    // The security assertion. `sanitizeFilename` strips these today, but this
    // function is exported and takes a `string`, so it cannot rely on that.
    //
    // `x-injected: 1` still appears as literal text inside the quoted parameter,
    // which is correct and harmless — a header is split on CRLF, not on a colon.
    // What matters is that the whole value is one line and stays inside the
    // quotes.
    const header = getContentDisposition({
      filename: 'a\r\nx-injected: 1\r\n\r\nbody.webp',
    });

    expect(header).not.toMatch(/[\r\n]/);
    expect(asciiValue(header)).toBe('ax-injected: 1body.webp');
    expect(header.match(/"/g)).toHaveLength(2);
  });

  test('falls back to a name rather than an empty parameter', () => {
    // `filename=""` is accepted by parsers and produces a nameless download.
    expect(asciiValue(getContentDisposition({ filename: '日本語' }))).toBe(
      '___'
    );
    expect(asciiValue(getContentDisposition({ filename: '\r\n' }))).toBe(
      'download'
    );
    expect(asciiValue(getContentDisposition({ filename: '' }))).toBe(
      'download'
    );
  });
});

describe('the filename* parameter', () => {
  test('round-trips the real name, non-ASCII included', () => {
    const filename = 'Ünïcode nàme (1).webp';
    const header = getContentDisposition({ filename });

    expect(decodeURIComponent(extValue(header))).toBe(filename);
  });

  test('percent-encodes every character RFC 5987 excludes from attr-char', () => {
    // `encodeURIComponent` leaves `!'()*` alone and only `!` is an attr-char, so
    // the previous implementation emitted an invalid ext-value for any filename
    // with a parenthesis — which `sanitizeFilename` permits.
    expect(extValue(getContentDisposition({ filename: "(a)'b*c.webp" }))).toBe(
      '%28a%29%27b%2Ac.webp'
    );
    // attr-chars that must NOT be escaped, or the name changes.
    expect(
      extValue(getContentDisposition({ filename: 'a!#$&+-.^_`|~z' }))
    ).toBe('a!#$&+-.^_`|~z');
  });

  test('encodes CR and LF rather than passing them through', () => {
    expect(extValue(getContentDisposition({ filename: 'a\r\nb' }))).toBe(
      'a%0D%0Ab'
    );
  });
});

describe('the path an upload actually takes', () => {
  test('a sanitised filename survives both parameters unchanged', () => {
    // `generateTempImageKey` builds `temp/<id>_<sanitizeFilename(name)>.<ext>`
    // and `uploadImagesToR2` passes that basename here.
    const sanitized = sanitizeFilename('My Photo (1).PNG');
    const header = getContentDisposition({
      filename: `0f1e2d3c4b5a6978_${sanitized}.webp`,
      inline: true,
    });

    expect(sanitized).toBe('My Photo (1)');
    expect(asciiValue(header)).toBe('0f1e2d3c4b5a6978_My Photo (1).webp');
    expect(decodeURIComponent(extValue(header))).toBe(
      '0f1e2d3c4b5a6978_My Photo (1).webp'
    );
  });

  test('a non-ASCII upload name reaches here intact and leaves ASCII-safe', () => {
    const sanitized = sanitizeFilename('Ünïcode nàme.png');
    expect(sanitized).toBe('Ünïcode nàme');

    const header = getContentDisposition({ filename: `${sanitized}.webp` });
    expect(header).not.toMatch(/[^ -~]/);
    expect(decodeURIComponent(extValue(header))).toBe('Ünïcode nàme.webp');
  });
});
