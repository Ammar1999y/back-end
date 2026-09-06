/**
 * `FilterColumnSpec.values`: a `select`/`multiSelect` column over a closed set —
 * a PostgreSQL enum in practice — checks membership before any SQL is built.
 *
 * Without it, `kind eq audio` reached PostgreSQL as an enum cast and answered
 * 500, and `kind isEmpty` compared the enum with `''` (reproduced on
 * `GET /api/dash/media`). The shared builder already documented the trap; this
 * is the descriptor that closes it for every column that declares its set.
 */
import { describe, expect, test } from 'bun:test';

import { PgDialect } from 'drizzle-orm/pg-core';

import { fileKindEnum, files } from '@/db/schema';
import {
  filterColumns,
  MSG_INVALID_FILTER,
} from '@/lib/data-table/filter-columns';

const dialect = new PgDialect();

function build(
  operator: 'eq' | 'ne' | 'inArray' | 'notInArray' | 'isEmpty' | 'isNotEmpty',
  value: string | string[]
) {
  const multi = Array.isArray(value);
  const condition = filterColumns({
    table: files,
    filters: [
      {
        filterId: 'f1',
        id: 'kind',
        value,
        operator,
        variant: multi ? 'multiSelect' : 'select',
      },
    ],
    joinOperator: 'and',
    specs: {
      kind: { type: multi ? 'multiSelect' : 'select', values: fileKindEnum },
    },
  });
  if (!condition) throw new Error('filterColumns produced no condition');
  return dialect.sqlToQuery(condition);
}

describe('a closed-set column', () => {
  test('a member outside the set is refused before any SQL, as a client error', () => {
    expect(() => build('eq', 'audio')).toThrow(MSG_INVALID_FILTER);
    expect(() => build('ne', 'internal')).toThrow(MSG_INVALID_FILTER);
  });

  test('one unknown member refuses the whole set filter', () => {
    expect(() => build('inArray', ['image', 'audio'])).toThrow(
      MSG_INVALID_FILTER
    );
    expect(() => build('notInArray', ['audio'])).toThrow(MSG_INVALID_FILTER);
  });

  test('a member inside the set is bound as a parameter', () => {
    const query = build('eq', 'image');
    expect(query.params).toEqual(['image']);
    expect(query.sql).toInclude('"kind" = ');
  });

  test('emptiness on a closed set is NULL, never an empty string the enum cannot hold', () => {
    expect(build('isEmpty', '').sql).toInclude('is null');
    expect(build('isEmpty', '').sql).not.toInclude("''");
    expect(build('isNotEmpty', '').sql).toInclude('is not null');
  });
});
