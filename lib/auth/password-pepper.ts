/**
 * The password pepper keyring: a server-side secret mixed into every Argon2id
 * password hash, so a stolen database alone cannot be attacked offline.
 *
 * All parsing and validation lives in `./keyring.ts`, shared with the OTP MAC
 * keyring in `./otp-key.ts`. This file is only the binding of that machinery to
 * these two variable names — the rules about base64url length, duplicate
 * generations and the key-count ceiling are stated once, there.
 *
 * **Retirement rule.** Removing a generation from the keyring makes every hash
 * still carrying its id unverifiable — `byId` throws a configuration error,
 * which surfaces as a 500, not a failed login. For passwords that means: keep a
 * generation until every stored hash has been rehashed under a newer one
 * (`verifyPasswordDetailed` reports `needsRehash` for exactly this). The OTP
 * keyring has the same rule with a much shorter horizon; see `./otp-key.ts`.
 */
import { defineKeyring } from './keyring';

const keyring = defineKeyring({
  activeIdEnv: 'PASSWORD_PEPPER_ACTIVE_ID',
  keyringEnv: 'PASSWORD_PEPPER_KEYRING',
  label: 'password pepper',
});

/** Forces the parse at startup so a misconfiguration crashes the boot, not a login. */
export function validatePasswordPepperConfiguration(): void {
  keyring.validate();
}

export const getActivePasswordPepper = keyring.active;
export const getPasswordPepper = keyring.byId;
