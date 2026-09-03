CREATE TYPE "public"."two_factor_method" AS ENUM('totp', 'otp', 'backup_code', 'passkey');--> statement-breakpoint
CREATE TABLE "two_factor_methods" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"method" "two_factor_method" NOT NULL,
	"channel" "otp_channel",
	"created_at" timestamp (2) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (2) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_two_factor_method_channel" CHECK ((method = 'otp') = (channel IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "two_factor_methods" ADD CONSTRAINT "two_factor_methods_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_two_factor_methods_user_method" ON "two_factor_methods" USING btree ("user_id","method");