/**
 * Working out which vendor a bill came from.
 *
 * The letterhead is never quite the contact record. Bill 517 says "SHAYAN
 * ENTERPRISE"; the ledger says "Shayan Enterprises". Matching on the raw string
 * fails, and the guard is left picking from four hundred names with a truck
 * waiting.
 *
 * So identity is tried strongest-first: GSTIN, then PAN, then the trading name
 * with its legal suffix stripped, then a loose token overlap. A PAN is the good
 * one for agricultural bills — a bill of supply carries no GSTIN at all, but it
 * must carry a PAN, and a PAN is unique to a business.
 *
 * **Never auto-creates a vendor.** No match offers the extracted name, PAN and
 * GSTIN back to a person to create from — deciding that a new trading party
 * exists is not a decision to take from a photograph.
 */
import { inArray } from "drizzle-orm";
import { contacts } from "@shared/schema";
import type { Db, Tx } from "../db";

export type VendorMatchMethod = "gstin" | "pan" | "exact" | "fuzzy" | "none";

export interface VendorMatch {
  vendorId: string | null;
  vendorName: string | null;
  method: VendorMatchMethod;
  /** Offered when nothing was certain enough to pick on its own. */
  candidates: Array<{ id: string; name: string; why: string }>;
}

/**
 * Suffixes that say what a business IS rather than what it is CALLED. Two
 * records for the same trader rarely agree on them.
 */
const SUFFIXES = [
  "enterprise", "enterprises", "traders", "trading", "agencies", "agency",
  "agro", "industries", "industry", "and co", "co", "company", "pvt", "private",
  "ltd", "limited", "llp", "sons", "brothers", "bros", "corporation", "corp",
  "trader", "suppliers", "supplier", "stores", "store",
];

/** "SHAYAN ENTERPRISE" and "Shayan Enterprises Pvt Ltd" both reduce to "shayan". */
export function normaliseVendorName(raw: string): string {
  let s = raw.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  // Repeatedly, so "Pvt Ltd" and "Trading Co" both come off.
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of SUFFIXES) {
      if (s.endsWith(` ${suffix}`)) {
        s = s.slice(0, -(suffix.length + 1)).trim();
        changed = true;
      }
    }
  }
  return s;
}

const tokens = (s: string) => new Set(normaliseVendorName(s).split(" ").filter(Boolean));

/** Jaccard overlap on the meaningful words. */
function overlap(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / new Set([...A, ...B]).size;
}

export async function resolveVendor(
  db: Db | Tx,
  input: { name?: string | null; pan?: string | null; gstin?: string | null },
): Promise<VendorMatch> {
  const all = await db
    .select({ id: contacts.id, name: contacts.displayName, pan: contacts.pan, gstin: contacts.gstin })
    .from(contacts)
    .where(inArray(contacts.type, ["vendor", "both"]));

  const clean = (s?: string | null) => (s ?? "").replace(/\s/g, "").toUpperCase();

  if (input.gstin) {
    const hit = all.find((v) => clean(v.gstin) === clean(input.gstin));
    if (hit) return { vendorId: hit.id, vendorName: hit.name, method: "gstin", candidates: [] };
  }

  if (input.pan) {
    const hits = all.filter((v) => clean(v.pan) === clean(input.pan));
    if (hits.length === 1) {
      return { vendorId: hits[0]!.id, vendorName: hits[0]!.name, method: "pan", candidates: [] };
    }
    // Two contacts sharing a PAN is a data problem, not a match.
    if (hits.length > 1) {
      return {
        vendorId: null,
        vendorName: null,
        method: "none",
        candidates: hits.map((h) => ({ id: h.id, name: h.name, why: `Same PAN ${input.pan}` })),
      };
    }
  }

  if (input.name) {
    const target = normaliseVendorName(input.name);
    if (target) {
      const exact = all.filter((v) => normaliseVendorName(v.name) === target);
      if (exact.length === 1) {
        return { vendorId: exact[0]!.id, vendorName: exact[0]!.name, method: "exact", candidates: [] };
      }
      if (exact.length > 1) {
        return {
          vendorId: null,
          vendorName: null,
          method: "none",
          candidates: exact.map((h) => ({ id: h.id, name: h.name, why: "Same trading name" })),
        };
      }

      const scored = all
        .map((v) => ({ v, score: overlap(input.name!, v.name) }))
        .filter((x) => x.score >= 0.6)
        .sort((a, b) => b.score - a.score);

      // Confident enough to apply, and clearly ahead of the runner-up.
      if (scored[0] && scored[0].score >= 0.8 && (!scored[1] || scored[1].score < 0.6)) {
        return {
          vendorId: scored[0].v.id,
          vendorName: scored[0].v.name,
          method: "fuzzy",
          candidates: [],
        };
      }
      if (scored.length) {
        return {
          vendorId: null,
          vendorName: null,
          method: "none",
          candidates: scored.slice(0, 5).map((x) => ({
            id: x.v.id,
            name: x.v.name,
            why: `${Math.round(x.score * 100)}% name match`,
          })),
        };
      }
    }
  }

  return { vendorId: null, vendorName: null, method: "none", candidates: [] };
}
