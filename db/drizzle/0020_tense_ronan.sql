CREATE TABLE "user_preferences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"ui" jsonb NOT NULL,
	"created_at" timestamp (2) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (2) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_user_preferences_ui_size" CHECK (pg_column_size(ui) <= 4096)
);
--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_user_preferences_user" ON "user_preferences" USING btree ("user_id");