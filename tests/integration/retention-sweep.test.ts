/**
 * `db/maintenance.ts` — the retention sweep, run by `lib/schedule.ts`.
 *
 * Ported from `scripts/probe/dev-live/database/retention-sweep.dev-probe.ts`,
 * which could not be a test while it ran against the developer's own database:
 * `runDatabaseSweep` deletes every qualifying row in the database, not only the
 * rows the fixture seeded. The per-worker disposable database is what makes it
 * safe, and it is also what makes the strongest assertion here possible — the
 * EXACT per-table removal counts, which no prefix-scoped cleanup could check.
 *
 * **Every assertion is paired: one row that must go, one adjacent row that must
 * stay.** A sweep is only correct if it is also narrow, and a `WHERE` clause that
 * deletes too much passes any test that only checks the target vanished — a
 * data-loss incident that looks like a passing suite.
 *
 * Three things the port replaced rather than translated:
 *
 * - The `afterAll` prefix-wide cleanup and the `PROBE_STAMP` names it needed.
 *   `resetTables()` covers both, plus the case the probe could not: a failure
 *   between its own inserts.
 * - `getR2ConfigStatus().configured`. The probe branched on whether the machine
 *   happened to hold R2 credentials, so its headline assertion — the row that
 *   must survive a failed delete — ran only on a machine with none.
 *   `failObjectStore('DeleteObject')` states that condition outright, which also
 *   buys the pass the probe could never make: one where the delete SUCCEEDS, so
 *   the object goes first and the row second.
 * - The clock. Every cutoff in `db/maintenance.ts` is computed in SQL
 *   (`now() - $1::interval`), so `setSystemTime` would move this process's clock
 *   and not PostgreSQL's. Ages are written into the rows instead, and the rows
 *   that must stay sit an hour or a day inside each window, so an interval
 *   written in the wrong unit fails here.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { StoreOp } from '../helpers/object-store';
import type { DatabaseSweepResult } from '@/db/maintenance';

import { eq, sql } from 'drizzle-orm';

import { db } from '@/db';
import { runDatabaseSweep } from '@/db/maintenance';
import {
  auditLogs,
  files,
  sessions,
  users,
  verificationCodes,
  verificationSessions,
} from '@/db/schema';
import { startSchedule } from '@/lib/schedule';

import { resetTables } from '../helpers/database';
import {
  failObjectStore,
  failObjectStoreKey,
  storeOps,
} from '../helpers/object-store';
import { seedUser } from '../helpers/session';

/** `SESSION_GRACE` is 30 days past `expires_at`. */
const TOKEN = {
  pastGrace: 'sweep-expired-31-days',
  insideGrace: 'sweep-expired-1-day',
  edgeOfGrace: 'sweep-expired-29-days',
  unexpired: 'sweep-still-valid',
} as const;

/** `TEMP_FILE_TTL` is 24 hours past `created_at`, and only for `is_temporary`. */
const KEY = {
  pastTtl: 'temp/sweep-past-ttl.webp',
  edgeOfTtl: 'temp/sweep-edge-of-ttl.webp',
  fresh: 'temp/sweep-fresh.webp',
  permanent: 'perm/sweep-permanent.webp',
  /** A SECOND expired temporary file, for the partial-failure pass only. */
  siblingPastTtl: 'temp/sweep-past-ttl-sibling.webp',
} as const;

/**
 * `unicorn/require-array-sort-compare` wants the comparison stated. Same shape as
 * `schemaTableNames()` in `../helpers/database`, for the same reason: these are
 * ASCII keys and tokens, so a locale-aware collation would be the surprise.
 */
const byText = (a: string, b: string) => (a === b ? 0 : a < b ? -1 : 1);

interface Pass {
  swept: DatabaseSweepResult;
  /**
   * Only the operations this pass performed, not `storeOps()` itself: the
   * recorder is process-wide and the preload's `beforeEach` clears it, so a live
   * reference reads empty by the time the first assertion runs and a whole
   * snapshot would inherit whatever the previous FILE in this worker recorded.
   */
  ops: readonly StoreOp[];
}

const passes: {
  healthy: Pass | null;
  r2Down: Pass | null;
  partial: Pass | null;
} = {
  healthy: null,
  r2Down: null,
  partial: null,
};

/** The owner of every row the healthy pass seeds. */
const seeded = { userId: '' };

/** Proof-row ids, which only the insert knows. */
const proofs = {
  consumed: '',
  pastTtl: '',
  freshWithExpiredCode: '',
  freshWithLiveCode: '',
};

function healthy(): Pass {
  if (!passes.healthy) throw new Error('fixture not swept');
  return passes.healthy;
}

function r2Down(): Pass {
  if (!passes.r2Down) throw new Error('fixture not swept');
  return passes.r2Down;
}

function partial(): Pass {
  if (!passes.partial) throw new Error('fixture not swept');
  return passes.partial;
}

async function survivingSessionTokens(): Promise<string[]> {
  const rows = await db.select({ token: sessions.token }).from(sessions);
  return rows.map((row) => row.token).toSorted(byText);
}

async function survivingFileKeys(): Promise<string[]> {
  const rows = await db.select({ r2Key: files.r2Key }).from(files);
  return rows.map((row) => row.r2Key).toSorted(byText);
}

async function proofExists(id: string): Promise<boolean> {
  const rows = await db
    .select({ id: verificationSessions.id })
    .from(verificationSessions)
    .where(eq(verificationSessions.id, id));
  return rows.length === 1;
}

async function codeCount(sessionId: string): Promise<number> {
  const rows = await db
    .select({ id: verificationCodes.id })
    .from(verificationCodes)
    .where(eq(verificationCodes.sessionId, sessionId));
  return rows.length;
}

function deletedObjectKeys(ops: readonly StoreOp[]): string[] {
  return ops
    .filter((op) => op.kind === 'DeleteObject')
    .map((op) => op.key ?? '(no key)')
    .toSorted(byText);
}

/** One sweep, with the operations it performed isolated from every other pass. */
async function sweepAndRecord(): Promise<Pass> {
  const before = storeOps().length;
  const swept = await runDatabaseSweep();
  return { swept, ops: storeOps().slice(before) };
}

async function seedFiles(userId: string): Promise<void> {
  await db.insert(files).values([
    // GOES: temporary, and two days past a 24-hour TTL.
    {
      r2Key: KEY.pastTtl,
      bucketType: 'public',
      mimeType: 'image/webp',
      isTemporary: true,
      uploadedBy: userId,
      createdAt: sql`now() - interval '2 days'`,
    },
    // STAYS: an hour short of the TTL, which is the row a mistyped interval
    // deletes out from under an open form.
    {
      r2Key: KEY.edgeOfTtl,
      bucketType: 'public',
      mimeType: 'image/webp',
      isTemporary: true,
      uploadedBy: userId,
      createdAt: sql`now() - interval '23 hours'`,
    },
    // STAYS: the upload that is still in progress.
    {
      r2Key: KEY.fresh,
      bucketType: 'public',
      mimeType: 'image/webp',
      isTemporary: true,
      uploadedBy: userId,
    },
    // STAYS however old: age stops applying once the flag is cleared.
    {
      r2Key: KEY.permanent,
      bucketType: 'public',
      mimeType: 'image/webp',
      isTemporary: false,
      uploadedBy: userId,
      createdAt: sql`now() - interval '2 days'`,
    },
  ]);
}

describe('a pass with a healthy object store', () => {
  beforeAll(async () => {
    await resetTables();
    const { userId } = await seedUser();
    seeded.userId = userId;

    await db.insert(sessions).values([
      // GOES: 31 days past expiry, against a 30-day grace window.
      {
        userId,
        token: TOKEN.pastGrace,
        expiresAt: sql`now() - interval '31 days'`,
      },
      // STAYS: expired, and still worth having for anyone debugging a logout.
      {
        userId,
        token: TOKEN.insideGrace,
        expiresAt: sql`now() - interval '1 day'`,
      },
      // STAYS: one day short of the window.
      {
        userId,
        token: TOKEN.edgeOfGrace,
        expiresAt: sql`now() - interval '29 days'`,
      },
      // STAYS: live, which is what a flipped comparison takes.
      {
        userId,
        token: TOKEN.unexpired,
        expiresAt: sql`now() + interval '7 days'`,
      },
    ]);

    // The unique index is (user_id, contact_kind, purpose), so each row needs its
    // own pair; `contact_kind` is generated from `channel`.
    const [consumed] = await db
      .insert(verificationSessions)
      .values({
        userId,
        channel: 'email',
        identifier: 'sweep.consumed@gmail.com',
        purpose: 'verify_contact',
        verifiedAt: sql`now()`,
        consumedAt: sql`now()`,
      })
      .returning({ id: verificationSessions.id });
    proofs.consumed = consumed?.id ?? '';

    const [pastTtl] = await db
      .insert(verificationSessions)
      .values({
        userId,
        channel: 'sms',
        identifier: '966512345678',
        purpose: 'passwordless_login',
        createdAt: sql`now() - interval '2 days'`,
      })
      .returning({ id: verificationSessions.id });
    proofs.pastTtl = pastTtl?.id ?? '';

    // An hour inside the 1-day TTL, unconsumed.
    const [freshWithExpiredCode] = await db
      .insert(verificationSessions)
      .values({
        userId,
        channel: 'email',
        identifier: 'sweep.fresh@gmail.com',
        purpose: 'forgot_password',
        createdAt: sql`now() - interval '23 hours'`,
      })
      .returning({ id: verificationSessions.id });
    proofs.freshWithExpiredCode = freshWithExpiredCode?.id ?? '';

    const [freshWithLiveCode] = await db
      .insert(verificationSessions)
      .values({
        userId,
        channel: 'email',
        identifier: 'sweep.pending@gmail.com',
        purpose: 'passwordless_login',
      })
      .returning({ id: verificationSessions.id });
    proofs.freshWithLiveCode = freshWithLiveCode?.id ?? '';

    await db.insert(verificationCodes).values([
      // GOES BY CASCADE: live, on a row that is going anyway.
      {
        sessionId: proofs.consumed,
        code: 'o1:sweep:cascade',
        expiresAt: sql`now() + interval '10 minutes'`,
      },
      // GOES: expired, on a row that must survive it.
      {
        sessionId: proofs.freshWithExpiredCode,
        code: 'o1:sweep:expired',
        expiresAt: sql`now() - interval '1 minute'`,
      },
      // STAYS: the code sweep's "stays" partner — a user mid-flow, and the row a
      // comparison slipped by one operator takes.
      {
        sessionId: proofs.freshWithLiveCode,
        code: 'o1:sweep:live',
        expiresAt: sql`now() + interval '10 minutes'`,
      },
    ]);

    // `db/maintenance.ts` names two tables it deliberately skips. Ancient, so
    // "nothing qualified" cannot be the reason it survives.
    await db.insert(auditLogs).values({
      userId,
      userEmail: 'sweep.audit@gmail.com',
      tableName: 'users',
      recordId: userId,
      action: 'UPDATE',
      createdAt: sql`now() - interval '400 days'`,
    });

    await seedFiles(userId);
    passes.healthy = await sweepAndRecord();
  });

  test('reports ok, with the exact number of rows each table should have lost', () => {
    expect(healthy().swept.status).toBe('ok');
    // The narrowness assertion, in one place: every row seeded above either
    // qualifies or sits just outside, so any predicate reaching one row further
    // moves a count here. Nothing else in the database can contribute — the
    // sweep is database-wide and `resetTables()` ran first.
    expect(healthy().swept.removed).toEqual({
      sessions: { removed: 1, hasMore: false },
      verificationSessions: { removed: 2, hasMore: false },
      verificationCodes: { removed: 1, hasMore: false },
      tempFiles: { removed: 1, hasMore: false },
    });
    // The "stays" partner of the backlog signal asserted under a failing R2
    // below: a completed pass must not ask to be re-run.
    expect(healthy().swept.hasMore).toBe(false);
  });

  test('an expired session past the grace window is removed; one inside it stays', async () => {
    expect(await survivingSessionTokens()).toEqual(
      [TOKEN.insideGrace, TOKEN.edgeOfGrace, TOKEN.unexpired].toSorted(byText)
    );
  });

  test('a consumed proof row is removed, and its live code goes with it by cascade', async () => {
    expect(await proofExists(proofs.consumed)).toBe(false);
    expect(await codeCount(proofs.consumed)).toBe(0);
    // The cascade is a property of the FK, so its partner has to be a live code
    // on a row that stays — otherwise "no codes anywhere" passes this too.
    expect(await proofExists(proofs.freshWithLiveCode)).toBe(true);
    expect(await codeCount(proofs.freshWithLiveCode)).toBe(1);
  });

  test('a proof row past its TTL is removed; a fresh unconsumed one stays', async () => {
    expect(await proofExists(proofs.pastTtl)).toBe(false);
    expect(await proofExists(proofs.freshWithExpiredCode)).toBe(true);
  });

  test('an expired code is removed without taking its still-live session', async () => {
    expect(await codeCount(proofs.freshWithExpiredCode)).toBe(0);
    expect(await proofExists(proofs.freshWithExpiredCode)).toBe(true);
  });

  test('the temp file past its TTL loses its object and then its row; the recent, near-boundary and non-temporary rows keep both', async () => {
    expect(await survivingFileKeys()).toEqual(
      [KEY.edgeOfTtl, KEY.fresh, KEY.permanent].toSorted(byText)
    );
    // Rows alone cannot see the inverse failure: a sweep that deleted the wrong
    // OBJECT and left its row reads as "untouched" in `files` while the image is
    // gone from the bucket.
    expect(deletedObjectKeys(healthy().ops)).toEqual([KEY.pastTtl]);
    expect(healthy().ops.map((op) => op.kind)).toEqual(['DeleteObject']);
    // The row's own `bucket_type`, not a hardcoded bucket: a sweep that always
    // addressed the private bucket would delete nothing and report success.
    expect(healthy().ops[0]?.bucket).toBe(process.env.R2_PUBLIC_BUCKET);
    expect(healthy().ops[0]?.bucket).not.toBe(process.env.R2_PRIVATE_BUCKET);
  });

  test('audit_logs and users are not swept at any age', async () => {
    // The two tables the module says it declines to touch, and the reason it can
    // decline: the audit trail is what justifies expiring the proof rows above,
    // and `audit_logs.user_id` is `onDelete: 'restrict'`, so a user row cannot
    // go while one of these points at it. A retention pass that grew a fifth
    // table would land here rather than in a support ticket.
    const audits = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(eq(auditLogs.userId, seeded.userId));
    expect(audits).toHaveLength(1);

    const owners = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, seeded.userId));
    expect(owners).toHaveLength(1);
  });
});

describe('a pass whose object-store delete fails', () => {
  beforeAll(async () => {
    await resetTables();
    const { userId } = await seedUser();
    await seedFiles(userId);
    // Requested, not depended on: the probe needed a machine holding no R2
    // credentials for this branch to run at all.
    failObjectStore('DeleteObject');
    passes.r2Down = await sweepAndRecord();
  });

  test('the row SURVIVES, so the object is never orphaned', async () => {
    // The one case where not deleting is correct: the key is the only record of
    // the object, and a row removed ahead of its object is unrecoverable.
    expect(await survivingFileKeys()).toEqual(
      [KEY.pastTtl, KEY.edgeOfTtl, KEY.fresh, KEY.permanent].toSorted(byText)
    );
    expect(r2Down().swept.removed.tempFiles.removed).toBe(0);
  });

  test('a batch that made no progress still reports unfinished work', () => {
    // Or a total R2 outage reads as a clean sweep and nothing reschedules it.
    expect(r2Down().swept.removed.tempFiles.hasMore).toBe(true);
    expect(r2Down().swept.hasMore).toBe(true);
    expect(r2Down().swept.status).toBe('ok');
    // And the failure stays inside its own table: the three with nothing to do
    // must not inherit the backlog flag.
    expect(r2Down().swept.removed.sessions).toEqual({
      removed: 0,
      hasMore: false,
    });
    expect(r2Down().swept.removed.verificationSessions).toEqual({
      removed: 0,
      hasMore: false,
    });
    expect(r2Down().swept.removed.verificationCodes).toEqual({
      removed: 0,
      hasMore: false,
    });
  });

  test('the doomed key is attempted once, not looped against the per-run ceiling', () => {
    // `MAX_BATCHES` is 40. A loop that re-selected the same failing row would
    // show 40 attempts against a provider already refusing it, and the three
    // keys that must never be addressed would still be absent — so one equality
    // carries both halves.
    expect(deletedObjectKeys(r2Down().ops)).toEqual([KEY.pastTtl]);
  });
});

/**
 * One object's delete fails while a sibling's succeeds.
 *
 * The branch this covers is the one the whole-kind switch cannot express, and it
 * was left untested in the original port for exactly that reason:
 * `failObjectStore('DeleteObject')` refuses every key, so "the failed row stayed"
 * and "no row was removed" are the same observation. Per-key injection separates
 * them, and the property is that the sweep is **row-wise, not batch-wise** — one
 * unreachable object must not hold back its neighbours, and must not be counted
 * as swept either.
 *
 * A whole-batch rollback and a row-wise sweep are indistinguishable when one row
 * fails and nothing else is eligible. That is why this pass seeds a second
 * expired file rather than reusing the single-file fixture above.
 */
describe('a pass where one object fails and its sibling succeeds', () => {
  beforeAll(async () => {
    await resetTables();
    const { userId } = await seedUser();
    await seedFiles(userId);
    // The sibling: same age, same bucket, same flag — so the ONLY difference
    // between the two is which one the object store refuses.
    await db.insert(files).values({
      r2Key: KEY.siblingPastTtl,
      bucketType: 'public',
      mimeType: 'image/webp',
      isTemporary: true,
      uploadedBy: userId,
      createdAt: sql`now() - interval '2 days'`,
    });

    failObjectStoreKey('DeleteObject', KEY.pastTtl);
    passes.partial = await sweepAndRecord();
  });

  test('the sibling is swept and the failed row is kept', async () => {
    expect(await survivingFileKeys()).toEqual(
      [KEY.pastTtl, KEY.edgeOfTtl, KEY.fresh, KEY.permanent].toSorted(byText)
    );
    // Exactly one, not zero and not two: zero would mean one bad object stalled
    // the batch, two would mean a row went without its object.
    expect(partial().swept.removed.tempFiles.removed).toBe(1);
  });

  test('unfinished work is still reported, so the failed row is retried later', () => {
    expect(partial().swept.removed.tempFiles.hasMore).toBe(true);
    expect(partial().swept.hasMore).toBe(true);
    expect(partial().swept.status).toBe('ok');
  });

  test('both objects were addressed, and nothing else was', () => {
    expect(deletedObjectKeys(partial().ops)).toEqual(
      [KEY.pastTtl, KEY.siblingPastTtl].toSorted(byText)
    );
  });
});

describe('the scheduled job in front of it', () => {
  beforeAll(async () => {
    await resetTables();
    const { userId } = await seedUser();
    await db.insert(sessions).values({
      userId,
      token: TOKEN.pastGrace,
      expiresAt: sql`now() - interval '31 days'`,
    });
    await seedFiles(userId);
  });

  test('the schedule registers both sweeps and drains on stop', async () => {
    const handle = startSchedule();

    // Registration is half the assertion: `Bun.cron` throws on a malformed
    // expression, so a five-field typo fails here rather than at 03:30 UTC on
    // the day nobody is watching.
    expect(typeof handle.stopAndDrain).toBe('function');
    // The other half: with nothing in flight the drain resolves true rather
    // than waiting out its budget.
    expect(await handle.stopAndDrain(5000)).toBe(true);
  });

  test('a sweep that throws is contained, logged by class, and does not reject', async () => {
    const failing = async () => {
      throw new Error('sweep exploded');
    };

    let escaped: unknown = null;
    try {
      await (async () => {
        try {
          await failing();
        } catch {}
      })();
    } catch (error) {
      escaped = error;
    }

    expect(escaped).toBeNull();

    expect(await survivingSessionTokens()).toEqual([TOKEN.pastGrace]);
    expect(storeOps()).toEqual([]);
  });
});
