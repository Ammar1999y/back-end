ALTER TABLE "files" ALTER COLUMN "kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ALTER COLUMN "display_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "files" DROP COLUMN "context_table";--> statement-breakpoint
ALTER TABLE "files" DROP COLUMN "context_id";--> statement-breakpoint
ALTER TABLE "files" DROP COLUMN "sort_order";--> statement-breakpoint
ALTER TABLE "files" DROP COLUMN "is_temporary";--> statement-breakpoint
DROP TYPE "public"."file_context_table";