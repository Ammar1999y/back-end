import { headers } from 'next/headers';
import { and, asc, eq } from 'drizzle-orm';

import { db } from '@/db';
import { roles } from '@/db/schema';
import { checkUserPermission } from '@/lib/permissions/checker';
import { ROLE_SCOPE } from '@/lib/permissions/constants';

import { MSG_FETCH_ERROR, MSG_FETCHED } from '@/utils/api-messages';
import { apiSuccess, handleApiError } from '@/utils/api-response';

export async function GET() {
  try {
    await checkUserPermission({
      headers: await headers(),
      resource: 'permissions',
      action: 'view',
    });

    const activeRoles = await db
      .select({
        id: roles.id,
        roleName: roles.roleName,
      })
      .from(roles)
      .where(
        and(eq(roles.isActive, true), eq(roles.scope, ROLE_SCOPE.STANDARD))
      )
      .orderBy(asc(roles.createdAt), asc(roles.id))
      .limit(1000);

    const allRoles = activeRoles.map((role) => ({
      id: role.id,
      value: role.roleName,
      label: role.roleName,
    }));

    return apiSuccess({ message: MSG_FETCHED, data: allRoles });
  } catch (error) {
    return handleApiError(error, MSG_FETCH_ERROR);
  }
}
