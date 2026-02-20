import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { and, count, desc, eq, ne } from 'drizzle-orm';

import { db } from '@/db';
import { rolePermissions, roles, users } from '@/db/schema';
import { WSDB } from '@/db/ws';
import { PermissionClient as Permission } from '@/types/permission';
import { isUniqueViolation, sanitizeForLog } from '@/utils';
import { checkUserPermission } from '@/lib/permissions/checker';
import {
  PermissionAction,
  SUPER_ADMIN_ROLE,
} from '@/lib/permissions/constants';

import { CustomError } from '@/utils/error-class';
import { createPermissionSchema } from '@/utils/validation/permissions';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await checkUserPermission({
      headers: await headers(),
      resource: 'permissions',
      action: 'view',
    });

    const rolesWithCounts = await db
      .select({
        id: roles.id,
        roleName: roles.roleName,
        description: roles.description,
        isActive: roles.isActive,
        createdAt: roles.createdAt,
        updatedAt: roles.updatedAt,
        usersCount: count(users.id),
      })
      .from(roles)
      .leftJoin(users, eq(users.roleId, roles.id))
      .where(
        and(eq(roles.scope, 'standard'), ne(roles.roleName, SUPER_ADMIN_ROLE))
      )
      .groupBy(roles.id)
      .orderBy(desc(roles.createdAt));

    return NextResponse.json({ data: rolesWithCounts }, { status: 200 });
  } catch (error) {
    if (error instanceof CustomError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error(sanitizeForLog(error));
    return NextResponse.json(
      { error: 'فشل في جلب الصلاحيات' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  let poolOpened = false;
  try {
    await checkUserPermission({
      headers: await headers(),
      resource: 'permissions',
      action: 'create',
    });

    const body = await request.json();

    const validatedDataParsed = createPermissionSchema.safeParse(body);
    if (!validatedDataParsed.success)
      throw new CustomError(validatedDataParsed.error.issues[0].message, 422);

    const validatedData = validatedDataParsed.data;

    if (validatedData.roleName === SUPER_ADMIN_ROLE)
      throw new CustomError(`لا يمكن إنشاء دور باسم ${SUPER_ADMIN_ROLE}`, 400);

    const { db: tdb, pool } = WSDB();
    poolOpened = true;
    let createdRole: Partial<Permission> = {};

    try {
      await tdb.transaction(async (tx) => {
        const [newRole] = await tx
          .insert(roles)
          .values({
            roleName: validatedData.roleName,
            description: validatedData.description,
            isActive: validatedData.isActive,
          })
          .returning({ id: roles.id });

        if (validatedData.permissions && validatedData.permissions.length > 0) {
          const permissionsData = validatedData.permissions.map((p) => ({
            roleId: newRole.id,
            pageName: p.name,
            permissions: p.permissions as Record<PermissionAction, boolean>,
          }));
          await tx.insert(rolePermissions).values(permissionsData);
        }

        createdRole = {
          id: newRole.id,
          roleName: validatedData.roleName,
          description: validatedData.description,
          isActive: validatedData.isActive,
          usersCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          permissions: validatedData.permissions || [],
        };
      });

      return NextResponse.json(
        {
          data: createdRole,
          success: true,
          message: 'تم إنشاء الصلاحية بنجاح',
        },
        { status: 201 }
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
      { error: 'حدث خطأ أثناء إنشاء الصلاحية' },
      { status: 500 }
    );
  }
}
