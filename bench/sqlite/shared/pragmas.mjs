// Config matrix. Every profile is { pragmas, schema, unsafe?, note? }.
//
// `baseline` is the candidate production set. Every other profile changes ONE
// dimension from it so the effect is attributable, except the `combo_*` entries
// which stack the settings that individually looked worthwhile.
//
// `schema` selects a DDL variant (see schema.mjs) because table design —
// WITHOUT ROWID, STRICT — affects these workloads at least as much as pragmas.

const BASE = {
  journal_mode: 'WAL',
  synchronous: 'NORMAL',
  busy_timeout: '2000',
  journal_size_limit: '67108864',
  trusted_schema: 'OFF',
};

// Pragmas that must be issued before the first table exists to take effect.
const PRE_SCHEMA = new Set(['page_size', 'auto_vacuum', 'locking_mode']);

function profile(overrides = {}, options = {}) {
  const merged = { ...BASE, ...overrides };
  const pragmas = [];
  for (const [key, value] of Object.entries(merged)) {
    if (value === null) continue;
    pragmas.push(`${key}=${value}`);
  }
  // page_size / auto_vacuum have to come first, before any CREATE TABLE.
  pragmas.sort((a, b) => {
    const aPre = PRE_SCHEMA.has(a.split('=')[0]) ? 0 : 1;
    const bPre = PRE_SCHEMA.has(b.split('=')[0]) ? 0 : 1;
    return aPre - bPre;
  });
  return {
    pragmas,
    schema: options.schema ?? 'default',
    unsafe: options.unsafe ?? false,
    note: options.note,
  };
}

export const PROFILES = {
  // ---- the candidate ----
  baseline: profile(),

  // ---- what SQLite gives you untouched ----
  sqlite_defaults: profile(
    {
      journal_mode: 'DELETE',
      synchronous: 'FULL',
      busy_timeout: '0',
      journal_size_limit: null,
      cache_size: null,
      temp_store: null,
      trusted_schema: null,
    },
    { note: 'reference point: no tuning at all' }
  ),

  // ---- durability dimension ----
  sync_off: profile(
    { synchronous: 'OFF' },
    {
      unsafe: true,
      note: 'disposable cache only: an OS crash or power loss can corrupt it',
    }
  ),
  sync_full: profile({ synchronous: 'FULL' }),
  sync_extra: profile({ synchronous: 'EXTRA' }),

  // ---- journal mode dimension ----
  journal_delete: profile({ journal_mode: 'DELETE' }),
  journal_truncate: profile({ journal_mode: 'TRUNCATE' }),
  journal_persist: profile({ journal_mode: 'PERSIST' }),
  journal_memory: profile(
    { journal_mode: 'MEMORY' },
    { unsafe: true, note: 'no rollback journal on disk' }
  ),
  journal_off: profile(
    { journal_mode: 'OFF' },
    { unsafe: true, note: 'no atomic rollback at all' }
  ),

  // ---- WAL tuning ----
  wal_ckpt_disabled: profile(
    { wal_autocheckpoint: '0' },
    { note: 'WAL grows until an explicit checkpoint' }
  ),
  wal_ckpt_100: profile({ wal_autocheckpoint: '100' }),
  wal_ckpt_4000: profile({ wal_autocheckpoint: '4000' }),
  wal_jsl_unlimited: profile(
    { journal_size_limit: '-1' },
    { note: 'WAL never shrinks back' }
  ),
  wal_jsl_32mb: profile({ journal_size_limit: '33554432' }),

  // ---- memory / IO dimension ----
  mmap_off: profile({ mmap_size: '0' }),
  mmap_64mb: profile({ mmap_size: '67108864' }),
  mmap_256mb: profile({ mmap_size: '268435456' }),
  mmap_1gb: profile({ mmap_size: '1073741824' }),
  cache_2mb: profile({ cache_size: '-2048' }),
  cache_64mb: profile({ cache_size: '-65536' }),
  temp_store_memory: profile({ temp_store: 'MEMORY' }),
  temp_store_file: profile({ temp_store: 'FILE' }),

  // ---- page size (pre-schema) ----
  page_8kb: profile({ page_size: '8192' }),
  page_16kb: profile({ page_size: '16384' }),
  page_32kb: profile({ page_size: '32768' }),

  // ---- locking / contention ----
  busy_0: profile({ busy_timeout: '0' }, { note: 'BUSY returns immediately' }),
  busy_500: profile({ busy_timeout: '500' }),
  busy_10000: profile({ busy_timeout: '10000' }),
  locking_exclusive: profile(
    { locking_mode: 'EXCLUSIVE' },
    {
      unsafe: true,
      note: 'single-client mode: blocks rolling deploys, workers, and sweep tasks',
    }
  ),

  // ---- space reclamation ----
  autovacuum_full: profile({ auto_vacuum: 'FULL' }),
  autovacuum_incremental: profile({ auto_vacuum: 'INCREMENTAL' }),
  secure_delete_on: profile(
    { secure_delete: 'ON' },
    { note: 'overwrites freed pages; slower writes' }
  ),
  secure_delete_fast: profile({ secure_delete: 'FAST' }),

  // ---- schema design (same pragmas, different table shape) ----
  schema_with_rowid: profile(
    {},
    { schema: 'rowid', note: 'ordinary rowid table + unique index on key' }
  ),
  schema_no_strict: profile(
    {},
    { schema: 'no_strict', note: 'no STRICT: no column type enforcement' }
  ),

  // ---- stacked combinations ----
  combo_tuned: profile(
    { mmap_size: '268435456', cache_size: '-65536', page_size: '8192' },
    { note: 'every individually-plausible read optimisation at once' }
  ),
  combo_fast_unsafe: profile(
    { synchronous: 'OFF', mmap_size: '268435456', cache_size: '-65536' },
    { unsafe: true, note: 'upper bound on achievable throughput' }
  ),
  combo_max_durability: profile(
    { synchronous: 'EXTRA', journal_size_limit: '-1' },
    { note: 'lower bound: strongest durability' }
  ),
};

// Profiles that must not run in the multi-process mode: they either disable the
// coordination the test depends on, or are known-unsafe across processes.
export const SINGLE_PROCESS_ONLY = new Set([
  'locking_exclusive',
  'journal_off',
  'journal_memory',
]);

export function profileNames({ includeUnsafe = true } = {}) {
  return Object.entries(PROFILES)
    .filter(([, p]) => includeUnsafe || !p.unsafe)
    .map(([name]) => name);
}

export const READBACK_NAMES = [
  'journal_mode',
  'synchronous',
  'busy_timeout',
  'trusted_schema',
  'cache_size',
  'temp_store',
  'mmap_size',
  'page_size',
  'journal_size_limit',
  'wal_autocheckpoint',
  'auto_vacuum',
  'secure_delete',
  'locking_mode',
];
