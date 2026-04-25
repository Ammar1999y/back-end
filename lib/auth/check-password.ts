import { sanitizeForLog } from '@/utils';
import { createHash } from '@better-auth/utils/hash';
import { betterFetch } from '@better-fetch/fetch';

import { HTTP_STATUS, MSG_PASSWORD_COMPROMISED } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';

const HIBP_RETRIES = 2;
const HIBP_RETRY_BASE_MS = 75;
// Per-attempt timeout. Three attempts × ~1s + backoff stays under ~3.5s
// total so a HIBP outage never stalls user create/update for many seconds.
const HIBP_ATTEMPT_TIMEOUT_MS = 1000;

/**
 * k-Anonymity check against the HaveIBeenPwned Passwords API.
 * Only the first 5 characters of the SHA-1 hash are sent to the API.
 * Throws CustomError (400) if the password appears in known breaches.
 * Retries transient failures, then fails open and logs so a HIBP outage
 * doesn't block users on an external dependency.
 */
export async function checkPasswordCompromise(password: string): Promise<void> {
  const sha1Hash = (
    await createHash('SHA-1', 'hex').digest(password)
  ).toUpperCase();
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
          .some((line) => line.split(':')[0].toUpperCase() === suffix)
      ) {
        throw new CustomError(MSG_PASSWORD_COMPROMISED, HTTP_STATUS.BAD_REQUEST);
      }
      return;
    } catch (error) {
      if (error instanceof CustomError) throw error;
      console.error(
        sanitizeForLog({ msg: 'hibp.degraded', attempt, error })
      );
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
