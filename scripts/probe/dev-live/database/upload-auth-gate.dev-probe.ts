/* eslint-disable unicorn/no-top-level-assignment-in-function --
   Dev probe: module-level fixture ids and the spawned server handle are assigned
   by `beforeAll` and read by the tests and by `afterAll` cleanup. Same shape, and
   same suppression, as the sibling probes. */
/**
 * ⚠️ DEV ONLY — DESTRUCTIVE — DISPOSABLE SERVICES ONLY ⚠️
 *
 * Writes to the real database in `.env` (roles, role permissions, users,
 * sessions) and spawns a real server on `UPLOAD_PROBE_PORT`. Removes what it
 * created. See `scripts/probe/dev-live/README.md`.
 *
 * Run: bun run probe:db
 *
 * ---
 *
 * The authorisation gate on `POST /api/upload/image`.
 *
 * `bun run smoke` already asserts the 401 for an unauthenticated caller. That is
 * the important one, and it is the one that runs in CI — but it is also the only
 * outcome a test without a database can reach, so on its own it proves the route
 * rejects EVERYONE. These four cases are what distinguish a working gate from a
 * closed door:
 *
 *  - no session                      -> 401
 *  - session, no create/edit grant   -> 403
 *  - session, grant, bad `resource`  -> 400
 *  - session, grant, good `resource` -> PAST the gate (400 "no files", from the
 *                                       handler's own body check)
 *
 * The last one is the assertion that matters most and the one a permission test
 * usually omits: a gate that rejects everything passes every negative case. It is
 * asserted via an EMPTY multipart form, so it proves the caller reached body
 * parsing without needing R2 credentials to be present.
 *
 * Sessions are inserted directly and the cookie is signed here, rather than going
 * through `/sign-in/email`: that path runs the captcha plugin and
 * `verifyLoginAttempt`, neither of which this probe is testing. The signature is
 * an HMAC-SHA-256 over the token with `BETTER_AUTH_SECRET`, base64, appended after
 * a `.` and URI-encoded — replicated from `better-call`'s `signCookieValue` rather
 * than imported, because importing a dependency's internal `dist` path is how a
 * probe breaks on a patch release.
 */
import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { rolePermissions, roles, sessions, users } from '@/db/schema';
import { afterAll, beforeAll, expect, test } from 'bun:test';

const PORT = Number(process.env.UPLOAD_PROBE_PORT ?? 3998);
const BASE = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 30_000;

const STAMP = process.env.PROBE_STAMP ?? '900000003';
// `http://` baseURL, so better-auth adds no `__Secure-` prefix. If PUBLIC_URL
// ever becomes https in a dev environment this name changes and every case here
// turns into a 401 — which is why the first test asserts the cookie WORKS rather
// than only asserting failures.
const COOKIE = 'better-auth.session_token';

const GRANTED_TOKEN = `upload-probe-granted-${STAMP}`;
const DENIED_TOKEN = `upload-probe-denied-${STAMP}`;

let server: ReturnType<typeof Bun.spawn>;
let grantedRoleId = '';
let deniedRoleId = '';
let grantedUserId = '';
let deniedUserId = '';

/** `better-call`'s `signCookieValue`, reproduced. */
async function signedCookie(token: string): Promise<string> {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error('BETTER_AUTH_SECRET is required for this probe');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(token)
    .digest('base64');
  return `${COOKIE}=${encodeURIComponent(`${token}.${signature}`)}`;
}

async function waitForBoot(): Promise<boolean> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) return false;
    try {
      await fetch(`${BASE}/api/health/storage`);
      return true;
    } catch {
      await Bun.sleep(250);
    }
  }
  return false;
}

async function seedRole(name: string, grant: boolean): Promise<string> {
  const [role] = await db
    .insert(roles)
    .values({ roleName: name, scope: 'standard', isActive: true })
    .returning({ id: roles.id });

  await db.insert(rolePermissions).values({
    roleId: role!.id,
    pageName: 'users',
    // `create` alone, not both: the route accepts create OR edit, so granting
    // only one proves the OR actually works rather than being satisfied by a
    // caller who happens to hold everything.
    permissions: {
      view: false,
      viewOwn: false,
      edit: false,
      editOwn: false,
      delete: false,
      deleteOwn: false,
      create: grant,
    },
  });

  return role!.id;
}

async function seedUser(
  email: string,
  roleId: string,
  token: string
): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ name: 'Upload gate probe', email, roleId, isActive: true })
    .returning({ id: users.id });

  await db.insert(sessions).values({
    userId: user!.id,
    token,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ipAddress: '127.0.0.1',
  });

  return user!.id;
}

function imageForm(): FormData {
  const form = new FormData();
  form.append(
    'files',
    new File([Buffer.from('89504e470d0a1a0a', 'hex')], 'probe.png', {
      type: 'image/png',
    })
  );
  return form;
}

async function post(
  query: string,
  cookie: string | null,
  body: FormData
): Promise<{ status: number; message: string }> {
  const response = await fetch(`${BASE}/api/upload/image${query}`, {
    method: 'POST',
    headers: cookie ? { cookie } : {},
    body,
  });
  const parsed = (await response.json().catch(() => ({}))) as {
    message?: string;
  };
  return { status: response.status, message: parsed.message ?? '' };
}

beforeAll(async () => {
  grantedRoleId = await seedRole(`upload-granted-${STAMP}`, true);
  deniedRoleId = await seedRole(`upload-denied-${STAMP}`, false);
  grantedUserId = await seedUser(
    `upload-granted-${STAMP}@probe.test`,
    grantedRoleId,
    GRANTED_TOKEN
  );
  deniedUserId = await seedUser(
    `upload-denied-${STAMP}@probe.test`,
    deniedRoleId,
    DENIED_TOKEN
  );

  server = Bun.spawn(['bun', 'server.ts'], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development' },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  if (!(await waitForBoot())) throw new Error('probe server did not boot');
});

afterAll(async () => {
  server?.kill();
  await server?.exited;

  for (const userId of [grantedUserId, deniedUserId]) {
    if (!userId) continue;
    await db.delete(sessions).where(eq(sessions.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  }
  for (const roleId of [grantedRoleId, deniedRoleId]) {
    if (!roleId) continue;
    await db.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
    await db.delete(roles).where(eq(roles.id, roleId));
  }
});

test('a granted session reaches body parsing — the gate is not just closed', async () => {
  // Empty form, so the handler's own "no files" check answers. Reaching it proves
  // the session was accepted, the permission passed, and `readFormData()` ran —
  // without R2 being involved at all.
  const { status, message } = await post(
    '?resource=users',
    await signedCookie(GRANTED_TOKEN),
    new FormData()
  );
  expect(status).toBe(400);
  expect(message).toBe('لم يتم إرسال ملفات');
});

test('no session is rejected with 401', async () => {
  const { status } = await post('?resource=users', null, imageForm());
  expect(status).toBe(401);
});

test('a session without create or edit on the resource is rejected with 403', async () => {
  const { status } = await post(
    '?resource=users',
    await signedCookie(DENIED_TOKEN),
    imageForm()
  );
  expect(status).toBe(403);
});

test('a grant on one resource does not authorise an upload for another', async () => {
  // The granted role holds `create` on `users` only. `permissions` is a real page
  // in the enum, so this is a valid request that must still be refused — the
  // check has to be per-resource, not "holds create anywhere".
  const { status } = await post(
    '?resource=permissions',
    await signedCookie(GRANTED_TOKEN),
    imageForm()
  );
  expect(status).toBe(403);
});

test.each([
  ['missing', ''],
  ['empty', '?resource='],
  ['unknown page', '?resource=nope'],
  ['prototype key', '?resource=__proto__'],
  ['prototype method', '?resource=toString'],
])('an invalid resource (%s) is rejected with 400', async (_, query) => {
  const { status, message } = await post(
    query,
    await signedCookie(GRANTED_TOKEN),
    imageForm()
  );
  expect(status).toBe(400);
  expect(message).toBe('المورد المطلوب رفع الصورة له غير صالح');
});

test('a signed cookie for a session row that does not exist is rejected', async () => {
  // Correctly signed, so this isolates the SESSION lookup from the signature
  // check: a valid signature over a token nobody owns must not authenticate.
  const { status } = await post(
    '?resource=users',
    await signedCookie(`upload-probe-nonexistent-${STAMP}`),
    imageForm()
  );
  expect(status).toBe(401);
});

test('an unsigned cookie is rejected', async () => {
  const { status } = await post(
    '?resource=users',
    `${COOKIE}=${GRANTED_TOKEN}`,
    imageForm()
  );
  expect(status).toBe(401);
});
