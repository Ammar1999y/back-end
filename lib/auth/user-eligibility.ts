import type { Tx } from '@/db';
import type { SQL } from 'drizzle-orm';

import { eq } from 'drizzle-orm';

import { roles, users } from '@/db/schema';
import { REQUIRE_ROLE_FOR_LOGIN } from '@/lib/permissions/constants';

export function roleAllowsLogin(
  role: Pick<typeof roles.$inferSelect, 'isActive'> | null | undefined
) {
  return role ? role.isActive : !REQUIRE_ROLE_FOR_LOGIN;
}

// Rotation and sign-in admission serialize on the user before reading role liveness.
export async function lockEligibleAuthUser(tx: Tx, where: SQL) {
  const [user] = await tx.select().from(users).where(where).for('update');
  if (!user?.isActive || user.deletedAt) return null;
  const [role] = user.roleId
    ? await tx
        .select({ isActive: roles.isActive })
        .from(roles)
        .where(eq(roles.id, user.roleId))
        .for('share')
    : [];
  return roleAllowsLogin(role) ? user : null;
}
