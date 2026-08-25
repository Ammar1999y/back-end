import { describe, expect, test } from 'bun:test';
import type {
  DashboardPage,
  PermissionAction,
} from '@/lib/permissions/constants';

import { resolveActionScope } from '@/lib/permissions/checker';
import {
  DASHBOARD_PAGE_NAMES,
  OWN_ACTION_MAP,
  PERMISSION_ACTIONS,
} from '@/lib/permissions/constants';

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
