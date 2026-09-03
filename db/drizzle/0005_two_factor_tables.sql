ALTER TYPE "public"."otp_purpose" ADD VALUE 'two_factor';--> statement-breakpoint
CREATE TABLE "passkeys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(150),
	"public_key" text NOT NULL,
	"credential_id" varchar(1400) NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"device_type" varchar(32) NOT NULL,
	"backed_up" boolean DEFAULT false NOT NULL,
	"transports" varchar(255),
	"aaguid" varchar(64),
	"created_at" timestamp (2) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (2) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_passkeys_counter_non_negative" CHECK (counter >= 0)
);
--> statement-breakpoint
CREATE TABLE "trusted_devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"trust_identifier" varchar(160) NOT NULL,
	"user_agent" varchar(512),
	"ip_address" varchar(45),
	"last_used_at" timestamp (2) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (2) with time zone NOT NULL,
	"created_at" timestamp (2) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (2) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "two_factor_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp (2) with time zone,
	"backup_codes_acknowledged_at" timestamp (2) with time zone,
	"created_at" timestamp (2) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (2) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_two_factor_failed_count_non_negative" CHECK (failed_verification_count >= 0)
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"identifier" varchar(160) NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp (2) with time zone NOT NULL,
	"created_at" timestamp (2) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (2) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "two_factor_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trusted_devices" ADD CONSTRAINT "trusted_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor_credentials" ADD CONSTRAINT "two_factor_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_passkeys_credential_id" ON "passkeys" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "idx_passkeys_user_id" ON "passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_trusted_devices_identifier" ON "trusted_devices" USING btree ("trust_identifier");--> statement-breakpoint
CREATE INDEX "idx_trusted_devices_user" ON "trusted_devices" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_two_factor_credentials_user" ON "two_factor_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_verifications_identifier" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "idx_verifications_expires_at" ON "verifications" USING btree ("expires_at");