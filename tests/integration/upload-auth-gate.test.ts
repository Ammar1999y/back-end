/**
 * The authorization gate on `POST /api/upload/image`.
 *
 * Ported from `scripts/probe/dev-live/database/upload-auth-gate.dev-probe.ts`.
 * Three things the port changes, all of them because the harness can reach what
 * the probe could not:
 *
 * 1. **No spawned server.** `app.handle(new Request(...))` runs the real route
 *    table in process, so the adapter's body policy, the pre-auth limiter, the
 *    session layer and the handler are all the production ones.
 * 2. **No hand-signed cookie.** The probe reimplemented `better-call`'s
 *    `signCookieValue` and inserted session rows directly, which meant its
 *    "cookie works" case proved its own HMAC rather than Better Auth's. Every
 *    cookie here comes from the real sign-in endpoint, and the two rejection
 *    cases are built by MUTATING it — a deleted session row under a still-valid
 *    signature, and a stripped or corrupted signature over a still-live row.
 * 3. **The ordering claim is observed, not inferred.** `routes.ts` says the
 *    permission check on `resource` must run before the multipart body is
 *    parsed. A status code cannot show that: every rejection is a 400 or a 401
 *    whether the body was buffered first or not. So each request instance gets
 *    its body accessors wrapped (`watchBody`), and the assertion is that a
 *    refused caller's body was never touched — `[]` — while an admitted one
 *    reads exactly `formData`.
 *
 * The last one is also what makes the positive case honest: a gate that rejects
 * everything passes every negative test in this file.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { SignedInSession } from '../helpers/session';

import { eq } from 'drizzle-orm';

import { app } from '@/app';
import { uploadMsg } from '@/app/api/upload/image/messages';
import { db } from '@/db';
import { files, sessions } from '@/db/schema';

import {
  HTTP_STATUS,
  MSG_INSUFFICIENT_PERMISSIONS,
  MSG_LOGIN_REQUIRED,
} from '@/utils/api-messages';

import { resetTables } from '../helpers/database';
import { storeOps, storeOpsOf } from '../helpers/object-store';
import { authedRequest, baseHeaders, signedInUser } from '../helpers/session';

/**
 * Five actors, each defined by the grant that is supposed to decide its fate.
 *
 * `readOnly` holds every other action on the same page rather than an empty
 * matrix: "no permissions at all is refused" is a much weaker statement than
 * "view, viewOwn, delete and deleteOwn on this very resource are not enough".
 */
const ACTOR_GRANTS = {
  create: { users: { create: true } },
  edit: { users: { edit: true } },
  editOwn: { users: { editOwn: true } },
  readOnly: {
    users: { view: true, viewOwn: true, delete: true, deleteOwn: true },
  },
  // Same grants as `create`; its session row is deleted inside its own test.
  revoked: { users: { create: true } },
} as const;

type ActorName = keyof typeof ACTOR_GRANTS;

const actors: Partial<Record<ActorName, SignedInSession>> = {};

function actor(name: ActorName): SignedInSession {
  const session = actors[name];
  if (!session) throw new Error(`actor "${name}" was not seeded`);
  return session;
}

/**
 * Seeded once, up front. Signing in costs an Argon2id verify at 64 MiB, and
 * truncating mid-file would delete the other actors' session rows underneath
 * them — every later test would then answer 401 instead of its assertion.
 */
beforeAll(async () => {
  await resetTables();
  for (const [name, permissions] of Object.entries(ACTOR_GRANTS)) {
    actors[name as ActorName] = await signedInUser({ permissions });
  }
});

/**
 * Body accessors, wrapped per REQUEST INSTANCE rather than on
 * `Request.prototype`.
 *
 * An own property shadows the prototype method for this object only, so nothing
 * process-wide is mutated — which matters because the integration tier runs
 * `--no-isolate`, and a prototype patch would outlive the test that installed it.
 *
 * `request.body` (the raw stream) is deliberately not covered: nothing in the
 * request path reads it directly, and a `ReadableStream` body is not a usable
 * probe here anyway — Bun drains a streamed request body on its own, one tick
 * after construction, whether a handler ever reads it or not (measured).
 */
const BODY_ACCESSORS = [
  'formData',
  'text',
  'json',
  'arrayBuffer',
  'blob',
] as const;

function watchBody(request: Request): readonly string[] {
  const reads: string[] = [];
  for (const name of BODY_ACCESSORS) {
    // Captured EAGERLY and bound. `() => request[name]()` looks the property up
    // at CALL time, by which point it is the wrapper installed below — so the
    // wrapper called itself forever, `reads` grew without limit, and the worker
    // died on `memory allocation of 2147483648 bytes failed`. With `--no-isolate`
    // that took the whole tier down with it, which is why this file could not be
    // run alongside its siblings.
    const original: () => Promise<unknown> = (
      request[name] as () => Promise<unknown>
    ).bind(request);
    Object.defineProperty(request, name, {
      configurable: true,
      writable: true,
      value: () => {
        reads.push(name);
        return original();
      },
    });
  }
  return reads;
}

interface UploadAttempt {
  status: number;
  /** Parsed envelope, left `unknown` so every assertion goes through `toEqual`. */
  body: unknown;
  /** The raw text, for the "does the failure leak anything" assertions. */
  text: string;
  /** Which body accessors the layers invoked, in the order they were called. */
  reads: readonly string[];
}

async function attempt(options: {
  session?: SignedInSession;
  /** A raw cookie header, for the forged-cookie cases. Omit for anonymous. */
  cookie?: string;
  /** Defaults to a resource the `create`/`edit` actors hold a grant on. */
  query?: string;
  body?: BodyInit;
  contentType?: string;
}): Promise<UploadAttempt> {
  const url = `/api/upload/image${options.query ?? '?resource=users'}`;
  const init: RequestInit = {
    method: 'POST',
    ...(options.body !== undefined && { body: options.body }),
    ...(options.contentType && {
      headers: { 'content-type': options.contentType },
    }),
  };

  // `authedRequest` carries the trusted-IP and captcha headers the admission
  // layer needs; without `cf-connecting-ip` the per-IP limiter fails closed and
  // every assertion below becomes a 503. The anonymous branch uses the same
  // `baseHeaders` for the same reason.
  const request = options.session
    ? authedRequest(options.session, url, init)
    : new Request(new URL(url, 'http://localhost'), {
        ...init,
        headers: baseHeaders({
          ...(options.cookie && { cookie: options.cookie }),
          ...(options.contentType && { 'content-type': options.contentType }),
        }),
      });

  const reads = watchBody(request);
  const response = await app.handle(request);
  const text = await response.text();
  const body: unknown = JSON.parse(text);
  return { status: response.status, body, text, reads };
}

function failure(message: string) {
  return { success: false, message, data: null };
}

/**
 * A real, decodable image the handler will accept — the file the refused cases
 * carry, so that a rejection is about the caller and not about the payload.
 *
 * SVG rather than PNG, and derived rather than pasted: `validateMagicBytes`
 * exempts SVG (it is XML, and `sanitizeSvgServer` validates it in full), and
 * `processImage` routes it away from `Bun.Image`, so the fixture needs neither a
 * hand-assembled zlib stream nor a copy of the magic-byte table to stay correct.
 * The image pipeline's own assertions — magic bytes, animated WebP, blurhash —
 * belong to the shard that owns `lib/r2/upload-helper.ts`, not to the gate.
 */
function imageForm(): FormData {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8">' +
    '<rect width="8" height="8" fill="#ff0000"/></svg>';
  const form = new FormData();
  form.append(
    'files',
    new File([svg], 'gate-fixture.svg', { type: 'image/svg+xml' })
  );
  return form;
}

const TOKEN_COOKIE_SUFFIX = 'session_token';

/**
 * The signed session cookie out of the pair list, located by SUFFIX.
 *
 * Better Auth prefixes the name with `__Secure-` when its baseURL is https, so
 * matching the full name would make every forged-cookie case below silently
 * vacuous the day a dev environment gains TLS — the exact trap the source probe
 * documented. A miss throws instead.
 */
function tokenCookie(cookie: string): { name: string; value: string } {
  for (const pair of cookie.split('; ')) {
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator);
    if (name.endsWith(TOKEN_COOKIE_SUFFIX))
      return { name, value: pair.slice(separator + 1) };
  }
  throw new Error(`no *${TOKEN_COOKIE_SUFFIX} cookie in "${cookie}"`);
}

/** Rewrites only the signed token cookie, leaving the cache cookie untouched. */
function forgeToken(
  cookie: string,
  rewrite: (value: string) => string
): string {
  const { name, value } = tokenCookie(cookie);
  const forged = cookie
    .split('; ')
    .map((pair) =>
      pair.startsWith(`${name}=`) ? `${name}=${rewrite(value)}` : pair
    )
    .join('; ');
  if (forged === cookie)
    throw new Error('the forgery did not change the cookie');
  return forged;
}

describe('the gate admits the callers it should', () => {
  test('a create grant reaches the multipart parse — the gate is not just shut', async () => {
    // An EMPTY form, so the handler's own "no files" check is what answers.
    // Reaching it means the session was accepted, the permission passed, the
    // per-user limiter admitted the request and `readFormData()` ran. `reads` is
    // what proves the last step rather than inferring it from the status.
    const result = await attempt({
      session: actor('create'),
      body: new FormData(),
    });

    expect(result.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(result.body).toEqual(failure(uploadMsg.noFiles));
    expect(result.reads).toEqual(['formData']);
    expect(storeOps()).toEqual([]);
  });

  test('an edit grant alone reaches it too — the other arm of the OR', async () => {
    // `UPLOAD_ACTIONS` is `['create', 'edit']`, and a caller holding everything
    // cannot tell an OR from an AND. Each arm is asserted on its own.
    const result = await attempt({
      session: actor('edit'),
      body: new FormData(),
    });

    expect(result.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(result.body).toEqual(failure(uploadMsg.noFiles));
    expect(result.reads).toEqual(['formData']);
  });

  test('an editOwn grant alone is admitted as well — current behaviour', async () => {
    // NOT an assertion that this is right. `resolveActionScope` answers
    // `allowed: true, scope: 'own'` for a request for `edit` backed only by
    // `editOwn`, and `requireAnyPermission` reads the boolean and discards the
    // scope — which is defensible here (a temporary upload is attached to no
    // record yet, so there is nothing to scope against) but is written down
    // nowhere. Pinned so that changing it is deliberate; reported with the port.
    const result = await attempt({
      session: actor('editOwn'),
      body: new FormData(),
    });

    expect(result.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(result.body).toEqual(failure(uploadMsg.noFiles));
  });

  test('a granted upload reaches the object store, attributed to the session user', async () => {
    const session = actor('create');
    const result = await attempt({ session, body: imageForm() });

    expect(result.status).toBe(HTTP_STATUS.OK);
    expect(result.reads).toEqual(['formData']);

    // The object store is the far end of the pipeline; a gate failure never gets
    // here, so this is the assertion that the caller was admitted all the way
    // through rather than merely past the permission check.
    const puts = storeOpsOf('PutObject');
    expect(puts.length).toBe(1);
    expect(puts[0]?.contentType).toBe('image/svg+xml');
    expect(puts[0]?.key?.startsWith('temp/')).toBe(true);
    expect(result.body).toEqual({
      success: true,
      message: uploadMsg.uploaded,
      data: [puts[0]?.key],
    });

    // `uploadedBy` comes from the SESSION, not from anything the client sent —
    // the identity the gate resolved is the identity the row is attributed to.
    const rows = await db
      .select({
        r2Key: files.r2Key,
        uploadedBy: files.uploadedBy,
        isTemporary: files.isTemporary,
      })
      .from(files);
    expect(rows).toEqual([
      {
        r2Key: puts[0]?.key ?? '',
        uploadedBy: session.user.userId,
        isTemporary: true,
      },
    ]);
  });
});

describe('the gate refuses everyone else', () => {
  test('no session is 401, and the body is never touched', async () => {
    const result = await attempt({ body: imageForm() });

    expect(result.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(result.body).toEqual(failure(MSG_LOGIN_REQUIRED));
    // The property `preAuth: 'ip-limit'` plus a lazy body exists for: an
    // unauthenticated caller's multipart payload is never buffered.
    expect(result.reads).toEqual([]);
    expect(storeOps()).toEqual([]);
  });

  test('a session holding every OTHER action on the resource is 403', async () => {
    const session = actor('readOnly');
    const result = await attempt({ session, body: imageForm() });

    expect(result.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(result.body).toEqual(failure(MSG_INSUFFICIENT_PERMISSIONS));
    expect(result.reads).toEqual([]);

    // The refusal says nothing about who asked or what they would have needed.
    expect(result.text).not.toContain(session.user.userId);
    expect(result.text).not.toContain(session.user.roleId);
    expect(result.text).not.toContain(session.user.email);
    expect(result.text).not.toContain('create');
    expect(result.text).not.toContain('edit');
  });

  test('a grant on one resource does not authorise an upload for another', async () => {
    // `permissions` is a real page in the enum, so this is a well-formed request
    // that must still be refused: the check has to be per-resource, not
    // "holds create somewhere".
    const result = await attempt({
      session: actor('create'),
      query: '?resource=permissions',
      body: imageForm(),
    });

    expect(result.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(result.body).toEqual(failure(MSG_INSUFFICIENT_PERMISSIONS));
    expect(result.reads).toEqual([]);
  });

  test('a page on which no role can hold create or edit is refused too', async () => {
    // `home` offers `view` only (`DEFAULT_PAGE_PERMISSIONS`), so no grant can
    // ever satisfy this route for it. It must be a 403, not an accidental pass
    // for a resource on which nobody owns a write action.
    const result = await attempt({
      session: actor('create'),
      query: '?resource=home',
      body: imageForm(),
    });

    expect(result.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(result.body).toEqual(failure(MSG_INSUFFICIENT_PERMISSIONS));
  });

  test('a repeated resource parameter is decided by the FIRST value', async () => {
    // `URLSearchParams.get` returns the first, so a second copy cannot smuggle
    // an authorised resource past a check made on an unauthorised one. Both
    // directions, because only the pair distinguishes "first wins" from "any
    // value passes".
    const smuggled = await attempt({
      session: actor('create'),
      query: '?resource=permissions&resource=users',
      body: imageForm(),
    });
    expect(smuggled.status).toBe(HTTP_STATUS.FORBIDDEN);
    expect(smuggled.reads).toEqual([]);

    const admitted = await attempt({
      session: actor('create'),
      query: '?resource=users&resource=permissions',
      body: new FormData(),
    });
    expect(admitted.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(admitted.body).toEqual(failure(uploadMsg.noFiles));
  });
});

describe('cookies that must not authenticate', () => {
  test('the fixture cookie is signed, or every case below is vacuous', () => {
    const { name, value } = tokenCookie(actor('create').cookie);
    expect(name.endsWith(TOKEN_COOKIE_SUFFIX)).toBe(true);

    // `better-call`'s shape check, pinned: it splits at the LAST dot and refuses
    // anything but a 44-character base64 HMAC-SHA-256 ending in `=`. The two
    // forgeries below are built against exactly this, so a change in either
    // direction should fail here first and name the reason.
    const cut = value.lastIndexOf('.');
    expect(cut).toBeGreaterThan(0);
    const signature = decodeURIComponent(value.slice(cut + 1));
    expect(signature.length).toBe(44);
    expect(signature.endsWith('=')).toBe(true);
  });

  test('a validly signed cookie whose session row is gone is 401', async () => {
    const session = actor('revoked');

    // Accepted FIRST, with the row present. Without this half a 401 after the
    // delete would prove nothing — a cookie that never worked answers 401 too.
    const before = await attempt({ session, body: new FormData() });
    expect(before.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(before.body).toEqual(failure(uploadMsg.noFiles));

    const deleted = await db
      .delete(sessions)
      .where(eq(sessions.userId, session.user.userId))
      .returning({ id: sessions.id });
    expect(deleted.length).toBe(1);

    // Same cookie, same signature, same user, same grant: only the row is gone.
    // Better Auth's cookie cache would still serve this session for minutes,
    // which is why `assertLiveSession` exists — and why the answer must be 401
    // rather than the 400 the identical request got a moment ago.
    const after = await attempt({ session, body: imageForm() });
    expect(after.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(after.body).toEqual(failure(MSG_LOGIN_REQUIRED));
    expect(after.reads).toEqual([]);
    expect(storeOps()).toEqual([]);
  });

  test('an unsigned cookie is 401', async () => {
    // The real token, stripped of its signature. Nothing about the session is
    // wrong; the cookie simply is not signed, and an unsigned cookie is a value
    // the client chose.
    const cookie = forgeToken(actor('create').cookie, (value) =>
      value.slice(0, value.lastIndexOf('.'))
    );
    const result = await attempt({ cookie, body: imageForm() });

    expect(result.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(result.body).toEqual(failure(MSG_LOGIN_REQUIRED));
    expect(result.reads).toEqual([]);
  });

  test('a well-formed but wrong signature is 401', async () => {
    // Still 44 base64 characters ending in `=`, so it passes the shape check and
    // reaches the HMAC comparison — which is the half a length-only guard would
    // let through.
    const cookie = forgeToken(actor('create').cookie, (value) => {
      const cut = value.lastIndexOf('.');
      const signature = decodeURIComponent(value.slice(cut + 1));
      const flipped =
        (signature.startsWith('A') ? 'B' : 'A') + signature.slice(1);
      return `${value.slice(0, cut)}.${encodeURIComponent(flipped)}`;
    });
    const result = await attempt({ cookie, body: imageForm() });

    expect(result.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(result.body).toEqual(failure(MSG_LOGIN_REQUIRED));
    expect(result.reads).toEqual([]);
  });
});

describe('the resource parameter is checked before the body is parsed', () => {
  // The ordering is the security property `routes.ts` documents: `resource` is
  // read from the query rather than from a form field precisely so the
  // permission check on it can run before `readFormData()`. `reads` toEqual([])
  // is that claim; the granted case above, whose `reads` is `['formData']`, is
  // what stops it from being vacuous.
  const INVALID = [
    ['missing', ''],
    ['empty', '?resource='],
    ['unknown page', '?resource=nope'],
    ['prototype key', '?resource=__proto__'],
    ['prototype method', '?resource=toString'],
    ['constructor', '?resource=constructor'],
    ['wrong case', '?resource=Users'],
    ['padded', '?resource=%20users'],
  ] as const;

  test.each([...INVALID])(
    'an invalid resource (%s) is 400 with the body untouched',
    async (_label, query) => {
      const result = await attempt({
        session: actor('create'),
        query,
        body: imageForm(),
      });

      expect(result.status).toBe(HTTP_STATUS.BAD_REQUEST);
      expect(result.body).toEqual(failure(uploadMsg.invalidResource));
      expect(result.reads).toEqual([]);
      expect(storeOps()).toEqual([]);
    }
  );

  test('the invalid value is not echoed back', async () => {
    const result = await attempt({
      session: actor('create'),
      query: '?resource=%3Cscript%3Ealert(1)%3C%2Fscript%3E',
      body: imageForm(),
    });

    expect(result.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(result.body).toEqual(failure(uploadMsg.invalidResource));
    expect(result.text).not.toContain('script');
  });

  test('an anonymous caller cannot tell a real page from an unknown one', async () => {
    // `resource` used to be parsed BEFORE the session check, so an
    // unauthenticated caller got 400 for a name that is not a page and 401 for
    // one that is — an exact, unauthenticated membership test for
    // `DASHBOARD_PAGE_NAMES`. It was accepted only while `/openapi.json`
    // published those names to anyone; the document is authenticated now, so the
    // divergence had to go with it.
    //
    // Both answers must be byte-identical, and neither may read the body.
    const unknown = await attempt({
      query: '?resource=nope',
      body: imageForm(),
    });
    const real = await attempt({ query: '?resource=users', body: imageForm() });

    expect(unknown.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(real.status).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(unknown.body).toEqual(failure(MSG_LOGIN_REQUIRED));
    expect(real.body).toEqual(unknown.body);

    expect(unknown.reads).toEqual([]);
    expect(real.reads).toEqual([]);
  });

  test('a missing resource is also indistinguishable to an anonymous caller', () =>
    attempt({ body: imageForm() }).then((result) => {
      expect(result.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      expect(result.body).toEqual(failure(MSG_LOGIN_REQUIRED));
    }));
});

describe('the body policy on the way past the gate', () => {
  test('a JSON content-type is never parsed as a form', async () => {
    // `withBodyPolicy` gates the readers by the route's declared policy, so a
    // client cannot pick the parser by choosing a Content-Type. The route is
    // `multipart`, so `readFormData()` is a constant null here and no accessor
    // is invoked at all — the handler answers "no files" without touching the
    // JSON the caller sent.
    const result = await attempt({
      session: actor('create'),
      contentType: 'application/json',
      body: JSON.stringify({ files: ['not-a-file'] }),
    });

    expect(result.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(result.body).toEqual(failure(uploadMsg.noFiles));
    expect(result.reads).toEqual([]);
    expect(storeOps()).toEqual([]);
  });

  test('a malformed multipart body is a 400, not a 500', async () => {
    // A parse failure must not surface as an internal error, and must not carry
    // the parser's own message out to the client.
    const result = await attempt({
      session: actor('create'),
      contentType: 'multipart/form-data; boundary=----gate-boundary',
      body: 'not a multipart body at all',
    });

    expect(result.status).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(result.body).toEqual(failure(uploadMsg.noFiles));
    // It tried, and `safeReadFormData` turned the throw into "no form".
    expect(result.reads).toEqual(['formData']);
    expect(result.text).not.toContain('boundary');
    expect(storeOps()).toEqual([]);
  });
});
