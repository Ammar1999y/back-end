/**
 * No Better Auth error may reach a client as English.
 *
 * `lib/auth/code-errors.ts` is a hand-maintained map and `app.ts`'s
 * `localiseAuthError` applies it by `code`. An unmapped code passes through
 * UNTOUCHED, which puts the dependency's own internal text on the wire in an
 * Arabic-locale API: measured before this file,
 * `POST /api/auth/passwordless/verify` with a body of `[]` answered
 * `"[body] Invalid input: expected record, received array"` and any malformed
 * JSON answered `"Invalid JSON in request body"`.
 *
 * Asserted as a PROPERTY over the reachable surface rather than as a list of
 * codes, because a list is a list of the codes somebody already thought of.
 * Better Auth declares 49; this deployment mounts four paths, so most are
 * unreachable and mapping them would be dead entries. What matters is that
 * nothing unmapped is reachable — and this fails the moment one becomes so,
 * whether by a dependency bump or by a new allowlisted path.
 *
 * The discriminator is the SCRIPT, the same one `zodIssueMessage` uses: every
 * message this project writes is Arabic and every dependency default is ASCII.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import { app } from '@/app';
import { BETTER_AUTH_ENDPOINTS } from '@/lib/auth/allowed-paths';

import { CUSTOM_AUTH_CODE } from '@/utils/api-messages';

import { baseHeaders } from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

/**
 * Bodies that reach Better Auth's own request-shape validation rather than a
 * handler.
 *
 * Deliberately no well-formed credential body: an unknown email costs an Argon2
 * timing guard, and the shapes below are the ones that produced English.
 */
const HOSTILE_BODIES = [
  '{}',
  'null',
  '[]',
  '"x"',
  '1',
  'true',
  '[1,2]',
  '',
  'not json at all',
  '{"email":1}',
  '{"email":"a@gmail.com","password":1}',
  '{"unexpected":true}',
] as const;

const ARABIC_LETTER = /\p{Script=Arabic}/u;

interface Answer {
  status: number;
  code: unknown;
  message: string;
}

async function ask(
  path: string,
  method: string,
  body?: string
): Promise<Answer> {
  const response = await app.handle(
    new Request(`http://localhost/api/auth${path}`, {
      method,
      headers: baseHeaders({ 'content-type': 'application/json' }),
      ...(body !== undefined && { body }),
    })
  );
  const text = await response.text();
  let parsed: { code?: unknown; message?: unknown } | null = null;
  try {
    // `/get-session` answers a bare `null` for an anonymous caller, which parses
    // to `null` rather than to an object.
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    // A bodiless or non-JSON answer carries no message to leak.
  }
  if (parsed === null || typeof parsed !== 'object') parsed = {};
  return {
    status: response.status,
    code: parsed.code,
    message: typeof parsed.message === 'string' ? parsed.message : '',
  };
}

describe('every reachable Better Auth error is localised', () => {
  beforeEach(() => {
    // Per case: `/sign-in/email` admits 20 requests per window, and this file
    // sends more than that across the matrix. A 429 is still Arabic, so without
    // the reset the sweep would pass while exercising the limiter instead of the
    // boundary it is about.
    resetSqliteStores();
  });

  const posts = BETTER_AUTH_ENDPOINTS.filter((endpoint) =>
    endpoint.methods.includes('POST')
  );

  test.each(posts.map((endpoint) => [endpoint.path, endpoint] as const))(
    'POST %s answers in Arabic for every malformed body',
    async (path) => {
      for (const body of HOSTILE_BODIES) {
        const answer = await ask(path, 'POST', body);
        if (answer.status < 400) continue;

        expect({ body, message: answer.message }).toMatchObject({
          body,
          message: expect.stringMatching(ARABIC_LETTER),
        });
        // And it went through the localiser rather than happening to be Arabic:
        // every rewritten body carries this project's own code.
        expect(
          answer.code === CUSTOM_AUTH_CODE || answer.code === undefined
        ).toBe(true);
      }
    },
    120_000
  );

  test('GET /get-session succeeds anonymously and leaks nothing', async () => {
    // The one GET path. It answers 200 with `null` for an anonymous caller, so
    // the property here is that it does not error at all.
    const answer = await ask('/get-session', 'GET');

    expect(answer.status).toBe(200);
    expect(answer.message).toBe('');
  });
});
