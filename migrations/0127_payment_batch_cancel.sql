-- A bank file that should not stand (16 Oct 2026): raised in error, never
-- uploaded, or one line bounced on a stale IFSC. Cancelling a transfer puts its
-- document back on the Vendor Sheet's To pay list; cancelling the batch cancels
-- every transfer in it. Nothing is deleted — the file that was raised stays on
-- record, marked, with who cancelled it and why.
ALTER TABLE "payment_batches" ADD COLUMN "cancelled_at" timestamp;
ALTER TABLE "payment_batches" ADD COLUMN "cancelled_by" uuid REFERENCES "users"("id");
ALTER TABLE "payment_batches" ADD COLUMN "cancel_reason" text;
ALTER TABLE "payment_batch_lines" ADD COLUMN "cancelled_at" timestamp;
ALTER TABLE "payment_batch_lines" ADD COLUMN "cancelled_by" uuid REFERENCES "users"("id");
ALTER TABLE "payment_batch_lines" ADD COLUMN "cancel_reason" text;
