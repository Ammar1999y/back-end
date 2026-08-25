/**
 * `bun run test:db:reset` — drop every harness database, template included.
 *
 * The tier runner already drops what it created, so this covers the two cases it
 * cannot: a run killed hard enough that its `finally` never executed, and a
 * template whose schema moved in a way the fingerprint cannot see (a hand-edited
 * database, a half-applied migration).
 *
 * It matches on the harness name pattern only, so a database this harness did not
 * create is never a candidate no matter what state it is in.
 */
import { SQL } from 'bun';

import { loadTestEnv } from './env-file';
import { adminUrl, dropEverything } from './provision';

loadTestEnv();

const client = new SQL(adminUrl(), { max: 1 });
try {
  const dropped = await dropEverything(client);
  console.log(
    dropped.length === 0
      ? 'no harness databases to drop'
      : `dropped ${dropped.length}: ${dropped.join(', ')}`
  );
} finally {
  await client.close();
}
