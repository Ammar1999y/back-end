/**
 * Zod's string bounds and the `varchar(n)` columns they mirror must count the
 * SAME unit, and since `zod@4.5` they do.
 *
 * Through 4.4, `.min()` / `.max()` / `.length()` counted UTF-16 CODE UNITS while
 * PostgreSQL `varchar(n)` counts CHARACTERS, so the two disagreed for any input
 * outside the Basic Multilingual Plane: a 150-character name containing one
 * emoji is 151 UTF-16 units, which Zod refused and the column would have
 * accepted. 4.5 changed the count to code points, which moved Zod ONTO the
 * column's definition — and nothing in the tree recorded that the two were ever
 * different or that they now agree. `NAME_MAX`, `EMAIL_MAX`, `ROLE_NAME_MAX` and
 * `ROLE_DESCRIPTION_MAX` are each declared once and used for both, so the
 * equivalence is load-bearing in both directions:
 *
 * - Zod STRICTER than the column silently refuses input the database would take,
 *   which is what 4.4 did.
 * - Zod LOOSER than the column turns a 422 into a `22001` from the driver — a
 *   500 on a valid-looking request.
 *
 * The round trip below runs against a real column rather than a scratch table,
 * so a migration that narrows THAT one without the constant is caught here. It
 * covers `roles.description` alone: `users.name`, `users.email`,
 * `roles.role_name`, `folders.name`, `files.display_name` and
 * `users.phone_number` are asserted at the schema only, so narrowing one of
 * those columns would still pass. Widen this if a migration touches them.
 */
import { beforeAll, describe, expect, test } from 'bun:test';

import { db } from '@/db';
import { roles } from '@/db/schema';
import * as z from 'zod';
import { generateUuidV7 } from '@/lib/id';

import { createUserSchema } from '@/utils/validation/auth';
import {
  EMAIL_MAX,
  NAME_MAX,
  ROLE_DESCRIPTION_MAX,
  ROLE_NAME_MAX,
} from '@/utils/validation/constants';

import { resetTables } from '../helpers/database';

/**
 * One astral character, so UTF-16 length and code-point length differ.
 *
 * A LETTER (`\p{Lo}`), not an emoji. `sanitizeStrict` and
 * `sanitizeStrictSingleLine` strip `\p{So}`, so an emoji probe is deleted before
 * any bound sees it: measured through the real `createUserSchema`, a 150
 * code-point name led by `😀` was stored as 149 and never reached `NAME_MAX`.
 * The ad-hoc schemas below do not sanitize and so could not show that; the
 * `through the real schema` case does, and shares this constant.
 */
const ASTRAL = '\u{20BB7}';

/**
 * Exactly `codePoints` code points, of which one is astral.
 *
 * The `.length` of the result is therefore `codePoints + 1`, which is the whole
 * discriminator: a UTF-16 count sees one character more than the database does.
 */
function astralText(codePoints: number): string {
  return ASTRAL + 'a'.repeat(codePoints - 1);
}

beforeAll(async () => {
  await resetTables();
});

describe('a string of exactly N code points', () => {
  test('is longer than N in UTF-16, which is what used to diverge', () => {
    const text = astralText(ROLE_DESCRIPTION_MAX);

    expect([...text]).toHaveLength(ROLE_DESCRIPTION_MAX);
    expect(text.length).toBe(ROLE_DESCRIPTION_MAX + 1);
  });

  test.each([
    ['NAME_MAX', NAME_MAX],
    ['EMAIL_MAX', EMAIL_MAX],
    ['ROLE_NAME_MAX', ROLE_NAME_MAX],
    ['ROLE_DESCRIPTION_MAX', ROLE_DESCRIPTION_MAX],
  ])('%s is a code-point bound in Zod', (_label, max) => {
    const schema = z.string().max(max);

    expect(schema.safeParse(astralText(max)).success).toBe(true);
    expect(schema.safeParse(astralText(max + 1)).success).toBe(false);
  });

  /**
   * The cases above build their own `z.string().max(n)`, so they assert what ZOD
   * counts, not what THIS codebase's schemas count — a length-changing step
   * between the two (every bounded leaf here is wrapped in a sanitizing
   * `z.preprocess`) is invisible to them. `NAME_MAX` is carried end to end here
   * so that gap is covered for at least one real bound.
   */
  test('NAME_MAX is a code-point bound through the real schema', () => {
    const base = {
      email: 'bounds@gmail.com',
      password: 'Passw0rd!x',
      isActive: true,
      roleId: '01931b3c-7f2a-7000-8000-000000000001',
    };

    const atBound = createUserSchema.safeParse({
      ...base,
      name: astralText(NAME_MAX),
    });
    expect(atBound.success).toBe(true);
    // Survives the sanitizer intact, so the bound is what refused the next case.
    expect([...(atBound.success ? atBound.data.name : '')]).toHaveLength(
      NAME_MAX
    );

    expect(
      createUserSchema.safeParse({ ...base, name: astralText(NAME_MAX + 1) })
        .success
    ).toBe(false);
  });
});

describe('PostgreSQL varchar counts the same unit', () => {
  async function insertDescription(description: string): Promise<void> {
    const id = generateUuidV7();
    await db.insert(roles).values({
      id,
      roleName: `bounds-${id.replaceAll('-', '')}`,
      description,
    });
  }

  test('a description of exactly ROLE_DESCRIPTION_MAX code points is stored', async () => {
    // The case Zod 4.4 refused and the column accepts. Both take it now.
    const description = astralText(ROLE_DESCRIPTION_MAX);
    expect(
      z.string().max(ROLE_DESCRIPTION_MAX).safeParse(description).success
    ).toBe(true);

    await insertDescription(description);

    const [row] = await db
      .select({ description: roles.description })
      .from(roles);
    expect(row?.description).toBe(description);
    expect([...(row?.description ?? '')]).toHaveLength(ROLE_DESCRIPTION_MAX);
  });

  test('one code point more is refused by the column, and by the schema', async () => {
    // The other direction: a bound looser than the column would turn this into a
    // driver error on a request the API had already accepted.
    const description = astralText(ROLE_DESCRIPTION_MAX + 1);
    expect(
      z.string().max(ROLE_DESCRIPTION_MAX).safeParse(description).success
    ).toBe(false);

    expect(insertDescription(description)).rejects.toThrow();
  });
});
