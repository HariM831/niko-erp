/**
 * When are two contact records the same party?
 *
 * One answer, shared, because the scripts that create contacts have to agree:
 * `create-vendors.ts` refuses a vendor niko already holds, and
 * `zoho/load-contacts.ts` adopts one instead of inserting a second copy. Two
 * definitions of "same party" would mean one script creating what the other
 * would have recognised, which is the bug below all over again.
 *
 * `load-contacts.ts` used to decide what to insert from `zoho_id_map` alone: it
 * selected the Zoho ids it had loaded before and created a contact for
 * everything else. A party that reached niko by another route — the Amino
 * import, or typed in at the office — has no map row, so it looked unimported
 * and got a second copy beside the original. The 12 Oct 2026 catch-up on
 * staging did that to seven of the twelve contacts it loaded.
 *
 * Carries no database import, so `scripts/check-contact-adoption.ts` can
 * exercise every branch — the refusals included — with no connection and no
 * fixtures.
 */

/** Only the two fields matching reads; a full Zoho contact satisfies it. */
export interface MatchableContact {
  contact_name: string;
  gst_no?: string;
}

/** What matching needs to know about a contact already on file. */
export interface ExistingContact {
  id: string;
  displayName: string;
  gstin: string | null;
}

export type Decision =
  | { kind: "create" }
  | { kind: "adopt"; contact: ExistingContact; on: "GSTIN" | "name" };

export interface ExistingIndex {
  byGstin: Map<string, ExistingContact[]>;
  byShape: Map<string, ExistingContact[]>;
}

/**
 * Same party, written differently: case, punctuation, spacing, an M/S prefix.
 *
 * Spacing has to go with the rest — Zoho holds "GOYALPROTEINS LIMITED" for the
 * vendor the office typed in as "Goyal Proteins Limited", and that pair is
 * invisible to anything that compares names as written.
 */
export const squash = (s: string) =>
  s.toLowerCase().replace(/^(m\/s\.?|ms\.?)\s+/, "").replace(/[^a-z0-9]/g, "");

/** Zoho and the office both space and case GSTINs inconsistently. */
export const normGstin = (s: string | null | undefined) =>
  (s ?? "").replace(/\s+/g, "").toUpperCase() || null;

export function indexExisting(rows: ExistingContact[]): ExistingIndex {
  const byGstin = new Map<string, ExistingContact[]>();
  const byShape = new Map<string, ExistingContact[]>();
  for (const r of rows) {
    const g = normGstin(r.gstin);
    if (g) byGstin.set(g, [...(byGstin.get(g) ?? []), r]);
    const n = squash(r.displayName);
    if (n) byShape.set(n, [...(byShape.get(n) ?? []), r]);
  }
  return { byGstin, byShape };
}

/**
 * Decide whether this Zoho party (one name's worth of records, already merged
 * by the loader's same-name rule) is a contact niko holds, or a new one.
 *
 * GSTIN decides where both sides carry one — it is the one identifier here
 * registered to exactly one legal person, so it outranks the name and survives
 * a rename. A matching name shape is taken as strong on its own, because
 * typing the same party in twice is how these duplicates arise.
 *
 * Everything short of that throws. A wrong adoption puts one party's bills and
 * invoices onto another party's ledger, which is not something to settle on a
 * resemblance; the cost of stopping is a line in the output and somebody
 * looking at it.
 */
export function decideExisting(group: MatchableContact[], index: ExistingIndex): Decision {
  const label = group[0]!.contact_name.trim();

  const shapes = [...new Set(group.map((c) => squash(c.contact_name)).filter(Boolean))];
  const gstins = [
    ...new Set(group.map((c) => normGstin(c.gst_no)).filter((g): g is string => !!g)),
  ];

  // The loader's name-merge has put two registrations under one name, so the
  // merge is itself wrong and adopting either one would bury that.
  if (gstins.length > 1) {
    throw new Error(
      `${label}: the dump holds this name under ${gstins.length} different GSTINs ` +
        `(${gstins.join(", ")}). One name, two registered parties — they must not be merged. ` +
        `Give them distinct names in Zoho, then re-run.`,
    );
  }

  const gstinHits = gstins[0] ? (index.byGstin.get(gstins[0]) ?? []) : [];
  const nameHits = [
    ...new Map(shapes.flatMap((n) => index.byShape.get(n) ?? []).map((c) => [c.id, c])).values(),
  ];

  if (gstinHits.length > 1) {
    throw new Error(
      `${label}: GSTIN ${gstins[0]} is already on ${gstinHits.length} niko contacts ` +
        `(${gstinHits.map((c) => c.displayName).join(", ")}). ` +
        `Merge those first — this script will not pick one.`,
    );
  }
  if (nameHits.length > 1) {
    throw new Error(
      `${label}: niko already holds ${nameHits.length} contacts under this name ` +
        `(${nameHits.map((c) => `"${c.displayName}" [${c.id}]`).join(", ")}). ` +
        `Merge those first — this script will not pick one.`,
    );
  }

  if (gstinHits.length === 1) {
    const byGst = gstinHits[0]!;
    // Two identifiers pointing at two different contacts is not a near miss:
    // one of the three records is wrong, and guessing which would hide it.
    if (nameHits.length === 1 && nameHits[0]!.id !== byGst.id) {
      throw new Error(
        `${label}: GSTIN ${gstins[0]} matches "${byGst.displayName}" but the name matches a ` +
          `different contact ("${nameHits[0]!.displayName}" [${nameHits[0]!.id}]). ` +
          `Decide which party this is.`,
      );
    }
    return { kind: "adopt", contact: byGst, on: "GSTIN" };
  }

  if (nameHits.length === 1) {
    const byNm = nameHits[0]!;
    const theirs = normGstin(byNm.gstin);
    // Same name, two registrations: either niko's GSTIN is out of date or these
    // are two parties sharing a name. Both need a human, and they need
    // opposite answers.
    if (gstins[0] && theirs && theirs !== gstins[0]) {
      throw new Error(
        `${label}: niko's "${byNm.displayName}" is registered ${theirs}, Zoho's is ` +
          `${gstins[0]}. Either one GSTIN is out of date or these are two parties ` +
          `sharing a name — this script will not assume.`,
      );
    }
    return { kind: "adopt", contact: byNm, on: "name" };
  }

  return { kind: "create" };
}
