CREATE TABLE "display_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"time_zone" text NOT NULL,
	CONSTRAINT "display_settings_singleton" CHECK ("display_settings"."id" = 1)
);
