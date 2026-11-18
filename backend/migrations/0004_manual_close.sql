ALTER TABLE "trade_orders" ALTER COLUMN "candle_time_ms" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "trade_orders" ALTER COLUMN "signal_time_ms" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "trade_orders" ALTER COLUMN "signal_price" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "trade_orders" ALTER COLUMN "ema" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "trade_orders" ADD COLUMN "action" text DEFAULT 'ema-crossing' NOT NULL;--> statement-breakpoint
ALTER TABLE "trade_orders" ADD COLUMN "manual_close_time_ms" bigint;--> statement-breakpoint
ALTER TABLE "trade_orders" ADD CONSTRAINT "trade_orders_action_context" CHECK ((
    "trade_orders"."action" = 'ema-crossing' and "trade_orders"."candle_time_ms" is not null and "trade_orders"."signal_time_ms" is not null
      and "trade_orders"."signal_price" is not null and "trade_orders"."ema" is not null and "trade_orders"."manual_close_time_ms" is null
  ) or (
    "trade_orders"."action" = 'manual-close' and "trade_orders"."candle_time_ms" is null and "trade_orders"."signal_time_ms" is null
      and "trade_orders"."signal_price" is null and "trade_orders"."ema" is null and "trade_orders"."manual_close_time_ms" is not null
      and "trade_orders"."target_position" = 0
  ));