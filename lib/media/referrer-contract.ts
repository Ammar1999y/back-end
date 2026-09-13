/**
 * The rule every table that references `files` must satisfy, checked against
 * the PostgreSQL catalog rather than against a list someone maintains.
 *
 * A referrer MUST use the composite `(file_id, file_status) → files (id,
 * status)` key, with a status column a NULL cannot slip through (`NOT NULL`, or
 * a `MATCH FULL` key for an optional attachment), a `file_status = 'active'`
 * check, and referential actions that REFUSE rather than propagate; and it MUST
 * be registered in `USAGE_SOURCES`. That shape is what makes deletion safe with
 * no transaction open across the object store: marking a row `deleting` is
 * refused while any referrer exists, BEFORE a byte is destroyed.
 *
 * A plain `file_id → files(id)` key is the failure this exists to stop. It is
 * invisible to `unreferenced()`, so the reaper treats the file as unused, and
 * PostgreSQL only refuses the FINAL row delete — which `finishDeleting` reaches
 * after the object is already gone. The result is lost bytes with a dangling
 * reference, and nothing in the request path can detect it.
 *
 * Driver-agnostic on purpose: `scripts/migrate.ts` runs this over its own
 * `bun:sql` client, before any application module exists, and the integration
 * tier runs it over Drizzle. One definition, two callers.
 */
/** Runs one parameterless catalog statement and returns its rows. */
export type CatalogQuery = (
  statement: string
) => Promise<Record<string, unknown>[]>;

/** `table.column` for every registered `files` reference. */
export type RegisteredColumns = ReadonlySet<string>;

interface ForeignKey {
  table: string;
  definition: string;
  /** `f` = MATCH FULL, `s` = MATCH SIMPLE (the default), `p` = MATCH PARTIAL. */
  matchType: string;
  /** `confupdtype`; see `REFUSING_ACTIONS`. */
  updateAction: string;
  /** `confdeltype`; same encoding. */
  deleteAction: string;
}

/**
 * The two `pg_constraint` action codes that make the database REFUSE rather
 * than rewrite the referencing row: `a` = NO ACTION, `r` = RESTRICT.
 *
 * `c` (CASCADE), `n` (SET NULL) and `d` (SET DEFAULT) all let the referenced row
 * move on and take the reference with it, which is the one thing this contract
 * exists to prevent — read `ACTION_RULES` for what each does here.
 */
const REFUSING_ACTIONS = new Set(['a', 'r']);

/**
 * Why each event must refuse, stated per event because the two failures are
 * different.
 *
 * ON UPDATE: `lifecycle.ts` marks `files.status` `deleting` and relies on the
 * key to refuse while another owner still references the row. SET NULL nulls
 * both referencing columns, and an all-null pair satisfies MATCH FULL and a
 * `CHECK` alike, so the update succeeds and silently unlinks that owner — after
 * which `finishDeleting` destroys an object something still points at.
 *
 * ON DELETE: the final row delete is the LAST refusal standing, and it is
 * reached after the object is gone. A propagating action there deletes or
 * blanks the referrer instead of failing the deletion.
 */
const ACTION_RULES = [
  { code: 'updateAction', event: 'ON UPDATE' },
  { code: 'deleteAction', event: 'ON DELETE' },
] as const satisfies readonly {
  code: keyof ForeignKey;
  event: string;
}[];

const FOREIGN_KEYS_INTO_FILES = `
  select cl.relname as table_name,
         c.confmatchtype::text as match_type,
         c.confupdtype::text as update_action,
         c.confdeltype::text as delete_action,
         pg_get_constraintdef(c.oid) as definition
  from pg_constraint c
  join pg_class cl on cl.oid = c.conrelid
  join pg_class ref on ref.oid = c.confrelid
  where c.contype = 'f' and ref.relname = 'files'
  order by cl.relname, c.conname
`;

const NOT_NULL_COLUMNS = `
  select cl.relname as table_name, a.attname as column_name
  from pg_attribute a
  join pg_class cl on cl.oid = a.attrelid
  where a.attnotnull and a.attnum > 0 and not a.attisdropped
`;

const CHECK_CONSTRAINTS = `
  select cl.relname as table_name, pg_get_constraintdef(c.oid) as definition
  from pg_constraint c
  join pg_class cl on cl.oid = c.conrelid
  where c.contype = 'c'
`;

const COMPOSITE_KEY =
  /^FOREIGN KEY \((\w+), (\w+)\) REFERENCES files\(id, status\)/;

/**
 * The `CHECK` that pins a status column to `'active'`, as PostgreSQL prints it,
 * whitespace and the optional outer parentheses removed.
 *
 * A substring test is not enough: `definition.includes(column)` also matches a
 * check on an unrelated column whose text merely contains the name, which
 * accepts a table whose status column is pinned to nothing.
 */
function pinsToActive(definition: string, statusColumn: string): boolean {
  const normalised = definition.replaceAll(/\s+/g, '').toLowerCase();
  const column = statusColumn.toLowerCase();
  return (
    normalised === `check((${column}='active'::file_status))` ||
    normalised === `check(${column}='active'::file_status)`
  );
}

/**
 * Every way the schema currently breaks the contract, one line each, empty when
 * it does not. Never throws on a clean schema, so a caller decides whether a
 * violation is fatal.
 *
 * **The nullability rule IS the delete protection.** `MATCH SIMPLE` skips a row
 * with any NULL key component and a `CHECK` is satisfied by NULL, so a nullable
 * status column carrying the `'active'` check leaves a referrer the database
 * will not defend. An optional attachment stays expressible — either a
 * `NOT NULL` status column beside a nullable id, or a `MATCH FULL` key where
 * all-null is an absent attachment and a half-null one is refused outright.
 *
 * **So is the referential-action rule**, and for the same reason one layer down:
 * a key that RE-WRITES the referencing row on a status change or a delete is not
 * a key that refuses. See `ACTION_RULES`.
 */
export async function referrerContractViolations(
  query: CatalogQuery,
  registered: RegisteredColumns
): Promise<string[]> {
  const keyRows = await query(FOREIGN_KEYS_INTO_FILES);
  const keys: ForeignKey[] = keyRows.map((row) => ({
    table: String(row['table_name']),
    definition: String(row['definition']),
    matchType: String(row['match_type']),
    updateAction: String(row['update_action']),
    deleteAction: String(row['delete_action']),
  }));
  if (keys.length === 0) return [];

  const notNullRows = await query(NOT_NULL_COLUMNS);
  const notNull = new Set(
    notNullRows.map(
      (row) => `${String(row['table_name'])}.${String(row['column_name'])}`
    )
  );
  const checkRows = await query(CHECK_CONSTRAINTS);
  const checks = new Map<string, string[]>();
  for (const row of checkRows) {
    const table = String(row['table_name']);
    const existing = checks.get(table) ?? [];
    existing.push(String(row['definition']));
    checks.set(table, existing);
  }

  const violations: string[] = [];
  for (const key of keys) {
    const shape = COMPOSITE_KEY.exec(key.definition);
    if (!shape) {
      violations.push(
        `${key.table}: ${key.definition} is not the composite (file_id, file_status) → files (id, status) key`
      );
      continue;
    }
    const [, fileColumn = '', statusColumn = ''] = shape;
    if (key.matchType !== 'f' && !notNull.has(`${key.table}.${statusColumn}`))
      violations.push(
        `${key.table}.${statusColumn}: nullable under a MATCH SIMPLE key, so a null status skips the foreign key`
      );
    if (
      !(checks.get(key.table) ?? []).some((check) =>
        pinsToActive(check, statusColumn)
      )
    )
      violations.push(
        `${key.table}.${statusColumn}: no check fixing it to 'active'`
      );
    for (const rule of ACTION_RULES)
      if (!REFUSING_ACTIONS.has(key[rule.code]))
        violations.push(
          `${key.table}.${fileColumn}: ${rule.event} on the composite key propagates instead of refusing, so a referenced file can be released while this row still points at it`
        );
    if (!registered.has(`${key.table}.${fileColumn}`))
      violations.push(`${key.table}.${fileColumn}: not in USAGE_SOURCES`);
  }
  return violations;
}
