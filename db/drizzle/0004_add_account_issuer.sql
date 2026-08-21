ALTER TABLE "accounts" ADD COLUMN "issuer" varchar(255) DEFAULT 'local:credential' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_accounts_issuer_account" ON "accounts" USING btree ("issuer","account_id");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "chk_credential_issuer" CHECK (provider_id <> 'credential' OR issuer = 'local:credential');