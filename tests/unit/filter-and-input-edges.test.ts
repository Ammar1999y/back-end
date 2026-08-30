import { describe, expect, test } from 'bun:test';

import { PgDialect } from 'drizzle-orm/pg-core';

import { parseDataTableParams } from '@/db/queries/data-table';
import { users } from '@/db/schema';
import { normalizeArabicDigits, OUT_OF_RANGE, positiveInt } from '@/utils';
import * as z from 'zod';
import { filterColumns } from '@/lib/data-table/filter-columns';
import { parseSearchParams } from '@/lib/data-table/parsers';
import { REQUEST_BODIES } from '@/lib/http/openapi';

import { HTTP_STATUS } from '@/utils/api-messages';
import { toCalendarDate } from '@/utils/time';
import { adminUpdateUserSchema } from '@/utils/validation/auth';
import { createPermissionSchema } from '@/utils/validation/permissions';
import {
  idSchema,
  slugSchema,
  zodIssueMessage,
} from '@/utils/validation/rules';

const ID = '01a02581-a7ee-723b-8000-000000000000';

function adminPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    roleId: ID,
    name: 'Valid Name',
    email: 'user@gmail.com',
    isActive: true,
    ...overrides,
  };
}

describe('L1 - positiveInt accepts only canonical decimal integers', () => {
  test.each([
    ['1e2'],
    ['0x10'],
    ['+1'],
    [' 5 '],
    ['05'],
    ['10.9'],
    ['-3'],
    [''],
  ])('%p is refused', (input) => {
    expect(positiveInt(input, 100)).toBe(0);
  });

  test('an in-range canonical value passes through', () => {
    expect(positiveInt('7', 100)).toBe(7);
    expect(positiveInt('100', 100)).toBe(100);
  });

  test('over the cap is OUT_OF_RANGE, distinguishable from unparseable', () => {
    expect(positiveInt('101', 100)).toBe(OUT_OF_RANGE);
    expect(positiveInt('nope', 100)).toBe(0);
    expect(OUT_OF_RANGE).not.toBe(0);
  });

  test('a maxValue above 2^31-1 does not return a negative number', () => {
    const big = 3_000_000_000;
    expect(positiveInt(String(big), 4_000_000_000)).toBe(big);
  });
});

describe('L1 - an over-cap page size is reported, not silently defaulted', () => {
  test.each([
    ['perPage', { perPage: '101' }],
    ['page', { page: '10001' }],
  ])('%s over the ceiling is reported', (_label, params) => {
    let dropped = 0;
    parseSearchParams(params, undefined, () => {
      dropped++;
    });
    expect(dropped).toBe(1);
  });

  test('an absent parameter is not a dropped one', () => {
    let dropped = 0;
    const parsed = parseSearchParams({}, undefined, () => {
      dropped++;
    });
    expect(dropped).toBe(0);
    expect(parsed.page).toBe(1);
    expect(parsed.perPage).toBe(10);
  });
});

describe('L1/L4 - a SUPPLIED but unreadable parameter is not an absent one', () => {
  test.each([
    ['1e2'],
    ['0x10'],
    ['+5'],
    [' 5 '],
    ['05'],
    ['10.9'],
    ['abc'],
    ['0'],
    [''],
  ])('perPage=%p is reported rather than defaulted', (value) => {
    let dropped = 0;
    const parsed = parseSearchParams({ perPage: value }, undefined, () => {
      dropped++;
    });

    // Both halves matter: the caller is told, AND the fallback is still a legal
    // page size so a non-throwing handler cannot be steered by the bad value.
    expect(dropped).toBe(1);
    expect(parsed.perPage).toBe(10);
  });
});

describe('L4 - unknown and repeated query keys are refused, not ignored', () => {
  const parse = (query: string) =>
    parseDataTableParams(users, {
      url: `https://example.test/api/dash/users?${query}`,
      filterableColumns: { name: { type: 'text' } },
      searchableColumns: ['name'],
    });

  test.each([['serach=bob'], ['filtres=x'], ['extra=1'], ['page=1&page=2']])(
    '%s is a 422',
    (query) => {
      expect(() => parse(query)).toThrow(
        expect.objectContaining({ status: HTTP_STATUS.UNPROCESSABLE })
      );
    }
  );

  test('every key the parser actually reads is accepted', () => {
    expect(() =>
      parse(
        'page=1&perPage=10&maxPerPage=50&sort=&filters=&joinOperator=and&search='
      )
    ).not.toThrow();
  });
});

describe('L4 - a numeric filter value uses the canonical grammar', () => {
  const filter = (value: string) =>
    filterColumns({
      table: users,
      filters: [
        {
          filterId: 'f1',
          id: 'failedLoginAttempts',
          value,
          operator: 'eq',
          variant: 'number',
        },
      ],
      joinOperator: 'and',
      specs: { failedLoginAttempts: { type: 'number' } },
    });

  test.each([[''], ['0x10'], ['1e2'], [' 5 '], ['+5'], ['abc'], ['05']])(
    '%p is a 422 rather than a filter',
    (value) => {
      // `Number('')` is 0, so an empty value silently became "= 0".
      expect(() => filter(value)).toThrow(
        expect.objectContaining({ status: HTTP_STATUS.UNPROCESSABLE })
      );
    }
  );

  test.each([['0'], ['5'], ['-5'], ['5.25']])(
    '%p is still a filter',
    (value) => {
      expect(() => filter(value)).not.toThrow();
    }
  );

  const between = (value: string[]) =>
    filterColumns({
      table: users,
      filters: [
        {
          filterId: 'f1',
          id: 'failedLoginAttempts',
          value,
          operator: 'isBetween',
          variant: 'number',
        },
      ],
      joinOperator: 'and',
      specs: { failedLoginAttempts: { type: 'number' } },
    });

  test.each([
    ['a malformed lower bound', ['abc', '100']],
    ['a malformed upper bound', ['1', 'abc']],
    ['both malformed', ['abc', 'def']],
    ['an empty-string spelling of a number', ['0x10', '']],
  ])('isBetween with %s is a 422, not a dropped bound', (_label, value) => {
    // The one operator that DROPPED: `['abc','100']` printed `WHERE col <= $1`
    // and returned 200 with every row below the lower bound the client asked
    // for. Absent (`''`) and uncoercible (`'abc'`) are different requests, and
    // only the first means an open-ended side.
    expect(() => between(value as string[])).toThrow(
      expect.objectContaining({ status: HTTP_STATUS.UNPROCESSABLE })
    );
  });

  test.each([
    ['both bounds', ['1', '100']],
    ['lower only', ['1', '']],
    ['upper only', ['', '100']],
  ])('isBetween with %s is still a filter', (_label, value) => {
    // Without these the entry above is satisfiable by rejecting every range.
    expect(() => between(value as string[])).not.toThrow();
  });
});

describe('negated set membership includes rows with no value', () => {
  // The three-valued-logic rule this file's siblings already apply to `notILike`
  // and `ne`: `NULL NOT IN ($1)` is NULL, not TRUE, so a row with no value was
  // EXCLUDED from a predicate that plainly describes it — missing from the list
  // and from `meta.total`, with a 200.
  const dialect = new PgDialect();
  // `ne` is only offered for `select`, the array operators only for
  // `multiSelect` (`lib/data-table/config.ts`), so the two halves of the
  // comparison use the descriptor each operator is actually reachable from —
  // both against the same nullable column.
  const printed = (operator: 'inArray' | 'notInArray' | 'ne') => {
    const isArrayOperator = operator !== 'ne';
    const condition = filterColumns({
      table: users,
      filters: [
        {
          filterId: 'f1',
          id: 'phoneNumber',
          value: isArrayOperator ? ['0500000000'] : '0500000000',
          operator,
          variant: isArrayOperator ? 'multiSelect' : 'select',
        },
      ],
      joinOperator: 'and',
      specs: {
        phoneNumber: { type: isArrayOperator ? 'multiSelect' : 'select' },
      },
    });
    if (!condition) throw new Error('filterColumns produced no condition');
    return dialect.sqlToQuery(condition).sql;
  };

  test('notInArray unions IS NULL, matching the ne it sits beside', () => {
    expect(printed('notInArray')).toInclude('is null');
    expect(printed('ne')).toInclude('is null');
  });

  test('inArray does not, because NULL is genuinely not a member', () => {
    expect(printed('inArray')).not.toInclude('is null');
  });
});

describe('no client-facing validation message is Zod ASCII', () => {
  /**
   * One assertion over the whole class, because the per-node fixes drifted:
   * `roleId` had its `error:` wired by hand while thirteen other nodes across the
   * dashboard write routes still answered in English — `"Invalid input"` from
   * every union, `"Invalid input: expected boolean, received undefined"` from a
   * `PUT /api/dash/users/:id` missing `isActive`.
   *
   * `REQUEST_BODIES` is the complete registry of schemas a client can reach, so
   * this covers a new route the moment it is added rather than when someone
   * remembers to test it.
   */
  const HOSTILE_BODIES: readonly unknown[] = [
    {},
    null,
    [],
    'x',
    0,
    true,
    { unexpectedKey: 1 },
    { channel: 'nope' },
    { revokeAll: false },
    { sessionIds: ['not-a-uuid'] },
    { id: 1, roleId: 1, name: 1, email: 1, isActive: 'yes' },
  ];

  const entries = Object.entries(REQUEST_BODIES).flatMap(([route, schemas]) =>
    (Array.isArray(schemas) ? schemas : [schemas]).map(
      (schema, index) => [`${route} [${index}]`, schema] as const
    )
  );

  test('every schema in REQUEST_BODIES is reachable from this sweep', () => {
    // Per KEY, not a count. `entries.length >= keys.length` cannot fail for the
    // reason it names — every key contributing at least one entry is what makes
    // it true — while a route registered as `[]` contributes none and is silently
    // uncovered, which a second key with two schemas then hides.
    const covered = new Set(
      entries.map(([label]) => label.slice(0, label.lastIndexOf(' [')))
    );

    const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    expect([...covered].toSorted(byCodePoint)).toEqual(
      Object.keys(REQUEST_BODIES).toSorted(byCodePoint)
    );
  });

  test.each(entries)(
    '%s answers in Arabic for every hostile body',
    (_route, schema) => {
      for (const body of HOSTILE_BODIES) {
        const parsed = schema.safeParse(body);
        if (parsed.success) continue;
        const message = zodIssueMessage(parsed.error);
        // The property: a message with no Arabic letter is one this project did
        // not author, so it came from Zod's defaults.
        expect(message).toMatch(/\p{Script=Arabic}/u);
      }
    }
  );
});

describe('M9 - control characters never reach a bound parameter', () => {
  test.each([
    ['NUL', '\u{0}'],
    ['BEL', '\u{7}'],
    ['CR', '\r'],
  ])('a filter value carrying %s is stripped', (_label, control) => {
    const parsed = parseSearchParams({
      filters: JSON.stringify([
        {
          id: 'name',
          filterId: 'f1',
          value: `ab${control}cd`,
          operator: 'iLike',
          variant: 'text',
        },
      ]),
    });
    expect(parsed.filters[0]?.value).toBe('abcd');
  });

  test('a value that is ONLY control characters becomes no filter at all', () => {
    const parsed = parseSearchParams({
      filters: JSON.stringify([
        {
          id: 'name',
          filterId: 'f1',
          value: '\u{0}\u{0}',
          operator: 'iLike',
          variant: 'text',
        },
      ]),
    });
    expect(parsed.filters).toEqual([]);
  });
});

describe('L3 - a malformed date filter is null, not 1970', () => {
  test.each([
    ['a bare year', '2026'],
    ['seconds mistaken for milliseconds', 1_700_000_000],
    ['a hex spelling', '0x10'],
    ['an array', [1_700_000_000_000]],
    ['a padded calendar date', '  2026-08-02  '],
    ['an object', { when: 1 }],
    ['true', true],
  ])('%s resolves to null', (_label, input) => {
    // Each of these used to resolve, so `dayBounds` did not raise its 422 and
    // the query ran for 1970 - HTTP 200, empty table, no signal.
    expect(toCalendarDate(input as unknown)).toBeNull();
  });

  test('the one form that IS the contract resolves', () => {
    expect(toCalendarDate('2026-08-02')).toBe('2026-08-02');
    // Epoch milliseconds are NOT part of it. The branch that accepted them was
    // unreachable through `parseDataTableParams` — `safeString` stringifies every
    // filter value first — so the documented "bookmarked URLs keep working"
    // capability answered 422 end to end. Deleted rather than wired through.
    expect(toCalendarDate(1_700_000_000_000)).toBeNull();
    expect(toCalendarDate('1700000000000')).toBeNull();
  });
});

describe('L5 - a union failure speaks the API language', () => {
  test.each([['not-a-uuid'], [''], [0], [null], [{}]])(
    'roleId %p is refused in Arabic, not with the framework default',
    (input) => {
      const parsed = adminUpdateUserSchema.safeParse(
        adminPayload({ roleId: input })
      );
      expect(parsed.success).toBe(false);
      if (parsed.success) return;
      const issue = parsed.error.issues.find(
        (candidate) => String(candidate.path[0]) === 'roleId'
      );
      expect(issue?.message).toBeString();
      expect(issue?.message).not.toContain('Invalid input');
      expect(issue?.message ?? '').toMatch(/\p{Script=Arabic}/u);
    }
  );

  test('both branches of the union still accept their own shape', () => {
    const union = z.union([z.literal('custom'), idSchema]);
    expect(union.safeParse('custom').success).toBe(true);
    expect(union.safeParse(ID).success).toBe(true);
  });
});

describe('L6 - reflected key names are bounded', () => {
  test('a huge key name does not produce a huge message', () => {
    const parsed = adminUpdateUserSchema.safeParse(
      adminPayload({ ['k'.repeat(200_000)]: 1 })
    );
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    // 200 026 characters before.
    expect(zodIssueMessage(parsed.error).length).toBeLessThan(300);
  });

  test('many keys are counted rather than all named', () => {
    const extras = Object.fromEntries(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((key) => [key, 1])
    );
    const parsed = adminUpdateUserSchema.safeParse(adminPayload(extras));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const message = zodIssueMessage(parsed.error);
    expect(message).toContain('(+');
    // Still actionable: it names some of them, which is why the message exists.
    expect(message).toContain('a');
  });
});

describe('L7 - both Arabic-Indic digit ranges normalise', () => {
  test.each([
    ['Arabic', '٠٥٠١٢٣', '050123'],
    ['extended (Persian/Urdu)', '۰۵۰۱۲۳', '050123'],
    ['mixed with ASCII', '+٩٦٦۵۰۰', '+966500'],
  ])('%s digits become ASCII', (_label, input, expected) => {
    // The extended range was missing, and `phoneCleanupRegex` (ASCII digits
    // only) then DELETED those digits - so the number failed with "phone number
    // is required" rather than with a format error.
    expect(normalizeArabicDigits(input)).toBe(expected);
  });
});

describe('M11 - a wrong TYPE stays a type error', () => {
  test.each([[12_345_678], [true], [['Passw0rd!']], [{ p: 1 }]])(
    'password %p is rejected rather than read as "no change"',
    (input) => {
      const parsed = adminUpdateUserSchema.safeParse(
        adminPayload({ password: input })
      );
      expect(parsed.success).toBe(false);
    }
  );

  test.each([
    ['absent', undefined],
    ['null', null],
    ['empty string', ''],
  ])('%s still means "leave the password alone"', (_label, input) => {
    const parsed = adminUpdateUserSchema.safeParse(
      adminPayload(input === undefined ? {} : { password: input })
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.password ?? null).toBeNull();
  });

  test.each([[123], [{ a: 1 }], [true]])(
    'description %p is rejected rather than overwriting with an empty value',
    (input) => {
      const parsed = createPermissionSchema.safeParse({
        roleName: 'Editors',
        description: input,
        permissions: [{ name: 'home', permissions: { view: true } }],
      });
      expect(parsed.success).toBe(false);
      if (parsed.success) return;
      expect(
        parsed.error.issues.some(
          (issue) => String(issue.path[0]) === 'description'
        )
      ).toBe(true);
    }
  );

  test('slugSchema, unreferenced today, is swept with the class', () => {
    expect(slugSchema.safeParse(123).success).toBe(false);
    expect(slugSchema.safeParse('My Slug').success).toBe(true);
  });
});
