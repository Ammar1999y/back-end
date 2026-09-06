CREATE TYPE "public"."file_kind" AS ENUM('image', 'document');--> statement-breakpoint
CREATE TYPE "public"."file_status" AS ENUM('pending', 'active', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."file_transition" AS ENUM('to_public', 'to_private', 'cleanup');--> statement-breakpoint
ALTER TYPE "public"."page_name" ADD VALUE 'media';--> statement-breakpoint
CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"parent_id" uuid,
	"name" varchar(100) NOT NULL,
	"created_by" uuid,
	"created_at" timestamp (2) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (2) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_folders_name" CHECK (name = btrim(name) AND name <> '' AND position('/' in name) = 0),
	CONSTRAINT "chk_folders_not_self" CHECK (parent_id IS NULL OR parent_id <> id)
);
--> statement-breakpoint
ALTER TABLE "files" DROP CONSTRAINT "chk_sort_order_positive";--> statement-breakpoint
DROP INDEX "idx_files_context";--> statement-breakpoint
ALTER TABLE "files" ALTER COLUMN "size_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "status" "file_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "kind" "file_kind";--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "transition" "file_transition";--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "display_name" varchar(150);--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "sha256" varchar(64);--> statement-breakpoint
UPDATE "files" SET "status" = CASE WHEN "is_temporary" THEN 'pending'::"file_status" ELSE 'active'::"file_status" END;--> statement-breakpoint
UPDATE "files" SET "kind" = 'image'::"file_kind";--> statement-breakpoint
UPDATE "files" SET "display_name" = regexp_replace("r2_key", '^.*/', '');--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_id_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."folders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_folders_parent_name" ON "folders" USING btree ("parent_id",lower("name")) WHERE parent_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_folders_root_name" ON "folders" USING btree (lower("name")) WHERE parent_id IS NULL;--> statement-breakpoint
CREATE INDEX "idx_folders_parent" ON "folders" USING btree ("parent_id");--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_files_folder_created" ON "files" USING btree ("folder_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_files_folder_name" ON "files" USING btree ("folder_id",lower("display_name"),"id");--> statement-breakpoint
CREATE INDEX "idx_files_status_created" ON "files" USING btree ("status","created_at") WHERE status <> 'active';--> statement-breakpoint
CREATE INDEX "idx_files_transition" ON "files" USING btree ("transition","updated_at") WHERE transition IS NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "ux_files_id_status" UNIQUE("id","status");--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "chk_files_sha256_hex" CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$');