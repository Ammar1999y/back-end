import { headers } from 'next/headers';
import { NextResponse } from 'next/server';

import { db } from '@/db';
import { accounts, rolePermissions, roles, users } from '@/db/schema';
import { withTransaction } from '@/db/ws';
import { UserClient as User } from '@/types/user';
import { isUniqueViolation, sanitizeForLog } from '@/utils';
import { v7 as uuidv7 } from 'uuid';
import { hashPassword } from '@/lib/auth';
import { checkUserPermission } from '@/lib/permissions/checker';
import {
  CUSTOM_ROLE_VALUE,
  PermissionAction,
  SUPER_ADMIN_ROLE,
} from '@/lib/permissions/constants';

import { CustomError } from '@/utils/error-class';
import { createUserSchema } from '@/utils/validation/auth';

export async function GET() {
  try {
    await checkUserPermission({
      headers: await headers(),
      resource: 'users',
      action: 'view',
    });

    const dashboardUsers = await db.query.users.findMany({
      where: (users, { isNotNull }) => isNotNull(users.roleId),
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
        },
      },
      orderBy: (users, { desc }) => [desc(users.createdAt)],
    });

    // Filter out super admin users (filtered in JS since we can't filter on relations in where)
    const filteredUsers = dashboardUsers.filter(
      (u) => u.role?.roleName !== SUPER_ADMIN_ROLE
    );

    return NextResponse.json({ data: filteredUsers }, { status: 200 });
  } catch (error) {
    if (error instanceof CustomError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }

    console.error(sanitizeForLog(error));
    return NextResponse.json(
      { error: 'حدث خطأ أثناء جلب بيانات المستخدمين' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  let poolOpened = false;
  try {
    await checkUserPermission({
      headers: await headers(),
      resource: 'users',
      action: 'create',
    });

    const body = await request.json();

    const validatedDataParsed = createUserSchema.safeParse(body);
    if (!validatedDataParsed.success)
      throw new CustomError(validatedDataParsed.error.issues[0].message, 422);

    const validatedData = validatedDataParsed.data;

    const hashedPassword = await hashPassword(validatedData.password);

    const { db: tdb, pool } = WSDB();
    poolOpened = true;
    let createdUser: Partial<User> = {};

    try {
      await tdb.transaction(async (tx) => {
        // Verify the role inside the transaction
        if (validatedData.roleId !== CUSTOM_ROLE_VALUE) {
          const targetRole = await tx.query.roles.findFirst({
            where: (roles, { eq }) => eq(roles.id, validatedData.roleId),
            columns: { roleName: true },
          });
          if (targetRole?.roleName === SUPER_ADMIN_ROLE)
            throw new CustomError(
              `لا يمكن إنشاء مستخدم بدور ${SUPER_ADMIN_ROLE}`,
              400
            );
        }
        let assignedRoleId: string;

        if (
          validatedData.roleId === CUSTOM_ROLE_VALUE &&
          validatedData?.permissions?.length
        ) {
          // Create a custom-scoped role for this user
          const [customRole] = await tx
            .insert(roles)
            .values({
              roleName: `custom-${uuidv7()}`,
              scope: 'custom',
              isActive: true,
            })
            .returning({ id: roles.id });

          assignedRoleId = customRole.id;

          const customPermsData = validatedData.permissions.map((p) => ({
            roleId: assignedRoleId,
            pageName: p.name,
            permissions: p.permissions as Record<PermissionAction, boolean>,
          }));

          await tx.insert(rolePermissions).values(customPermsData);
        } else {
          assignedRoleId = validatedData.roleId;
        }

        const [newUser] = await tx
          .insert(users)
          .values({
            name: validatedData.name,
            email: validatedData.email,
            roleId: assignedRoleId,
            isActive: validatedData.isActive,
          })
          .returning({ id: users.id });

        const userId = newUser.id;
        if (!userId) throw new CustomError('فشل في إنشاء المستخدم', 500);

        await tx.insert(accounts).values({
          accountId: userId,
          providerId: 'credential',
          userId: userId,
          password: hashedPassword,
        });

        createdUser = {
          id: userId,
        };
      });

      return NextResponse.json(
        {
          data: createdUser,
          success: true,
          message: 'تم إنشاء المستخدم بنجاح',
        },
        { status: 201 }
      );
    } finally {
      if (poolOpened) await pool.end();
    }
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
      { error: 'حدث خطأ أثناء إنشاء المستخدم' },
      { status: 500 }
    );
  }
}
