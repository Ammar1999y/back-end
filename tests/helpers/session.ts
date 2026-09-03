/**
 * Seeding a user and getting a cookie Better Auth will accept.
 *
 * **The cookie comes from the real sign-in endpoint.** Hand-forging one means
 * reimplementing Better Auth's signing, which is both the thing most likely to
 * drift and the thing whose drift a forged cookie would hide: a complete
 * authentication outage once passed `tsc --noEmit` and 150/150 probes because
 * nothing in the suite ever signed anybody in.
 *
 * **Sign in once per file, in `beforeAll`.** The password KDF is Argon2id at
 * 64 MiB; a `beforeEach` sign-in makes every file pay it per test.
 *
 * Three seeding details are recorded here rather than rediscovered, because each
 * one fails as a plain 401 that looks exactly like a broken login:
 *
 * - **Ids must be UUID v7.** `validID` rejects v4, and the rejection surfaces
 *   from the session-create hook.
 * - **The email domain must be one `emailSchema` allows** (gmail, outlook,
 *   hotmail, live, yahoo), or a 422 lands before Better Auth is reached.
 * - **The request needs `cf-connecting-ip` and `x-captcha-response`.** The
 *   per-IP limiter fails closed with no trusted header, and the captcha check
 *   fails closed with no token.
 */
import type {
  DashboardPage,
  PermissionAction,
} from '@/lib/permissions/constants';

import { eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import { accounts, rolePermissions, roles, users } from '@/db/schema';
import { hashPassword } from '@/lib/auth/password';
import { generateUuidV7 } from '@/lib/id';
import {
  DEFAULT_PAGE_PERMISSIONS,
  ROLE_SCOPE,
} from '@/lib/permissions/constants';

import {
  CREDENTIAL_ISSUER,
  CREDENTIAL_PROVIDER_ID,
} from '@/utils/api-messages';

import { assertHarnessDatabase } from './database';

/**
 * Satisfies `passwordSchema`: lower, upper, digit, symbol, at least its minimum.
 *
 * Module-private: every seeded user carries its own `password`, so a caller that
 * needs the value already has it and one that reads the constant is coupling to
 * the fixture's internals.
 */
const TEST_PASSWORD = 'Harness!Passw0rd';

/** Any address the limiter's `IP_SCHEMA` accepts; documentation range. */
export const TEST_IP = '203.0.113.7';

export interface SeededUser {
  userId: string;
  roleId: string;
  email: string;
  password: string;
}

export interface SeedOptions {
  /**
   * Per-page grants. Omitted means every action on every page — the shape an
   * admin fixture needs, and the one `DEFAULT_PAGE_PERMISSIONS` describes.
   */
  permissions?: Partial<
    Record<DashboardPage, Partial<Record<PermissionAction, boolean>>>
  >;
  isActive?: boolean;
  roleActive?: boolean;
  /** `system` roles are protected from edits; `standard` is the normal case. */
  roleScope?: (typeof ROLE_SCOPE)[keyof typeof ROLE_SCOPE];
  /** Sets `users.created_by`, which the `own`-scoped permission paths read. */
  createdBy?: string;
  emailVerified?: boolean;
  /**
   * A Saudi number matching `chk_phone_number_format`. Omitted leaves the column
   * null, which is what `PHONE_NUMBER_MODE: 'optional'` allows and what every
   * fixture predating the second factor assumes.
   */
  phoneNumber?: string;
  phoneNumberVerified?: boolean;
}

/**
 * Sequential, not derived from a UUID: the last eight digits of a v7 collide at
 * roughly 10^4 seeds per table reset, and `ux_users_phone_number` turns that into
 * a flake nobody can reproduce.
 */
const nextPhoneSuffix = (() => {
  let n = 0;
  return () => {
    n += 1;
    return String(n).padStart(8, '0');
  };
})();

/**
 * Unique per call, in the one shape `chk_phone_number_format` accepts.
 *
 * `ux_users_phone_number` is unique over live rows, so two seeds in one file
 * would collide on a fixed value the same way a fixed email would.
 */
export function uniquePhone(): string {
  return `9665${nextPhoneSuffix()}`;
}

/** Unique per call, so two seeds in one file cannot collide on the email index. */
function uniqueEmail(): string {
  return `harness.${generateUuidV7().replaceAll('-', '').slice(0, 20)}@gmail.com`;
}

function everyPermission(): SeedOptions['permissions'] {
  return Object.fromEntries(
    DEFAULT_PAGE_PERMISSIONS.map((page) => [
      page.name,
      Object.fromEntries(
        page.availablePermissions.map((action) => [action, true])
      ),
    ])
  ) as SeedOptions['permissions'];
}

/**
 * Inserts a role, its permission rows, a user and a credential account.
 *
 * Direct SQL rather than `POST /api/dev/sign-up`, and deliberately: that route
 * grants every default permission on a `system`-scoped role, which is the one
 * shape the authorization tests cannot use — a protected system role behaves
 * differently from every real one. `signUpThroughDevRoute` below is the real-path
 * variant, for the assertions that are about the route itself.
 */
export async function seedUser(options: SeedOptions = {}): Promise<SeededUser> {
  // Not only `resetTables`: a file that seeds without truncating first would
  // otherwise insert harness users into whatever `DATABASE_URL` happens to name.
  await assertHarnessDatabase();

  const roleId = generateUuidV7();
  const userId = generateUuidV7();
  const email = uniqueEmail();
  const scope = options.roleScope ?? ROLE_SCOPE.STANDARD;

  await db.insert(roles).values({
    id: roleId,
    // `chk_custom_prefix_scope` ties the `custom-` prefix to the custom scope, so
    // the name has to be derived from the scope rather than picked freely.
    //
    // The WHOLE id, not `slice(0, 8)`. A UUID v7's leading hex digits are its
    // TIMESTAMP, so a truncated prefix is identical for every role seeded in the
    // same millisecond — two `seedUser()` calls in one `beforeAll` collided on
    // `ux_roles_role_name`. 40 characters against a `ROLE_NAME_MAX` of 100.
    roleName: `${scope === ROLE_SCOPE.CUSTOM ? 'custom-' : ''}harness-${roleId.replaceAll('-', '')}`,
    scope,
    isActive: options.roleActive ?? true,
  });

  const grants = options.permissions ?? everyPermission();
  const rows = Object.entries(grants ?? {}).map(([pageName, actions]) => ({
    id: generateUuidV7(),
    roleId,
    pageName: pageName as (typeof rolePermissions.$inferInsert)['pageName'],
    permissions:
      actions as (typeof rolePermissions.$inferInsert)['permissions'],
  }));
  if (rows.length > 0) await db.insert(rolePermissions).values(rows);

  await db.insert(users).values({
    id: userId,
    name: 'Harness User',
    email,
    roleId,
    isActive: options.isActive ?? true,
    emailVerified: options.emailVerified ?? true,
    phoneNumber: options.phoneNumber ?? null,
    phoneNumberVerified: options.phoneNumberVerified ?? false,
    createdBy: options.createdBy ?? null,
  });

  await db.insert(accounts).values({
    id: generateUuidV7(),
    // `(issuer, accountId)` is the pair Better Auth 1.7 resolves an account by;
    // `accountId` is the user id here for the same reason the production insert
    // sites use it.
    accountId: userId,
    issuer: CREDENTIAL_ISSUER,
    providerId: CREDENTIAL_PROVIDER_ID,
    userId,
    password: await hashPassword(TEST_PASSWORD),
  });

  return { userId, roleId, email, password: TEST_PASSWORD };
}

/** The headers every request through the app needs to get past admission. */
export function baseHeaders(
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    'cf-connecting-ip': TEST_IP,
    // Any value passes: the egress guard answers siteverify with success.
    'x-captcha-response': 'harness-captcha-token',
    ...extra,
  };
}

export interface SignedInSession {
  user: SeededUser;
  /** Ready to put straight into a request's `cookie` header. */
  cookie: string;
  /** The raw `Set-Cookie` values, for assertions about attributes. */
  setCookie: string[];
}

/**
 * Signs in through `POST /api/auth/sign-in/email` and returns the cookie.
 *
 * Throws on a non-200 with the body attached: a 401 here is the signature of the
 * account-model defect this fixture exists to keep visible, and swallowing it
 * would make every authenticated test fail somewhere less informative.
 */
export async function signIn(user: SeededUser): Promise<SignedInSession> {
  const response = await app.handle(
    new Request('http://localhost/api/auth/sign-in/email', {
      method: 'POST',
      headers: baseHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ email: user.email, password: user.password }),
    })
  );

  if (response.status !== 200) {
    const body = await response.text();
    throw new Error(
      `sign-in returned ${response.status} for a correct password. Body: ${body}`
    );
  }

  const setCookie = response.headers.getSetCookie();
  const cookie = setCookie.map((value) => value.split(';', 1)[0]).join('; ');
  if (!cookie) throw new Error('sign-in returned 200 but set no cookie');

  return { user, cookie, setCookie };
}

/**
 * Opens the administrator re-authentication window on an existing session.
 *
 * ⚠️ Needed by every test that performs an action in the `D12` class — the user
 * edit, the user delete, permission mutation, the two-factor reset. Those all
 * require a password proof that is FRESH, not merely a session, and it is bound
 * to the session so there is nothing to thread through the request: the same
 * cookie carries it afterwards.
 */
export async function openReauthWindow(
  user: SeededUser,
  cookie: string
): Promise<void> {
  const response = await app.handle(
    new Request('http://localhost/api/dash/auth/reauth', {
      method: 'POST',
      headers: baseHeaders({
        'content-type': 'application/json',
        cookie,
      }),
      body: JSON.stringify({ password: user.password }),
    })
  );
  if (response.status !== 200)
    throw new Error(
      `re-authentication returned ${response.status}: ${await response.text()}`
    );
}

/**
 * Sign in AND open the re-authentication window, for a fixture that is going to
 * perform an action in the `D12` class.
 */
export async function signInAsAdmin(
  user: SeededUser
): Promise<SignedInSession> {
  const session = await signIn(user);
  await openReauthWindow(user, session.cookie);
  return session;
}

/**
 * Seed, sign in, and open the re-authentication window — which is what most
 * `beforeAll` blocks want, because most of them go on to perform an action in
 * the `D12` class.
 *
 * ⚠️ A test that asserts the re-authentication REFUSAL must not use this. Use
 * `seedUser` + `signIn` and leave the window closed.
 */
export async function signedInUser(
  options: SeedOptions = {}
): Promise<SignedInSession> {
  return signInAsAdmin(await seedUser(options));
}

/** An authenticated request against the real route table. */
export function authedRequest(
  session: SignedInSession,
  url: string,
  init: RequestInit = {}
): Request {
  const headers = new Headers(baseHeaders());
  headers.set('cookie', session.cookie);
  const overrides = new Headers(init.headers ?? {});
  for (const [key, value] of overrides) headers.set(key, value);
  return new Request(new URL(url, 'http://localhost'), { ...init, headers });
}

/**
 * Creates a user through the real dev route.
 *
 * Only for the assertions that are about that path — §7.7b's account-row check,
 * and anything that has to prove a user created the way production creates one
 * can sign in. It needs `NODE_ENV=development`, which the database tiers run
 * under; under `bun test`'s default `NODE_ENV=test` the route answers 403.
 */
export async function signUpThroughDevRoute(): Promise<{
  status: number;
  userId: string | null;
  email: string;
  password: string;
}> {
  const email = uniqueEmail();
  const response = await app.handle(
    new Request('http://localhost/api/dev/sign-up', {
      method: 'POST',
      headers: baseHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        name: 'Harness Signup',
        email,
        password: TEST_PASSWORD,
      }),
    })
  );

  const body = (await response.json()) as { data?: { id?: string } };
  return {
    status: response.status,
    userId: body.data?.id ?? null,
    email,
    password: TEST_PASSWORD,
  };
}

/**
 * Merges new `Set-Cookie` values over an existing jar, the way a browser would.
 *
 * A plain replace loses state the flows here accumulate across responses: the
 * challenge flow clears the session cookie and sets its own, a remembered login
 * clears the `dont_remember` marker, and a trusted device adds a cookie the next
 * sign-in has to carry. An empty value deletes the entry.
 */
export function mergeCookies(jar: string, setCookie: string[]): string {
  const map = new Map<string, string>();
  for (const pair of jar.split('; ')) {
    if (!pair) continue;
    const [name, ...rest] = pair.split('=');
    if (name) map.set(name, rest.join('='));
  }
  for (const raw of setCookie) {
    const [pair] = raw.split(';', 1);
    const [name, ...rest] = (pair ?? '').split('=');
    if (!name) continue;
    const value = rest.join('=');
    if (value === '') map.delete(name);
    else map.set(name, value);
  }
  return [...map].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** The account row Better Auth's sign-in lookup matches on. */
export async function accountRowFor(userId: string) {
  const [row] = await db
    .select({
      accountId: accounts.accountId,
      issuer: accounts.issuer,
      providerId: accounts.providerId,
    })
    .from(accounts)
    .where(eq(accounts.userId, userId));
  return row ?? null;
}
