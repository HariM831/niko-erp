CREATE TYPE "public"."account_subtype" AS ENUM('other_current_asset', 'cash', 'bank', 'accounts_receivable', 'stock', 'fixed_asset', 'other_asset', 'other_current_liability', 'accounts_payable', 'credit_card', 'non_current_liability', 'other_liability', 'equity', 'income', 'other_income', 'expense', 'cost_of_goods_sold', 'other_expense');--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "subtype" "account_subtype";--> statement-breakpoint
-- Backfill: classify existing accounts by their system key / code range, so the
-- new granular reporting groups are correct without hand-editing every account.
UPDATE "accounts" SET "subtype" = CASE
  WHEN "system_key" = 'ar'                        THEN 'accounts_receivable'
  WHEN "system_key" = 'ap'                        THEN 'accounts_payable'
  WHEN "system_key" IN ('cash_bank','petty_cash') THEN 'cash'
  WHEN "system_key" = 'inventory'                 THEN 'stock'
  WHEN "system_key" = 'cogs'                      THEN 'cost_of_goods_sold'
  WHEN "code" LIKE 'BNK-%'                        THEN 'bank'
  WHEN "type" = 'asset'     AND "code" >= '1600'  THEN 'fixed_asset'
  WHEN "type" = 'asset'                           THEN 'other_current_asset'
  WHEN "type" = 'liability'                       THEN 'other_current_liability'
  WHEN "type" = 'equity'                          THEN 'equity'
  WHEN "type" = 'income'                          THEN 'income'
  WHEN "type" = 'expense'                         THEN 'expense'
END::"account_subtype"
WHERE "subtype" IS NULL;
