/**
 * Three properties that only a real request through the real route table can
 * see, and that the existing suite could not.
 *
 * **1. `own`-scope filtering, asserted at the SQL level.**
 * `tests/unit/permission-scope.test.ts` proves `resolveActionScope` answers
 * `scope: 'own'`. Nothing proved the query then USED it. A route that resolves
 * the scope correctly and drops it from the `where` clause is an authorization
 * bypass no pure-function test can reach, so every case here seeds one row the
 * actor created and one somebody else created and asserts on the returned IDS —
 * a count would pass against a list of the wrong rows, and "sees nothing" would
 * pass against a route that returns nothing at all.
 *
 * The `meta.total` half is asserted too: the listing runs the filter twice, once
 * for the page and once for `count()`, and a total computed without the scope
 * predicate leaks the existence of every row the page hid.
 *
 * **2. An audit row written by an actual route mutation.**
 * `tests/integration/driver-contract.test.ts` calls `auditLog()` directly, which
 * proves the writer works and says nothing about whether a handler still calls
 * it. `POST /api/dash/users` and `PUT /api/dash/users/:id` are driven through
 * `app.handle` here and the row is then read with raw SQL — `jsonb_typeof`,
 * never a select through Drizzle, because the ORM's read path JSON-parses a
 * double-encoded string back into an object and is exactly what hid that defect.
 *
 * **3. The maintenance token's ACCEPT path.**
 * `maintenanceTokenMatches` short-circuits on a length mismatch before
 * `timingSafeEqual` runs, and the only existing case (`retention-sweep.test.ts`)
 * sends a 13-character token against a 25-character one — so the constant-time
 * compare had never executed in the suite. The wrong token here is built FROM
 * the configured one and its length is asserted equal, so the case cannot decay
 * back into the short-circuit unnoticed.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { SeededUser, SignedInSession } from '../helpers/session';

import { sql } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import { SQLITE_MAINTENANCE_TOKEN } from '@/lib/env.server';
import { generateUuidV7 } from '@/lib/id';

import { HTTP_STATUS, MSG_CREATED, MSG_NOT_FOUND } from '@/utils/api-messages';

import { resetTables } from '../helpers/database';
import {
  authedRequest,
  baseHeaders,
  seedUser,
  signedInUser,
  TEST_IP,
} from '../helpers/session';

interface Fixture {
  /** Every action on every page — and therefore `view` AND `viewOwn` at once. */
  admin: SignedInSession;
  /** Unrestricted `view` on users only: the control the own case is read against. */
  usersViewAll: SignedInSession;
  /** The own-scoped actor, for both the read and the write path. */
  usersOwn: SignedInSession;
  permsViewAll: SignedInSession;
  permsOwn: SignedInSession;
  /**
   * The two target rows. Seeded with NO permissions, deliberately: a target role
   * carrying grants the actor does not hold is refused by
   * `validateRolePermissionScope` before the ownership predicate is reached, and
   * the test would then pass while proving nothing about `own`.
   */
  rowOfOwnActor: SeededUser;
  rowOfAdmin: SeededUser;

  usersEditAll: SignedInSession;
}

const state: { fixture: Fixture | null } = { fixture: null };

function fx(): Fixture {
  if (!state.fixture) throw new Error('fixture not seeded');
  return state.fixture;
}

/**
 * Seeded ONCE. `resetTables()` mid-file deletes the session rows of every actor
 * seeded before it, and the whole file then answers 401 instead of its
 * assertions.
 */
beforeAll(async () => {
  await resetTables();

  const admin = await signedInUser();
  const usersViewAll = await signedInUser({
    permissions: { users: { view: true } },
  });
  const usersOwn = await signedInUser({
    permissions: { users: { viewOwn: true, editOwn: true } },
  });
  const permsViewAll = await signedInUser({
    permissions: { permissions: { view: true } },
  });
  const permsOwn = await signedInUser({
    permissions: { permissions: { create: true, viewOwn: true } },
  });

  const usersEditAll = await signedInUser({
    permissions: { users: { view: true, edit: true, delete: true } },
  });

  state.fixture = {
    admin,
    usersEditAll,
    usersViewAll,
    usersOwn,
    permsViewAll,
    permsOwn,
    rowOfOwnActor: await seedUser({
      permissions: {},
      createdBy: usersOwn.user.userId,
    }),
    rowOfAdmin: await seedUser({
      permissions: {},
      createdBy: admin.user.userId,
    }),
  };
}, 30_000);

/** The not-found envelope, which is what a scoped refusal has to be. */
const NOT_FOUND_BODY = {
  success: false,
  message: MSG_NOT_FOUND,
  data: null,
};

/**
 * `perPage=100` is `MAX_PER_PAGE`. The default is 10, and a `toContain` against
 * a truncated first page fails for a reason that has nothing to do with scope.
 */
async function listPage(
  session: SignedInSession,
  path: string
): Promise<{ status: number; ids: string[]; total: number }> {
  const response = await app.handle(
    authedRequest(session, `${path}?perPage=100`)
  );
  const body = (await response.json()) as {
    data?: { id: string }[];
    meta?: { total?: number };
  };
  return {
    status: response.status,
    ids: (body.data ?? []).map((row) => row.id),
    // -1 rather than 0: an absent `meta` must not read as "the total was zero".
    total: body.meta?.total ?? -1,
  };
}

/**
 * A complete admin-update payload. `adminUpdateUserSchema` is `.strict()` and
 * requires name, email, roleId and isActive, so a partial body is a 422 that
 * would look exactly like the authorization refusal under test.
 */
function putUser(
  session: SignedInSession,
  target: { userId: string; email: string; roleId: string },
  overrides: Record<string, unknown> = {}
): Promise<Response> {
  return app.handle(
    authedRequest(session, `/api/dash/users/${target.userId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Renamed By Harness',
        email: target.email,
        roleId: target.roleId,
        isActive: true,
        ...overrides,
      }),
    })
  );
}

describe('`own` scope on GET /api/dash/users', () => {
  test('an actor holding only viewOwn receives exactly the rows it created', async () => {
    const listed = await listPage(fx().usersOwn, '/api/dash/users');

    expect(listed.status).toBe(HTTP_STATUS.OK);
    // The IDS, not the count: a scope predicate dropped from the query returns
    // the right NUMBER of rows on any page size that happens to match.
    expect(listed.ids).toEqual([fx().rowOfOwnActor.userId]);
    expect(listed.ids).not.toContain(fx().rowOfAdmin.userId);
    // Not the actor's own row either — `created_by` is null on it, and "own"
    // means created-by, not is.
    expect(listed.ids).not.toContain(fx().usersOwn.user.userId);
  });

  test('and a total computed under the same filter, which is what stops the count leaking the hidden rows', async () => {
    const listed = await listPage(fx().usersOwn, '/api/dash/users');
    expect(listed.total).toBe(1);
  });

  test('an actor holding unrestricted view receives both rows', async () => {
    // The half that makes the assertion above meaningful: a route that returned
    // nothing at all would satisfy it.
    const listed = await listPage(fx().usersViewAll, '/api/dash/users');

    expect(listed.status).toBe(HTTP_STATUS.OK);
    expect(listed.ids).toContain(fx().rowOfOwnActor.userId);
    expect(listed.ids).toContain(fx().rowOfAdmin.userId);
    expect(listed.total).toBeGreaterThanOrEqual(2);
  });

  test('holding view AND viewOwn resolves to the unrestricted scope in the query', async () => {
    // Supersession, observed at the SQL level rather than in the resolver: the
    // admin fixture holds both grants, and reading the own one first would hide
    // every row it did not create.
    const listed = await listPage(fx().admin, '/api/dash/users');

    expect(listed.ids).toContain(fx().rowOfOwnActor.userId);
    expect(listed.ids).toContain(fx().rowOfAdmin.userId);
  });
});

describe('`own` scope on GET /api/dash/users/:id', () => {
  test('a row the actor did not create answers 404 — not 403, and with no detail about the row', async () => {
    const response = await app.handle(
      authedRequest(fx().usersOwn, `/api/dash/users/${fx().rowOfAdmin.userId}`)
    );

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    // Exactly the standard envelope: no id, no email, no role, nothing that
    // confirms the row is there to be refused.
    expect(await response.json()).toEqual(NOT_FOUND_BODY);
  });

  test('an id that exists nowhere answers identically, so the refusal does not confirm existence', async () => {
    const response = await app.handle(
      authedRequest(fx().usersOwn, `/api/dash/users/${generateUuidV7()}`)
    );

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    expect(await response.json()).toEqual(NOT_FOUND_BODY);
  });

  test('the row the actor did create is served, so the refusal is not blanket', async () => {
    const response = await app.handle(
      authedRequest(
        fx().usersOwn,
        `/api/dash/users/${fx().rowOfOwnActor.userId}`
      )
    );
    const body = (await response.json()) as { data?: { id?: string } };

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(body.data?.id).toBe(fx().rowOfOwnActor.userId);
  });
});

describe('a target whose role outranks the caller', () => {
  /**
   * The privilege-ranking oracle, from the caller who can actually mount it: an
   * actor with `users.view` + `users.edit` and NO `permissions.view`.
   *
   * They can list users (which per `should-ignore.md` #39 shows every non-system
   * user) and send a minimal valid `PUT` at each id. While
   * `validateRolePermissionScope` answered 403 for a target whose role held a
   * permission the actor did not, the two replies were distinguishable: 404
   * meant nonexistent / system-role / not-mine, 403 meant "this account exists
   * and outranks me". That reconstructs the relative privilege ranking of every
   * account without ever granting `permissions.view` — the grant that is
   * supposed to gate exactly that knowledge.
   */
  /**
   * A body that PASSES validation, so the reply comes from the authorization
   * gate rather than from the schema. Both arms send the identical body, and
   * the actor's own `roleId` is used because it is the one role they are
   * certain to be allowed to confer.
   */
  function editAttempt(
    actor: SignedInSession,
    targetId: string,
    email: string
  ): Promise<Response> {
    return app.handle(
      authedRequest(actor, `/api/dash/users/${targetId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Renamed By Probe',
          email,
          isActive: true,
          roleId: actor.user.roleId,
        }),
      })
    );
  }

  test('is refused identically to one that does not exist', async () => {
    // `admin` holds every action on every page, so its role outranks an actor
    // that holds only `users`.
    const outranking = await editAttempt(
      fx().usersEditAll,
      fx().admin.user.userId,
      'probe-outranking@gmail.com'
    );
    const nonexistent = await editAttempt(
      fx().usersEditAll,
      generateUuidV7(),
      'probe-nonexistent@gmail.com'
    );

    expect(outranking.status).toBe(nonexistent.status);
    expect(outranking.status).toBe(HTTP_STATUS.NOT_FOUND);
    expect(await outranking.json()).toEqual(await nonexistent.json());
  });

  test('DELETE answers the same way', async () => {
    const outranking = await app.handle(
      authedRequest(
        fx().usersEditAll,
        `/api/dash/users/${fx().admin.user.userId}`,
        { method: 'DELETE' }
      )
    );

    expect(outranking.status).toBe(HTTP_STATUS.NOT_FOUND);
    expect(await outranking.json()).toEqual(NOT_FOUND_BODY);
  });
});

describe('`own` scope on a WRITE — PUT /api/dash/users/:id', () => {
  test('an editOwn holder is refused a row it did not create, with the not-found shape', async () => {
    const response = await putUser(fx().usersOwn, fx().rowOfAdmin);

    expect(response.status).toBe(HTTP_STATUS.NOT_FOUND);
    expect(await response.json()).toEqual(NOT_FOUND_BODY);
  });

  test('the refused write changed nothing', async () => {
    const rows = await db.execute<{ name: string }>(
      sql`select name from users where id = ${fx().rowOfAdmin.userId}`
    );
    // The seeded name, not the one the refused request carried.
    expect(rows[0]?.name).toBe('Harness User');
  });

  test('and the same holder may edit the row it created', async () => {
    const response = await putUser(fx().usersOwn, fx().rowOfOwnActor);
    expect(response.status).toBe(HTTP_STATUS.OK);
  });
});

describe('`own` scope on GET /api/dash/permissions', () => {
  const roleIds = { ofOwnActor: '', ofAdmin: '' };

  /**
   * The roles are created through the ROUTE. `seedUser` leaves `roles.created_by`
   * null, so a fixture-seeded role can never be "own" — an own-scoped listing
   * over them is empty whether the filter works or not.
   */
  async function createRole(session: SignedInSession): Promise<string> {
    const response = await app.handle(
      authedRequest(session, '/api/dash/permissions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roleName: `harness-role-${generateUuidV7().replaceAll('-', '')}`,
          description: null,
          isActive: true,
          // `viewOwn` alone: `validatePermissionScope` refuses to grant what the
          // actor does not hold, and the own-scoped creator holds only this.
          permissions: [
            { name: 'permissions', permissions: { viewOwn: true } },
          ],
        }),
      })
    );
    const body = (await response.json()) as { data?: { id?: string } };
    if (response.status !== HTTP_STATUS.CREATED || !body.data?.id)
      throw new Error(
        `role create returned ${response.status}: ${JSON.stringify(body)}`
      );
    return body.data.id;
  }

  beforeAll(async () => {
    roleIds.ofOwnActor = await createRole(fx().permsOwn);
    roleIds.ofAdmin = await createRole(fx().admin);
  });

  test('an actor holding only viewOwn receives exactly the roles it created', async () => {
    const listed = await listPage(fx().permsOwn, '/api/dash/permissions');

    expect(listed.status).toBe(HTTP_STATUS.OK);
    expect(listed.ids).toEqual([roleIds.ofOwnActor]);
    expect(listed.ids).not.toContain(roleIds.ofAdmin);
    // Its OWN role — the one `seedUser` gave it — is not "own" either.
    expect(listed.ids).not.toContain(fx().permsOwn.user.roleId);
    expect(listed.total).toBe(1);
  });

  test('an actor holding unrestricted view receives both', async () => {
    const listed = await listPage(fx().permsViewAll, '/api/dash/permissions');

    expect(listed.status).toBe(HTTP_STATUS.OK);
    expect(listed.ids).toContain(roleIds.ofOwnActor);
    expect(listed.ids).toContain(roleIds.ofAdmin);
  });
});

/**
 * One audit row, read with raw SQL.
 *
 * `jsonb_typeof` and `::text` rather than a Drizzle select, for the reason the
 * strategy records: the column mapper JSON-parses a double-encoded string back
 * into an object, so a write-twice/read-twice defect is invisible through it.
 */
interface AuditRow {
  action: string;
  table_name: string;
  record_id: string;
  user_id: string | null;
  user_email: string;
  api_path: string | null;
  ip_address: string | null;
  old_kind: string | null;
  new_kind: string | null;
  changed_kind: string | null;
  new_text: string | null;
  changed_text: string | null;
  /** Keys whose NAME mentions a password, on either side of the event. */
  password_keys: string;
  /** The whole row as JSON, for the "the credential is nowhere in it" half. */
  row_text: string;
  /**
   * `db.execute<T>` constrains `T` to `Record<string, unknown>`, and an
   * interface without an index signature does not satisfy that — the constraint
   * is structural and interfaces are not implicitly indexable. Declaring it here
   * is what lets the named shape above stay a readable contract instead of
   * collapsing to `Record<string, unknown>` at the call site.
   */
  [column: string]: unknown;
}

async function auditRowsFor(
  recordId: string,
  action: string
): Promise<AuditRow[]> {
  // Two shapes have to be reconciled here, and neither is this test's doing.
  // `db.execute` yields a `PgRaw` — thenable but not a `Promise` — so it is
  // awaited rather than returned; and its result type widens to
  // `Record<string, any>[]` regardless of the generic, so the assertion below
  // restores the shape the generic was already given. Earned rather than
  // assumed: the cast names the same type the query was parameterised with, and
  // the column list is spelled out in the SQL directly beneath it.
  const rows = await db.execute<AuditRow>(sql`
    select a.action::text                 as action,
           a.table_name                   as table_name,
           a.record_id                    as record_id,
           a.user_id::text                as user_id,
           a.user_email                   as user_email,
           a.api_path                     as api_path,
           a.ip_address                   as ip_address,
           jsonb_typeof(a.old_data)       as old_kind,
           jsonb_typeof(a.new_data)       as new_kind,
           jsonb_typeof(a.changed_fields) as changed_kind,
           a.new_data::text               as new_text,
           a.changed_fields::text         as changed_text,
           (select coalesce(jsonb_agg(k order by k), '[]'::jsonb)
              from jsonb_object_keys(
                     coalesce(a.old_data, '{}'::jsonb)
                     || coalesce(a.new_data, '{}'::jsonb)
                   ) k
             where k ilike '%password%')::text as password_keys,
           to_jsonb(a)::text              as row_text
      from audit_logs a
     where a.record_id = ${recordId}
       and a.table_name = 'users'
       and a.action::text = ${action}
     order by a.created_at, a.id
  `);

  return rows as AuditRow[];
}

describe('an audit row written by an actual route mutation', () => {
  /** Distinctive, so `not.toContain` on the stored row means something. */
  const CREATED_PASSWORD = 'Harness!Created1';
  const ROTATED_PASSWORD = 'Harness!Rotated2';

  const created: {
    userId: string;
    email: string;
    status: number;
    body: unknown;
    insert: AuditRow | null;
    update: AuditRow | null;
  } = {
    userId: '',
    email: '',
    status: 0,
    body: null,
    insert: null,
    update: null,
  };

  beforeAll(async () => {
    created.email = `harness.audit.${generateUuidV7().replaceAll('-', '').slice(0, 16)}@gmail.com`;

    const response = await app.handle(
      authedRequest(fx().admin, '/api/dash/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Audited Create',
          email: created.email,
          password: CREATED_PASSWORD,
          // A role with no grants at all, so `validateRolePermissionScope`
          // cannot be what decides this request.
          roleId: fx().rowOfAdmin.roleId,
          isActive: true,
        }),
      })
    );

    created.status = response.status;
    created.body = await response.json();
    created.userId =
      (created.body as { data?: { id?: string } }).data?.id ?? '';
    if (!created.userId)
      throw new Error(
        `user create returned ${created.status}: ${JSON.stringify(created.body)}`
      );

    // The target is a user nobody is signed in as: a password change revokes
    // every session the target holds, and doing that to a fixture actor would
    // fail every later test with a 401.
    const updated = await putUser(
      fx().admin,
      {
        userId: created.userId,
        email: created.email,
        roleId: fx().rowOfAdmin.roleId,
      },
      { name: 'Audited Update', password: ROTATED_PASSWORD }
    );
    if (updated.status !== HTTP_STATUS.OK)
      throw new Error(
        `user update returned ${updated.status}: ${await updated.text()}`
      );

    const inserts = await auditRowsFor(created.userId, 'INSERT');
    const updates = await auditRowsFor(created.userId, 'UPDATE');
    created.insert = inserts[0] ?? null;
    created.update = updates[0] ?? null;
  });

  test('the create route answered 201 carrying only the new id', () => {
    expect(created.status).toBe(HTTP_STATUS.CREATED);
    expect(created.body).toEqual({
      success: true,
      message: MSG_CREATED,
      data: { id: created.userId },
    });
  });

  test('POST /api/dash/users wrote exactly one INSERT row, attributed to the actor and the request', async () => {
    const rows = await auditRowsFor(created.userId, 'INSERT');
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row?.table_name).toBe('users');
    expect(row?.record_id).toBe(created.userId);
    // The ACTOR, not the record — an audit row attributed to its own subject is
    // useless during an investigation.
    expect(row?.user_id).toBe(fx().admin.user.userId);
    expect(row?.user_email).toBe(fx().admin.user.email);
    expect(row?.api_path).toBe('/api/dash/users');
    // `getAuditMeta` reads the trusted header, so this is also the proof the
    // request metadata reached the row rather than defaulting to null.
    expect(row?.ip_address).toBe(TEST_IP);
  });

  test("the INSERT row's new_data is a jsonb OBJECT, and there is no before-state to claim", () => {
    // 'string' is precisely what the double encode produced, so it is named.
    expect(created.insert?.new_kind).toBe('object');
    expect(created.insert?.new_kind).not.toBe('string');
    expect(created.insert?.old_kind).toBeNull();
    expect(created.insert?.changed_kind).toBeNull();
  });

  test('the INSERT row records the fields the request actually carried', () => {
    const newData = JSON.parse(created.insert?.new_text ?? 'null') as Record<
      string,
      unknown
    >;
    expect(newData.name).toBe('Audited Create');
    expect(newData.email).toBe(created.email);
    expect(newData.isActive).toBe(true);
  });

  test('the plaintext password reaches no part of the INSERT row, under any key', () => {
    // Two halves. The key rule is what `stripSensitive` implements; the
    // whole-row scan is what catches a future call site that renames the field
    // to something the fragment list does not match.
    expect(JSON.parse(created.insert?.password_keys ?? '[]')).toEqual([]);
    // Anchored first: `not.toContain` against an empty or null scan passes for
    // the wrong reason, and this is the assertion that would go quiet.
    expect(created.insert?.row_text).toContain(created.email);
    expect(created.insert?.row_text).not.toContain(CREATED_PASSWORD);
  });

  test('PUT /api/dash/users/:id wrote exactly one UPDATE row, attributed to the actor and the concrete path', async () => {
    const rows = await auditRowsFor(created.userId, 'UPDATE');
    expect(rows).toHaveLength(1);

    expect(rows[0]?.user_id).toBe(fx().admin.user.userId);
    expect(rows[0]?.user_email).toBe(fx().admin.user.email);
    expect(rows[0]?.api_path).toBe(`/api/dash/users/${created.userId}`);
    expect(rows[0]?.ip_address).toBe(TEST_IP);
  });

  test('the three jsonb columns hold the KIND of the JS value written, and never a string', () => {
    // The invariant that actually generalises, per the strategy's own
    // correction: `changed_fields` is an ARRAY by design, so "object for every
    // jsonb column" would accept a broken write here.
    expect(created.update?.old_kind).toBe('object');
    expect(created.update?.new_kind).toBe('object');
    expect(created.update?.changed_kind).toBe('array');
    expect([
      created.update?.old_kind,
      created.update?.new_kind,
      created.update?.changed_kind,
    ]).not.toContain('string');
  });

  test('changed_fields lists the fields that moved and nothing that did not', () => {
    const changed = JSON.parse(created.update?.changed_text ?? 'null') as
      string[] | null;
    expect(changed).toContain('name');
    // Email, role and isActive were sent unchanged; a diff that reported them
    // would make a real identity change indistinguishable from a no-op edit.
    expect(changed).not.toContain('email');
    expect(changed).not.toContain('roleId');
    expect(changed).not.toContain('isActive');
  });

  test('the boolean flag ABOUT the password survives redaction while the credential does not', () => {
    const newData = JSON.parse(created.update?.new_text ?? 'null') as Record<
      string,
      unknown
    >;
    // `isSensitiveAuditKey` exempts booleans by rule, not by name: dropping this
    // left an admin password reset with no trace in the audit trail at all.
    expect(newData.passwordChanged).toBe(true);
    expect(
      JSON.parse(created.update?.changed_text ?? '[]') as string[]
    ).toContain('passwordChanged');

    // The only password-shaped key on either side is that flag, and the value
    // that was actually sent is nowhere in the row.
    expect(JSON.parse(created.update?.password_keys ?? '[]')).toEqual([
      'passwordChanged',
    ]);
    expect(created.update?.row_text).toContain('Audited Update');
    expect(created.update?.row_text).not.toContain(ROTATED_PASSWORD);
    expect(created.update?.row_text).not.toContain(CREATED_PASSWORD);
  });
});

describe('the maintenance token — the accept path, and the compare that guards it', () => {
  /**
   * Driven through `GET /api/health/storage?deep=1`, which is now the ONLY
   * surface the token guards. The two `/api/internal/*` sweep routes it used to
   * gate are gone — the sweeps run in-process (`lib/schedule.ts`), which is what
   * removed them from the unauthenticated route table entirely.
   *
   * The compare itself is unchanged and shared, so this still covers it: the
   * route calls the same `maintenanceTokenMatches`.
   *
   * Imported from `lib/env.server`, never restated. The value is read at module
   * load, so a test file that sets `process.env.SQLITE_MAINTENANCE_TOKEN`
   * changes nothing — `tests/helpers/preload-base.ts` is what makes an
   * authorised request possible at all.
   */
  const configured = SQLITE_MAINTENANCE_TOKEN;

  /**
   * Same length, different bytes: the only shape that reaches `timingSafeEqual`.
   *
   * Two of them, differing at opposite ends, because a compare that stopped
   * early — or looked at one end only — answers one of them correctly.
   */
  const wrongInLastByte = `${configured.slice(0, -1)}${configured.endsWith('z') ? 'y' : 'z'}`;
  const wrongInFirstByte = `${configured.startsWith('z') ? 'y' : 'z'}${configured.slice(1)}`;

  function deepProbe(token: string | null): Promise<Response> {
    return app.handle(
      new Request('http://localhost/api/health/storage?deep=1', {
        headers: baseHeaders(
          token === null ? {} : { 'x-maintenance-token': token }
        ),
      })
    );
  }

  test('the harness configures a token at all, or every case below is vacuous', () => {
    // Without this the accept path is unreachable and the whole matrix collapses
    // into "unset token always denies" — which is a different property.
    expect(configured.length).toBeGreaterThan(0);
  });

  test('both wrong tokens are the same LENGTH as the configured one, so the length guard cannot answer them', () => {
    // Asserted rather than assumed: `maintenanceTokenMatches` short-circuits on
    // length before `timingSafeEqual` (it must — that function throws on a
    // length mismatch), so a differently-sized probe never reaches the compare
    // and these cases would decay into the short-circuit silently.
    for (const wrong of [wrongInFirstByte, wrongInLastByte]) {
      expect(wrong).toHaveLength(configured.length);
      expect(wrong).not.toBe(configured);
    }
  });

  const refused: [string, string | null][] = [
    ['absent', null],
    ['empty', ''],
    ['wrong in the first byte, same length', wrongInFirstByte],
    ['wrong in the last byte, same length', wrongInLastByte],
    ['the configured token with one byte appended', `${configured}z`],
    ['a proper prefix of the configured token', configured.slice(0, -1)],
  ];

  test.each([...refused])(
    'the deep storage probe refuses a token that is %s',
    async (_label, token) => {
      const response = await deepProbe(token);

      expect(response.status).toBe(HTTP_STATUS.UNAUTHORIZED);
      // Exactly this, for every refusal: nothing about length, nothing about how
      // far the comparison got, and no `www-authenticate` to enumerate against.
      expect(await response.json()).toEqual({ status: 'unauthorized' });
      expect(response.headers.get('www-authenticate')).toBeNull();
    }
  );

  test('the deep storage probe accepts the configured token and runs the deep checks', async () => {
    const response = await deepProbe(configured);
    const body = (await response.json()) as {
      status?: string;
      checks?: Record<string, unknown>;
    };

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(body.status).toBe('ok');
    // The two checks that ONLY the authorised branch adds. Their presence is
    // what distinguishes "accepted" from "answered the cheap branch anyway".
    expect(body.checks?.quickCheck).toBe(true);
    expect(body.checks?.writable).toBe(true);
  });

  test('the cheap probe needs no token and does not run the deep checks', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/health/storage', {
        headers: baseHeaders(),
      })
    );
    const body = (await response.json()) as {
      checks?: Record<string, unknown>;
    };

    expect(response.status).toBe(HTTP_STATUS.OK);
    expect(body.checks).not.toHaveProperty('quickCheck');
    expect(body.checks).not.toHaveProperty('writable');
  });
});
