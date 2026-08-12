import { db } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const r = await db.execute(sql`
    SELECT c.display_name, COALESCE((
      SELECT SUM(i.balance_due) FROM invoices i WHERE i.customer_id = c.id AND i.status NOT IN ('draft','void')
    ), 0)::numeric(14,2) AS outstanding
    FROM contacts c
    LIMIT 10
  `);
  console.log(JSON.stringify(r.rows, null, 2));
  process.exit(0);
}
main();
