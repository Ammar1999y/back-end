import { and, asc, eq } from 'drizzle-orm';

import { db } from '@/db';
import { roles } from '@/db/schema';
import { requirePermission } from '@/lib/http/session';
import { ROLE_SCOPE } from '@/lib/permissions/constants';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

import type { Handler } from '@/lib/http/contract';

import { MSG_FETCH_ERROR, MSG_FETCHED } from '@/utils/api-messages';
import { apiSuccess, handleApiError } from '@/utils/api-response';

export const GET: Handler = async (ctx) => {
  try {
    const { session } = await requirePermission(ctx, {
      resource: 'permissions',
      action: 'view',
    });

    await enforceRateLimit({
      scope: 'roles.get',
      identifier: userIdentifier(session!.user.id),
      limit: 30,
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
};
