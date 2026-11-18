-- Existing Compose databases already have this table from the pre-Drizzle migration.
CREATE TABLE IF NOT EXISTS "owner_sessions" (
	"token_digest" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "owner_sessions_expiry" ON "owner_sessions" USING btree ("expires_at");
