/**
 * The database-name grammar the harness's safety guards are asserted against.
 *
 * **This file exists because its absence cost a high-severity defect.**
 * `tests/helpers/names.ts` is the one pure, dependency-free, security-relevant
 * module in the harness — the preload's guards compare against it and
 * `reclaimStale` decides what to `DROP DATABASE … WITH (FORCE)` from it — and it
 * had no test. The separator between a run token's timestamp and its random half
 * was `x`, which is a base36 digit, so `split('x')` truncated the stamp mid-number
 * and reported a database created one second ago as decades old. A concurrently
 * running suite's databases were one reclaim away from being dropped under it.
 *
 * The round-trip property below is what catches that class: for any timestamp,
 * the age read back out of a freshly built name must be zero. It is asserted over
 * a range rather than one value, because the defect was data-dependent — the
 * timestamp at the moment of writing happened not to contain an `x`, so a single
 * `Date.now()` case would have passed.
 */
import { describe, expect, test } from 'bun:test';

import {
  HARNESS_PREFIX,
  HARNESS_SUFFIX,
  harnessDatabaseAgeMs,
  isHarnessDatabase,
  newRunToken,
  TEMPLATE_DATABASE,
  workerDatabaseName,
} from '../helpers/names';

/** Matches `quoteIdentifier`'s charset in `tests/helpers/provision.ts`. */
const SAFE_IDENTIFIER = /^[a-z0-9_]+$/;

/** PostgreSQL truncates an identifier past this, which would alias two names. */
const PG_IDENTIFIER_MAX_BYTES = 63;

const SAMPLE_MS = 1_787_000_000_000;

describe('run token round-trip', () => {
  test('a freshly built name reports an age of zero, for every hour in five years', () => {
    // The whole defect class in one walk. Hourly over five years is 43,800
    // timestamps; the broken separator failed 22.8% of them.
    const failures: string[] = [];
    for (let hour = 0; hour < 24 * 365 * 5; hour++) {
      const now = SAMPLE_MS + hour * 3_600_000;
      const name = workerDatabaseName(newRunToken(now, 'abc123'), 1);
      if (harnessDatabaseAgeMs(name, now) !== 0) failures.push(name);
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });

  test('the separator is not a base36 digit', () => {
    // Stated as a property of the OUTPUT rather than by reading the constant: the
    // stamp must be exactly what `toString(36)` produced, so whatever separates
    // it from the random half cannot be a character `toString(36)` can emit.
    const token = newRunToken(SAMPLE_MS, 'abc123');
    const stamp = SAMPLE_MS.toString(36);
    expect(token.startsWith(stamp)).toBe(true);
    const separator = token.charAt(stamp.length);
    expect(Number.parseInt(separator, 36)).toBeNaN();
  });

  test('an older database reports the elapsed time', () => {
    const created = SAMPLE_MS;
    const name = workerDatabaseName(newRunToken(created, 'abc123'), 1);
    expect(harnessDatabaseAgeMs(name, created + 7_200_000)).toBe(7_200_000);
  });

  test('a name from the future reports null rather than a negative age', () => {
    // `null` means "do not reclaim". A negative age would compare below the
    // staleness threshold and be safe today, but the contract is what is asserted.
    const name = workerDatabaseName(newRunToken(SAMPLE_MS + 60_000, 'abc'), 1);
    expect(harnessDatabaseAgeMs(name, SAMPLE_MS)).toBeNull();
  });
});

describe('ownership and reclaim safety', () => {
  test.each([
    ['app', 'the developer database'],
    ['postgres', 'the maintenance database'],
    ['app_test', 'the suffix without the prefix'],
    ['app_harness_x', 'the prefix without the suffix'],
    ['myapp_harness_abc_test', 'the prefix not at the start'],
  ])('%s is not a harness database (%s)', (name) => {
    expect(isHarnessDatabase(name)).toBe(false);
    // The stronger half: it is never a reclaim candidate either.
    expect(harnessDatabaseAgeMs(name, Date.now())).toBeNull();
  });

  test('the template is harness-owned but carries no readable age', () => {
    // `reclaimStale` exempts it by name; this pins that it could not be reclaimed
    // by age even if that exemption were removed.
    expect(isHarnessDatabase(TEMPLATE_DATABASE)).toBe(true);
    expect(harnessDatabaseAgeMs(TEMPLATE_DATABASE, Date.now())).toBeNull();
  });

  test('a harness-shaped name with an unparseable stamp is not reclaimable', () => {
    const name = `${HARNESS_PREFIX}NOT-BASE36_w1${HARNESS_SUFFIX}`;
    expect(harnessDatabaseAgeMs(name, Date.now())).toBeNull();
  });
});

describe('generated names are usable as PostgreSQL identifiers', () => {
  test('every part matches the charset quoteIdentifier accepts', () => {
    const name = workerDatabaseName(newRunToken(SAMPLE_MS, 'zx9q1k'), 12);
    expect(name).toMatch(SAFE_IDENTIFIER);
    expect(TEMPLATE_DATABASE).toMatch(SAFE_IDENTIFIER);
  });

  test('a name fits inside the identifier length limit', () => {
    // Two names that differ only past the limit would be ONE database, so this is
    // an isolation property, not a tidiness one.
    const name = workerDatabaseName(newRunToken(SAMPLE_MS, 'zx9q1k'), 99);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(
      PG_IDENTIFIER_MAX_BYTES
    );
  });

  test('different workers and different runs never collide', () => {
    const a = workerDatabaseName(newRunToken(SAMPLE_MS, 'aaaaaa'), 1);
    const b = workerDatabaseName(newRunToken(SAMPLE_MS, 'aaaaaa'), 2);
    const c = workerDatabaseName(newRunToken(SAMPLE_MS, 'bbbbbb'), 1);
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
