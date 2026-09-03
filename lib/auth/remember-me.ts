/**
 * The submitted "remember me", filtered by whether this deployment obeys it.
 *
 * One reader for every first-factor path, because the value has to survive a
 * two-factor challenge — it is stored in the challenge's companion record and
 * spent at completion — and two paths reading it differently would give the
 * same account two session lifetimes.
 *
 * ⚠️ Absent means `true`, not `false`. That is Better Auth's own default for
 * `/sign-in/email` (`rememberMe: z.boolean().default(true)`), and reading an
 * absent field as "do not remember" would silently shorten every session from
 * every client that does not send it. Only an explicit `false` shortens one.
 *
 * With `HONOUR_REMEMBER_ME` off the answer is always `true`: the flag means the
 * deployment ignores the client's choice, not that it inverts it.
 */
import { HONOUR_REMEMBER_ME } from '@/utils/config';

export function submittedRememberMe(body: unknown): boolean {
  if (!HONOUR_REMEMBER_ME) return true;
  if (!body || typeof body !== 'object') return true;
  return (body as { rememberMe?: unknown }).rememberMe !== false;
}
