import type { OtpChannel } from '@/utils/validation/enums';
import type { AnyColumn } from 'drizzle-orm';

import { sql } from 'drizzle-orm';

import { users } from '@/db/schema';

/**
 * The `users` column an OTP channel's identifier is stored in. Six auth flows
 * had inlined the channel→column mapping, which hid how many places resolve a
 * user by contact.
 */
export function userContactColumn(channel: OtpChannel) {
  return channel === 'email' ? users.email : users.phoneNumber;
}

/**
 * ⚠️ TEXT-LIKE COLUMNS ONLY. `= ''` is a hard PostgreSQL error on
 * boolean/timestamp/numeric columns — a 500, not a filter. Non-text callers
 * must use `IS NULL` (see `isStringLike` in lib/data-table/filter-columns.ts).
 *
 * A bare boolean expression, not the `CASE` this used to emit. PostgreSQL
 * cannot match a `CASE` against an index: on a 200k-row table with a btree on
 * the column, the `CASE` form planned a parallel sequential scan (71.9 ms,
 * 1868 buffers) where this one takes the index through `BitmapOr` (1.5 ms, 350
 * buffers). The parentheses are load-bearing — `isNotEmpty` below and any
 * future `and`/`or` composition would otherwise bind against `or`.
 *
 * NULL or '' only. The `[]` / `{}` branches this used to carry treated those
 * two literal strings as empty text, so a role description of "[]" matched
 * "is empty" — JSON emptiness semantics leaking into a text helper. They
 * belong with a JSON/array descriptor if one ever becomes filterable.
 */
export function isEmpty<TColumn extends AnyColumn>(column: TColumn) {
  return sql<boolean>`(${column} is null or ${column} = '')`;
}

/**
 * The negation of `isEmpty`, spelled out rather than `not(isEmpty(column))`.
 *
 * Same text-only restriction. Written as its own expression because
 * `IS NOT NULL AND <> ''` is what an index can be matched against; wrapping the
 * positive form in `NOT` hands the planner a negated disjunction instead.
 */
export function isNotEmpty<TColumn extends AnyColumn>(column: TColumn) {
  return sql<boolean>`(${column} is not null and ${column} <> '')`;
}
