import type { Handler } from '@/lib/http/contract';

import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { userPreferences } from '@/db/schema';
import { requireSession } from '@/lib/http/session';
import { enforceRateLimit, userIdentifier } from '@/lib/rate-limit';

import {
  HTTP_STATUS,
  MSG_FETCH_ERROR,
  MSG_FETCHED,
  MSG_UPDATE_ERROR,
  MSG_UPDATED,
} from '@/utils/api-messages';
import {
  apiSuccess,
  handleApiError,
  requireJsonBody,
} from '@/utils/api-response';
import { CustomError } from '@/utils/error-class';
import {
  preferencesSchema,
  sanitizePreferences,
} from '@/utils/validation/preferences';
import { zodIssueMessage } from '@/utils/validation/rules';

export const GET: Handler = async (ctx) => {
  try {
    const { userId } = await requireSession(ctx);

    await enforceRateLimit({
      scope: 'users.me.preferences.get',
      identifier: userIdentifier(userId),
      limit: 60,
    });

    const [row] = await db
      .select({ ui: userPreferences.ui, updatedAt: userPreferences.updatedAt })
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId));

    // Defaults, not 404: the client reconciles against a total document.
    return apiSuccess({
      message: MSG_FETCHED,
      data: {
        preferences: sanitizePreferences(row?.ui),
        updatedAt: row?.updatedAt ?? null,
      },
    });
  } catch (error) {
    return handleApiError(error, MSG_FETCH_ERROR);
  }
};

/**
 * `PUT`, not `PATCH`: `HttpMethod` is a closed set the 405 boundary answers from.
 * No audit entry: `audit_logs` has no retention sweep, and a debounced slider
 * would fill it with rows nobody reads.
 */
export const PUT: Handler = async (ctx) => {
  try {
    const { userId } = await requireSession(ctx);

    await enforceRateLimit({
      scope: 'users.me.preferences.put',
      identifier: userIdentifier(userId),
      limit: 30,
      failClosed: true,
    });

    const body = requireJsonBody(await ctx.readJson());
    const parsed = preferencesSchema.safeParse(body);
    if (!parsed.success)
      throw new CustomError(
        zodIssueMessage(parsed.error),
        HTTP_STATUS.UNPROCESSABLE
      );

    const [row] = await db
      .insert(userPreferences)
      .values({ userId, ui: parsed.data })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: { ui: parsed.data },
      })
      .returning({ updatedAt: userPreferences.updatedAt });
    if (!row)
      throw new CustomError(MSG_UPDATE_ERROR, HTTP_STATUS.INTERNAL_ERROR);

    return apiSuccess({
      message: MSG_UPDATED,
      data: { preferences: parsed.data, updatedAt: row.updatedAt },
    });
  } catch (error) {
    return handleApiError(error, MSG_UPDATE_ERROR);
  }
};
