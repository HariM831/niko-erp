-- A journal source of its own for money moving between a customer's advances
-- and their receivable. The loading bay settles invoices from advances the
-- moment they are raised, and the void path hands the money back; both post
-- journals that are neither the payment nor the invoice, and filing them
-- under either would make the audit trail lie about what happened.
-- Value only: Postgres refuses to USE a new enum value in the transaction
-- that created it (see 0044 for the same dance).
ALTER TYPE "public"."journal_source_type" ADD VALUE IF NOT EXISTS 'advance_application';
