import { createHash } from 'node:crypto';

import { sanitizeForLog } from '@/utils';
import { betterFetch } from '@better-fetch/fetch';

import { HTTP_STATUS, MSG_PASSWORD_COMPROMISED } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';

const HIBP_RETRIES = 2;
const HIBP_RETRY_BASE_MS = 75;
// Per-attempt timeout. Three attempts × ~1s + backoff stays under ~3.5s
// total so a HIBP outage never stalls user create/update for many seconds.
const HIBP_ATTEMPT_TIMEOUT_MS = 1000;

/**
 * k-Anonymity check against the HaveIBeenPwned Passwords API. Only the first 5
 * characters of the SHA-1 hash are sent. Throws `CustomError` (400) if the
 * password appears in known breaches.
 *
 * **THE ONLY implementation, and it FAILS OPEN. Both halves are decisions.**
 *
 * Only: `better-auth`'s `haveIBeenPwned` plugin used to be registered as well
 * (`lib/auth.ts`). It could never fire — its default `paths` do not intersect
 * this deployment's reachable Better Auth surface — so it was inert
 * configuration duplicating this file's concept. It is gone; adding it back
 * reintroduces two implementations of one thing that disagree on the case below.
 *
 * Fails open: after `HIBP_RETRIES + 1` bounded attempts, an unreachable HIBP
 * logs `hibp.degraded` and the password is ACCEPTED. The plugin did the
 * opposite — `throw new APIError('INTERNAL_SERVER_ERROR')` — and that is the
 * behaviour deliberately not kept. A third party being down must not take this
 * service's account creation, password reset and credential rotation down with
 * it; a breached password that slips through during an outage is still subject
 * to every other control (length floor, argon2id + pepper, lockout, per-IP
 * limits), while a hard failure has no compensating control at all.
 *
 * The cost, stated rather than hidden: during an HIBP outage every
 * password-setting path accepts a known-breached password, and the only record
 * is the log line. Alert on `hibp.degraded`.
 */
export async function checkPasswordCompromise(password: string): Promise<void> {
  const sha1Hash = createHash('sha1')
    .update(password, 'utf8')
    .digest('hex')
    .toUpperCase();
  const prefix = sha1Hash.slice(0, 5);
  const suffix = sha1Hash.slice(5);

  for (let attempt = 0; attempt <= HIBP_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      HIBP_ATTEMPT_TIMEOUT_MS
    );
    try {
      const { data, error } = await betterFetch<string>(
        `https://api.pwnedpasswords.com/range/${prefix}`,
        {
          headers: {
            'Add-Padding': 'true',
            'User-Agent': 'BetterAuth Password Checker',
          },
          signal: controller.signal,
        }
      );

      if (error) throw new Error(`HIBP API returned ${error.status}`);

      if (
        data
          .split('\n')
          .some((line) => line.split(':', 1)[0]?.toUpperCase() === suffix)
      ) {
        throw new CustomError(
          MSG_PASSWORD_COMPROMISED,
          HTTP_STATUS.BAD_REQUEST
        );
      }
      return;
    } catch (error) {
      if (error instanceof CustomError) throw error;
      console.error(sanitizeForLog({ msg: 'hibp.degraded', attempt, error }));
      if (attempt < HIBP_RETRIES) {
        await new Promise((r) =>
          setTimeout(r, HIBP_RETRY_BASE_MS * (attempt + 1))
        );
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
