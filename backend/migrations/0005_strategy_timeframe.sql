DROP INDEX "trade_orders_candle";--> statement-breakpoint
ALTER TABLE "strategy_settings" ADD COLUMN "timeframe" text DEFAULT '1h' NOT NULL;--> statement-breakpoint
ALTER TABLE "trade_orders" ADD COLUMN "timeframe" text DEFAULT '1h' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "trade_orders_candle" ON "trade_orders" USING btree ("account_id","instrument_uid","timeframe","candle_time_ms");--> statement-breakpoint
ALTER TABLE "strategy_settings" ADD CONSTRAINT "strategy_settings_valid_timeframe" CHECK ("strategy_settings"."timeframe" in ('5m', '15m', '30m', '1h'));--> statement-breakpoint
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_valid_timeframe" CHECK ("trade_orders"."timeframe" in ('5m', '15m', '30m', '1h'));