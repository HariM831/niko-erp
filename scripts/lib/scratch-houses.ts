/**
 * Houses a check script owns outright, made inside its rolled-back transaction.
 *
 * The flock checks used to borrow the real P1/P2/L-houses, which only worked
 * while those stood empty. Since the Amino import they hold real batches, and
 * the spine rightly refuses to house a test batch on top of one — so a check
 * that places birds brings its own sheds, on the same site as the real ones so
 * site-scoped rules (flock codes, feed pools) behave as they do for real.
 */
import { houses, locations, stockLocations } from "@shared/schema";
import { db } from "../../server/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type House = typeof houses.$inferSelect;

export async function scratchHouse(
  tx: Tx,
  code: string,
  purpose: "pullet" | "layer",
  ownerId: string | null = null,
): Promise<House> {
  const [real] = await tx.select({ locationId: houses.locationId }).from(houses).limit(1);
  const locationId = real?.locationId ?? (await tx.select({ id: locations.id }).from(locations).limit(1))[0]?.id;
  if (!locationId) throw new Error("no site to stand a scratch house on");
  const [stock] = await tx
    .insert(stockLocations)
    .values({ locationId, code, name: `check scratch ${code}`, kind: "house" })
    .returning();
  const [house] = await tx
    .insert(houses)
    .values({ locationId, stockLocationId: stock!.id, code, purpose, ownerId, displayOrder: 9999 })
    .returning();
  return house!;
}
