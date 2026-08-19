/**
 * Subprocess body for `env-secret.test.ts`. Prints `LOADED` if
 * `lib/env.server.ts` accepts the environment, otherwise the rejection message.
 *
 * Separate file because the guard throws at MODULE LOAD, so each case needs its
 * own process to observe it.
 */
try {
  await import('@/lib/env.server');
  console.log('LOADED');
} catch (error) {
  console.log(error instanceof Error ? error.message : String(error));
}
