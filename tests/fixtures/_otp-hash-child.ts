/**
 * Subprocess body for `otp-hash.test.ts`.
 *
 * Separate file because the keyring memoises its parse on first use, so each
 * keyring configuration needs its own process. Every mode prints ONE line of
 * JSON on stdout; a configuration failure is left to escape, so the test can
 * assert on a non-zero exit and the message on stderr.
 */
import { hashOtpCode, verifyOtpCode } from '@/lib/auth/otp-hash';
import { hashPassword } from '@/lib/auth/password';

const CODE = '123456';
const WRONG = '654321';

const [mode, argument] = process.argv.slice(2);

switch (mode) {
  case 'roundtrip': {
    const stored = hashOtpCode(CODE);
    console.log(
      JSON.stringify({
        match: await verifyOtpCode(CODE, stored),
        mismatch: await verifyOtpCode(WRONG, stored),
      })
    );
    break;
  }

  case 'envelope': {
    console.log(JSON.stringify({ stored: hashOtpCode(CODE) }));
    break;
  }

  case 'verify': {
    console.log(
      JSON.stringify({ valid: await verifyOtpCode(CODE, argument ?? '') })
    );
    break;
  }

  case 'legacy': {
    // The envelope the previous build wrote: an Argon2id hash under the password
    // pepper. Produced with the real `hashPassword`, not a fixture, so this
    // cannot pass against a format that no longer exists.
    const stored = await hashPassword(CODE);
    console.log(
      JSON.stringify({
        match: await verifyOtpCode(CODE, stored),
        mismatch: await verifyOtpCode(WRONG, stored),
      })
    );
    break;
  }

  default: {
    throw new Error(`unknown mode: ${mode}`);
  }
}
