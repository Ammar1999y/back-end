CREATE TYPE "public"."provider_id" AS ENUM('credential');--> statement-breakpoint
ALTER TABLE "roles" DROP CONSTRAINT "chk_custom_prefix_scope";--> statement-breakpoint
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "role_permissions" ALTER COLUMN "page_name" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."page_name";--> statement-breakpoint
CREATE TYPE "public"."page_name" AS ENUM('home', 'users', 'permissions');--> statement-breakpoint
ALTER TABLE "role_permissions" ALTER COLUMN "page_name" SET DATA TYPE "public"."page_name" USING "page_name"::"public"."page_name";--> statement-breakpoint
DROP INDEX "idx_sessions_user_expires";--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "provider_id" SET DATA TYPE "public"."provider_id" USING "provider_id"::"public"."provider_id";--> statement-breakpoint
ALTER TABLE "audit_logs" ALTER COLUMN "api_path" SET DATA TYPE varchar(2048);--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_roles_created_by" ON "roles" USING btree ("created_by") WHERE created_by IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_sessions_user_expires_created" ON "sessions" USING btree ("user_id","expires_at","created_at");--> statement-breakpoint
CREATE INDEX "idx_users_created_by" ON "users" USING btree ("created_by") WHERE deleted_at IS NULL AND created_by IS NOT NULL;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "chk_custom_prefix_scope" CHECK ((role_name ILIKE 'custom-%' AND scope = 'custom') OR (role_name NOT ILIKE 'custom-%' AND scope <> 'custom'));