import { SQL } from 'bun';

import { assertPasswordHashEvaluable } from '@/lib/auth/password';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set');

const sql = new SQL(databaseUrl, { max: 1, connectionTimeout: 10 });
try {
  const rows = await sql<{ id: string; password: string }[]>`
    SELECT id, password
    FROM accounts
    WHERE provider_id = 'credential'
  `;
  const failures: string[] = [];
  for (const row of rows) {
    try {
      assertPasswordHashEvaluable(row.password);
    } catch {
      failures.push(row.id);
    }
  }
  if (failures.length > 0)
    throw new Error(
      `${failures.length} credential hash(es) cannot be evaluated; account ids: ${failures.join(', ')}`
    );
  console.log(
    JSON.stringify({
      msg: 'password pepper preflight passed',
      credentials: rows.length,
    })
  );
} finally {
  await sql.close();
}
