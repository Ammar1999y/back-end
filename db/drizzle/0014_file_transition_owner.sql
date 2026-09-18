ALTER TABLE "files" ADD COLUMN "transition_id" uuid;--> statement-breakpoint
-- A CHECK is validated against existing rows, and a row holding a live or
-- stalled visibility saga has `transition` set. Without this backfill the
-- statement below aborts the migration on any database where a publish is in
-- flight, and the sweep's claim needs a token to take over from anyway.
UPDATE "files" SET "transition_id" = gen_random_uuid() WHERE "transition" IS NOT NULL AND "transition_id" IS NULL;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "chk_files_transition_owner" CHECK ((transition IS NULL) = (transition_id IS NULL));
