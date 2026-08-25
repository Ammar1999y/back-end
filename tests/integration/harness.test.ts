/**
 * The harness asserting on itself.
 *
 * Every other integration file assumes these four things. If one of them is
 * wrong, the failures land somewhere else entirely — a truncate that hit the
 * wrong database looks like a flaky uniqueness violation, and a sign-in fixture
 * that silently returns no cookie looks like a broken authorization check in
 * whichever route ran first.
 */
import { beforeAll, describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import { users } from '@/db/schema';

import {
  currentDatabase,
  resetTables,
  schemaTableNames,
} from '../helpers/database';
import { egressCalls, egressCallsTo, scriptEgress } from '../helpers/egress';
import { failNextMail, sentMail } from '../helpers/mailbox';
import { HARNESS_PREFIX, HARNESS_SUFFIX } from '../helpers/names';
import { failObjectStore, storeOps, storeOpsOf } from '../helpers/object-store';
import {
  accountRowFor,
  authedRequest,
  baseHeaders,
  seedUser,
  signedInUser,
  signIn,
  signUpThroughDevRoute,
  TEST_IP,
} from '../helpers/session';

beforeAll(async () => {
  await resetTables();
});

/**
 * **No `afterAll(closeDatabase)` here, and no integration file may add one.**
 *
 * The pool is constructed at module load and is process-wide, and the integration
 * tier runs `--no-isolate` so one worker executes many files in one process.
 * Closing it in a file's teardown therefore poisons every file the worker runs
 * afterwards — reproduced: the next file's `TRUNCATE` failed with
 * `ERR_POSTGRES_CONNECTION_CLOSED`, which reads as a database outage rather than
 * as a teardown bug, and a single-file run cannot see it at all.
 *
 * Nothing needs to close it: the worker exits and Bun tears the sockets down. The
 * §7.4e assertions that are ABOUT `closeDatabase()` — that it resolves on a live
 * pool, and that a query after it fails rather than silently reconnecting —
 * belong in a spawned child in the process tier for exactly this reason.
 */

describe('database targeting', () => {
  test('the connection landed on a harness database, asked of the server', async () => {
    const name = await currentDatabase();
    expect(name.startsWith(HARNESS_PREFIX)).toBe(true);
    expect(name.endsWith(HARNESS_SUFFIX)).toBe(true);
  });

  test('it is not the database .env names', async () => {
    const name = await currentDatabase();
    expect(name).not.toBe('app');
  });

  test('the migrated schema is present', async () => {
    const names = schemaTableNames();
    expect(names).toContain('users');
    expect(names).toContain('sessions');
    expect(names).toContain('accounts');

    // Read every public table and compare sets. `= any(${names})` is the obvious
    // form and does not work: Drizzle renders a JS array as a parameter TUPLE,
    // which PostgreSQL rejects with `op ANY/ALL (array) requires array on right
    // side` (42809).
    const rows = await db.execute<{ table_name: string }>(sql`
      select table_name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'`);
    const present = new Set(rows.map((row) => row.table_name));
    expect(names.filter((name) => !present.has(name))).toEqual([]);
  });

  test('the hand-written trigram indexes were applied, so phase order held', async () => {
    // Asserted by consequence rather than by reading the migration runner: a GIN
    // trigram index can only exist if the table it indexes was created first.
    const rows = await db.execute<{ indexname: string }>(sql`
      select indexname from pg_indexes
       where schemaname = 'public' and indexdef ilike '%gin_trgm_ops%'`);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('table reset', () => {
  test('truncate empties the tables and leaves the harness marker', async () => {
    await seedUser();
    const before = await db.select().from(users);
    expect(before.length).toBeGreaterThan(0);

    await resetTables();
    expect(await db.select().from(users)).toEqual([]);

    // `_harness_schema` is the ownership marker the preload's guard reads. A
    // truncate that took it out would make the next run refuse to start.
    const marker = await db.execute<{ count: string }>(sql`
      select count(*)::text as count from _harness_schema`);
    expect(Number(marker[0]?.count)).toBe(1);
  });
});

describe('sign-in fixture', () => {
  test('a seeded user signs in through the real endpoint and gets a cookie', async () => {
    await resetTables();
    const session = await signedInUser();

    expect(session.cookie).toContain('session_token');
    expect(session.setCookie.length).toBeGreaterThan(0);
  });

  test('the fixture sends a trusted IP header', () => {
    // Without it `ipIdentifier` fails closed and EVERY authenticated test
    // answers 503 instead of its assertion — a failure that reads as a broken
    // route rather than a broken fixture, which is why it is pinned here.
    expect(baseHeaders()['cf-connecting-ip']).toBe(TEST_IP);
  });

  test('an authenticated request reaches a real route', async () => {
    await resetTables();
    const session = await signedInUser();

    // The single property twelve route shards rest on: `authedRequest` produces
    // a request the session layer accepts AND whose grants are honoured.
    //
    // This was briefly weakened to `not.toBe(401)` plus a write-path 422, because
    // the route answered 403 — `session.user.roleId` was always undefined
    // (`lib/auth.ts` mapped it with `fieldName: 'role_id'` against a Drizzle
    // adapter that returns Drizzle keys). That is fixed, so the assertion is back
    // to what it has to be: `not.toBe(401)` cannot tell "authorization works" from
    // "authorization is broken for every read action".
    const read = await app.handle(authedRequest(session, '/api/dash/users'));
    expect(read.status).toBe(200);

    // The write path too, since the two resolve `roleId` differently — the write
    // path from its own SQL join — and only asserting one leaves the other free
    // to break silently.
    const write = await app.handle(
      authedRequest(session, '/api/dash/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
    );
    expect(write.status).toBe(422);
  });

  test('the dev route creates an account row Better Auth can resolve', async () => {
    await resetTables();
    const created = await signUpThroughDevRoute();
    expect(created.status).toBe(201);
    // A throw rather than only an assertion: it narrows `userId` for the lookup
    // below and fails with a message naming the cause instead of a null deref.
    if (created.userId === null)
      throw new Error('dev sign-up returned 201 with no id');

    // Better Auth 1.7 resolves an account by `(providerId, issuer, accountId)`.
    // A wrong `issuer` answers a clean 401 for a correct password — the exact
    // shape of the outage that passed `tsc` and 150/150 probes — so the row is
    // asserted at the cause, not four layers downstream. The full §7.7 surface
    // belongs to its own shard; this is the fixture guarantee.
    const account = await accountRowFor(created.userId);
    expect(account).not.toBeNull();
    expect(account?.issuer).toBe('local:credential');
    expect(account?.accountId).toBe(created.userId);
  });

  test('the sign-in path verified the captcha through the egress boundary', async () => {
    await resetTables();
    await signIn(await seedUser());

    // Not incidental: it proves the guard is installed and intercepting, which is
    // what makes the "made NO outbound call" assertions elsewhere meaningful.
    expect(egressCallsTo('challenges.cloudflare.com').length).toBeGreaterThan(
      0
    );
  });
});

describe('egress boundary', () => {
  test('an unknown host is recorded and rejected', async () => {
    await expect(fetch('https://not-a-known-host.example/x')).rejects.toThrow(
      /no fake installed/
    );
    // The violation is consumed here so the global afterEach does not fail this
    // test for the call it was asked to make.
    const { assertNoEgressViolations } = await import('../helpers/egress');
    expect(() => assertNoEgressViolations()).toThrow(/unexpected outbound/);
  });

  test('loopback is passed through untouched', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('ok') });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(await response.text()).toBe('ok');
      expect(egressCallsTo('127.0.0.1')).toEqual([]);
    } finally {
      await server.stop(true);
    }
  });
});

describe('boundary overrides and their reset', () => {
  // Two properties, and the second is the one that makes the first safe to use:
  // an override must win over the default, and must NOT survive into the next
  // test. The global `beforeEach` in the base preload is what clears it, so a
  // regression there would silently leak a scripted 500 into every later file.
  test('a scripted host response wins over the default', async () => {
    scriptEgress('challenges.cloudflare.com', () =>
      Response.json({ success: false }, { status: 500 })
    );

    const response = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      { method: 'POST' }
    );
    expect(response.status).toBe(500);
  });

  test('the override did not survive into this test', async () => {
    const response = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      { method: 'POST' }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
  });

  test('an injected SMTP failure rejects, and does not record a message', async () => {
    // The seam shard 12 needs: `processOtpSend` treats a delivery failure as a
    // committed-but-undelivered code, and that branch is unreachable while every
    // send succeeds.
    const smtpRejection = Object.assign(new Error('550 mailbox unavailable'), {
      responseCode: 550,
    });
    failNextMail(smtpRejection);

    const module = await import('nodemailer');
    const nodemailer = module.default as unknown as {
      createTransport: () => {
        sendMail: (m: { to: string }) => Promise<unknown>;
      };
    };

    await expect(
      nodemailer.createTransport().sendMail({ to: 'someone@gmail.com' })
    ).rejects.toThrow('550 mailbox unavailable');
    expect(sentMail()).toEqual([]);
  });
});

describe('object-store boundary', () => {
  // Its own boundary, because the `fetch` router cannot see this one: the AWS SDK
  // resolves `NodeHttpHandler` — `node:http`, not `fetch` — so a guard installed
  // on `globalThis.fetch` never intercepts an S3 call. Asserted rather than
  // assumed, which is how that gap was found in the first place.
  test('a real uploadToR2 call lands in the stub and opens no socket', async () => {
    const { uploadToR2 } = await import('@/lib/r2/client');

    const result = await uploadToR2({
      file: Buffer.from('harness-bytes'),
      key: 'harness/one.png',
      bucketType: 'public',
      contentType: 'image/png',
    });

    expect(result).toEqual({ success: true, key: 'harness/one.png' });
    const puts = storeOpsOf('PutObject');
    expect(puts.length).toBe(1);
    expect(puts[0]?.key).toBe('harness/one.png');
    expect(puts[0]?.contentType).toBe('image/png');
    expect(puts[0]?.bytes).toBe('harness-bytes'.length);

    // Nothing reached the HTTP router, which is the point: an unfaked S3 call
    // would have gone out through node:http and been invisible to it.
    expect(
      egressCalls().filter((call) =>
        call.host.endsWith('.r2.cloudflarestorage.com')
      )
    ).toEqual([]);
  });

  test('an injected failure is what makes the rollback path reachable', async () => {
    const { uploadToR2 } = await import('@/lib/r2/client');
    failObjectStore('PutObject');

    await expect(
      uploadToR2({
        file: Buffer.from('x'),
        key: 'harness/two.png',
        bucketType: 'public',
        contentType: 'image/png',
      })
    ).rejects.toThrow(/injected PutObject failure/);

    // Recorded before it threw, so a test can assert which key was attempted —
    // which is exactly what `uploadImagesToR2`'s cleanup has to be checked against.
    expect(storeOpsOf('PutObject').map((op) => op.key)).toEqual([
      'harness/two.png',
    ]);
  });

  test('operations are recorded in order across kinds', async () => {
    const { uploadToR2, deleteFromR2 } = await import('@/lib/r2/client');

    await uploadToR2({
      file: Buffer.from('bytes'),
      key: 'harness/three.png',
      bucketType: 'public',
      contentType: 'image/png',
    });
    await deleteFromR2({ key: 'harness/three.png', bucketType: 'public' });

    // Sequence, not per-kind counts: the rollback in `uploadImagesToR2` is
    // DEFINED by ordering — a delete that lands before its upload leaves the
    // object behind — and `storeOpsOf` cannot express that.
    expect(storeOps().map((op) => op.kind)).toEqual([
      'PutObject',
      'DeleteObject',
    ]);
  });
});

describe('SMTP boundary', () => {
  test('a mail send is captured rather than delivered', async () => {
    const module = await import('nodemailer');
    const nodemailer = module.default as unknown as {
      createTransport: () => {
        sendMail: (m: { to: string; subject: string }) => Promise<unknown>;
      };
    };
    await nodemailer.createTransport().sendMail({
      to: 'someone@gmail.com',
      subject: 'harness',
    });

    const { sentMail } = await import('../helpers/mailbox');
    expect(sentMail().map((mail) => mail.to)).toEqual(['someone@gmail.com']);
  });
});

describe('dev routes are reachable in this tier', () => {
  test('the dev sign-up route is not 403, so NODE_ENV=development took effect', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/dev/sign-up', {
        method: 'POST',
        headers: baseHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({}),
      })
    );
    // 422 for the empty body — the point is that it reached validation rather
    // than the environment gate.
    expect(response.status).toBe(422);
  });
});
