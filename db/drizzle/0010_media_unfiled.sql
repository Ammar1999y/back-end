ALTER TABLE "files" ADD COLUMN "unfiled_at" timestamp (2) with time zone;--> statement-breakpoint
CREATE INDEX "idx_files_unfiled" ON "files" USING btree ("unfiled_at") WHERE unfiled_at IS NOT NULL;