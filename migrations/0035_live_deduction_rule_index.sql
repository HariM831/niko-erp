-- One live deduction rule per parameter per material per vendor.
--
-- computeDeductions() keeps a single rule per parameter and picks the most
-- specific one. Two live rules of EQUAL specificity leave that choice to
-- whatever order the rows happen to come back in, which makes a vendor's
-- deduction depend on the query plan.
--
-- Hand-written, because the COALESCE is load-bearing: a plain unique index
-- treats two NULL item_ids as distinct, so exactly the blanket rules that do
-- collide would pass straight through it.
CREATE UNIQUE INDEX "uq_deduction_rule_live" ON "deduction_rules" (
  "parameter",
  coalesce("item_id", '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce("vendor_id", '00000000-0000-0000-0000-000000000000'::uuid)
) WHERE "is_active";
