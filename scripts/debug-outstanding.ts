import { db } from "../server/db";
import { contacts } from "@shared/schema";
import { sql, getTableColumns } from "drizzle-orm";

async function main() {
  const rows = await db
    .select({
      ...getTableColumns(contacts),
      outstanding: sql<string>`COALESCE((
        SELECT SUM(i.balance_due) FROM invoices i WHERE i.customer_id = ${contacts.id} AND i.status NOT IN ('draft', 'void')
      ), 0)::numeric(14,2) + COALESCE((
        SELECT SUM(b.balance_due) FROM bills b WHERE b.vendor_id = ${contacts.id} AND b.status NOT IN ('draft', 'void')
      ), 0)::numeric(14,2)`,
    })
    .from(contacts)
    .limit(10);
  console.log(JSON.stringify(rows.map((r) => ({ name: r.displayName, outstanding: r.outstanding })), null, 2));
  process.exit(0);
}
main();
