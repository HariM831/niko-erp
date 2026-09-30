-- The day's WhatsApp message to each customer, as Amino sent it (the user,
-- 30 Sep 2026). The template is Amino's own, copied from its Sales Settings;
-- the payment instructions are the farm's to type, so the column starts empty
-- and the message leaves the line out until it is filled.

ALTER TABLE "egg_sales_preferences"
  ADD COLUMN IF NOT EXISTS "whatsapp_template" text NOT NULL DEFAULT E'Hi [customer_name],\n\nYour delivery for [delivery_date] is confirmed:\n\n[order_lines]\n\nTotal: [total_amount]\n\n[payment_instructions]',
  ADD COLUMN IF NOT EXISTS "payment_instructions" text;
