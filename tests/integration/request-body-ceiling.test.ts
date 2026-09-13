/**
 * The JSON body ceiling, at the boundary rather than at the reader.
 *
 * `readBoundedText` bounds the routes it reads for, which is every route in the
 * table — and not `/api/auth/*`, which hands the raw `Request` to
 * `auth.handler`. Those endpoints kept the server-wide `maxRequestBodySize`
 * (12 MiB), in front of the captcha plugin and the pre-auth limiter, and they
 * are the amplification surface: `/sign-in/email`, `/two-factor/verify-*`,
 * `/passkey/verify-registration`, `/reauth/*`. The bound is now a property of the
 * REQUEST rather than of the reader a route happens to use: `app.ts`'s
 * `onRequest` refuses a declared over-size body from the head alone, whatever
 * serves it, and the prefix that hands the request on reads it through the same
 * ceiling for the chunked case that declares no length.
 *
 * What each case here proves that a unit test cannot: the refusal happens
 * BEFORE the request reaches the mount. The captcha plugin performs an outbound
 * Turnstile call, so its absence from the egress log is the evidence — a 413
 * issued after the plugin ran would look identical from the status alone.
 */
import { describe, expect, test } from 'bun:test';

import { app } from '@/app';
import {
  MAX_JSON_BODY_BYTES,
  MAX_REQUEST_BODY_BYTES,
} from '@/lib/http/request';

import { HTTP_STATUS } from '@/utils/api-messages';

import { egressCalls } from '../helpers/egress';
import { baseHeaders } from '../helpers/session';

const TURNSTILE_HOST = 'challenges.cloudflare.com';

/** A syntactically valid JSON document of roughly `bytes` bytes. */
const jsonBody = (bytes: number) =>
  JSON.stringify({ email: 'x'.repeat(Math.max(0, bytes - 20)) });

/**
 * `declared` is set explicitly, and that is not a shortcut.
 *
 * Bun does NOT synthesise `Content-Length` on a `Request` built in process
 * (measured) — only a request off the wire carries one. The `onRequest` boundary
 * reads that header, so without stating it here the case would silently exercise
 * the streaming half instead of the boundary, and the boundary would be covered
 * by nothing.
 */
function post(
  path: string,
  body: BodyInit,
  contentType: string,
  declared?: number
): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: baseHeaders({
      'content-type': contentType,
      'x-captcha-response': 'token',
      ...(declared !== undefined && { 'content-length': String(declared) }),
    }),
    body,
  });
}

describe('an oversized JSON body is refused before the mount that would read it', () => {
  const oversized = 2 * 1024 * 1024;

  test('POST /api/auth/sign-in/email answers 413 and never reaches the captcha plugin', async () => {
    // No reader bounds this path: `/api/auth/*` hands the raw request to
    // `auth.handler`, which reads it with the library's own parser. Before the
    // boundary, this body was buffered and parsed under the 12 MiB server-wide
    // ceiling, in front of the captcha plugin's outbound verify.
    const response = await app.handle(
      post('/api/auth/sign-in/email', jsonBody(oversized), 'application/json')
    );

    expect(response.status).toBe(HTTP_STATUS.CONTENT_TOO_LARGE);
    // This project's envelope, not Better Auth's error shape: the refusal is
    // this application's, taken before the library was called at all.
    expect(await response.json()).toMatchObject({ success: false });
    expect(
      egressCalls().filter((call) => call.host === TURNSTILE_HOST)
    ).toBeEmpty();
  });

  test('a declared over-size body is refused at the boundary, before any mount', async () => {
    // `/api/dash/users` authenticates before it reads, so a refusal here CANNOT
    // have come from the route: an unauthenticated request that got as far as
    // the reader would be 401. 413 is the boundary answering from the head
    // alone, which is what covers a mount that never calls the reader.
    const body = jsonBody(MAX_JSON_BODY_BYTES + 4096);
    const response = await app.handle(
      post('/api/dash/users', body, 'application/json', body.length)
    );

    expect(response.status).toBe(HTTP_STATUS.CONTENT_TOO_LARGE);
  });

  test('a body just under the ceiling is not refused', async () => {
    // The negative control. Without it every case above passes on a boundary
    // that refuses everything, and the ceiling would be indistinguishable from
    // an outage.
    const body = jsonBody(MAX_JSON_BODY_BYTES - 4096);
    const response = await app.handle(
      post('/api/auth/sign-in/email', body, 'application/json', body.length)
    );

    expect(response.status).not.toBe(HTTP_STATUS.CONTENT_TOO_LARGE);
  });

  test('multipart keeps the 12 MiB budget the JSON ceiling does not touch', async () => {
    // The other half of the policy rule, and why one number at the boundary is
    // not the answer: a route that declares `multipart` keeps the server-wide
    // budget. 401 because the upload route authenticates before it reads — that
    // it is not 413 is the assertion.
    const boundary = 'X';
    const filler = 'y'.repeat(MAX_JSON_BODY_BYTES * 2);
    const body =
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="files"; filename="probe.bin"\r\n' +
      'Content-Type: application/octet-stream\r\n\r\n' +
      `${filler}\r\n--${boundary}--\r\n`;
    expect(body.length).toBeGreaterThan(MAX_JSON_BODY_BYTES);
    expect(body.length).toBeLessThan(MAX_REQUEST_BODY_BYTES);

    const response = await app.handle(
      post(
        '/api/upload/file?resource=users',
        body,
        `multipart/form-data; boundary=${boundary}`
      )
    );

    expect(response.status).not.toBe(HTTP_STATUS.CONTENT_TOO_LARGE);
    expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
  });

  test('a multipart Content-Type on an auth path buys nothing', async () => {
    // The ceiling comes from the POLICY the table declares for the path, not
    // from the type the caller wrote on the request. Deciding from the type
    // handed the 12 MiB upload allowance to anyone who put `multipart/form-data`
    // on `/sign-in/email`, which accepts no multipart body at all — and the
    // refusal then arrived only after the whole body had been buffered.
    const boundary = 'X';
    const body =
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="email"\r\n\r\n' +
      `${'y'.repeat(MAX_JSON_BODY_BYTES * 2)}\r\n--${boundary}--\r\n`;
    expect(body.length).toBeGreaterThan(MAX_JSON_BODY_BYTES);
    expect(body.length).toBeLessThan(MAX_REQUEST_BODY_BYTES);

    const declared = await app.handle(
      post(
        '/api/auth/sign-in/email',
        body,
        `multipart/form-data; boundary=${boundary}`,
        body.length
      )
    );

    expect(declared.status).toBe(HTTP_STATUS.CONTENT_TOO_LARGE);
    expect(
      egressCalls().filter((call) => call.host === TURNSTILE_HOST)
    ).toBeEmpty();
  });

  test('a chunked auth body with no Content-Length is bounded too', async () => {
    // The half a `Content-Length` check cannot cover, and the only half a caller
    // who wants to bypass the ceiling would use. `boundedBodyRequest` counts
    // while reading, so the process stops at the ceiling instead of buffering the
    // whole document, and the refusal is this file's 413 rather than whatever the
    // library makes of a body that ended mid-document.
    const bytes = new TextEncoder().encode(jsonBody(MAX_JSON_BODY_BYTES * 3));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += 65_536)
          controller.enqueue(bytes.slice(at, at + 65_536));
        controller.close();
      },
    });
    const request = new Request('http://localhost/api/auth/sign-in/email', {
      method: 'POST',
      headers: baseHeaders({
        'content-type': 'application/json',
        'x-captcha-response': 'token',
      }),
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(request.headers.get('content-length')).toBeNull();

    const response = await app.handle(request);

    expect(response.status).toBe(HTTP_STATUS.CONTENT_TOO_LARGE);
  });
});
