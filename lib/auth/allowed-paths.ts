import type { RoutePrefixPath } from '@/lib/http/route-manifest';

import {
  isTwoFactorMethodEnabled,
  TWO_FACTOR_ENABLED,
  TWO_FACTOR_OTP_AVAILABLE,
} from '@/utils/validation/two-factor';

/**
 * The two-factor surface, gated per METHOD by the environment: a method that is
 * off contributes no entry, so `app.ts` never forwards its path to Better Auth
 * and the `before` hook rejects it a second time.
 *
 * `/two-factor/send-otp` and `/two-factor/verify-otp` are absent
 * unconditionally — the plugin's OTP is not configured, so listing them would
 * advertise an endpoint that answers `OTP_NOT_CONFIGURED`.
 *
 * ⚠️ A path here carrying a `password` field must also be in
 * `PASSWORD_PROOF_PATHS` (`lib/auth.ts`), or it rejects every password.
 */
function twoFactorEndpoints(): RoutePrefixPath[] {
  if (!TWO_FACTOR_ENABLED) return [];

  // ⚠️ `/two-factor/enable` is ABSENT and stays absent. It can only produce TOTP
  // in this configuration, and it writes the flag and the credential outside the
  // transaction that has to carry the intent row with them. Enrolment is
  // `lib/auth/two-factor-enrolment.ts`.
  const paths: RoutePrefixPath[] = [
    {
      path: '/two-factor/disable',
      methods: ['POST'],
      preAuthLimit: 20,
      captcha: false,
    },
  ];

  if (isTwoFactorMethodEnabled('totp'))
    paths.push(
      {
        path: '/two-factor/get-totp-uri',
        methods: ['POST'],
        preAuthLimit: 20,
        captcha: false,
      },
      {
        path: '/two-factor/totp/start',
        methods: ['POST'],
        preAuthLimit: 20,
        captcha: false,
      },
      {
        path: '/two-factor/totp/confirm',
        methods: ['POST'],
        preAuthLimit: 30,
        captcha: false,
      },
      // Reachable with only the challenge cookie: the sign-in half of TOTP, not
      // a management path. Its real budget is the per-challenge attempt counter.
      {
        path: '/two-factor/verify-totp',
        methods: ['POST'],
        preAuthLimit: 30,
        captcha: false,
      }
    );

  // Not gated on any single method: this is how a user reaches all of them.
  paths.push(
    {
      path: '/two-factor/trust-device',
      methods: ['POST'],
      preAuthLimit: 20,
      captcha: false,
    },
    {
      path: '/two-factor/trusted-devices',
      methods: ['GET'],
      preAuthLimit: 60,
      captcha: false,
    },
    {
      path: '/two-factor/trusted-devices/revoke',
      methods: ['POST'],
      preAuthLimit: 30,
      captcha: false,
    },
    {
      path: '/two-factor/methods',
      methods: ['GET'],
      preAuthLimit: 60,
      captcha: false,
    },
    {
      path: '/two-factor/methods/disable',
      methods: ['POST'],
      preAuthLimit: 20,
      captcha: false,
    },
    {
      path: '/two-factor/methods/default',
      methods: ['POST'],
      preAuthLimit: 30,
      captcha: false,
    },
    {
      path: '/two-factor/backup-codes/acknowledge',
      methods: ['POST'],
      preAuthLimit: 20,
      captcha: false,
    }
  );

  // Neither is anonymous — enrolment needs a session, sign-in a challenge
  // cookie — so neither carries a captcha.
  if (TWO_FACTOR_OTP_AVAILABLE)
    paths.push(
      {
        path: '/two-factor/otp/send',
        methods: ['POST'],
        // Below the verify budget: every request here can cost a message.
        preAuthLimit: 20,
        captcha: false,
      },
      {
        path: '/two-factor/otp/verify',
        methods: ['POST'],
        preAuthLimit: 30,
        captcha: false,
      }
    );

  if (isTwoFactorMethodEnabled('backup_code'))
    paths.push(
      {
        path: '/two-factor/generate-backup-codes',
        methods: ['POST'],
        preAuthLimit: 20,
        captcha: false,
      },
      {
        path: '/two-factor/verify-backup-code',
        methods: ['POST'],
        preAuthLimit: 30,
        captcha: false,
      }
    );

  if (isTwoFactorMethodEnabled('passkey'))
    paths.push(
      // The POST re-authentication in front of the ceremony. The ceremony
      // endpoints are the library's and take the library's bodies, so the
      // password is proven here and spent there.
      {
        path: '/two-factor/passkey/grant',
        methods: ['POST'],
        preAuthLimit: 20,
        captcha: false,
      },
      {
        path: '/passkey/generate-register-options',
        methods: ['GET'],
        preAuthLimit: 20,
        captcha: false,
      },
      {
        path: '/passkey/verify-registration',
        methods: ['POST'],
        preAuthLimit: 20,
        captcha: false,
      },
      {
        path: '/passkey/list-user-passkeys',
        methods: ['GET'],
        preAuthLimit: 60,
        captcha: false,
      },
      {
        path: '/passkey/delete-passkey',
        methods: ['POST'],
        preAuthLimit: 30,
        captcha: false,
      },
      {
        path: '/passkey/update-passkey',
        methods: ['POST'],
        preAuthLimit: 30,
        captcha: false,
      },
      // Reachable only with a live 2FA challenge.
      {
        path: '/two-factor/passkey/options',
        methods: ['POST'],
        preAuthLimit: 30,
        captcha: false,
      },
      {
        path: '/two-factor/passkey/verify',
        methods: ['POST'],
        preAuthLimit: 30,
        captcha: false,
      }
      // ⚠️ `/passkey/generate-authenticate-options` and
      // `/passkey/verify-authentication` are ABSENT, permanently and with no
      // flag: the second resolves a credential by id alone and issues a session
      // to whoever owns it. Adding either reopens an unauthenticated sign-in.
    );

  return paths;
}

/**
 * The complete Better Auth surface this deployment exposes, per ENDPOINT.
 *
 * A leaf module (type-only import above), read by `lib/auth.ts` (which enforces
 * it in a `before` hook), `routes.ts` (which needs it to answer 404-versus-405
 * accurately), `app.ts` (which registers it and reads `preAuthLimit`) and
 * `lib/http/openapi.ts` (which publishes it). One table, every reader, so
 * enforcement, admission and advertisement cannot drift.
 *
 * Methods are per path, and the values are read from the dependency's own
 * endpoint definitions (`method:` in `better-auth/dist/api/routes/*.mjs`) and
 * from `lib/auth/passwordless.ts` for the local plugin endpoint. Declared once
 * for the whole prefix, the 405 boundary advertises `Allow: GET` on POST-only
 * paths and the document lists operations no client can make.
 *
 * ⚠️ WARNING that travels with this list: `lib/auth.ts` replaces Better Auth's
 * built-in `password.verify` with a check that the `before` hook already ran the
 * real `verifyLoginAttempt`. A password-bearing path added here must also be in
 * that hook's `PASSWORD_PROOF_PATHS`, or it rejects every password.
 */
export const BETTER_AUTH_ENDPOINTS: readonly RoutePrefixPath[] = [
  // GET only, and this is the case that proves the values have to be MEASURED
  // rather than read off the dependency's declaration. `getSession` declares
  // `method: ["GET", "POST"]`, but its own handler throws
  // `METHOD_NOT_ALLOWED` for a POST unless `session.deferSessionRefresh` is
  // enabled (`better-auth/dist/api/routes/session.mjs`), and `lib/auth.ts` does
  // not enable it — measured, `POST /api/auth/get-session` answers 405. Turning
  // that option on is what would make POST belong here.
  // Session reads need a separate budget from credential attempts for shared NATs.
  {
    path: '/get-session',
    methods: ['GET'],
    preAuthLimit: 300,
    captcha: false,
  },
  {
    path: '/sign-out',
    methods: ['POST'],
    preAuthLimit: 30,
    captcha: false,
  },
  {
    path: '/sign-in/email',
    methods: ['POST'],
    preAuthLimit: 20,
    captcha: true,
  },
  // Passwordless plugin endpoint — does its own captcha/rate-limit/OTP verify.
  {
    path: '/passwordless/verify',
    methods: ['POST'],
    preAuthLimit: 60,
    captcha: true,
  },
  ...twoFactorEndpoints(),
];

/**
 * Every Better Auth path this codebase can serve under SOME configuration, as
 * opposed to `BETTER_AUTH_ENDPOINTS`, which is what the current one serves.
 *
 * The contract builder needs the distinction: a documentation entry for a path
 * that is switched off is expected, one for a path that exists nowhere is a typo.
 *
 * ⚠️ Not used for enforcement — `BETTER_AUTH_ALLOWED_PATH_SET` decides that, and
 * it is derived from the enabled set alone.
 */
export const BETTER_AUTH_KNOWN_PATHS: ReadonlySet<string> = new Set([
  '/get-session',
  '/sign-out',
  '/sign-in/email',
  '/passwordless/verify',
  '/two-factor/disable',
  '/two-factor/get-totp-uri',
  '/two-factor/totp/start',
  '/two-factor/totp/confirm',
  '/two-factor/verify-totp',
  '/two-factor/generate-backup-codes',
  '/two-factor/verify-backup-code',
  '/two-factor/otp/send',
  '/two-factor/otp/verify',
  '/two-factor/passkey/options',
  '/two-factor/passkey/verify',
  '/two-factor/trust-device',
  '/two-factor/trusted-devices',
  '/two-factor/trusted-devices/revoke',
  '/two-factor/methods',
  '/two-factor/methods/disable',
  '/two-factor/methods/default',
  '/two-factor/backup-codes/acknowledge',
  '/two-factor/passkey/grant',
  '/passkey/generate-register-options',
  '/passkey/verify-registration',
  '/passkey/list-user-passkeys',
  '/passkey/delete-passkey',
  '/passkey/update-passkey',
]);

/** Membership test for the `before` hook, which decides on the PATH alone. */
export const BETTER_AUTH_ALLOWED_PATH_SET: ReadonlySet<string> = new Set(
  BETTER_AUTH_ENDPOINTS.map((endpoint) => endpoint.path)
);

/** Path -> the methods it answers, for the 405 boundary and the document. */
const SERVED_METHODS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  BETTER_AUTH_ENDPOINTS.map((endpoint) => [
    endpoint.path,
    new Set<string>(endpoint.methods),
  ])
);

/**
 * Does this deployment serve `path` under `method`? Drives the 405 boundary.
 *
 * `HEAD` is answered from the `GET` entry, because a resource that serves GET
 * serves HEAD — RFC 9110 §9.3.2 makes both mandatory for a general-purpose
 * server, `CORS_POLICY` advertises HEAD, and `createRouteLookup` already derives
 * it for every table route. Without this, `HEAD /api/auth/get-session` answered
 * `405` while advertising `Allow: GET` on the very path it was refusing — a
 * response that contradicts itself.
 */
export function betterAuthServes(path: string, method: string): boolean {
  const served = SERVED_METHODS.get(path);
  if (!served) return false;
  return served.has(method === 'HEAD' ? 'GET' : method);
}
