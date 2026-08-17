/**
 * Turning a GPS fix into a place we have a name for.
 *
 * A reverse geocoder would say "Dhekiajuli, North Assam Division". True, and
 * useless: the ledger has no such dimension. What a photo needs to carry is the
 * location the business actually operates — "Nalbari Feed Mill · Main gate" —
 * because that is the same dimension the receipt, the stock and the journal use.
 *
 * So the fix is resolved against our own gates and locations, and nothing else.
 * No network call, no third party, works at a boom with no signal.
 */
import { eq } from "drizzle-orm";
import { gates, locations } from "@shared/schema";
import type { Db, Tx } from "../db";

export interface Fix {
  latitude: number;
  longitude: number;
  /** Reported horizontal accuracy in metres, if the device gave one. */
  accuracyM?: number;
}

export type GeofenceVerdict = "inside" | "outside" | "no_fix";

export interface ResolvedPlace {
  locationId: string | null;
  /** What to show a person: "Nalbari Feed Mill · Main gate". */
  label: string;
  gateId: string | null;
  /** Metres from the matched point, or from the nearest one when outside. */
  distanceM: number | null;
  verdict: GeofenceVerdict;
}

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversine(a: Fix, b: { latitude: number; longitude: number }): number {
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const num = (v: string | null): number | null => (v == null ? null : Number(v));

/**
 * Where was this taken?
 *
 * Gates are checked first because they are surveyed standing at the barrier and
 * carry a tight radius; a site fix is the fallback. A fix that matches nothing
 * still returns its distance to the nearest known point, so "outside" can say
 * how far outside.
 *
 * **This never fails a capture.** A phone beside a steel shed reports ±80 m as a
 * matter of course, and inside a godown it reports nothing at all. Refusing a
 * photo over a drifted satellite fix would strand a loaded truck at the boom, so
 * the verdict is recorded and flagged, never enforced.
 */
export async function resolvePlace(db: Db | Tx, fix: Fix | null): Promise<ResolvedPlace> {
  if (
    !fix ||
    !Number.isFinite(fix.latitude) ||
    !Number.isFinite(fix.longitude) ||
    (fix.latitude === 0 && fix.longitude === 0)
  ) {
    return { locationId: null, label: "Location unavailable", gateId: null, distanceM: null, verdict: "no_fix" };
  }

  const [gateRows, siteRows] = await Promise.all([
    db
      .select({
        id: gates.id,
        name: gates.name,
        latitude: gates.latitude,
        longitude: gates.longitude,
        radiusM: gates.radiusM,
        locationId: gates.locationId,
      })
      .from(gates)
      .where(eq(gates.isActive, true)),
    db
      .select({
        id: locations.id,
        name: locations.name,
        latitude: locations.latitude,
        longitude: locations.longitude,
        radiusM: locations.radiusM,
      })
      .from(locations)
      .where(eq(locations.isActive, true)),
  ]);

  const siteName = new Map(siteRows.map((s) => [s.id, s.name]));

  interface Candidate {
    label: string;
    locationId: string | null;
    gateId: string | null;
    distance: number;
    inside: boolean;
  }

  const candidates: Candidate[] = [];
  const add = (
    label: string,
    locationId: string | null,
    gateId: string | null,
    lat: number | null,
    lng: number | null,
    radiusM: number,
  ) => {
    if (lat == null || lng == null) return;
    const distance = haversine(fix, { latitude: lat, longitude: lng });
    candidates.push({ label, locationId, gateId, distance, inside: distance <= radiusM });
  };

  for (const g of gateRows) {
    const site = siteName.get(g.locationId) ?? "Unknown site";
    add(`${site} · ${g.name}`, g.locationId, g.id, num(g.latitude), num(g.longitude), g.radiusM);
  }
  for (const s of siteRows) {
    add(s.name, s.id, null, num(s.latitude), num(s.longitude), s.radiusM);
  }

  // An inside match always beats an outside one; among equals, nearest wins.
  candidates.sort((a, b) =>
    a.inside !== b.inside ? (a.inside ? -1 : 1) : a.distance - b.distance,
  );
  const best = candidates[0];

  if (!best) {
    // Nothing has been surveyed yet. Record the raw fix rather than pretend.
    return {
      locationId: null,
      label: `${fix.latitude.toFixed(5)}, ${fix.longitude.toFixed(5)}`,
      gateId: null,
      distanceM: null,
      verdict: "outside",
    };
  }

  return {
    locationId: best.locationId,
    label: best.inside ? best.label : `Near ${best.label} (${Math.round(best.distance)} m away)`,
    gateId: best.gateId,
    distanceM: Math.round(best.distance),
    verdict: best.inside ? "inside" : "outside",
  };
}
