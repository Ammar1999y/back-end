import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { and, asc, eq } from 'drizzle-orm';

import { db } from '@/db';
import { roles } from '@/db/schema';
import { sanitizeForLog } from '@/utils';
import { checkUserPermission } from '@/lib/permissions/checker';

import { CustomError } from '@/utils/error-class';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await checkUserPermission({
      headers: await headers(),
      resource: 'users',
      action: 'view',
    });

    // For user assignment dropdown: only show standard roles
    // (system roles are assigned outside UI, custom roles are user-specific)
    const activeRoles = await db
      .select({
        id: roles.id,
        roleName: roles.roleName,
      })
      .from(roles)
      .where(and(eq(roles.isActive, true), eq(roles.scope, 'standard')))
      .orderBy(asc(roles.createdAt));

    const allRoles = activeRoles.map((role) => ({
      id: role.id,
      value: role.roleName,
      label: role.roleName,
    }));

    return NextResponse.json({ data: allRoles }, { status: 200 });
  } catch (error) {
    if (error instanceof CustomError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }

    console.error(sanitizeForLog(error));
    return NextResponse.json(
      { error: 'حدث خطأ أثناء جلب الصلاحيات' },
      { status: 500 }
    );
  }
}
