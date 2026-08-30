import { describe, expect, test } from 'bun:test';
import type {
  DashboardPage,
  PermissionAction,
  PermissionObject,
} from '@/lib/permissions/constants';

import { resolveActionScope } from '@/lib/permissions/checker';
import {
  DASHBOARD_PAGE_NAMES,
  OWN_ACTION_MAP,
  PERMISSION_ACTIONS,
} from '@/lib/permissions/constants';
import {
  collapseToNotFound,
  validatePermissionScope,
} from '@/lib/permissions/utils';

import {
  HTTP_STATUS,
  MSG_CANNOT_GRANT_UNOWNED_PERMISSIONS,
  MSG_NOT_FOUND,
} from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';

/**
 * `resolveActionScope` — the two cases its own comment records as previously
 * wrong, plus the hostile-key cases.
 *
 * `reports/test-strategy.md` §7.5 calls this the highest-value target in the
 * repository: a bug here is an authorization bypass, and the function is pure. It
 * was not exported, so the matrix the strategy asks for was not writable as a
 * unit test at all — every case would have cost a session and a database round
 * trip. It is exported now.
 *
 * **This is not the full matrix.** The `DASHBOARD_PAGES × PERMISSION_ACTIONS`
 * walk belongs to its own shard. What is here is the part that cannot wait: the
 * two answers the function's comment says it used to get wrong, and the
 * caller-supplied-key cases, because it indexes a plain object with a key that
 * arrives from a request.
 */

/** Derived from the production map, so a new scoped action joins these tables. */
const SCOPED_PAIRS = Object.entries(OWN_ACTION_MAP) as [
  PermissionAction,
  PermissionAction,
][];

const PAGE = 'users' as DashboardPage;

describe('the two answers this function used to get wrong', () => {
  test.each(SCOPED_PAIRS)(
    'holding %s while asking for %s is allowed with scope "all"',
    (all, own) => {
      // Was DENIED OUTRIGHT: the unrestricted grant supersedes the own variant,
      // so refusing it locked a full-access holder out of a narrower request.
      const result = resolveActionScope({ [PAGE]: { [all]: true } }, PAGE, own);
      expect(result).toEqual({ allowed: true, scope: 'all' });
    }
  );

  test.each(SCOPED_PAIRS)(
    'holding only %2$s while asking for %2$s reports scope "own", not "all"',
    (_all, own) => {
      // Reported `scope: 'all'` — an own-scoped grant presented as unrestricted
      // access, which is the direction that leaks other users' rows.
      const result = resolveActionScope({ [PAGE]: { [own]: true } }, PAGE, own);
      expect(result).toEqual({ allowed: true, scope: 'own' });
    }
  );

  test.each(SCOPED_PAIRS)(
    'holding only %2$s while asking for %1$s reports scope "own"',
    (all, own) => {
      // The direction that already worked, asserted so a fix to the two above
      // cannot break it: the own grant admits the broad request, scoped.
      const result = resolveActionScope({ [PAGE]: { [own]: true } }, PAGE, all);
      expect(result).toEqual({ allowed: true, scope: 'own' });
    }
  );
});

describe('denial is the default', () => {
  test('an empty matrix denies every action on every page', () => {
    for (const page of DASHBOARD_PAGE_NAMES as DashboardPage[])
      for (const action of Object.keys(
        PERMISSION_ACTIONS
      ) as PermissionAction[])
        expect(resolveActionScope({}, page, action)).toEqual({
          allowed: false,
          scope: null,
        });
  });

  test.each([
    ['a non-boolean truthy value', 1],
    ['the string "true"', 'true'],
    ['the string "false"', 'false'],
    ['a nested object', { nested: true }],
    ['an array', [true]],
  ])('%s is not a grant', (_label, value) => {
    // The comparison is `=== true` for exactly this reason: a `"false"` string
    // surviving as truthy would BE a grant.
    const result = resolveActionScope(
      { [PAGE]: { view: value } } as unknown as Record<
        string,
        Record<string, boolean>
      >,
      PAGE,
      'view'
    );
    expect(result).toEqual({ allowed: false, scope: null });
  });
});

describe('caller-supplied keys cannot reach the prototype', () => {
  test.each(['__proto__', 'constructor', 'prototype', 'toString'])(
    'resource "%s" denies',
    (resource) => {
      // `resource` arrives from a route, and the lookup indexes a plain object.
      // `Object.prototype.constructor` is truthy, so a lookup that reached the
      // prototype chain would answer `allowed` for a page that does not exist.
      expect(
        resolveActionScope(
          { [PAGE]: { view: true } },
          resource as DashboardPage,
          'view'
        )
      ).toEqual({ allowed: false, scope: null });
    }
  );

  test.each(['__proto__', 'constructor', 'toString'])(
    'action "%s" denies',
    (action) => {
      expect(
        resolveActionScope(
          { [PAGE]: { view: true } },
          PAGE,
          action as PermissionAction
        )
      ).toEqual({ allowed: false, scope: null });
    }
  );

  test('a null matrix denies rather than throwing', () => {
    expect(
      resolveActionScope(
        null as unknown as Record<string, Record<string, boolean>>,
        PAGE,
        'view'
      )
    ).toEqual({ allowed: false, scope: null });
  });
});

describe('the reachability collapse both role write paths must give', () => {
  /**
   * `RoleScopeCheck` says the distinction is "a disclosure boundary, not a style
   * choice": every neighbouring unreachable-target gate answers `404
   * MSG_NOT_FOUND`, and answering `403 "you cannot GRANT permissions you don't
   * own"` instead tells a caller without `permissions.view` that a role exists
   * and outranks them.
   *
   * `DELETE /api/dash/permissions/:id` bypassed the helper that makes that
   * decision — it called `validatePermissionScope` directly, to avoid re-reading
   * `role_permissions` it already held `FOR SHARE` — so a deletion, which grants
   * nothing, answered 403 where the neighbouring PUT on the same role answered
   * 404. `collapseToNotFound` is the extracted collapse both now share.
   */
  const outranking = [
    {
      name: 'users' as DashboardPage,
      permissions: { view: true, delete: true } as Record<string, boolean>,
    },
  ];
  /**
   * Holds `view` but not `delete`, so the target's matrix outranks it.
   *
   * A PARTIAL page record, which is the real shape: session metadata carries only
   * the actions a role was granted, and `PermissionObject`'s per-page value is a
   * full `Record`, so the cast is what the runtime already passes.
   */
  const actor = { users: { view: true } } as Partial<PermissionObject>;

  function scopeError(): unknown {
    try {
      validatePermissionScope(actor, outranking);
    } catch (error) {
      return error;
    }
    throw new Error('expected validatePermissionScope to reject');
  }

  test('the un-collapsed answer is the 403 grant message', () => {
    const error = scopeError();

    expect(error).toBeInstanceOf(CustomError);
    expect((error as CustomError).status).toBe(HTTP_STATUS.FORBIDDEN);
    expect((error as CustomError).message).toBe(
      MSG_CANNOT_GRANT_UNOWNED_PERMISSIONS
    );
  });

  test('collapsed, it is indistinguishable from a nonexistent role', () => {
    expect(() => collapseToNotFound(scopeError())).toThrow(
      expect.objectContaining({
        status: HTTP_STATUS.NOT_FOUND,
        message: MSG_NOT_FOUND,
      })
    );
  });

  test('a non-CustomError is rethrown untouched, not turned into a 404', () => {
    // Collapsing an unexpected fault would hide a real bug behind a routine
    // "not found".
    const bug = new TypeError('unrelated');
    expect(() => collapseToNotFound(bug)).toThrow(bug);
  });
});
