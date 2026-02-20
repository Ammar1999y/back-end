import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { and, eq, ne, sql } from 'drizzle-orm';

import { db } from '@/db';
import { rolePermissions, roles } from '@/db/schema';
import { WSDB } from '@/db/ws';
import { PermissionClient as Permission } from '@/types/permission';
import { isUniqueViolation, sanitizeForLog, validID } from '@/utils';
import { checkUserPermission } from '@/lib/permissions/checker';
import {
  PermissionAction,
  SUPER_ADMIN_ROLE,
} from '@/lib/permissions/constants';
import { refreshRoleSessions } from '@/lib/permissions/utils';

import { CustomError } from '@/utils/error-class';
import { updatePermissionSchema } from '@/utils/validation/permissions';
import { idRequired } from '@/utils/validation/rules';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: _id } = await params;
    const roleId = validID(_id);
    if (!roleId) throw new CustomError(idRequired, 422);
    await checkUserPermission({
      headers: await headers(),
      resource: 'permissions',
      action: 'view',
    });

    const roleData = await db.query.roles.findFirst({
      where: (roles, { eq, and, ne }) =>
        and(eq(roles.id, roleId), ne(roles.roleName, SUPER_ADMIN_ROLE)),
      with: {
        rolePermissions: true,
      },
    });

    if (!roleData) throw new CustomError('الصلاحية غير موجودة', 404);

    return NextResponse.json(
      {
        data: {
          id: roleData.id,
          roleName: roleData.roleName,
          description: roleData.description,
          isActive: roleData.isActive,
          permissions: roleData.rolePermissions.map((p) => ({
            name: p.pageName,
            permissions: p.permissions,
          })),
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
      { error: 'حدث خطأ أثناء جلب بيانات الصلاحية' },
      { status: 500 }
    );
  }
}

// PUT /api/dash/permissions/[id] - Update role
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let poolOpened = false;
  try {
    const { id } = await params;

    const body = await request.json();

    const validatedDataParsed = updatePermissionSchema.safeParse({
      ...body,
      id,
    });

    if (!validatedDataParsed.success)
      throw new CustomError(validatedDataParsed.error.issues[0].message, 422);

    await checkUserPermission({
      headers: await headers(),
      resource: 'permissions',
      action: 'edit',
    });

    const roleId = validatedDataParsed.data.id;
    const validatedData = validatedDataParsed.data;

    if (validatedData.roleName === SUPER_ADMIN_ROLE)
      throw new CustomError(`لا يمكن تغيير الاسم إلى ${SUPER_ADMIN_ROLE}`, 400);

    const { db: tdb, pool } = WSDB();
    poolOpened = true;
    let updatedRole: Partial<Permission> = {};

    try {
      await tdb.transaction(async (tx) => {
        // Get the old role name before updating
        const existingRole = await tx.query.roles.findFirst({
          where: (roles, { eq, and, ne }) =>
            and(eq(roles.id, roleId), ne(roles.roleName, SUPER_ADMIN_ROLE)),
          columns: {
            roleName: true,
          },
        });

        if (!existingRole) throw new CustomError('الصلاحية غير موجودة', 404);

        // Update the role
        const [roleUpdated] = await tx
          .update(roles)
          .set({
            roleName: validatedData.roleName,
            description: validatedData.description,
            isActive: validatedData.isActive,
          })
          .where(
            and(eq(roles.id, roleId), ne(roles.roleName, SUPER_ADMIN_ROLE))
          )
          .returning({ id: roles.id });

        if (!roleUpdated) throw new CustomError('الصلاحية غير موجودة', 404);

        if (validatedData?.permissions?.length) {
          const permissionsData = validatedData.permissions.map((p) => ({
            roleId: roleId,
            pageName: p.name,
            permissions: p.permissions as Record<PermissionAction, boolean>,
          }));

          await tx
            .delete(rolePermissions)
            .where(eq(rolePermissions.roleId, roleId));

          await tx.insert(rolePermissions).values(permissionsData);

          await refreshRoleSessions(roleId, tx);
        }

        updatedRole = {
          id: roleId,
          roleName: validatedData.roleName,
          description: validatedData.description,
          isActive: validatedData.isActive,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      });

      return NextResponse.json(
        {
          data: updatedRole,
          success: true,
          message: 'تم تحديث الصلاحية بنجاح',
        },
        { status: 200 }
      );
    } finally {
      if (poolOpened) await pool.end();
    }
  } catch (error) {
    if (isUniqueViolation(error))
      return NextResponse.json(
        { error: 'اسم الصلاحية موجود بالفعل، قم بتغيره' },
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
      { error: 'حدث خطأ أثناء تحديث الصلاحية' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let poolOpened = false;

  try {
    const { id: _id } = await params;
    const roleId = validID(_id);
    if (!roleId) throw new CustomError(idRequired, 422);

    await checkUserPermission({
      headers: await headers(),
      resource: 'permissions',
      action: 'delete',
    });

    const { db: tdb, pool } = WSDB();
    poolOpened = true;
    try {
      await tdb.transaction(async (tx) => {
        const [existingRole] = await tx
          .select({ id: roles.id })
          .from(roles)
          .where(
            and(eq(roles.id, roleId), ne(roles.roleName, SUPER_ADMIN_ROLE))
          )
          .for('update');
        if (!existingRole) throw new CustomError('الصلاحية غير موجودة', 404);

        // Check users while row is locked
        const [{ exists }] = (
          await tx.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM users WHERE role_id = ${roleId}
      ) AS "exists"
    `)
        ).rows;
        if (exists)
          throw new CustomError(
            'لا يمكن حذف هذه الصلاحية لأنها مرتبطة بمستخدمين',
            400
          );

        await tx.delete(roles).where(eq(roles.id, roleId));
      });
    } finally {
      if (poolOpened) await pool.end();
    }

    return NextResponse.json(
      {
        success: true,
        message: 'تم حذف الصلاحية بنجاح',
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
      { error: 'حدث خطأ أثناء حذف الصلاحية' },
      { status: 500 }
    );
  }
}
