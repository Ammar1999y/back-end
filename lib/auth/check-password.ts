import { sanitizeForLog } from '@/utils';
import { createHash } from '@better-auth/utils/hash';
import { betterFetch } from '@better-fetch/fetch';

import { HTTP_STATUS, MSG_PASSWORD_COMPROMISED } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';

/**
 * k-Anonymity check against the HaveIBeenPwned Passwords API.
 * Only the first 5 characters of the SHA-1 hash are sent to the API.
 * Throws CustomError (400) if the password appears in known breaches.
 * On API failure, logs the error and continues (fail-open) to avoid
 * blocking users when the external service is down.
 */
export async function checkPasswordCompromise(password: string): Promise<void> {
  const sha1Hash = (
    await createHash('SHA-1', 'hex').digest(password)
  ).toUpperCase();
  const prefix = sha1Hash.slice(0, 5);
  const suffix = sha1Hash.slice(5);

  try {
    const { data, error } = await betterFetch<string>(
      `https://api.pwnedpasswords.com/range/${prefix}`,
      {
        headers: {
          'Add-Padding': 'true',
          'User-Agent': 'BetterAuth Password Checker',
        },
      }
    );

    if (error) {
      throw new Error(`HIBP API returned ${error.status}`);
    }

    if (
      data
        .split('\n')
        .some((line) => line.split(':')[0].toUpperCase() === suffix)
    ) {
      throw new CustomError(MSG_PASSWORD_COMPROMISED, HTTP_STATUS.BAD_REQUEST);
    }
  } catch (error) {
    if (error instanceof CustomError) throw error;
    console.error('HIBP check failed:', sanitizeForLog(error));
  }
}
