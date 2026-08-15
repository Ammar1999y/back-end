import type { OtpChannel } from '@/utils/validation/otp';
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
 */
export function isEmpty<TColumn extends AnyColumn>(column: TColumn) {
  // NULL or '' only. The `[]` / `{}` branches this used to carry treated those
  // two literal strings as empty text, so a role description of "[]" matched
  // "is empty" — JSON emptiness semantics leaking into a text helper. They
  // belong with a JSON/array descriptor if one ever becomes filterable.
  return sql<boolean>`
    case
      when ${column} is null then true
      when ${column} = '' then true
      else false
    end
  `;
}
