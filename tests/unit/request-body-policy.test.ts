/**
 * `withBodyPolicy` — the seam that decides which parser a route may use, and the
 * only place the media-type matcher is exercised end to end against the runtime
 * parser it hands the body to.
 *
 * The mixed-case multipart case is version-gated and that is why it is pinned
 * here rather than reasoned about: up to Bun 1.3.14 `Request.formData()` matched
 * `form-data` case-SENSITIVELY and threw on `Multipart/Form-Data`, so a
 * spec-valid request the matcher admitted was refused one layer down. Bun 1.4.0
 * made the parser case-insensitive, and 1.4.0 is the floor `server.ts` asserts —
 * so a regression below that floor breaks a real request, and this is what says
 * so instead of leaving it to be inferred from a comment.
 */
import { describe, expect, test } from 'bun:test';

import { buildRequestMeta, withBodyPolicy } from '@/lib/http/request';

const BOUNDARY = 'X';
const MULTIPART_BODY =
  `--${BOUNDARY}\r\n` +
  'Content-Disposition: form-data; name="files"\r\n\r\n' +
  `hello\r\n--${BOUNDARY}--\r\n`;

const multipartRequest = (contentType: string) =>
  new Request('http://localhost/api/upload/image?resource=users', {
    method: 'POST',
    headers: { 'content-type': `${contentType}; boundary=${BOUNDARY}` },
    body: MULTIPART_BODY,
  });

const jsonRequest = (contentType: string) =>
  new Request('http://localhost/api/dash/users', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: JSON.stringify({ a: 1 }),
  });

const input = (request: Request, policy: 'json' | 'multipart' | 'none') =>
  withBodyPolicy(buildRequestMeta(request), policy);

describe('a multipart route accepts every spelling of its media type', () => {
  test.each([
    ['multipart/form-data'],
    ['Multipart/Form-Data'],
    ['MULTIPART/FORM-DATA'],
    ['multipart/form-data '],
  ])('%p parses', async (contentType) => {
    const form = await input(
      multipartRequest(contentType),
      'multipart'
    ).readFormData();

    expect(form).not.toBeNull();
    expect(form?.get('files')).toBe('hello');
  });

  test('a non-multipart type is not readable as a form', async () => {
    expect(
      await input(jsonRequest('application/json'), 'multipart').readFormData()
    ).toBeNull();
  });
});

describe('a json route accepts every spelling of its media type', () => {
  test.each([
    ['application/json'],
    ['Application/JSON'],
    ['application/json; charset=utf-8'],
  ])('%p parses', async (contentType) => {
    expect(await input(jsonRequest(contentType), 'json').readJson()).toEqual({
      a: 1,
    });
  });

  test('a near-miss subtype is refused rather than matched by substring', async () => {
    expect(
      await input(jsonRequest('application/jsonx'), 'json').readJson()
    ).toBeNull();
  });
});

describe('the policy, not the client, chooses the parser', () => {
  test('a json route cannot be made to parse multipart', async () => {
    const ctx = input(multipartRequest('multipart/form-data'), 'json');

    expect(await ctx.readFormData()).toBeNull();
    expect(await ctx.readJson()).toBeNull();
  });

  test('a multipart route cannot be made to parse json', async () => {
    const ctx = input(jsonRequest('application/json'), 'multipart');

    expect(await ctx.readJson()).toBeNull();
    expect(await ctx.readFormData()).toBeNull();
  });

  test("policy 'none' reads nothing at all", async () => {
    const ctx = input(jsonRequest('application/json'), 'none');

    expect(await ctx.readJson()).toBeNull();
    expect(await ctx.readFormData()).toBeNull();
  });

  test('a GET carrying a body still reads nothing', async () => {
    const ctx = withBodyPolicy(
      buildRequestMeta(
        new Request('http://localhost/api/dash/users', {
          headers: { 'content-type': 'application/json' },
        })
      ),
      'json'
    );

    expect(await ctx.readJson()).toBeNull();
  });
});

describe('a body reads once', () => {
  test('a second read returns the first result rather than throwing', async () => {
    const ctx = input(jsonRequest('application/json'), 'json');

    expect(await ctx.readJson()).toEqual({ a: 1 });
    // A web `Request` body reads exactly once; without the memoisation this
    // rejects with `Body has already been used`.
    expect(await ctx.readJson()).toEqual({ a: 1 });
  });

  test('a malformed body is null both times, not a throw', async () => {
    const ctx = input(
      new Request('http://localhost/api/dash/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ not json',
      }),
      'json'
    );

    expect(await ctx.readJson()).toBeNull();
    expect(await ctx.readJson()).toBeNull();
  });
});
