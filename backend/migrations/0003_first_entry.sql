CREATE TABLE "trade_executions" (
	"order_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"trade_id" text NOT NULL,
	"lots" integer NOT NULL,
	"price" double precision,
	"execution_time_ms" bigint,
	CONSTRAINT "trade_executions_order_id_sequence_pk" PRIMARY KEY("order_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "trade_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"instrument_uid" text NOT NULL,
	"ticker" text NOT NULL,
	"candle_time_ms" bigint NOT NULL,
	"signal_time_ms" bigint NOT NULL,
	"signal_price" double precision NOT NULL,
	"ema" double precision NOT NULL,
	"direction" text NOT NULL,
	"lots" integer NOT NULL,
	"from_position" integer NOT NULL,
	"target_position" integer NOT NULL,
	"status" text NOT NULL,
	"broker_order_id" text,
	"broker_status" text NOT NULL,
	"executed_lots" integer,
	"position" integer
);
--> statement-breakpoint
ALTER TABLE "trade_executions" ADD CONSTRAINT "trade_executions_order_id_trade_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."trade_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trade_orders_candle" ON "trade_orders" USING btree ("account_id","instrument_uid","candle_time_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "trade_orders_single_unresolved" ON "trade_orders" USING btree ((true)) WHERE "trade_orders"."status" in ('reserved', 'unconfirmed');