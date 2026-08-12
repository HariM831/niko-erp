import { db } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const r1 = await db.execute(sql`SELECT id, customer_id, status, balance_due FROM invoices LIMIT 10`);
  console.log("invoices:", JSON.stringify(r1.rows, null, 2));
  const r2 = await db.execute(sql`SELECT id, display_name FROM contacts LIMIT 5`);
  console.log("contacts:", JSON.stringify(r2.rows, null, 2));
  process.exit(0);
}
main();
