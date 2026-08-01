CREATE TYPE "public"."otp_purpose" AS ENUM('verify_contact', 'passwordless_login', 'forgot_password', 'change_password', 'change_email', 'change_phone');--> statement-breakpoint
DROP INDEX "ux_verification_sessions_user_channel";--> statement-breakpoint
ALTER TABLE "verification_sessions" ADD COLUMN "purpose" "otp_purpose" DEFAULT 'verify_contact' NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_sessions" ADD COLUMN "target_identifier" varchar(160);--> statement-breakpoint
ALTER TABLE "verification_sessions" ADD COLUMN "verified_at" timestamp(2) with time zone;--> statement-breakpoint
ALTER TABLE "verification_sessions" ADD COLUMN "consumed_at" timestamp(2) with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_verification_sessions_user_channel_purpose" ON "verification_sessions" USING btree ("user_id","channel","purpose");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "chk_phone_verified_requires_phone" CHECK (phone_number_verified = false OR phone_number IS NOT NULL);--> statement-breakpoint
ALTER TABLE "verification_sessions" ADD CONSTRAINT "chk_change_purpose_has_target" CHECK ((purpose IN ('change_email', 'change_phone')) = (target_identifier IS NOT NULL));--> statement-breakpoint
ALTER TABLE "verification_sessions" ADD CONSTRAINT "chk_consumed_requires_verified" CHECK (consumed_at IS NULL OR verified_at IS NOT NULL);