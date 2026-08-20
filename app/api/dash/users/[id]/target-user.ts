import type { Tx } from '@/db';
import type { PermissionObject } from '@/lib/permissions/constants';
import type { EntityID } from '@/types';

import { db } from '@/db';
import {
  isProtectedSystemRole,
  validateRolePermissionScope,
} from '@/lib/permissions/utils';

import { HTTP_STATUS, MSG_NOT_FOUND } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';

export type RolePolicyShape = {
  roleName?: string | null;
  scope?: string | null;
} | null;

/**
 * The single definition of "which user rows this actor may act on".
 *
 * Every check lives here because the parent resource and its subresources have
 * to agree: the user GET hid protected system users, while the sessions
 * endpoints checked only ownership — so an actor blocked from *reading* a
 * protected account could still list and revoke its sessions. A subresource
 * must never be reachable when its parent is not.
 *
 * Returns the target's role id, which a caller that needs it would otherwise
 * have to re-narrow from `EntityID | null` after this function already proved
 * it present.
 */
export function assertTargetUserVisible(opts: {
  isSelf: boolean;
  roleId: EntityID | null;
  createdBy: EntityID | null;
  role: RolePolicyShape;
  actorUserId: EntityID;
  scope: 'all' | 'own' | null;
}): EntityID {
  if (!opts.roleId) throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

  // Self is exempt: a system-role owner can still read their own account.
  if (!opts.isSelf && isProtectedSystemRole(opts.role))
    throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

  if (
    !opts.isSelf &&
    opts.scope === 'own' &&
    opts.createdBy !== opts.actorUserId
  )
    throw new CustomError(MSG_NOT_FOUND, HTTP_STATUS.NOT_FOUND);

  return opts.roleId;
}

/**
 * Non-throwing `validateRolePermissionScope`, for data that is omitted rather
 * than refused. Used where the same authority question decides visibility
 * instead of failing the request, so both paths ask it the same way.
 */
export async function actorCoversTargetRole(
  actorPermissions: Partial<PermissionObject> | undefined,
  roleId: EntityID,
  executor: Tx | typeof db
): Promise<boolean> {
  if (!actorPermissions) return true;
  try {
    await validateRolePermissionScope(actorPermissions, roleId, executor);
    return true;
  } catch (error) {
    if (error instanceof CustomError && error.status === HTTP_STATUS.FORBIDDEN)
      return false;
    throw error;
  }
}
