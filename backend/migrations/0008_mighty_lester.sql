UPDATE "strategy_settings"
SET "kind" = coalesce("kind", 'surfing'),
    "parameters" = coalesce("parameters", jsonb_build_object('emaPeriod', "ema_period", 'lots', "lots"))
WHERE ("kind" IS NULL OR "kind" = 'surfing')
  AND ("kind" IS NULL OR "parameters" IS NULL);--> statement-breakpoint
ALTER TABLE "strategy_settings" DROP CONSTRAINT "strategy_settings_positive_ema";--> statement-breakpoint
ALTER TABLE "strategy_settings" DROP CONSTRAINT "strategy_settings_positive_lots";--> statement-breakpoint
ALTER TABLE "strategy_settings" ALTER COLUMN "kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "strategy_settings" ALTER COLUMN "parameters" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "strategy_settings" DROP COLUMN "ema_period";--> statement-breakpoint
ALTER TABLE "strategy_settings" DROP COLUMN "lots";
