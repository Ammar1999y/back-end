/**
 * `bun scripts/check-two-factor-rollout.ts <methods> [channels]`
 *
 * Answers the one question a method-list or channel-list change cannot be made
 * safely without: **how many accounts does this strand?**
 *
 * A user is stranded when they hold `two_factor_enabled` and, under the PROPOSED
 * configuration, no enrolment of theirs survives the intersection of intent,
 * capability and the enabled sets. Post-refusal that is not a downgrade — it is
 * a hard 403 at their next sign-in and an administrative reset each, so an
 * unsized rollout is an outage.
 *
 * Read-only, and it takes the proposed configuration as ARGUMENTS rather than
 * from the environment: the point is to ask before the environment changes.
 *
 *   bun scripts/check-two-factor-rollout.ts totp,backup_code
 *   bun scripts/check-two-factor-rollout.ts totp,otp sms
 *
 * Exit code 1 when anyone would be stranded. The intersection here MUST mirror
 * `offeredMethods` in `lib/auth/two-factor-challenge.ts`; it is expressed in SQL
 * because it has to run against a database this process does not otherwise open.
 */
import { SQL } from 'bun';

const [methodsArg, channelsArg] = process.argv.slice(2);
if (!methodsArg)
  throw new Error(
    'usage: bun scripts/check-two-factor-rollout.ts <methods> [otp-channels]'
  );

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set');

const KNOWN_METHODS = new Set(['totp', 'otp', 'backup_code', 'passkey']);
const KNOWN_CHANNELS = new Set(['email', 'sms', 'whatsapp']);

const parseList = (raw: string | undefined, known: Set<string>, noun: string) =>
  (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      if (!known.has(entry)) throw new Error(`unknown ${noun}: ${entry}`);
      return entry;
    });

const methods = parseList(methodsArg, KNOWN_METHODS, 'method');
const channels = parseList(channelsArg, KNOWN_CHANNELS, 'channel');

/**
 * Bun's SQL driver binds a JS array as a comma-joined STRING, which Postgres
 * then refuses as a malformed array literal. Both lists are already checked
 * against a closed allow-list above, so the literal cannot carry anything but
 * those names.
 */
const asArrayLiteral = (values: string[]) => `{${values.join(',')}}`;

interface StrandedRow {
  id: string;
  email: string;
  enrolled: string | null;
}

const sql = new SQL(databaseUrl, { max: 1, connectionTimeout: 10 });
try {
  // `usable` is the intersection, per user: the method is in the proposed list,
  // the capability behind it exists, and for `otp` the channel is in the
  // proposed channel list and the contact it names is verified.
  const stranded = await sql<StrandedRow[]>`
    WITH usable AS (
      SELECT m.user_id
      FROM two_factor_methods m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN two_factor_credentials c ON c.user_id = m.user_id
      WHERE m.method = ANY(${asArrayLiteral(methods)}::text[]::two_factor_method[])
        AND (
          (m.method = 'totp' AND c.verified IS TRUE)
          OR (m.method = 'backup_code'
              AND c.backup_codes_acknowledged_version = c.backup_codes_version
              AND c.backup_codes_remaining > 0)
          OR (m.method = 'passkey'
              AND EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = m.user_id))
          OR (m.method = 'otp'
              AND m.channel::text = ANY(${asArrayLiteral(channels)}::text[])
              AND ((m.contact_kind = 'email' AND u.email_verified IS TRUE)
                OR (m.contact_kind = 'phone' AND u.phone_number_verified IS TRUE)))
        )
    )
    SELECT u.id,
           u.email,
           (SELECT string_agg(DISTINCT m.method::text || COALESCE(':' || m.contact_kind, ''), ',')
              FROM two_factor_methods m WHERE m.user_id = u.id) AS enrolled
    FROM users u
    WHERE u.two_factor_enabled IS TRUE
      AND u.deleted_at IS NULL
      AND u.id NOT IN (SELECT user_id FROM usable)
    ORDER BY u.email
  `;

  const [enabled] = await sql<{ total: number }[]>`
    SELECT count(*)::int AS total
    FROM users
    WHERE two_factor_enabled IS TRUE AND deleted_at IS NULL
  `;

  console.log(
    JSON.stringify(
      {
        msg: 'twoFactor.rolloutPreflight',
        proposedMethods: methods,
        proposedOtpChannels: channels,
        accountsWithTwoFactor: enabled?.total ?? 0,
        strandedAccounts: stranded.length,
        // Bounded: the count is the decision, the sample is for the ticket.
        sample: stranded.slice(0, 20).map((row) => ({
          id: row.id,
          email: row.email,
          enrolled: row.enrolled,
        })),
      },
      null,
      2
    )
  );

  if (stranded.length > 0) {
    console.error(
      `${stranded.length} account(s) would be left two-factor-enabled with nothing to prove it. ` +
        'Each needs POST /api/dash/users/:id/two-factor/reset before this configuration ships.'
    );
    // `exitCode`, not `exit()`: the `finally` below still has to close the pool.
    process.exitCode = 1;
  }
} finally {
  await sql.close();
}
