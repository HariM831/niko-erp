-- Where each of a house-day's figures came from (9 Oct 2026): the silo, the
-- controller, the mill's book, or a person — and the person's reason when they
-- overrode or settled a figure the instruments could not. See
-- server/services/house-day-autofill.ts.
ALTER TABLE "placement_days" ADD COLUMN "sources" jsonb;
