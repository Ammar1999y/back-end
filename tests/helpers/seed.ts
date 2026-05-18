import { sql, and, eq } from 'drizzle-orm';

import { hashPassword } from 'better-auth/crypto';

import {
  accounts,
  rolePermissions,
  roles,
  users,
  verificationCodes,
  verificationSessions,
} from '@/db/schema';
import type { EntityID } from '@/types';
import type {
  DashboardPage,
  PermissionAction,
} from '@/lib/permissions/constants';
import { DEFAULT_PAGE_PERMISSIONS } from '@/lib/permissions/constants';

import { tdb, tag, tagEmail } from './db';

export const DEFAULT_PASSWORD = 'TestPass1!@#';

export type PagePerms = Partial<Record<PermissionAction, boolean>>;
export type RolePerms = Partial<Record<DashboardPage, PagePerms>>;

function fullPermsForRole(perms: RolePerms) {
  const rows: Array<{ pageName: DashboardPage; permissions: Record<PermissionAction, boolean> }> = [];
  for (const page of DEFAULT_PAGE_PERMISSIONS) {
    const set = perms[page.name];
    if (!set) continue;
    const pagePerms = {} as Record<PermissionAction, boolean>;
    for (const action of page.availablePermissions) {
      pagePerms[action] = set[action] === true;
    }
    rows.push({ pageName: page.name, permissions: pagePerms });
  }
  return rows;
}

const ALL_TRUE: RolePerms = {
  home: { view: true },
  users: {
    view: true,
    viewOwn: true,
    edit: true,
    editOwn: true,
    delete: true,
    deleteOwn: true,
    create: true,
  },
  permissions: {
    view: true,
    viewOwn: true,
    edit: true,
    editOwn: true,
    delete: true,
    deleteOwn: true,
    create: true,
  },
};

interface CreateRoleOpts {
  name?: string;
  description?: string | null;
  isActive?: boolean;
  scope?: 'system' | 'standard' | 'custom';
  permissions?: RolePerms;
  createdBy?: EntityID | null;
}

export async function createRole(opts: CreateRoleOpts = {}): Promise<{
  id: EntityID;
  roleName: string;
}> {
  const roleName = opts.name ?? tag(`role-${Math.random().toString(36).slice(2, 8)}`);
  const [role] = await tdb
    .insert(roles)
    .values({
      roleName,
      description: opts.description ?? null,
      isActive: opts.isActive ?? true,
      scope: opts.scope ?? 'standard',
      createdBy: opts.createdBy ?? null,
    })
    .returning({ id: roles.id });

  const permsRows = fullPermsForRole(opts.permissions ?? ALL_TRUE).map((p) => ({
    roleId: role.id,
    pageName: p.pageName,
    permissions: p.permissions,
  }));
  if (permsRows.length) await tdb.insert(rolePermissions).values(permsRows);

  return { id: role.id, roleName };
}

interface CreateUserOpts {
  email?: string;
  password?: string;
  name?: string;
  roleId: EntityID | null;
  isActive?: boolean;
  emailVerified?: boolean;
  phoneNumber?: string | null;
  phoneNumberVerified?: boolean;
  createdBy?: EntityID | null;
}

export interface SeededUser {
  id: EntityID;
  email: string;
  password: string;
  name: string;
  roleId: EntityID | null;
}

export async function createUser(opts: CreateUserOpts): Promise<SeededUser> {
  const email = (opts.email ?? tagEmail(`u${Math.random().toString(36).slice(2, 8)}`)).toLowerCase();
  const password = opts.password ?? DEFAULT_PASSWORD;
  const name = opts.name ?? tag('User');

  const [user] = await tdb
    .insert(users)
    .values({
      name,
      email,
      roleId: opts.roleId ?? null,
      isActive: opts.isActive ?? true,
      emailVerified: opts.emailVerified ?? true,
      phoneNumber: opts.phoneNumber ?? null,
      phoneNumberVerified: opts.phoneNumberVerified ?? false,
      createdBy: opts.createdBy ?? null,
    })
    .returning({ id: users.id });

  const hashed = await hashPassword(password);
  await tdb.insert(accounts).values({
    accountId: user.id,
    providerId: 'credential',
    userId: user.id,
    password: hashed,
  });

  return { id: user.id, email, password, name, roleId: opts.roleId ?? null };
}

/**
 * Insert a verification session + verification code row with a known plaintext
 * code. Used by OTP verify tests to bypass the (unknowable) hashed value the
 * /send endpoint would have stored.
 */
export async function seedOtp({
  userId,
  channel,
  identifier,
  code = '123456',
  expiresInMs = 10 * 60 * 1000,
}: {
  userId: EntityID;
  channel: 'email' | 'sms' | 'whatsapp';
  identifier: string;
  code?: string;
  expiresInMs?: number;
}) {
  await tdb
    .delete(verificationSessions)
    .where(
      and(
        eq(verificationSessions.userId, userId),
        eq(verificationSessions.channel, channel)
      )
    );

  const [session] = await tdb
    .insert(verificationSessions)
    .values({
      userId,
      channel,
      identifier,
      attemptNumber: 1,
      verifyAttemptNumber: 0,
      verifyAttemptDaily: 0,
      lastSentAt: new Date().toISOString(),
      nextAllowedAt: new Date(Date.now() - 1000).toISOString(),
    })
    .returning({ id: verificationSessions.id });

  const hashedCode = await hashPassword(code);
  await tdb.insert(verificationCodes).values({
    sessionId: session.id,
    code: hashedCode,
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  });

  return { sessionId: session.id, plaintextCode: code };
}

export async function setUserEmailVerified(userId: EntityID, verified: boolean) {
  await tdb.execute(sql`UPDATE users SET email_verified = ${verified} WHERE id = ${userId}`);
}

export async function deleteRoleHard(roleId: EntityID) {
  await tdb.delete(roles).where(eq(roles.id, roleId));
}

export { ALL_TRUE as ALL_PERMISSIONS };
