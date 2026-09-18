CREATE TABLE "orphaned_objects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"r2_key" varchar(500) NOT NULL,
	"bucket_type" "bucket_type" NOT NULL,
	"created_at" timestamp (2) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (2) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ux_orphaned_objects_key_bucket" ON "orphaned_objects" USING btree ("r2_key","bucket_type");