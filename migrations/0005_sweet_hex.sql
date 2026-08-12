ALTER TABLE "bills" ADD COLUMN "freight_vendor_id" uuid;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "freight_account_id" uuid;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "freight_journal_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_freight_vendor_id_contacts_id_fk" FOREIGN KEY ("freight_vendor_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_freight_account_id_accounts_id_fk" FOREIGN KEY ("freight_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_freight_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("freight_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;