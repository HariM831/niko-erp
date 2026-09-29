/**
 * Who a Zoho load is recorded as: the Zoho user, where it came from.
 *
 * The loaders used to take the first row of `users`, which is whoever
 * Postgres reads first, and put Geetanjali Borah's name on every bill,
 * invoice, expense, payment and journal of the 17 Sep 2026 load. The user,
 * 29 Sep 2026: put Zoho ones as Zoho. Falls back to the oldest user on a
 * database with no `zoho` user.
 */
import { asc, eq } from "drizzle-orm";
import { users } from "@shared/schema";
import { db } from "../../server/db";

export async function zohoActor(): Promise<{ id: string }> {
  const [zoho] = await db.select({ id: users.id }).from(users).where(eq(users.username, "zoho"));
  if (zoho) return zoho;
  const [oldest] = await db.select({ id: users.id }).from(users).orderBy(asc(users.createdAt)).limit(1);
  if (!oldest) throw new Error("No user to record the load as");
  return oldest;
}
