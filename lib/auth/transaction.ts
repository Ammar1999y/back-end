import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthContext } from './two-factor-challenge';
import type { Tx } from '@/db';

import { db, withTransaction } from '@/db';
import { runWithTransaction } from '@better-auth/core/context';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';

import { authAdapterOptions } from './adapter-options';

const transactions = new AsyncLocalStorage<Tx>();

export const authDatabase = () => transactions.getStore() ?? db;

// The session hook must read the same uncommitted identity that its adapter writes.
export async function withAuthTransaction<T>(
  ctx: AuthContext,
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  return await runWithTransaction(
    {
      ...ctx.context.adapter,
      transaction: (run) =>
        withTransaction((tx) =>
          transactions.run(tx, () =>
            run(drizzleAdapter(tx, authAdapterOptions)(ctx.context.options))
          )
        ),
    },
    () => {
      const tx = transactions.getStore();
      if (!tx) throw new Error('Authentication transaction is unavailable.');
      return fn(tx);
    }
  );
}
