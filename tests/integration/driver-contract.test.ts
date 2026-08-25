/**
 * The `bun:sql` driver contract — the properties the Neon → `bun:sql` swap rests
 * on, and that only a live PostgreSQL can witness.
 *
 * Ported from `scripts/probe/dev-live/database/driver-contract.dev-probe.ts`,
 * which proved these against a developer's own database and could not run in a
 * tier. `tests/unit/log-serializer.test.ts` already pins the serializer against
 * a `PostgresError` built from Bun's own constructor — that runs without a
 * server, but it cannot prove the one thing underneath it: that Bun POPULATES
 * those fields from the wire the way the constructor suggests. Everything here
 * is asserted against an error the real driver threw, or against SQL the real
 * server executed.
 *
 * What it pins down (reports/test-strategy.md §7.4 a, b, c, d, g):
 *  - the SQLSTATE arrives in `errno`, not `code` — the relocation that silently
 *    disabled `isUniqueViolation` and `isForeignKeyViolation` — at BOTH the
 *    `DrizzleQueryError` level and the driver-error level underneath it
 *  - a real constraint name reaches `getConstraintName`, and a real `users`
 *    violation maps to 409 rather than a generic 500
 *  - both predicates are FALSE for an unrelated failure, so nothing here passes
 *    by matching everything
 *  - `sanitizeForLog` keeps the SQLSTATE while withholding the bound parameter
 *    PostgreSQL echoes back
 *  - every `jsonb` column write lands as jsonb rather than a jsonb STRING, and
 *    the `||` merge in the permission-refresh path merges instead of appending
 *  - a transaction is one session: same backend PID, advisory lock visible,
 *    rollback on throw, nested block behaves as a savepoint
 *  - `db.execute()` yields rows as an array, which three call sites read
 *
 * **No hand-authored driver errors and no hand-copied SQL.** A fixture setting
 * `.errno = '23505'` proves only that the reader reads `errno`, so every error
 * below is provoked; the three `db.execute` statements and the advisory lock are
 * READ OUT OF THE APPLICATION SOURCE at run time, so a rewritten statement
 * fails the extraction instead of leaving a copy nobody runs.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- the paths are
   module-scope constants in this file, never input */
import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { SeededUser, SignedInSession } from '../helpers/session';
import type { SessionMetadata } from '@/lib/permissions/constants';
import type { SQL, SQLChunk } from 'drizzle-orm';

import {
  DrizzleQueryError,
  eq,
  getTableColumns,
  getTableName,
  is,
  sql,
} from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';

import { db, withTransaction } from '@/db';
import * as schema from '@/db/schema';
import {
  auditLogs,
  rolePermissions,
  roles,
  sessions,
  users,
} from '@/db/schema';
import {
  getConstraintName,
  isForeignKeyViolation,
  isUniqueViolation,
  sanitizeForLog,
} from '@/utils';
import { auditLog } from '@/lib/audit';
import { generateUuidV7 } from '@/lib/id';
import {
  DEFAULT_PAGE_PERMISSIONS,
  ROLE_SCOPE,
} from '@/lib/permissions/constants';
import {
  refreshRoleSessions,
  refreshUserSessions,
} from '@/lib/permissions/utils';

import { MSG_EMAIL_EXISTS } from '@/utils/api-messages';
import {
  handleUserForeignKeyViolation,
  handleUserUniqueViolation,
} from '@/utils/api-response';
import { OTP_CHANNELS, OTP_PURPOSES } from '@/utils/validation/otp';

import { resetTables } from '../helpers/database';
import { seedUser, signedInUser } from '../helpers/session';

const REPO_ROOT = path.join(import.meta.dir, '..', '..');

/** The three `db.execute` call sites §7.4c names, and the lock §7.4d names. */
const ROLE_DELETE = {
  file: 'app/api/dash/permissions/[id]/handler.ts',
  anchor: 'DELETE FROM roles r',
} as const;
const SELF_UPDATE_CTE = {
  file: 'app/api/dash/users/[id]/handler.ts',
  anchor: 'RETURNING prev.name AS old_name',
} as const;
const LOCKING_SELECT = {
  file: 'app/api/dash/users/[id]/handler.ts',
  anchor: 'FOR UPDATE OF u',
} as const;
const ADVISORY_LOCK = {
  file: 'utils/otp.ts',
  anchor: 'pg_advisory_xact_lock',
} as const;

/** Every `` sql`…` `` template body in a module. */
function sqlTemplates(file: string): string[] {
  const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
  return source
    .matchAll(/sql`([^`]*)`/g)
    .map((match) => match[1] ?? '')
    .toArray();
}

/**
 * The production statement, rebuilt with parameters this test controls.
 *
 * The TEXT comes from the application source and the VALUES come from here, so
 * the assertion is about the statement the application really issues. A copy in
 * this file would keep passing against a statement nobody runs — and both
 * failures below are hard, not skips: a moved statement or a changed parameter
 * count has to be read and re-checked by a person.
 */
function productionStatement(
  site: { file: string; anchor: string },
  params: unknown[]
): SQL {
  const found = sqlTemplates(site.file).filter((body) =>
    body.includes(site.anchor)
  );
  if (found.length !== 1)
    throw new Error(
      `expected exactly one sql template containing "${site.anchor}" in ` +
        `${site.file}, found ${found.length}. If the statement moved or was ` +
        'rewritten, update this test rather than inlining a copy of the SQL.'
    );

  const literals = (found[0] ?? '').split(/\$\{[^}]*\}/g);
  if (literals.length - 1 !== params.length)
    throw new Error(
      `"${site.anchor}" binds ${literals.length - 1} parameters and this test ` +
        `supplies ${params.length}. Read the statement before changing either.`
    );

  const chunks: SQLChunk[] = [];
  for (const [index, literal] of literals.entries()) {
    chunks.push(sql.raw(literal));
    if (index < params.length) chunks.push(sql.param(params[index]));
  }
  return sql.join(chunks);
}

/**
 * Runs `operation`, returns what it threw, and fails loudly when it did not
 * throw at all.
 *
 * The guard is the point: a provoked failure that silently starts succeeding
 * would otherwise turn every assertion downstream of it into an assertion about
 * `undefined`.
 */
async function provoke(
  operation: () => Promise<unknown>,
  what: string
): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error(`expected ${what} to fail, and it succeeded`);
}

/** The driver error underneath a `DrizzleQueryError`. */
function driverErrorOf(thrown: unknown): unknown {
  return (thrown as { cause?: unknown }).cause;
}

/** `jsonb_typeof`, asked of the server — never through the ORM's read path. */
async function jsonbTypeof(
  table: string,
  column: string,
  id: string
): Promise<string | null> {
  const rows = await db.execute<{ kind: string | null }>(
    sql`SELECT jsonb_typeof(${sql.identifier(column)}) AS kind
          FROM ${sql.identifier(table)} WHERE id = ${id}`
  );
  if (rows.length !== 1)
    throw new Error(
      `${table}.${column}: expected one row for id ${id}, got ${rows.length}`
    );
  return rows[0]?.kind ?? null;
}

/** Every jsonb column Drizzle knows about, read out of the schema module. */
function jsonbColumns(): string[] {
  const found: string[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const table = value as PgTable;
    const name = getTableName(table);
    const columns = Object.values(getTableColumns(table));
    for (const column of columns)
      if (column.getSQLType() === 'jsonb') found.push(`${name}.${column.name}`);
  }
  return found.toSorted((a, b) => (a === b ? 0 : a < b ? -1 : 1));
}

/** A session row for `userId`, written through Drizzle's jsonb column mapper. */
async function insertSession(
  userId: string,
  metadata: SessionMetadata & Record<string, unknown>
): Promise<string> {
  const [row] = await db
    .insert(sessions)
    .values({
      userId,
      token: `driver-contract-${generateUuidV7()}`,
      // `expires_at` is declared `mode: 'string'`, so a Date would only fail the
      // typecheck — the column's value is an ISO string.
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      metadata,
    })
    .returning({ id: sessions.id });
  if (!row) throw new Error('session insert returned no row');
  return row.id;
}

const PAGE = DEFAULT_PAGE_PERMISSIONS[0]?.name ?? 'home';
const ACTION = DEFAULT_PAGE_PERMISSIONS[0]?.availablePermissions[0] ?? 'view';

interface Fixture {
  signedIn: SignedInSession;
  roleMerge: SeededUser;
  deletable: SeededUser;
  systemScoped: SeededUser;
  /**
   * `jsonb_typeof(sessions.metadata)` for the row the REAL sign-in wrote,
   * captured before any test can touch it. Read here rather than in the test so
   * the assertion cannot depend on which tests ran first.
   */
  signInMetadataKind: string | null;
}

const fixture: { current: Fixture | null } = { current: null };

function seeded(): Fixture {
  if (!fixture.current) throw new Error('fixture not seeded');
  return fixture.current;
}

beforeAll(async () => {
  await resetTables();

  // One sign-in, not four: the password KDF is Argon2id at 64 MiB and the per-IP
  // limiter is 20/minute for the whole worker.
  const signedIn = await signedInUser();
  const [session] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, signedIn.user.userId));
  if (!session) throw new Error('sign-in wrote no session row');

  fixture.current = {
    signedIn,
    roleMerge: await seedUser(),
    deletable: await seedUser(),
    systemScoped: await seedUser({ roleScope: ROLE_SCOPE.SYSTEM }),
    signInMetadataKind: await jsonbTypeof('sessions', 'metadata', session.id),
  };
});

/** A duplicate-email INSERT through Drizzle: a real `ux_users_email` violation. */
function duplicateEmail(): Promise<unknown> {
  return provoke(
    () =>
      db.insert(users).values({
        id: generateUuidV7(),
        name: 'Driver Contract Duplicate',
        email: seeded().signedIn.user.email,
        roleId: seeded().signedIn.user.roleId,
        isActive: true,
      }),
    'a second insert of an existing email'
  );
}

describe('a real unique violation', () => {
  test('carries its SQLSTATE in errno, not code, and at both error levels', async () => {
    const thrown = await duplicateEmail();

    // The wrapper first, because that is what a catch block in a handler sees.
    expect(thrown).toBeInstanceOf(DrizzleQueryError);
    expect(isUniqueViolation(thrown)).toBe(true);
    // The index name, not an empty string: this feeds the resolver that turns
    // the failure into a field-specific 409.
    expect(getConstraintName(thrown)).toBe('ux_users_email');

    // `hasSqlState` reads two levels and a test that only ever sees one proves
    // half of it. The wrapper carries NO code of its own — so for anything
    // thrown through the ORM the `cause` branch is the only branch that fires.
    expect((thrown as { errno?: unknown }).errno).toBeUndefined();
    expect((thrown as { constraint?: unknown }).constraint).toBeUndefined();

    const driver = driverErrorOf(thrown);
    expect(driver).toBeDefined();
    expect(driver).not.toBe(thrown);
    expect(isUniqueViolation(driver)).toBe(true);
    expect(getConstraintName(driver)).toBe('ux_users_email');

    // The relocation itself, stated as an assertion rather than as a comment.
    const fields = driver as { code?: unknown; errno?: unknown };
    expect(fields.errno).toBe('23505');
    expect(fields.code).not.toBe('23505');
    // And `code` is not even SQLSTATE-SHAPED, which is why the log serializer
    // drops it and had to gain `errno` to report a code at all (§7.4b).
    expect(String(fields.code)).not.toMatch(/^[0-9A-Z]{5}$/);
  });

  test('maps to 409 through handleUserUniqueViolation, not a generic 500', async () => {
    const thrown = await duplicateEmail();
    const output = handleUserUniqueViolation(thrown);

    expect(output?.status).toBe(409);
    expect(output?.body).toEqual({
      success: false,
      message: MSG_EMAIL_EXISTS,
      data: null,
    });

    // The 409 says the address is taken and nothing else: not the index name it
    // was resolved from, and not the id of the row that already holds it.
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain('ux_users_email');
    expect(serialized).not.toContain(seeded().signedIn.user.userId);
  });
});

describe('a real foreign-key violation', () => {
  test('is recognised at both levels, and carries the name the mapper matches', async () => {
    const thrown = await provoke(
      () =>
        db.insert(users).values({
          id: generateUuidV7(),
          name: 'Driver Contract Orphan',
          email: `driver.orphan.${generateUuidV7().replaceAll('-', '')}@gmail.com`,
          // A role id that exists nowhere.
          roleId: generateUuidV7(),
          isActive: true,
        }),
      'an insert with an orphan role_id'
    );

    expect(isForeignKeyViolation(thrown)).toBe(true);
    expect(isForeignKeyViolation(driverErrorOf(thrown))).toBe(true);
    expect((driverErrorOf(thrown) as { errno?: unknown }).errno).toBe('23503');

    // `USER_FK_CONSTRAINTS` matches EXACTLY, so the real name reaching it is the
    // whole reason this becomes a 400 the client can act on.
    expect(getConstraintName(thrown)).toBe('users_role_id_roles_id_fk');
    expect(
      handleUserForeignKeyViolation(thrown, { roleNotFound: 'role not found' })
        ?.status
    ).toBe(400);
  });

  test('and neither predicate matches an unrelated failure', async () => {
    // Without this the suite could pass with `isUniqueViolation = () => true`.
    const undefinedTable = await provoke(
      () => db.execute(sql`SELECT 1 FROM a_table_that_does_not_exist`),
      'a query against a table that does not exist'
    );

    expect((driverErrorOf(undefinedTable) as { errno?: unknown }).errno).toBe(
      '42P01'
    );
    expect(isUniqueViolation(undefinedTable)).toBe(false);
    expect(isForeignKeyViolation(undefinedTable)).toBe(false);
    expect(getConstraintName(undefinedTable)).toBe('');
    expect(handleUserUniqueViolation(undefinedTable)).toBeUndefined();
  });
});

describe('the log line for a real driver error', () => {
  test('keeps the SQLSTATE and withholds the bound parameter PostgreSQL echoes back', async () => {
    // Both halves in one test, because widening the allowlist to fix the first
    // is exactly how the second gets broken.
    const undefinedTable = await provoke(
      () => db.execute(sql`SELECT 1 FROM a_table_that_does_not_exist`),
      'a query against a table that does not exist'
    );
    expect(JSON.stringify(sanitizeForLog(undefinedTable))).toContain('42P01');

    const secret = 'not-a-uuid-3f9a2b';
    const badCast = await provoke(
      () => db.select().from(users).where(eq(users.id, secret)),
      'a uuid comparison against a non-uuid'
    );

    // The containment half is only meaningful if the driver really does echo the
    // value, so that is asserted first.
    expect(
      String((driverErrorOf(badCast) as { message?: unknown }).message)
    ).toContain(secret);

    const serialized = JSON.stringify(sanitizeForLog(badCast));
    expect(serialized).toContain('22P02');
    expect(serialized).not.toContain(secret);
  });
});

describe('every jsonb column write lands as jsonb, asserted at the SQL level', () => {
  // `jsonb_typeof`, never a select through Drizzle: the ORM's read path is what
  // hid the double encode — `mapFromDriverValue` JSON-parsed the string back
  // into an object, so write twice / read twice returned the same object.

  test('the columns covered here are every jsonb column in the schema', () => {
    // Read out of the schema rather than listed, so a sixth jsonb column fails
    // this instead of being silently uncovered.
    expect(jsonbColumns()).toEqual([
      'audit_logs.changed_fields',
      'audit_logs.new_data',
      'audit_logs.old_data',
      'role_permissions.permissions',
      'sessions.metadata',
    ]);
  });

  test('sessions.metadata — through the real sign-in path and through the column mapper', async () => {
    // Better Auth's session-create hook writes `{roleId, roleName, roleScope,
    // permissions}` through the Drizzle adapter. That is the production write.
    expect(seeded().signInMetadataKind).toBe('object');

    const id = await insertSession(seeded().signedIn.user.userId, {
      roleId: seeded().signedIn.user.roleId,
    });
    const kind = await jsonbTypeof('sessions', 'metadata', id);
    expect(kind).toBe('object');
    // Named, because 'string' is the exact value the double encode produced.
    expect(kind).not.toBe('string');
  });

  test('role_permissions.permissions — written by the seeding insert', async () => {
    const [row] = await db
      .select({ id: rolePermissions.id })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, seeded().signedIn.user.roleId));
    if (!row) throw new Error('the seeded role holds no permission rows');

    const kind = await jsonbTypeof('role_permissions', 'permissions', row.id);
    expect(kind).toBe('object');
    expect(kind).not.toBe('string');
  });

  test("audit_logs' three columns — written by auditLog(), the production writer", async () => {
    const recordId = generateUuidV7();
    await withTransaction((tx) =>
      auditLog(tx, {
        userId: seeded().signedIn.user.userId,
        userEmail: seeded().signedIn.user.email,
        action: 'UPDATE',
        tableName: 'roles',
        recordId,
        oldData: { label: 'before' },
        newData: { label: 'after' },
        meta: { ip: null, userAgent: null, apiPath: '/driver-contract' },
      })
    );

    const [row] = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(eq(auditLogs.recordId, recordId));
    if (!row) throw new Error('auditLog wrote no row');

    expect(await jsonbTypeof('audit_logs', 'old_data', row.id)).toBe('object');
    expect(await jsonbTypeof('audit_logs', 'new_data', row.id)).toBe('object');
    // `changed_fields` is a jsonb ARRAY by design — `computeChangedFields`
    // returns `string[]`. The property under test is the same one: it is not a
    // jsonb STRING holding the JSON text of an array.
    expect(await jsonbTypeof('audit_logs', 'changed_fields', row.id)).toBe(
      'array'
    );
  });
});

describe('the permission-refresh merge', () => {
  /**
   * The state each case starts from, written fresh so no case can read another's
   * output. Once a row holds an array, `array || object` APPENDS, and every
   * later assertion against that row reads contaminated state — this made a
   * working fix look broken while it was being written.
   *
   * `keepMe` is a key `SessionMetadata` does not declare, which is the point: a
   * REPLACE loses it while passing every "the patch landed" assertion. `roleId`
   * and `permissions` start WRONG, so "the patch landed" means overwritten
   * rather than merely present.
   */
  function stale(): SessionMetadata & Record<string, unknown> {
    return { keepMe: 'must survive', roleId: 'stale-role-id', permissions: {} };
  }

  async function mergedMetadata(sessionId: string) {
    const rows = await db.execute<{
      kind: string | null;
      keep_me: string | null;
      role_id: string | null;
      permissions_kind: string | null;
      granted: string | null;
    }>(sql`
      SELECT jsonb_typeof(metadata) AS kind,
             metadata->>'keepMe' AS keep_me,
             metadata->>'roleId' AS role_id,
             jsonb_typeof(metadata->'permissions') AS permissions_kind,
             jsonb_extract_path_text(
               metadata, 'permissions', ${PAGE}, ${ACTION}
             ) AS granted
        FROM sessions WHERE id = ${sessionId}`);
    const row = rows[0];
    if (!row) throw new Error(`no session row for ${sessionId}`);
    return row;
  }

  test('refreshUserSessions merges: the unrelated key survives and the patch overwrites', async () => {
    const userId = seeded().signedIn.user.userId;
    const sessionId = await insertSession(userId, stale());
    expect(await jsonbTypeof('sessions', 'metadata', sessionId)).toBe('object');

    await refreshUserSessions(userId);

    const merged = await mergedMetadata(sessionId);
    // `||` on two jsonb STRINGS concatenates into an array, so this is the
    // defect in one assertion.
    expect(merged.kind).toBe('object');
    expect(merged.keep_me).toBe('must survive');
    expect(merged.role_id).toBe(seeded().signedIn.user.roleId);
    expect(merged.permissions_kind).toBe('object');
    expect(merged.granted).toBe('true');
  });

  test('refreshRoleSessions merges the same way, on its own row', async () => {
    const { userId, roleId } = seeded().roleMerge;
    const sessionId = await insertSession(userId, stale());
    expect(await jsonbTypeof('sessions', 'metadata', sessionId)).toBe('object');

    await withTransaction((tx) => refreshRoleSessions(roleId, tx));

    const merged = await mergedMetadata(sessionId);
    expect(merged.kind).toBe('object');
    expect(merged.keep_me).toBe('must survive');
    expect(merged.role_id).toBe(roleId);
    expect(merged.permissions_kind).toBe('object');
    expect(merged.granted).toBe('true');
  });
});

describe('a transaction is one session', () => {
  test('two pg_backend_pid() reads inside one withTransaction match, and the OTP advisory lock is held by that backend', async () => {
    const observed = await withTransaction(async (tx) => {
      const first = await tx.execute<{ pid: number }>(
        sql`SELECT pg_backend_pid() AS pid`
      );
      // The statement `processOtpSend` really issues, read out of `utils/otp.ts`.
      await tx.execute(
        productionStatement(ADVISORY_LOCK, [
          seeded().signedIn.user.userId,
          OTP_CHANNELS[0],
          OTP_PURPOSES[0],
        ])
      );
      const locks = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM pg_locks
         WHERE locktype = 'advisory' AND pid = pg_backend_pid()`);
      const second = await tx.execute<{ pid: number }>(
        sql`SELECT pg_backend_pid() AS pid`
      );
      return {
        first: first[0]?.pid,
        second: second[0]?.pid,
        advisoryLocks: locks[0]?.n,
      };
    });

    expect(observed.first).toBeGreaterThan(0);
    expect(observed.second).toBe(observed.first);
    // Exactly one, for THIS backend: without session continuity the lock is
    // taken and released by a connection nobody else in the block is using.
    expect(observed.advisoryLocks).toBe(1);
  });

  test('two concurrent transactions get different backends, so that PID is not a constant', async () => {
    // Without this, `samePid` above would also hold for a driver that reported
    // one fixed PID. The gate makes the two transactions genuinely overlap, and
    // it is bounded so a pool that cannot serve two cannot hang the run.
    const gate: { arrived: number; open: (() => void) | null } = {
      arrived: 0,
      open: null,
    };
    const both = new Promise<void>((resolve) => {
      gate.open = resolve;
    });

    const pidOf = () =>
      withTransaction(async (tx) => {
        const rows = await tx.execute<{ pid: number }>(
          sql`SELECT pg_backend_pid() AS pid`
        );
        gate.arrived += 1;
        if (gate.arrived === 2) gate.open?.();
        await Promise.race([both, Bun.sleep(2000)]);
        return rows[0]?.pid;
      });

    const [left, right] = await Promise.all([pidOf(), pidOf()]);
    expect(left).toBeGreaterThan(0);
    expect(right).not.toBe(left);
  });

  test('a throw rolls the write back', async () => {
    const roleName = `harness-driver-${generateUuidV7().replaceAll('-', '')}`;
    const seen = { insideTransaction: 0 };

    await expect(
      withTransaction(async (tx) => {
        await tx
          .insert(roles)
          .values({ roleName, scope: ROLE_SCOPE.STANDARD, isActive: true });
        // Read back inside the transaction, or "no row afterwards" would also
        // hold for an insert that never happened.
        const inside = await tx
          .select({ id: roles.id })
          .from(roles)
          .where(eq(roles.roleName, roleName));
        seen.insideTransaction = inside.length;
        throw new Error('deliberate rollback');
      })
    ).rejects.toThrow('deliberate rollback');

    expect(seen.insideTransaction).toBe(1);
    expect(
      await db
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.roleName, roleName))
    ).toEqual([]);
  });

  test('a nested tx.transaction() is a SAVEPOINT: the inner throw takes only the inner write', async () => {
    const suffix = generateUuidV7().replaceAll('-', '');
    const outerName = `harness-driver-outer-${suffix}`;
    const innerName = `harness-driver-inner-${suffix}`;

    await withTransaction(async (tx) => {
      await tx.insert(roles).values({
        roleName: outerName,
        scope: ROLE_SCOPE.STANDARD,
        isActive: true,
      });

      await expect(
        tx.transaction(async (inner) => {
          await inner.insert(roles).values({
            roleName: innerName,
            scope: ROLE_SCOPE.STANDARD,
            isActive: true,
          });
          throw new Error('inner fails');
        })
      ).rejects.toThrow('inner fails');

      // The outer transaction is still usable. On a driver that could not nest
      // at all, the inner failure aborted the whole transaction and this read
      // would fail with `current transaction is aborted`.
      expect(
        await tx
          .select({ id: roles.id })
          .from(roles)
          .where(eq(roles.roleName, outerName))
      ).toHaveLength(1);
    });

    // And the outer write committed while the inner one did not.
    expect(
      await db
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.roleName, outerName))
    ).toHaveLength(1);
    expect(
      await db
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.roleName, innerName))
    ).toHaveLength(0);
  });
});

describe('db.execute yields an array, at each call site that reads it', () => {
  // `neon-http` returned `{ rows: [...] }`. `deleted.rows.length === 0` on an
  // array is `undefined === 0`, i.e. false, so the role-delete guard would have
  // silently stopped rejecting deletes of roles that still have users. The
  // compiler caught all three sites; a future `execute` written from memory gets
  // no type error if it never touches `.rows`.

  test('the role DELETE … RETURNING returns zero rows for a role that still has users', async () => {
    const roleId = seeded().signedIn.user.roleId;
    const deleted = await db.execute(
      productionStatement(ROLE_DELETE, [roleId, ROLE_SCOPE.STANDARD])
    );

    expect(Array.isArray(deleted)).toBe(true);
    expect('rows' in deleted).toBe(false);
    // The guard's input: `deleted.length === 0` is what raises the 400.
    expect(deleted).toHaveLength(0);
    // And the role is still there, which is the security-relevant half.
    expect(
      await db.select({ id: roles.id }).from(roles).where(eq(roles.id, roleId))
    ).toHaveLength(1);
  });

  test('the role DELETE … RETURNING returns one row for a deletable role, and zero for one already gone', async () => {
    // Emptying the role is what makes it deletable: the statement's own
    // `NOT EXISTS` is the condition under test, so the user has to move rather
    // than be deleted here.
    const { roleId, userId } = seeded().deletable;
    await db
      .update(users)
      .set({ roleId: seeded().systemScoped.roleId })
      .where(eq(users.id, userId));

    const deleted = await db.execute<{ id: string }>(
      productionStatement(ROLE_DELETE, [roleId, ROLE_SCOPE.STANDARD])
    );
    expect(Array.isArray(deleted)).toBe(true);
    expect('rows' in deleted).toBe(false);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.id).toBe(roleId);

    const again = await db.execute(
      productionStatement(ROLE_DELETE, [roleId, ROLE_SCOPE.STANDARD])
    );
    expect(Array.isArray(again)).toBe(true);
    expect(again).toHaveLength(0);
  });

  test('the CTE UPDATE … RETURNING carries the previous name beside the new timestamp', async () => {
    const userId = seeded().signedIn.user.userId;
    const [before] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, userId));
    const renamed = `Renamed ${generateUuidV7().slice(0, 8)}`;

    const updated = await db.execute<{
      old_name: string;
      updated_at: unknown;
    }>(productionStatement(SELF_UPDATE_CTE, [userId, renamed]));

    expect(Array.isArray(updated)).toBe(true);
    expect('rows' in updated).toBe(false);
    // `updated[0]` is what the handler reads; `{rows}` would make it undefined
    // and answer 404 for a legitimate self-edit.
    expect(updated).toHaveLength(1);
    expect(updated[0]?.old_name).toBe(before?.name);
    expect(updated[0]?.updated_at).toBeInstanceOf(Date);

    const [after] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, userId));
    expect(after?.name).toBe(renamed);
  });

  test('the locking SELECT … FOR UPDATE OF u FOR SHARE OF r returns the locked row', async () => {
    const locked = await withTransaction((tx) =>
      tx.execute<{ email: string; role_name: string; role_scope: string }>(
        productionStatement(LOCKING_SELECT, [
          seeded().signedIn.user.userId,
          ROLE_SCOPE.SYSTEM,
        ])
      )
    );

    expect(Array.isArray(locked)).toBe(true);
    expect('rows' in locked).toBe(false);
    expect(locked).toHaveLength(1);
    expect(locked[0]?.email).toBe(seeded().signedIn.user.email);
    expect(locked[0]?.role_scope).toBe(ROLE_SCOPE.STANDARD);
  });

  test('the locking SELECT excludes a system-scoped role, and the empty array is what the 404 reads', async () => {
    const locked = await withTransaction((tx) =>
      tx.execute(
        productionStatement(LOCKING_SELECT, [
          seeded().systemScoped.userId,
          ROLE_SCOPE.SYSTEM,
        ])
      )
    );

    expect(Array.isArray(locked)).toBe(true);
    expect(locked).toHaveLength(0);
    // `locked[0]` is undefined, so `!lockedUser?.role_id` raises the 404 that
    // protects a system role from deletion.
    expect(locked[0]).toBeUndefined();
  });
});
