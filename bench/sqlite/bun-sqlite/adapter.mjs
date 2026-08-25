// bun:sqlite adapter. db.query() returns a cached compiled statement (Bun caches
// up to 20 by SQL string); db.prepare() always compiles a fresh one.

import { Database } from 'bun:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROFILES } from '../shared/pragmas.mjs';
import { ddlFor } from '../shared/schema.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function wrap(statement) {
  return {
    get: (...params) => statement.get(...params),
    all: (...params) => statement.all(...params),
    // Normalized to `{ changes }` so batched-sweep workloads read the same shape
    // on both drivers. bun:sqlite and better-sqlite3 return different objects.
    run: (...params) => ({ changes: Number(statement.run(...params).changes) }),
    values: (...params) => statement.values(...params),
    finalize: () => statement.finalize(),
  };
}

export const driver = {
  name: 'bun:sqlite',
  slug: 'bun-sqlite',
  version: Bun.version,
  runtime: 'bun',
  runtimeVersion: `${Bun.version} (${Bun.revision.slice(0, 9)})`,
  rootDir: here,
  workerPath: join(here, 'worker.mjs'),

  open(path, profileName, schemaScope = 'all') {
    const profile = PROFILES[profileName];
    if (!profile) throw new Error(`unknown pragma profile: ${profileName}`);

    const db = new Database(path, { create: true });
    for (const pragma of profile.pragmas) db.exec(`PRAGMA ${pragma}`);
    for (const ddl of ddlFor(profile.schema, schemaScope)) db.exec(ddl);

    return {
      prepare: (sql) => wrap(db.query(sql)),
      prepareUncached: (sql) => wrap(db.prepare(sql)),
      exec: (sql) => db.exec(sql),
      pragma: (text) => db.exec(`PRAGMA ${text}`),
      transaction: (fn) => db.transaction(fn),
      sqliteVersion: () => db.query('SELECT sqlite_version() AS v').get().v,
      readback: (names) => {
        const out = {};
        for (const name of names) {
          const row = db.query(`PRAGMA ${name}`).get();
          out[name] = row ? Object.values(row)[0] : null;
        }
        return out;
      },
      close: () => db.close(true),
    };
  },
};
