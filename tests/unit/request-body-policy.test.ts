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

import {
  buildRequestMeta,
  MAX_JSON_BODY_BYTES,
  MAX_REQUEST_BODY_BYTES,
  withBodyPolicy,
} from '@/lib/http/request';

import { HTTP_STATUS } from '@/utils/api-messages';

const BOUNDARY = 'X';
const MULTIPART_BODY =
  `--${BOUNDARY}\r\n` +
  'Content-Disposition: form-data; name="files"\r\n\r\n' +
  `hello\r\n--${BOUNDARY}--\r\n`;

const multipartRequest = (contentType: string) =>
  new Request('http://localhost/api/upload/file?resource=users', {
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

describe('a JSON route is bounded independently of the server-wide ceiling', () => {
  /**
   * `MAX_REQUEST_BODY_BYTES` is 12 MiB for ONE route shape — a 10 MB document
   * plus multipart framing — and every JSON route used to inherit it, although
   * no JSON schema here admits more than kilobytes. `JSON.parse` is
   * synchronous, so the cost is a stall of the whole process: measured on this
   * runtime, 9.5 MiB of many small keys took 446 ms against 10 ms for the same
   * byte count as one long string. Bounding the JSON reader is what keeps the
   * 12 MiB budget with multipart, where it is actually needed.
   */
  const jsonBody = (bytes: number) =>
    JSON.stringify({ a: 'x'.repeat(Math.max(0, bytes - 8)) });

  const post = (body: BodyInit) =>
    new Request('http://localhost/api/dash/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

  const readWith = (request: Request, maxBytes?: number) =>
    withBodyPolicy(buildRequestMeta(request), 'json', maxBytes).readJson();

  const expectTooLarge = async (promise: Promise<unknown>) => {
    // 413, not the `null` a malformed body produces: a correct document that is
    // merely too big must not be reported as unparseable.
    expect(promise).rejects.toMatchObject({
      status: HTTP_STATUS.CONTENT_TOO_LARGE,
    });
  };

  test('a body at the ceiling is still read', async () => {
    const body = jsonBody(MAX_JSON_BODY_BYTES);
    expect(body.length).toBeLessThanOrEqual(MAX_JSON_BODY_BYTES);
    expect(await readWith(post(body))).toBeObject();
  });

  test('a body over the ceiling is 413', async () => {
    await expectTooLarge(readWith(post(jsonBody(MAX_JSON_BODY_BYTES + 4096))));
  });

  test('a route may raise its own ceiling and is still bounded by it', async () => {
    const raised = MAX_JSON_BODY_BYTES * 4;
    expect(await readWith(post(jsonBody(raised - 4096)), raised)).toBeObject();
    await expectTooLarge(readWith(post(jsonBody(raised + 4096)), raised));
  });

  /**
   * The half a `Content-Length` check alone does not cover, and the only half a
   * caller who wants to bypass the ceiling would use: a chunked request
   * declares no length, so the count has to happen while the stream is read.
   */
  test('a chunked body with no Content-Length is bounded too', async () => {
    const bytes = new TextEncoder().encode(jsonBody(MAX_JSON_BODY_BYTES * 4));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += 65_536)
          controller.enqueue(bytes.slice(at, at + 65_536));
        controller.close();
      },
    });
    const request = new Request('http://localhost/api/dash/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    } as RequestInit);

    expect(request.headers.get('content-length')).toBeNull();
    await expectTooLarge(readWith(request));
  });

  test('multipart keeps the 12 MiB budget the JSON cap does not touch', () => {
    expect(MAX_REQUEST_BODY_BYTES).toBe(12 * 1024 * 1024);
    expect(MAX_JSON_BODY_BYTES).toBeLessThan(MAX_REQUEST_BODY_BYTES);
  });
});
