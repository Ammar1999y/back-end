ALTER TYPE "public"."provider_id" ADD VALUE 'google';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auth_revoked_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "chk_google_account" CHECK (provider_id::text <> 'google' OR (issuer = 'https://accounts.google.com' AND password IS NULL));