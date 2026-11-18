CREATE TABLE "strategy_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"instrument_uid" text NOT NULL,
	"ticker" text NOT NULL,
	"name" text NOT NULL,
	"class_code" text NOT NULL,
	"exchange" text NOT NULL,
	"expiration_date" text,
	"ema_period" integer NOT NULL,
	"lots" integer NOT NULL,
	CONSTRAINT "strategy_settings_singleton" CHECK ("strategy_settings"."id" = 1),
	CONSTRAINT "strategy_settings_positive_ema" CHECK ("strategy_settings"."ema_period" > 0),
	CONSTRAINT "strategy_settings_positive_lots" CHECK ("strategy_settings"."lots" > 0)
);
