-- The supervisor's submission of a day's Production & Stock Statement. A
-- submitted day is locked until an Admin or a Director reopens it.
CREATE TABLE IF NOT EXISTS "egg_stock_days" (
  "day" date PRIMARY KEY,
  "submitted_by" uuid REFERENCES "users"("id"),
  "submitted_at" timestamp with time zone,
  "reopened_by" uuid REFERENCES "users"("id"),
  "reopened_at" timestamp with time zone
);
