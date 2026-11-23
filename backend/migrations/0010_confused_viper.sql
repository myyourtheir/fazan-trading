CREATE TABLE "app_owner" (
	"id" integer PRIMARY KEY NOT NULL,
	"app_account_id" text NOT NULL,
	CONSTRAINT "app_owner_app_account_id_unique" UNIQUE("app_account_id"),
	CONSTRAINT "app_owner_singleton" CHECK ("app_owner"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "legacy_strategy_claim" (
	"id" integer PRIMARY KEY NOT NULL,
	"app_account_id" text NOT NULL,
	CONSTRAINT "legacy_strategy_claim_singleton" CHECK ("legacy_strategy_claim"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "strategy_profiles" (
	"app_account_id" text NOT NULL,
	"instrument_uid" text NOT NULL,
	"ticker" text NOT NULL,
	"name" text NOT NULL,
	"class_code" text NOT NULL,
	"exchange" text NOT NULL,
	"expiration_date" text,
	"kind" text NOT NULL,
	"parameters" jsonb NOT NULL,
	"timeframe" text NOT NULL,
	CONSTRAINT "strategy_profiles_app_account_id_kind_pk" PRIMARY KEY("app_account_id","kind"),
	CONSTRAINT "strategy_profiles_valid_timeframe" CHECK ("strategy_profiles"."timeframe" in ('5m', '15m', '30m', '1h'))
);
--> statement-breakpoint
CREATE TABLE "strategy_selection" (
	"app_account_id" text PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'surfing' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "legacy_strategy_claim" ADD CONSTRAINT "legacy_strategy_claim_app_account_id_app_owner_app_account_id_fk" FOREIGN KEY ("app_account_id") REFERENCES "public"."app_owner"("app_account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_profiles" ADD CONSTRAINT "strategy_profiles_app_account_id_app_owner_app_account_id_fk" FOREIGN KEY ("app_account_id") REFERENCES "public"."app_owner"("app_account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_selection" ADD CONSTRAINT "strategy_selection_app_account_id_app_owner_app_account_id_fk" FOREIGN KEY ("app_account_id") REFERENCES "public"."app_owner"("app_account_id") ON DELETE no action ON UPDATE no action;