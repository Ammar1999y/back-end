CREATE TYPE "public"."audit_log_action" AS ENUM('INSERT', 'UPDATE', 'DELETE');--> statement-breakpoint
CREATE TYPE "public"."bucket_type" AS ENUM('public', 'private');--> statement-breakpoint
CREATE TYPE "public"."file_context_table" AS ENUM('');--> statement-breakpoint
CREATE TYPE "public"."otp_channel" AS ENUM('email', 'sms', 'whatsapp');--> statement-breakpoint
CREATE TYPE "public"."page_name" AS ENUM('home', 'users', 'permissions', 'mainPage');--> statement-breakpoint
CREATE TYPE "public"."role_scope" AS ENUM('system', 'standard', 'custom');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" varchar(255) NOT NULL,
	"provider_id" varchar(100) NOT NULL,
	"user_id" uuid NOT NULL,
	"password" varchar(255),
	"created_at" timestamp(2) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(2) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_password_hash_length" CHECK (password IS NULL OR char_length(password) >= 50),
	CONSTRAINT "chk_credential_password" CHECK (provider_id <> 'credential' OR password IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"user_email" varchar(150) NOT NULL,
	"table_name" varchar(50) NOT NULL,
	"record_id" varchar(100) NOT NULL,
	"action" "audit_log_action" NOT NULL,
	"old_data" jsonb,
	"new_data" jsonb,
	"changed_fields" jsonb,
	"ip_address" varchar(45),
	"user_agent" varchar(512),
	"api_path" varchar(255),
	"created_at" timestamp(2) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"r2_key" varchar(500) NOT NULL,
	"bucket_type" "bucket_type" NOT NULL,
	"context_table" "file_context_table",
	"context_id" uuid,
	"mime_type" varchar(100) NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"width" integer,
	"height" integer,
	"blurhash" varchar(100),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_temporary" boolean DEFAULT true NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp(2) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(2) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_size_bytes_positive" CHECK (size_bytes >= 0),
	CONSTRAINT "chk_sort_order_positive" CHECK (sort_order >= 0),
	CONSTRAINT "chk_width_positive" CHECK (width IS NULL OR width > 0),
	CONSTRAINT "chk_height_positive" CHECK (height IS NULL OR height > 0)
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"role_id" uuid NOT NULL,
	"page_name" "page_name" NOT NULL,
	"permissions" jsonb NOT NULL,
	"created_at" timestamp(2) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"role_name" varchar(100) NOT NULL,
	"description" varchar(150),
	"is_active" boolean DEFAULT true NOT NULL,
	"scope" "role_scope" DEFAULT 'standard' NOT NULL,
	"created_at" timestamp(2) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(2) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ux_roles_role_name" UNIQUE("role_name"),
	CONSTRAINT "chk_custom_prefix_scope" CHECK ((role_name LIKE 'custom-%' AND scope = 'custom') OR (role_name NOT LIKE 'custom-%' AND scope <> 'custom'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"expires_at" timestamp(2) with time zone NOT NULL,
	"token" varchar(500) NOT NULL,
	"ip_address" varchar(45),
	"user_agent" varchar(512),
	"user_id" uuid NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp(2) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(2) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(150) NOT NULL,
	"email" varchar(150) NOT NULL,
	"phone_number" varchar(15),
	"email_verified" boolean DEFAULT false NOT NULL,
	"phone_number_verified" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"role_id" uuid,
	"failed_login_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp(2) with time zone,
	"deleted_at" timestamp(2) with time zone,
	"created_at" timestamp(2) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(2) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_email_lowercase" CHECK (email = LOWER(email)),
	CONSTRAINT "chk_failed_login_attempts_non_negative" CHECK (failed_login_attempts >= 0),
	CONSTRAINT "chk_deleted_user_inactive" CHECK (deleted_at IS NULL OR is_active = false),
	CONSTRAINT "chk_phone_number_format" CHECK (phone_number IS NULL OR phone_number ~ '^9665[0-9]{8}$'),
	CONSTRAINT "chk_active_user_has_role" CHECK (deleted_at IS NOT NULL OR role_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "verification_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"code" varchar(255) NOT NULL,
	"expires_at" timestamp(2) with time zone NOT NULL,
	"created_at" timestamp(2) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" "otp_channel" NOT NULL,
	"identifier" varchar(160) NOT NULL,
	"attempt_number" integer DEFAULT 0 NOT NULL,
	"verify_attempt_number" integer DEFAULT 0 NOT NULL,
	"verify_attempt_daily" integer DEFAULT 0 NOT NULL,
	"verify_attempt_window_start" timestamp(2) with time zone DEFAULT now() NOT NULL,
	"last_sent_at" timestamp(2) with time zone,
	"next_allowed_at" timestamp(2) with time zone,
	"is_blocked" boolean DEFAULT false NOT NULL,
	"blocked_until" timestamp(2) with time zone,
	"created_at" timestamp(2) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(2) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_attempt_number_non_negative" CHECK (attempt_number >= 0),
	CONSTRAINT "chk_attempt_number_max" CHECK (attempt_number <= 5),
	CONSTRAINT "chk_verify_attempt_number_max" CHECK (verify_attempt_number <= 5),
	CONSTRAINT "chk_verify_attempt_daily_max" CHECK (verify_attempt_daily <= 15),
	CONSTRAINT "chk_verify_attempt_number_non_negative" CHECK (verify_attempt_number >= 0),
	CONSTRAINT "chk_verify_attempt_daily_non_negative" CHECK (verify_attempt_daily >= 0),
	CONSTRAINT "chk_blocked_has_until" CHECK (is_blocked = false OR blocked_until IS NOT NULL),
	CONSTRAINT "chk_unblocked_no_until" CHECK (is_blocked = true OR blocked_until IS NULL)
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_codes" ADD CONSTRAINT "verification_codes_session_id_verification_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."verification_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_sessions" ADD CONSTRAINT "verification_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_accounts_provider_user" ON "accounts" USING btree ("provider_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_accounts_provider_account" ON "accounts" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "idx_accounts_user_id" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_table_record" ON "audit_logs" USING btree ("table_name","record_id");--> statement-breakpoint
CREATE INDEX "idx_files_uploaded_by" ON "files" USING btree ("uploaded_by");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_files_r2_key" ON "files" USING btree ("r2_key");--> statement-breakpoint
CREATE INDEX "idx_files_context" ON "files" USING btree ("context_table","context_id","sort_order");--> statement-breakpoint
CREATE INDEX "idx_role_permissions_role_id" ON "role_permissions" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_role_permissions_role_page" ON "role_permissions" USING btree ("role_id","page_name");--> statement-breakpoint
CREATE INDEX "idx_roles_scope_active_created" ON "roles" USING btree ("scope","is_active","created_at");--> statement-breakpoint
CREATE INDEX "idx_sessions_user_expires" ON "sessions" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_sessions_token" ON "sessions" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_users_email" ON "users" USING btree ("email") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_users_phone_number" ON "users" USING btree ("phone_number") WHERE deleted_at IS NULL AND phone_number IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_users_role_active" ON "users" USING btree ("role_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_users_created_at" ON "users" USING btree ("created_at") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_verification_codes_session" ON "verification_codes" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_verification_sessions_user_channel" ON "verification_sessions" USING btree ("user_id","channel");