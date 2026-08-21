/**
 * The OTP MAC keyring — the key material behind `./otp-hash.ts`.
 *
 * Its own keyring, not the password pepper, and that separation is the point of
 * the change that introduced it. When OTPs were hashed with `hashPassword` they
 * carried a PASSWORD pepper id, which coupled two key lifecycles that have
 * nothing in common: retiring a pepper generation while codes issued under it
 * were still inside their ten-minute expiry turned those verifications into
 * configuration errors — HTTP 500 — instead of clean failures.
 *
 * **Retirement rule, and it is genuinely cheap here.** A key may be dropped once
 * no unexpired code was issued under it. Codes live `OTP_EXPIRY_MINUTES`
 * (currently 10), so a generation is safe to remove after roughly an hour of
 * grace — compare the password keyring, where a generation has to be retained
 * until every stored hash has been rehashed. This is the asymmetry that made the
 * shared keyring wrong.
 *
 * Structure and validation are shared with the password pepper via
 * `./keyring.ts`; only the variable names differ.
 */
import { defineKeyring } from './keyring';

const keyring = defineKeyring({
  activeIdEnv: 'OTP_HMAC_ACTIVE_ID',
  keyringEnv: 'OTP_HMAC_KEYRING',
  label: 'OTP MAC',
});

/** Forces the parse at startup so a misconfiguration crashes the boot, not a send. */
export function validateOtpKeyConfiguration(): void {
  keyring.validate();
}

export const getActiveOtpKey = keyring.active;
export const getOtpKey = keyring.byId;
