CREATE TABLE "protection_ledger" (
	"id" integer PRIMARY KEY NOT NULL,
	"state" jsonb NOT NULL,
	CONSTRAINT "protection_ledger_singleton" CHECK ("protection_ledger"."id" = 1)
);
--> statement-breakpoint
INSERT INTO "protection_ledger" ("id", "state") VALUES (
	1,
	'{"protection":null,"orders":{},"settledOrders":{},"proof":null,"definiteChildren":{},"definiteParent":null,"stopSubmitPending":false,"entry":null,"guardedIds":{}}'::jsonb
);
