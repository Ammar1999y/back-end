import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import { accounts, rolePermissions, roles, users } from '@/db/schema';
import { WSDB } from '@/db/ws';
import { isUniqueViolation, sanitizeForLog, validID } from '@/utils';
import { v7 as uuidv7 } from 'uuid';
import { hashPassword } from '@/lib/auth';
import { checkUserPermission } from '@/lib/permissions/checker';
import {
  CUSTOM_ROLE_VALUE,
  PermissionAction,
  SUPER_ADMIN_ROLE,
} from '@/lib/permissions/constants';
import { refreshUserSessions } from '@/lib/permissions/utils';

import { CustomError } from '@/utils/error-class';
import { updateUserSchema } from '@/utils/validation/auth';
import { idRequired } from '@/utils/validation/rules';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: _id } = await params;
    const userId = validID(_id);
    if (!userId) throw new CustomError(idRequired, 422);
    await checkUserPermission({
      headers: await headers(),
      resource: 'users',
      action: 'view',
    });

    const userData = await db.query.users.findFirst({
      where: (users, { eq }) => eq(users.id, userId),
      columns: {
        id: true,
        name: true,
        email: true,
        isActive: true,
        roleId: true,
        createdAt: true,
        updatedAt: true,
      },
      with: {
        role: {
          columns: {
            id: true,
            roleName: true,
            scope: true,
          },
          with: {
            rolePermissions: true,
          },
        },
      },
    });

    if (!userData) throw new CustomError('المستخدم غير موجود', 404);

    // Prevent viewing super admin users
    if (userData.role?.roleName === SUPER_ADMIN_ROLE)
      throw new CustomError('المستخدم غير موجود', 404);

    if (!userData.roleId)
      throw new CustomError('ليس من مستخدمين لوحة التحكم', 400);

    // Map role permissions for the response
    const permissions =
      userData.role?.rolePermissions?.map((p) => ({
        name: p.pageName,
        permissions: p.permissions,
      })) || [];

    return NextResponse.json(
      {
        data: {
          id: userData.id,
          name: userData.name,
          email: userData.email,
          isActive: userData.isActive,
          // Return 'custom' for custom-scoped roles so the form knows to show permissions editor
          roleId:
            userData.role?.scope === 'custom'
              ? CUSTOM_ROLE_VALUE
              : userData.roleId,
          role: userData.role
            ? {
                id: userData.role.id,
                roleName: userData.role.roleName,
                scope: userData.role.scope,
              }
            : null,
          createdAt: userData.createdAt,
          updatedAt: userData.updatedAt,
          permissions,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof CustomError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }

    console.error(sanitizeForLog(error));
    return NextResponse.json(
      { error: 'حدث خطأ أثناء جلب بيانات المستخدم' },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let poolOpened = false;
  try {
    const { id } = await params;

    const body = await request.json();

    const validatedDataParsed = updateUserSchema.safeParse({
      ...body,
      id,
    });

    if (!validatedDataParsed.success)
      throw new CustomError(validatedDataParsed.error.issues[0].message, 422);

    await checkUserPermission({
      headers: await headers(),
      resource: 'users',
      action: 'edit',
    });

    const userId = validatedDataParsed.data.id;
    const validatedData = validatedDataParsed.data;
    const password = validatedDataParsed.data.password;

    const { db: tdb, pool } = WSDB();
    poolOpened = true;
    try {
      await tdb.transaction(async (tx) => {
        // Check if user exists and is not super admin
        const existingUser = await tx.query.users.findFirst({
          where: (users, { eq }) => eq(users.id, userId),
          columns: { roleId: true },
          with: {
            role: { columns: { id: true, roleName: true, scope: true } },
          },
        });

        if (!existingUser || existingUser.role?.roleName === SUPER_ADMIN_ROLE)
          throw new CustomError('المستخدم غير موجود', 404);

        const isCurrentlyCustom = existingUser.role?.scope === 'custom';
        const isNewCustom = validatedData.roleId === CUSTOM_ROLE_VALUE;

        let assignedRoleId: string;

        if (isNewCustom && validatedData.permissions?.length) {
          if (isCurrentlyCustom && existingUser.roleId) {
            // Update existing custom role's permissions
            assignedRoleId = existingUser.roleId;
            await tx
              .delete(rolePermissions)
              .where(eq(rolePermissions.roleId, assignedRoleId));
          } else {
            // Create a new custom role
            const [customRole] = await tx
              .insert(roles)
              .values({
                roleName: `custom-${uuidv7()}`,
                scope: 'custom',
                isActive: true,
              })
              .returning({ id: roles.id });
            assignedRoleId = customRole.id;
          }

          const permsData = validatedData.permissions.map((p) => ({
            roleId: assignedRoleId,
            pageName: p.name,
            permissions: p.permissions as Record<PermissionAction, boolean>,
          }));
          await tx.insert(rolePermissions).values(permsData);
        } else {
          assignedRoleId = validatedData.roleId;

          // If switching from custom to standard, delete the old custom role
          if (isCurrentlyCustom && existingUser.roleId) {
            await tx.delete(roles).where(eq(roles.id, existingUser.roleId));
          }
        }

        const [userUpdated] = await tx
          .update(users)
          .set({
            name: validatedData.name,
            email: validatedData.email,
            isActive: validatedData.isActive,
            roleId: assignedRoleId,
          })
          .where(eq(users.id, userId))
          .returning({ id: users.id });

        if (!userUpdated) throw new CustomError('المستخدم غير موجود', 404);

        if (password)
          await tx
            .update(accounts)
            .set({
              password: await hashPassword(password),
            })
            .where(
              and(
                eq(accounts.userId, userId),
                eq(accounts.providerId, 'credential')
              )
            );
      });

      if (validatedData?.permissions !== undefined)
        await refreshUserSessions(userId);

      return NextResponse.json(
        {
          success: true,
          message: 'تم تحديث المستخدم بنجاح',
        },
        { status: 200 }
      );
    } finally {
      if (poolOpened) await pool.end();
    }
    // يجب ان يصل هنا فقط اذا تمت transaction بنجاح، والى يتم تحويل الخطاء الي catch الاخيره
  } catch (error) {
    if (isUniqueViolation(error))
      return NextResponse.json(
        { error: 'البريد الإلكتروني أو رقم الهاتف مستخدم بالفعل' },
        { status: 409 }
      );

    if (error instanceof CustomError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }

    console.error(sanitizeForLog(error));
    return NextResponse.json(
      { error: 'حدث خطأ أثناء تحديث المستخدم' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: _id } = await params;
    const userId = validID(_id);
    if (!userId) throw new CustomError(idRequired, 422);

    await checkUserPermission({
      headers: await headers(),
      resource: 'users',
      action: 'delete',
    });

    // Check if user exists, excluding superAdmin users
    const existingUser = await db.query.users.findFirst({
      where: (users, { eq, and, isNotNull }) =>
        and(eq(users.id, userId), isNotNull(users.roleId)),
      with: {
        role: { columns: { roleName: true, scope: true } },
      },
    });

    if (!existingUser || existingUser.role?.roleName === SUPER_ADMIN_ROLE)
      throw new CustomError('المستخدم غير موجود', 404);

    const customRoleId =
      existingUser.role?.scope === 'custom' ? existingUser.roleId : null;

    // Delete user first (cascades to accounts/sessions)
    await db.delete(users).where(eq(users.id, userId));

    // Clean up custom role if one existed
    if (customRoleId) {
      await db.delete(roles).where(eq(roles.id, customRoleId));
    }

    return NextResponse.json(
      {
        success: true,
        message: 'تم حذف المستخدم بنجاح',
      },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof CustomError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }

    console.error(sanitizeForLog(error));
    return NextResponse.json(
      { error: 'حدث خطأ أثناء حذف المستخدم' },
      { status: 500 }
    );
  }
}
