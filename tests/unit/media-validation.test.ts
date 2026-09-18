/**
 * The media request schemas — what a folder or file may be called, and what a
 * delete may ask for. Names are user input that becomes a `lower(name)` unique
 * key and a `Content-Disposition` filename, so the normalisation is part of the
 * contract, not a courtesy.
 */
import { describe, expect, test } from 'bun:test';

import * as z from 'zod';

import {
  FOLDER_NAME_MAX,
  IDS_ARRAY_MAX,
  MEDIA_DISPLAY_NAME_MAX,
} from '@/utils/validation/constants';
import {
  createFolderSchema,
  deleteFilesSchema,
  displayNameSchema,
  folderNameSchema,
  mediaValidationMsg,
  updateFileSchema,
  updateFolderSchema,
} from '@/utils/validation/media';

const ID = '0192b4b6-6f1a-7c3e-9a1f-2b3c4d5e6f70';

function firstMessage(result: {
  success: boolean;
  error?: { issues: { message: string }[] };
}) {
  return result.success ? null : (result.error?.issues[0]?.message ?? null);
}

describe('folder names', () => {
  test('are NFC-normalised, whitespace-collapsed and trimmed', () => {
    // U+0065 U+0301 (e + combining acute) → U+00E9 (é).
    const decomposed = 'café   2024 ';
    expect(folderNameSchema.parse(decomposed)).toBe('café 2024');
  });

  test('refuse separators, control and format characters, and the two dot names', () => {
    for (const bad of ['a/b', String.raw`a\b`, 'zero​width', 'bell', '.', '..'])
      expect(
        firstMessage(folderNameSchema.safeParse(bad)),
        JSON.stringify(bad)
      ).toBe(mediaValidationMsg.folderNameInvalid);
  });

  test('a tab is whitespace, so it collapses to one space rather than being refused', () => {
    expect(folderNameSchema.parse('tab\there')).toBe('tab here');
  });

  test('refuse empty and over-long names with their own messages', () => {
    expect(firstMessage(folderNameSchema.safeParse(' '.repeat(3)))).toBe(
      mediaValidationMsg.folderNameRequired
    );
    expect(
      firstMessage(folderNameSchema.safeParse('x'.repeat(FOLDER_NAME_MAX + 1)))
    ).toBe(mediaValidationMsg.folderNameTooLong);
    expect(
      folderNameSchema.safeParse('x'.repeat(FOLDER_NAME_MAX)).success
    ).toBe(true);
  });

  test('a non-string is refused, not coerced', () => {
    expect(folderNameSchema.safeParse(42).success).toBe(false);
    expect(folderNameSchema.safeParse(null).success).toBe(false);
  });
});

describe('display names', () => {
  test('keep dots (an extension is fine) but refuse separators', () => {
    expect(displayNameSchema.parse(' report.final.pdf ')).toBe(
      'report.final.pdf'
    );
    expect(displayNameSchema.safeParse('../report.pdf').success).toBe(false);
    expect(
      displayNameSchema.safeParse('x'.repeat(MEDIA_DISPLAY_NAME_MAX + 1))
        .success
    ).toBe(false);
  });
});

describe('the bodies', () => {
  test('createFolder: a root folder omits or nulls parentId; an unknown key is a 422', () => {
    expect(createFolderSchema.parse({ name: 'Brand' })).toEqual({
      name: 'Brand',
    });
    expect(createFolderSchema.parse({ name: 'Brand', parentId: null })).toEqual(
      {
        name: 'Brand',
        parentId: null,
      }
    );
    expect(createFolderSchema.parse({ name: 'Brand', parentId: ID })).toEqual({
      name: 'Brand',
      parentId: ID,
    });
    expect(
      createFolderSchema.safeParse({ name: 'Brand', parent: ID }).success
    ).toBe(false);
    expect(
      createFolderSchema.safeParse({ name: 'Brand', parentId: 'nope' }).success
    ).toBe(false);
  });

  test('updateFolder: something has to change, and null parentId means the root', () => {
    expect(firstMessage(updateFolderSchema.safeParse({}))).toBe(
      mediaValidationMsg.nothingToUpdate
    );
    expect(updateFolderSchema.parse({ parentId: null })).toEqual({
      parentId: null,
    });
    expect(updateFolderSchema.parse({ name: 'New' })).toEqual({ name: 'New' });
  });

  test('updateFile: folderId cannot be null — a library file always has a folder', () => {
    expect(updateFileSchema.safeParse({ folderId: null }).success).toBe(false);
    expect(updateFileSchema.parse({ folderId: ID })).toEqual({ folderId: ID });
    expect(firstMessage(updateFileSchema.safeParse({}))).toBe(
      mediaValidationMsg.nothingToUpdate
    );
  });

  test('deleteFiles: one to IDS_ARRAY_MAX valid ids', () => {
    expect(firstMessage(deleteFilesSchema.safeParse({ ids: [] }))).toBe(
      mediaValidationMsg.idsRequired
    );
    expect(
      firstMessage(
        deleteFilesSchema.safeParse({
          ids: Array.from({ length: IDS_ARRAY_MAX + 1 }, () => ID),
        })
      )
    ).toBe(mediaValidationMsg.idsTooMany);
    expect(deleteFilesSchema.safeParse({ ids: ['not-an-id'] }).success).toBe(
      false
    );
    expect(
      deleteFilesSchema.safeParse({ ids: [ID], extra: true }).success
    ).toBe(false);
  });
});

/**
 * The published `pattern` is compiled by CONSUMERS, on their own thread, against
 * whatever a caller typed. Its cost is therefore part of the contract in a way
 * the runtime schema's is not — the server never runs it.
 */
describe('the published name pattern', () => {
  const patternOf = (schema: z.core.$ZodType) => {
    const emitted = z.toJSONSchema(schema, {
      io: 'input',
      unrepresentable: 'any',
    }) as { pattern?: string };
    if (!emitted.pattern) throw new Error('no pattern emitted');
    return emitted.pattern;
  };

  const SCHEMAS = [
    ['folder', folderNameSchema],
    ['display', displayNameSchema],
  ] as const;

  test.each(SCHEMAS)(
    '%s: refuses a long run of whitespace without backtracking over it',
    (name, schema) => {
      /* eslint-disable-next-line security/detect-non-literal-regexp -- the
         schema's own published pattern, which is the thing under test */
      const compiled = new RegExp(patternOf(schema));
      const spaces = ' '.repeat(64_000);
      const started = Bun.nanoseconds();
      expect(compiled.test(spaces)).toBe(false);
      const ms = (Bun.nanoseconds() - started) / 1e6;

      // The shape this replaced re-scanned the same suffix from every position
      // and took ~4.3 s here; this one takes ~0.1 ms. The ceiling is loose
      // enough that a loaded worker cannot fail it and tight enough that the
      // quadratic shape cannot pass it.
      expect([name, ms < 1000]).toEqual([name, true]);
    }
  );

  test.each(SCHEMAS)(
    '%s: admits every value the schema accepts, over each discriminating shape',
    (name, schema) => {
      /* eslint-disable-next-line security/detect-non-literal-regexp -- as above */
      const compiled = new RegExp(patternOf(schema));
      // One representative of every class the pattern distinguishes: allowed
      // characters, ASCII space and the other whitespace forms, the refused
      // separators, the dot names, a combining sequence, and the control
      // characters at both ends of the excluded ranges.
      const alphabet = [
        'a',
        '9',
        ' ',
        '\t',
        '\n',
        '/',
        '\\',
        '.',
        'e\u{0301}',
        '\u{0000}',
        '\u{007F}',
        '\u{00A0}',
      ];
      const seen: string[] = [];
      const build = (depth: number, prefix: string) => {
        if (depth === 0) {
          seen.push(prefix);
          return;
        }
        for (const character of alphabet) build(depth - 1, prefix + character);
      };
      for (let depth = 0; depth <= 3; depth++) build(depth, '');

      // Only where the runtime ACCEPTS. The pattern is deliberately laxer (it
      // cannot express `\p{Cf}`), so a value it admits and the server refuses is
      // the tolerated direction; one it refuses and the server accepts is the
      // defect.
      const refusedButAccepted = seen.filter(
        (value) => z.safeParse(schema, value).success && !compiled.test(value)
      );
      expect([name, refusedButAccepted]).toEqual([name, []]);
      expect(seen.length).toBeGreaterThan(1000);
    }
  );
});
