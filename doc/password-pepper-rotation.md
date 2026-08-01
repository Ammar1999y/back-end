# Password Pepper Operations

The password adapter uses Argon2id with node-argon2's `secret` option. The
secret is a pepper: it is never written into the Argon2 PHC string or the
database.

Stored values use this envelope:

```text
p1:<pepper-id>:$argon2id$...
```

`p1` versions the envelope format. `<pepper-id>` selects exactly one key from
the keyring. Changing the active pepper therefore requires no database schema
change and no trial verification against every retained key.

## Required configuration

Configure both variables in the deployment secret manager. Do not commit the
keyring, place it in logs, or reuse `BETTER_AUTH_SECRET` as a pepper.

```dotenv
PASSWORD_PEPPER_ACTIVE_ID=v2026_07
PASSWORD_PEPPER_KEYRING='{"v2026_07":{"generation":1,"secret":"<43-character-base64url-key>"}}'
```

Each `secret` must be exactly 32 random bytes encoded as canonical, unpadded
base64url. Generate one with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Pepper IDs are non-secret deployment identifiers. They may contain ASCII
letters, digits, `_`, and `-`, with a maximum length of 32 characters. Every
entry also has a unique positive integer `generation`. Generations must only
increase: if the current generation is 4, the replacement must be 5 or higher.
Never replace the secret or generation behind an existing ID. Add a new ID
instead. The keyring accepts at most eight keys so stale keys cannot accumulate
unnoticed.

The generation makes upgrades directional during a rolling deployment. An old
instance may verify a hash created by a newer instance because both keys are in
its keyring, but it will never rewrite that newer-generation hash with its old
active key through the lazy-upgrade path.

Generation does not change the active writer on an already-running old instance.
During planned deployment overlap, normal password create/change/reset and OTP
send operations handled by that instance can still write the old generation.
After the rollout, password hashes are upgraded on successful verification and
old OTPs expire. Keep the Argon2 costs pinned during a pepper rotation. A future
cost-policy change needs a separate rollout and response-time analysis because
old PHC strings retain their old verification cost.

Configuration is cached for the process lifetime. Every keyring or active-ID
change therefore requires a process restart or deployment.

The application fails closed during startup if either variable is missing or
invalid. A stored hash that references a missing key also raises an operational
error; it is not treated as a wrong password and does not increment login
failure counters.

## Planned rotation

Use two deployments so old and new application instances agree on the keyring:

1. Generate a new 32-byte key, a new ID, and a generation greater than every
   retained entry.
2. Add the new key to `PASSWORD_PEPPER_KEYRING`, but keep
   `PASSWORD_PEPPER_ACTIVE_ID` set to the old ID.
3. Deploy and wait until every application instance has the expanded keyring.
4. Change `PASSWORD_PEPPER_ACTIVE_ID` to the new ID and deploy again. Keep both
   keys in the keyring.
5. New passwords and OTP codes now use the new key. A successful password
   verification from a lower generation creates a new hash outside the
   verification transaction, then updates it with a compare-and-swap condition.
   A concurrent password change cannot be overwritten, and an old instance's
   lazy upgrader cannot downgrade a newer-generation hash.
6. Monitor the remaining password hashes by ID. Keep the old key until no
   password references it and at least the maximum OTP lifetime plus deployment
   overlap has elapsed.
7. Remove the old key in a later deployment.

Count credential hashes by pepper ID with:

```sql
SELECT split_part(password, ':', 2) AS pepper_id, count(*)
FROM accounts
WHERE provider_id = 'credential'
  AND password LIKE 'p1:%'
GROUP BY pepper_id
ORDER BY pepper_id;
```

Automatic password upgrades are opportunistic. If an upgrade fails after the
password has already been verified, login remains valid and the upgrade is
retried after a later successful verification. Successful compare-and-swap
upgrades are recorded in `audit_logs` without any hash or secret value.

Existing OTP hashes are not upgraded because they are short-lived and
single-use. Retaining the old key during their lifetime lets them complete
normally. Removing an old key immediately intentionally invalidates OTPs that
reference it; users must request a new code.

## Compromised pepper

Normal lazy rotation is not sufficient if an attacker obtained both the database
and the pepper: the attacker can continue offline guessing with the stolen
copies.

1. Create a new active key and use an atomic or blue/green cutover, or drain old
   instances before sending traffic to the new deployment. Do not leave an old
   instance able to create hashes with the compromised key during rolling
   overlap.
2. Define a short incident deadline for the compromised key.
3. Force password resets for accounts that still reference the compromised ID;
   do not wait indefinitely for inactive users to log in.
4. Revoke sessions as required by the incident scope.
5. Remove the compromised key after all remaining dependent credentials have
   been reset or deliberately invalidated.

If a pepper is lost without a secure backup, hashes that reference it cannot be
verified. Those users must reset their passwords. Back up the keyring in the
organization's secret-management system with access controls and audit trails,
separate from the application database.

## Initial rollout in this project

Unprefixed Better Auth/scrypt hashes and unpeppered Argon2 hashes are
intentionally rejected. This project is still under construction, so reset or
reseed development credentials after configuring the first pepper rather than
carrying a legacy verification path into production.
