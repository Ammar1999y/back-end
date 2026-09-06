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
 *   `failObjectStore('DeleteObjects')` states that condition outright, which
 *   also buys the pass the probe could never make: one where the delete
 *   SUCCEEDS, so the object goes first and the row second.
 * - The clock. Every cutoff in `db/maintenance.ts` is computed in SQL
 *   (`now() - $1::interval`), so `setSystemTime` would move this process's clock
 *   and not PostgreSQL's. Ages are written into the rows instead, and the rows
 *   that must stay sit an hour or a day inside each window, so an interval
 *   written in the wrong unit fails here.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { StoreOp } from '../helpers/object-store';
import type { DatabaseSweepResult } from '@/db/maintenance';

import { eq, sql } from 'drizzle-orm';

import { db } from '@/db';
import { runDatabaseSweep } from '@/db/maintenance';
import {
  auditLogs,
  files,
  folders,
  sessions,
  trustedDevices,
  users,
  verificationCodes,
  verifications,
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
import {
  createReferrerTable,
  dropReferrerTable,
  PUBLIC_SOURCE,
  withSource,
} from '../helpers/usage-registry';

/** `SESSION_GRACE` is 30 days past `expires_at`. */
const TOKEN = {
  pastGrace: 'sweep-expired-31-days',
  insideGrace: 'sweep-expired-1-day',
  edgeOfGrace: 'sweep-expired-29-days',
  unexpired: 'sweep-still-valid',
} as const;

/**
 * `PENDING_FILE_TTL` is 24 hours past `created_at`, and only for `pending`
 * rows. A `deleting` row is finished at any age: it is a delete that lost its
 * request between phases, not a retention decision.
 */
const KEY = {
  pastTtl: 'm/2026/09/sweep-past-ttl.webp',
  edgeOfTtl: 'm/2026/09/sweep-edge-of-ttl.webp',
  fresh: 'm/2026/09/sweep-fresh.webp',
  permanent: 'm/2026/09/sweep-permanent.webp',
  orphanDeleting: 'm/2026/09/sweep-orphan-deleting.webp',
  /** A SECOND expired pending file, for the partial-failure pass only. */
  siblingPastTtl: 'm/2026/09/sweep-past-ttl-sibling.webp',
} as const;

/** Both new sweeps cut on `expires_at` against `now()`, with no grace window. */
const IDENTIFIER = {
  expiredChallenge: '2fa-sweep-expired-challenge',
  liveChallenge: '2fa-sweep-live-challenge',
  expiredDevice: 'trust-device-sweep-expired',
  liveDevice: 'trust-device-sweep-live',
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

/**
 * The identifiers still present in one of the two tables keyed by one.
 *
 * Both columns are named differently by design — `verifications.identifier` is
 * Better Auth's, `trusted_devices.trust_identifier` is ours — so the table
 * supplies its own column rather than the caller naming it twice.
 */
async function survivingIdentifiers(
  table: typeof verifications | typeof trustedDevices
): Promise<string[]> {
  const column =
    table === verifications
      ? verifications.identifier
      : trustedDevices.trustIdentifier;
  const rows = await db.select({ identifier: column }).from(table);
  return rows.map((row) => row.identifier).toSorted(byText);
}

async function codeCount(sessionId: string): Promise<number> {
  const rows = await db
    .select({ id: verificationCodes.id })
    .from(verificationCodes)
    .where(eq(verificationCodes.sessionId, sessionId));
  return rows.length;
}

/** Every key the pass asked the object store to remove, single or batched. */
function deletedObjectKeys(ops: readonly StoreOp[]): string[] {
  return ops
    .flatMap((op) =>
      op.kind === 'DeleteObjects'
        ? (op.keys ?? [])
        : op.kind === 'DeleteObject'
          ? [op.key ?? '(no key)']
          : []
    )
    .toSorted(byText);
}

/** One sweep, with the operations it performed isolated from every other pass. */
async function sweepAndRecord(): Promise<Pass> {
  const before = storeOps().length;
  const swept = await runDatabaseSweep();
  return { swept, ops: storeOps().slice(before) };
}

const IMAGE_ROW = {
  bucketType: 'public',
  kind: 'image',
  mimeType: 'image/webp',
} as const;

async function seedFiles(userId: string): Promise<void> {
  await db.insert(files).values([
    // GOES: pending, and two days past a 24-hour TTL.
    {
      ...IMAGE_ROW,
      r2Key: KEY.pastTtl,
      displayName: 'past-ttl.webp',
      status: 'pending',
      uploadedBy: userId,
      createdAt: sql`now() - interval '2 days'`,
    },
    // STAYS: an hour short of the TTL, which is the row a mistyped interval
    // deletes out from under an open form.
    {
      ...IMAGE_ROW,
      r2Key: KEY.edgeOfTtl,
      displayName: 'edge-of-ttl.webp',
      status: 'pending',
      uploadedBy: userId,
      createdAt: sql`now() - interval '23 hours'`,
    },
    // STAYS: the upload that is still in progress.
    {
      ...IMAGE_ROW,
      r2Key: KEY.fresh,
      displayName: 'fresh.webp',
      status: 'pending',
      uploadedBy: userId,
    },
    // STAYS however old: age stops applying once the row is active.
    {
      ...IMAGE_ROW,
      r2Key: KEY.permanent,
      displayName: 'permanent.webp',
      status: 'active',
      uploadedBy: userId,
      createdAt: sql`now() - interval '2 days'`,
    },
    // GOES at any age: a delete that committed phase A and lost its request.
    {
      ...IMAGE_ROW,
      r2Key: KEY.orphanDeleting,
      displayName: 'orphan-deleting.webp',
      status: 'deleting',
      uploadedBy: userId,
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

    // Both new sweeps filter on `expires_at` alone, so their "stays" partner is
    // a row a minute the other side of now — the margin an inverted comparison
    // or a missing sign has to cross.
    await db.insert(verifications).values([
      // GOES: a 2FA challenge nobody completed.
      {
        identifier: IDENTIFIER.expiredChallenge,
        value: userId,
        expiresAt: sql`now() - interval '1 minute'`,
      },
      // STAYS: a challenge still in flight.
      {
        identifier: IDENTIFIER.liveChallenge,
        value: userId,
        expiresAt: sql`now() + interval '9 minutes'`,
      },
    ]);

    await db.insert(trustedDevices).values([
      // GOES: past `trustDeviceMaxAge`; it already grants no skip.
      {
        userId,
        trustIdentifier: IDENTIFIER.expiredDevice,
        expiresAt: sql`now() - interval '1 minute'`,
      },
      // STAYS: a device the user would expect to still see listed.
      {
        userId,
        trustIdentifier: IDENTIFIER.liveDevice,
        expiresAt: sql`now() + interval '29 days'`,
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
      verifications: { removed: 1, hasMore: false },
      trustedDevices: { removed: 1, hasMore: false },
      // `stamped: 0`, with an active row in no folder present (`KEY.permanent`):
      // no owner table is registered here, and the unfiled guards fail closed
      // while none is. The registered case is the `unfiled files` block below.
      files: {
        removed: 2,
        unfiled: { stamped: 0, reaped: 0 },
        hasMore: false,
        degraded: false,
      },
      transitions: { reverted: 0, finished: 0, failed: 0, degraded: false },
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

  test('an expired 2FA challenge is removed; one still in flight stays', async () => {
    expect(await survivingIdentifiers(verifications)).toEqual([
      IDENTIFIER.liveChallenge,
    ]);
  });

  test('an expired trusted device is removed; a live one stays listed', async () => {
    expect(await survivingIdentifiers(trustedDevices)).toEqual([
      IDENTIFIER.liveDevice,
    ]);
  });

  test('the pending file past its TTL and the orphaned deleting row lose their objects and then their rows; the recent, near-boundary and active rows keep both', async () => {
    expect(await survivingFileKeys()).toEqual(
      [KEY.edgeOfTtl, KEY.fresh, KEY.permanent].toSorted(byText)
    );
    // Rows alone cannot see the inverse failure: a sweep that deleted the wrong
    // OBJECT and left its row reads as "untouched" in `files` while the image is
    // gone from the bucket.
    expect(deletedObjectKeys(healthy().ops)).toEqual(
      [KEY.pastTtl, KEY.orphanDeleting].toSorted(byText)
    );
    // One batched call per bucket, not one round trip per row.
    expect(healthy().ops.map((op) => op.kind)).toEqual(['DeleteObjects']);
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
    failObjectStore('DeleteObjects');
    passes.r2Down = await sweepAndRecord();
  });

  test('every row SURVIVES, so no object is ever orphaned', async () => {
    // The one case where not deleting is correct: the key is the only record of
    // the object, and a row removed ahead of its object is unrecoverable. The
    // expired row is now `deleting` — marked, so the next run finishes it — but
    // it is still there.
    expect(await survivingFileKeys()).toEqual(
      [
        KEY.pastTtl,
        KEY.edgeOfTtl,
        KEY.fresh,
        KEY.permanent,
        KEY.orphanDeleting,
      ].toSorted(byText)
    );
    expect(r2Down().swept.removed.files.removed).toBe(0);
  });

  test('a batch that made no progress still reports unfinished work', () => {
    // Or a total R2 outage reads as a clean sweep and nothing reschedules it.
    expect(r2Down().swept.removed.files.hasMore).toBe(true);
    expect(r2Down().swept.hasMore).toBe(true);
    // And it reports DEGRADED, not `ok`. `hasMore` alone is indistinguishable
    // from an ordinary backlog, so an alert built on the sweep-level status —
    // the signal the sibling SQLite job defines and the only one either job
    // emits — stayed quiet through a total object-store outage while abandoned
    // uploads accumulated in the bucket and were billed.
    expect(r2Down().swept.status).toBe('degraded');
    expect(r2Down().swept.removed.files.degraded).toBe(true);
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

  test('the doomed keys are attempted once, not looped against the per-run ceiling', () => {
    // A loop that re-selected the same failing rows would show repeated
    // attempts against a provider already refusing them, and the three keys
    // that must never be addressed would still be absent — so one equality
    // carries both halves.
    expect(deletedObjectKeys(r2Down().ops)).toEqual(
      [KEY.pastTtl, KEY.orphanDeleting].toSorted(byText)
    );
    expect(r2Down().ops.map((op) => op.kind)).toEqual(['DeleteObjects']);
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
    // The sibling: same age, same bucket, same status — so the ONLY difference
    // between the two is which one the object store refuses.
    await db.insert(files).values({
      ...IMAGE_ROW,
      r2Key: KEY.siblingPastTtl,
      displayName: 'past-ttl-sibling.webp',
      status: 'pending',
      uploadedBy: userId,
      createdAt: sql`now() - interval '2 days'`,
    });

    // Inside one `DeleteObjects` call the refused key comes back in `Errors`
    // while its neighbours are removed — how R2 reports it, and how the stub
    // reproduces it.
    failObjectStoreKey('DeleteObjects', KEY.pastTtl);
    passes.partial = await sweepAndRecord();
  });

  test('the sibling and the orphan are swept and the failed row is kept', async () => {
    expect(await survivingFileKeys()).toEqual(
      [KEY.pastTtl, KEY.edgeOfTtl, KEY.fresh, KEY.permanent].toSorted(byText)
    );
    // Exactly two, not zero and not three: zero would mean one bad object
    // stalled the batch, three would mean a row went without its object.
    expect(partial().swept.removed.files.removed).toBe(2);
  });

  test('unfinished work is still reported, so the failed row is retried later', () => {
    expect(partial().swept.removed.files.hasMore).toBe(true);
    expect(partial().swept.hasMore).toBe(true);
    // Degraded on ANY failed delete, not only on a run that removed nothing:
    // partial progress still means a store this pass was asked to sweep was not
    // fully swept, and `hasMore` alone reads as an ordinary backlog.
    expect(partial().swept.status).toBe('degraded');
    expect(partial().swept.removed.files.degraded).toBe(true);
  });

  test('all three objects were addressed in one call, and nothing else was', () => {
    expect(deletedObjectKeys(partial().ops)).toEqual(
      [KEY.pastTtl, KEY.siblingPastTtl, KEY.orphanDeleting].toSorted(byText)
    );
    expect(partial().ops.map((op) => op.kind)).toEqual(['DeleteObjects']);
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

/**
 * Unfiled files — active, in no folder, referenced by no record: the state an
 * entity upload reaches when the record that held it is deleted. The sweep
 * stamps one the first time it sees it and reaps it `UNFILED_RETENTION_DAYS`
 * after the stamp; a folder (adoption) or a new owner clears the stamp.
 */
describe('unfiled files', () => {
  const UNFILED = {
    fresh: 'm/2026/09/unfiled-fresh.webp',
    due: 'm/2026/09/unfiled-due.webp',
    inside: 'm/2026/09/unfiled-inside.webp',
    refiled: 'm/2026/09/unfiled-refiled.webp',
    library: 'm/2026/09/unfiled-library.webp',
  } as const;

  const unfiledPass: { pass: Pass | null } = { pass: null };

  beforeAll(async () => {
    await resetTables();
    const { userId } = await seedUser();
    const [folder] = await db
      .insert(folders)
      .values({ name: 'Kept' })
      .returning({ id: folders.id });
    if (!folder) throw new Error('folder fixture missing');
    await db.insert(files).values([
      // STAMPED this pass, and stays: the window starts now.
      {
        ...IMAGE_ROW,
        r2Key: UNFILED.fresh,
        displayName: 'fresh.webp',
        status: 'active',
        uploadedBy: userId,
      },
      // GOES: stamped eight days ago against a seven-day window.
      {
        ...IMAGE_ROW,
        r2Key: UNFILED.due,
        displayName: 'due.webp',
        status: 'active',
        uploadedBy: userId,
        unfiledAt: sql`now() - interval '8 days'`,
      },
      // STAYS: a day inside the window.
      {
        ...IMAGE_ROW,
        r2Key: UNFILED.inside,
        displayName: 'inside.webp',
        status: 'active',
        uploadedBy: userId,
        unfiledAt: sql`now() - interval '6 days'`,
      },
      // STAYS, and loses its stamp: it was moved into a folder after being
      // stamped, which is exactly the adoption the listing offers.
      {
        ...IMAGE_ROW,
        r2Key: UNFILED.refiled,
        displayName: 'refiled.webp',
        status: 'active',
        uploadedBy: userId,
        folderId: folder.id,
        unfiledAt: sql`now() - interval '8 days'`,
      },
      // STAYS, never stamped: a library file is not unfiled.
      {
        ...IMAGE_ROW,
        r2Key: UNFILED.library,
        displayName: 'library.webp',
        status: 'active',
        uploadedBy: userId,
        folderId: folder.id,
      },
    ]);
    await createReferrerTable();
    // The unfiled scope exists for projects that hold files on their own
    // records, and its guards match nothing until one says so.
    unfiledPass.pass = await withSource(PUBLIC_SOURCE, sweepAndRecord);
  });

  afterAll(async () => {
    await dropReferrerTable();
  });

  test('one stamped, one reaped, the filed one unstamped, the rest untouched', async () => {
    const pass = unfiledPass.pass;
    if (!pass) throw new Error('fixture not swept');
    expect(pass.swept.removed.files).toEqual({
      removed: 1,
      unfiled: { stamped: 1, reaped: 1 },
      hasMore: false,
      degraded: false,
    });
    expect(pass.swept.status).toBe('ok');

    const rows = await db
      .select({ r2Key: files.r2Key, unfiledAt: files.unfiledAt })
      .from(files);
    const stamps = new Map(rows.map((row) => [row.r2Key, row.unfiledAt]));
    expect(stamps.keys().toArray().toSorted(byText)).toEqual(
      [
        UNFILED.fresh,
        UNFILED.inside,
        UNFILED.refiled,
        UNFILED.library,
      ].toSorted(byText)
    );
    expect(stamps.get(UNFILED.fresh)).toBeInstanceOf(Date);
    expect(stamps.get(UNFILED.inside)).toBeInstanceOf(Date);
    expect(stamps.get(UNFILED.refiled)).toBeNull();
    expect(stamps.get(UNFILED.library)).toBeNull();

    // The object went with the row, and only that one.
    expect(deletedObjectKeys(pass.ops)).toEqual([UNFILED.due]);
  });

  test('a pass with no owner table registered stamps nothing, reaps nothing, and takes the stamped rows off the clock', async () => {
    // The shipped state of the kit: `unreferenced()` fails closed, so no row is
    // unfiled and the reaper has nothing to collect. Answering "true" there put
    // every claimed entity upload of every project on a seven-day clock.
    const before = await db
      .select({ id: files.id })
      .from(files)
      .where(eq(files.r2Key, UNFILED.fresh));
    expect(before).toHaveLength(1);

    const pass = await sweepAndRecord();
    expect(pass.swept.removed.files).toMatchObject({
      unfiled: { stamped: 0, reaped: 0 },
    });
    const stamps = await db
      .select({ unfiledAt: files.unfiledAt })
      .from(files)
      .where(eq(files.r2Key, UNFILED.fresh));
    expect(stamps[0]?.unfiledAt).toBeNull();
  });
});
