DROP INDEX "ux_two_factor_methods_user_method";--> statement-breakpoint
ALTER TABLE "two_factor_credentials" ALTER COLUMN "verified" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "two_factor_credentials" ADD COLUMN "backup_codes_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "two_factor_credentials" ADD COLUMN "backup_codes_acknowledged_version" integer;--> statement-breakpoint
ALTER TABLE "two_factor_credentials" ADD COLUMN "backup_codes_remaining" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "two_factor_methods" ADD COLUMN "contact_kind" text GENERATED ALWAYS AS (CASE WHEN channel IS NULL THEN NULL WHEN channel = 'email' THEN 'email' ELSE 'phone' END) STORED;--> statement-breakpoint
ALTER TABLE "two_factor_methods" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_trusted_devices_expires_at" ON "trusted_devices" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_two_factor_methods_user_otp_contact" ON "two_factor_methods" USING btree ("user_id","contact_kind") WHERE method = 'otp';--> statement-breakpoint
CREATE UNIQUE INDEX "ux_two_factor_methods_default" ON "two_factor_methods" USING btree ("user_id") WHERE is_default;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_two_factor_methods_user_method" ON "two_factor_methods" USING btree ("user_id","method") WHERE method <> 'otp';--> statement-breakpoint
ALTER TABLE "two_factor_credentials" ADD CONSTRAINT "chk_two_factor_backup_codes_remaining_non_negative" CHECK (backup_codes_remaining >= 0);