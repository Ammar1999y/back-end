// better-sqlite3 adapter. Statements are never cached by the driver, so
// prepare() and prepareUncached() both compile; the harness reuses the handle it
// gets from prepare(), matching how Bun's cached query() is used.

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { PROFILES } from '../shared/pragmas.mjs';
import { ddlFor } from '../shared/schema.mjs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

function wrap(statement) {
  return {
    get: (...params) => statement.get(...params),
    all: (...params) => statement.all(...params),
    // Normalized to `{ changes }` so batched-sweep workloads read the same shape
    // on both drivers. bun:sqlite and better-sqlite3 return different objects.
    run: (...params) => ({ changes: Number(statement.run(...params).changes) }),
    values: (...params) => statement.raw().all(...params),
    // better-sqlite3 reclaims statements through GC; there is no finalize().
    finalize: () => {},
  };
}

export const driver = {
  name: 'better-sqlite3',
  slug: 'better-sqlite3',
  version: require('better-sqlite3/package.json').version,
  runtime: 'node',
  runtimeVersion: process.version,
  rootDir: here,
  workerPath: join(here, 'worker.mjs'),

  open(path, profileName, schemaScope = 'all') {
    const profile = PROFILES[profileName];
    if (!profile) throw new Error(`unknown pragma profile: ${profileName}`);

    const db = new Database(path);
    for (const pragma of profile.pragmas) db.pragma(pragma);
    for (const ddl of ddlFor(profile.schema, schemaScope)) db.exec(ddl);

    return {
      prepare: (sql) => wrap(db.prepare(sql)),
      prepareUncached: (sql) => wrap(db.prepare(sql)),
      exec: (sql) => db.exec(sql),
      pragma: (text) => db.pragma(text),
      transaction: (fn) => db.transaction(fn),
      sqliteVersion: () => db.prepare('SELECT sqlite_version() AS v').get().v,
      readback: (names) => {
        const out = {};
        for (const name of names)
          out[name] = db.pragma(name, { simple: true }) ?? null;
        return out;
      },
      close: () => db.close(),
    };
  },
};
