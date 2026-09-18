import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthContext } from './two-factor-challenge';
import type { Tx } from '@/db';

import { db, withTransaction } from '@/db';
import {
  getCurrentAdapter,
  runWithTransaction,
} from '@better-auth/core/context';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';

import { authAdapterOptions } from './adapter-options';

const transactions = new AsyncLocalStorage<Tx>();

export const authDatabase = () => transactions.getStore() ?? db;

/**
 * The endpoint context with its adapter bound to the transaction that is open,
 * for handing to a library endpoint called from inside one.
 *
 * ⚠️ Not a convenience. `internalAdapter` resolves every statement through
 * `getCurrentAdapter`, so it already runs on the transaction — but a plugin
 * reaching for `ctx.context.adapter` DIRECTLY gets the pool, and Better Auth's
 * two-factor plugin does exactly that for its credential read and for the
 * lockout counters (`plugins/two-factor/totp/index.mjs`,
 * `plugins/two-factor/verify-two-factor.mjs`). A statement issued against the
 * pool from inside a transaction asks for a second connection while holding the
 * first, so `MAX_POOL_CONNECTIONS` concurrent verifications wait on each other
 * for a connection none of them will release — measured, with ten wrong codes
 * against one account. The same call also writes the credential row the caller
 * may be holding a lock on, which is the other half of the same deadlock.
 *
 * A Proxy rather than a spread: the library SETS `newSession` on this object and
 * our own after-hooks read it back off the original, so a copy would silently
 * lose every completion event. Only the one property is intercepted; writes,
 * deletes and everything else pass through to the real context.
 */
export async function transactionBoundContext(
  context: AuthContext['context']
): Promise<AuthContext['context']> {
  const adapter = await getCurrentAdapter(context.adapter);
  if (adapter === context.adapter) return context;
  return new Proxy(context, {
    get: (target, property) =>
      property === 'adapter'
        ? adapter
        : (target as unknown as Record<PropertyKey, unknown>)[property],
  });
}

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
