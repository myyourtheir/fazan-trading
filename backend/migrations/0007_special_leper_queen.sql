ALTER TABLE "strategy_settings" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "strategy_settings" ADD COLUMN "parameters" jsonb;--> statement-breakpoint
UPDATE "strategy_settings" SET "kind" = 'surfing', "parameters" = jsonb_build_object('emaPeriod', "ema_period", 'lots', "lots");
