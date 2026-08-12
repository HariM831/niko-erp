CREATE TABLE "transaction_locks" (
	"module" varchar(20) PRIMARY KEY NOT NULL,
	"locked_through" date,
	"reason" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
