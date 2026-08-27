import { describe, expect, test } from 'bun:test';

import { parseDataTableParams } from '@/db/queries/data-table';
import { users } from '@/db/schema';
import { normalizeArabicDigits, OUT_OF_RANGE, positiveInt } from '@/utils';
import * as z from 'zod';
import { filterColumns } from '@/lib/data-table/filter-columns';
import { parseSearchParams } from '@/lib/data-table/parsers';

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

  test('the two forms that ARE the contract still resolve', () => {
    expect(toCalendarDate('2026-08-02')).toBe('2026-08-02');
    // Epoch milliseconds stay accepted for bookmarked URLs.
    expect(toCalendarDate(1_700_000_000_000)).toBeString();
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
