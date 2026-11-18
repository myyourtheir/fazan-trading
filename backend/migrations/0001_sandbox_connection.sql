CREATE TABLE "sandbox_connection" (
	"id" integer PRIMARY KEY NOT NULL,
	"encrypted_token" text NOT NULL,
	"account_id" text,
	CONSTRAINT "sandbox_connection_singleton" CHECK ("sandbox_connection"."id" = 1)
);
