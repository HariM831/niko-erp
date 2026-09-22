import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { accounts } from "./accounting";

/**
 * Which section of the Cost Analysis statement a P&L account belongs to.
 *
 * The live chart is Zoho's, not the seeded one, so the statement cannot pick
 * its heads by code or name in source — the mapping is data, chosen once in
 * Settings. An account with no row here is UNASSIGNED and the report says so
 * in red; `excluded` is a row too, so "decided out" (raw-material purchases,
 * chicks, the eggs bought back from the group companies) can be told apart
 * from "nobody looked".
 */
export const COST_SECTIONS = [
  "income",
  "cogs",
  "farm",
  "mill",
  "packing",
  "admin",
  "finance",
  "excluded",
] as const;
export type CostSection = (typeof COST_SECTIONS)[number];

export const costAnalysisHeads = pgTable("cost_analysis_heads", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => accounts.id, { onDelete: "cascade" }),
  section: text("section", { enum: COST_SECTIONS }).notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
