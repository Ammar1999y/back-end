/**
 * The complete Better Auth surface this deployment exposes.
 *
 * A leaf module, imported by both `lib/auth.ts` (which enforces it in a `before`
 * hook) and `routes.ts` (which needs it to answer 404-versus-405 accurately).
 * It lives here rather than in `lib/auth.ts` so the route table does not have to
 * import Better Auth — and, more importantly, so the enforcement and the
 * advertised surface cannot drift: one set, two readers.
 *
 * ⚠️ WARNING that travels with this list: `lib/auth.ts` stubs Better Auth's
 * built-in `password.verify` to always return true because the before hook runs
 * the real `verifyLoginAttempt`. Adding a password-bearing path here without
 * wiring verification into that hook is a credential bypass. Read the note above
 * `ALLOWED_PATHS`' use in `lib/auth.ts` before extending this.
 */
export const BETTER_AUTH_ALLOWED_PATHS = [
  '/get-session',
  '/sign-out',
  '/sign-in/email',
  // Passwordless plugin endpoint — does its own captcha/rate-limit/OTP verify.
  '/passwordless/verify',
] as const;

/** Membership test for the `before` hook. */
export const BETTER_AUTH_ALLOWED_PATH_SET: ReadonlySet<string> = new Set(
  BETTER_AUTH_ALLOWED_PATHS
);
