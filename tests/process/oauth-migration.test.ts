import { SQL } from 'bun';
import { expect, test } from 'bun:test';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { drizzle } from 'drizzle-orm/bun-sql';
import { migrate } from 'drizzle-orm/bun-sql/migrator';

import * as z from 'zod';

import { newRunToken } from '../helpers/names';
import {
  adminUrl,
  createWorkerDatabases,
  dropWorkerDatabases,
  workerUrl,
} from '../helpers/provision';

test('OAuth migration applies cleanly and upgrades the previous schema through the real deployment runner', async () => {
  const token = newRunToken(Date.now(), crypto.randomBytes(6).toString('hex'));
  const admin = new SQL(adminUrl(), { max: 1 });
  const names = await createWorkerDatabases(admin, token, 2);
  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = await mkdtemp(path.join(temporaryRoot, 'oauth-migration-'));
  try {
    const raw: unknown = JSON.parse(
      await readFile('db/drizzle/meta/_journal.json', 'utf8')
    );
    const journal = z
      .object({
        version: z.string(),
        dialect: z.string(),
        entries: z.array(
          z.object({
            idx: z.number(),
            version: z.string(),
            when: z.number(),
            tag: z.string().regex(/^\d{4}_[\w-]+$/),
            breakpoints: z.boolean(),
          })
        ),
      })
      .parse(raw);
    const previous = journal.entries.filter((entry) => entry.idx < 11);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed child of the test's mkdtemp directory
    await mkdir(path.join(directory, 'meta'));
    await Bun.write(
      path.join(directory, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: previous })
    );
    for (const entry of previous)
      await Bun.write(
        path.join(directory, `${entry.tag}.sql`),
        Bun.file(`db/drizzle/${entry.tag}.sql`)
      );
    for (const [index, name] of names.entries()) {
      const url = workerUrl(token, index + 1);
      const client = new SQL(url, { max: 1 });
      try {
        const rows: unknown = await client`select current_database() as name`;
        expect(z.array(z.object({ name: z.string() })).parse(rows)).toEqual([
          { name },
        ]);
        await client.unsafe(
          'drop schema public cascade; drop schema if exists drizzle cascade; create schema public'
        );
        if (index === 1) {
          await migrate(drizzle({ client }), { migrationsFolder: directory });
          const columns: unknown =
            await client`select column_name from information_schema.columns where table_name='users' and column_name='auth_revoked_at'`;
          expect(columns).toEqual([]);
        }
        for (let repetition = 0; repetition < 2; repetition++) {
          const child = Bun.spawn(
            ['bun', '--no-env-file', 'scripts/migrate.ts'],
            {
              env: { ...process.env, DATABASE_URL: url },
              stdout: 'pipe',
              stderr: 'pipe',
            }
          );
          const [stdout, stderr, exit] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
          expect(stdout).toContain('up to date');
        }
        const labels: unknown =
          await client`select enumlabel from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='provider_id' order by enumsortorder`;
        expect(labels).toEqual([
          { enumlabel: 'credential' },
          { enumlabel: 'google' },
        ]);
        const columns: unknown =
          await client`select is_nullable, data_type from information_schema.columns where table_name='users' and column_name='auth_revoked_at'`;
        expect(columns).toEqual([
          { is_nullable: 'YES', data_type: 'timestamp with time zone' },
        ]);
        const constraints: unknown =
          await client`select conname from pg_constraint where conname='chk_google_account'`;
        expect(constraints).toEqual([{ conname: 'chk_google_account' }]);
      } finally {
        await client.close();
      }
    }
  } finally {
    expect(await dropWorkerDatabases(admin, names)).toEqual([]);
    await admin.close();
    const relative = path.relative(temporaryRoot, path.resolve(directory));
    if (!relative.startsWith('oauth-migration-') || relative.includes(path.sep))
      throw new Error('Unexpected migration scratch path.');
    await rm(directory, { recursive: true });
  }
}, 60_000);
