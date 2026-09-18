ALTER TABLE "two_factor_credentials" ADD COLUMN "backup_codes_set_id" uuid;--> statement-breakpoint
ALTER TABLE "two_factor_credentials" ADD COLUMN "backup_codes_acknowledged_set_id" uuid;--> statement-breakpoint
-- Hand-written, and it has to run BEFORE 0016 drops the columns it reads.
-- `backup_codes_version` counted generations per row and 0 meant "no set has
-- ever been generated"; the set id replaces it. An existing row therefore needs
-- a name for the set it already holds, or the acknowledgement it already has
-- stops matching and a backup-code-only account is left with no offered factor.
UPDATE "two_factor_credentials"
SET "backup_codes_set_id" = gen_random_uuid()
WHERE "backup_codes_version" > 0;--> statement-breakpoint
-- Only where the acknowledgement named the set that is CURRENT. An older
-- version acknowledged against a set since regenerated was not ready before
-- this migration and must not become ready because of it.
UPDATE "two_factor_credentials"
SET "backup_codes_acknowledged_set_id" = "backup_codes_set_id"
WHERE "backup_codes_set_id" IS NOT NULL
  AND "backup_codes_acknowledged_version" = "backup_codes_version";
