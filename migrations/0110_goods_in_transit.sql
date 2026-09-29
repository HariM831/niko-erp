-- Goods in Transit: where a bill's stock value waits between the vendor's date
-- and the day the lorry reaches the gate.
--
-- The user, 29 Sep 2026: the bill keeps the vendor's date, and the goods go
-- into stock on arrival. Soybean meal billed 14 Sep came in on the 21st;
-- Cantaxanthin billed 11 Sep came in on the 28th. The bill's own entry still
-- debits the stock account on its date; a pair of entries moves that value
-- out to here on the bill date and back on the arrival day, so the stock
-- account never holds value for kilos the mill has not received.
--
-- Code 1152 sits beside 1151 Inventory Asset in the live (Zoho) chart; a
-- chart built from seed.ts, which has no 1152 of its own, gets it too. Where
-- that code is taken, the account still goes in, under GIT-1.
INSERT INTO "accounts" ("code", "name", "type", "subtype", "system_key", "is_group")
SELECT CASE WHEN EXISTS (SELECT 1 FROM accounts WHERE code = '1152') THEN 'GIT-1' ELSE '1152' END,
       'Goods in Transit', 'asset', 'other_current_asset', 'goods_in_transit', false
WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE system_key = 'goods_in_transit');
