/**
 * Which site a punch was made at, from the coordinates the device recorded.
 *
 * A punch carries raw latitude and longitude and nothing else — the gate is a
 * browser on a phone, not a fixed turnstile. The calendar shows a one-letter
 * badge beside each time so a night at the mill is not read as a night at the
 * farm, and that letter is worked out here.
 *
 * The sites are niko's own `locations`, not a list in the code: a farm added
 * next year should light up on the calendar without a deploy. A location with
 * no coordinates takes part in nothing — better a missing letter than a wrong
 * one — and so does a punch whose point sits outside every site's radius.
 *
 * The letter is the first character of the location's code (NALBARI → N),
 * which is how the yard already says them out loud. Two sites sharing a first
 * letter get the first two characters instead, so they stay tellable apart.
 */
import { isNotNull } from "drizzle-orm";
import { locations } from "@shared/schema";
import { db } from "../db";

export interface Site {
  id: string;
  code: string;
  name: string;
  lat: number;
  lng: number;
  radiusKm: number;
}

/** Default reach of a site: GPS on a phone scatters by tens of metres, and a farm is not a point. */
const DEFAULT_RADIUS_KM = 5;

let cache: { at: number; sites: Site[] } | null = null;
const TTL_MS = 5 * 60_000;

async function sites(): Promise<Site[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.sites;
  const rows = await db
    .select({
      id: locations.id,
      code: locations.code,
      name: locations.name,
      latitude: locations.latitude,
      longitude: locations.longitude,
      radiusM: locations.radiusM,
    })
    .from(locations)
    .where(isNotNull(locations.latitude));

  const byLetter = new Map<string, number>();
  for (const r of rows) byLetter.set(r.code.slice(0, 1).toUpperCase(), (byLetter.get(r.code.slice(0, 1).toUpperCase()) ?? 0) + 1);

  const out = rows
    .filter((r) => r.latitude != null && r.longitude != null)
    .map((r) => {
      const first = r.code.slice(0, 1).toUpperCase();
      return {
        id: r.id,
        code: (byLetter.get(first) ?? 0) > 1 ? r.code.slice(0, 2).toUpperCase() : first,
        name: r.name,
        lat: Number(r.latitude),
        lng: Number(r.longitude),
        // A radius under a kilometre is the geofence for standing AT a gate;
        // for reading a punch after the fact the site's whole ground counts.
        radiusKm: Math.max((r.radiusM ?? 0) / 1000, DEFAULT_RADIUS_KM),
      };
    });
  cache = { at: Date.now(), sites: out };
  return out;
}

/** Sites forget themselves when one is edited, so a new farm shows up at once. */
export function forgetSites() {
  cache = null;
}

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** The nearest site within its radius, or null when there is no point or no site near it. */
export async function siteForPoint(lat: number | null, lng: number | null): Promise<Site | null> {
  if (lat == null || lng == null) return null;
  let best: Site | null = null;
  let bestKm = Infinity;
  for (const s of await sites()) {
    const km = haversineKm(lat, lng, s.lat, s.lng);
    if (km <= s.radiusKm && km < bestKm) {
      best = s;
      bestKm = km;
    }
  }
  return best;
}

/** The legend the calendar prints under itself: every site that can produce a letter. */
export async function siteLegend(): Promise<Array<{ code: string; name: string }>> {
  return (await sites()).map((s) => ({ code: s.code, name: s.name }));
}
