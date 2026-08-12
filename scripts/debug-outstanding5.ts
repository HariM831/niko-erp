import { db } from "../server/db";
import { contacts } from "@shared/schema";
import { sql } from "drizzle-orm";

const q = db
  .select({
    name: contacts.displayName,
    outstanding: sql<string>`COALESCE((
      SELECT SUM(i.balance_due) FROM invoices i WHERE i.customer_id = ${contacts.id} AND i.status NOT IN ('draft','void')
    ), 0)::numeric(14,2)`,
  })
  .from(contacts)
  .limit(10);
console.log(q.toSQL());
