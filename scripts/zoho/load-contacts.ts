/**
 * Phase 3: customers and vendors, with their people and addresses.
 *
 *   npx tsx scripts/zoho/load-contacts.ts             # say what would happen
 *   npx tsx scripts/zoho/load-contacts.ts --commit    # do it
 *
 * Zoho keeps customers and vendors as separate lists, so a party that trades
 * both ways appears twice with no link between the halves. Here they become one
 * contact typed `both`, which is why that enum value exists: Nandamuri
 * Poultries carries a ₹6.14cr payable and a ₹6.60cr receivable at the same
 * time, and as two unrelated rows nobody can see the net position.
 *
 * The same-name rule also catches records duplicated within one type — the two
 * "Baijnath Mukhiya" vendors that differ only in capitalisation. Those collapse
 * to a single vendor, which is what they always were.
 *
 * Both Zoho ids point at the merged row in zoho_id_map, so every document still
 * resolves, whichever record it named.
 *
 * A party niko already holds is adopted, not duplicated. Deciding what to
 * insert from `zoho_id_map` alone is not enough: a contact that arrived by
 * another route — the Amino import, or typed in at the office — has no map row,
 * so it looks unimported and a second copy gets created beside it. That is what
 * the 12 Oct 2026 catch-up did on staging to seven of the twelve contacts it
 * loaded. So before inserting, each party is looked for among the contacts
 * already on file: a shared GSTIN settles it, and a matching name shape is
 * strong enough on its own. Where the evidence is ambiguous or
 * self-contradictory the run stops and says why, because a wrong pairing posts
 * somebody's bills to the wrong ledger — see `decideExisting` in
 * `scripts/contact-identity.ts`, which `create-vendors.ts` shares.
 */
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { contactAddresses, contactPersons, contacts, zohoIdMap } from "@shared/schema";
import { db, pool } from "../../server/db";
import { toGstStateCode } from "@shared/gst-states";
import { decideExisting, indexExisting, type Decision } from "../contact-identity";

/** Zoho's GST treatment vocabulary onto niko's. */
const GST_TREATMENT: Record<string, string> = {
  business_gst: "registered_business",
  business_registered_composition: "registered_composition",
  business_none: "unregistered_business",
  consumer: "consumer",
  overseas: "overseas",
  business_sez: "special_economic_zone",
};

/** Treatments that say "this party is not GST-registered". */
const UNREGISTERED = new Set(["consumer", "unregistered_business"]);
const registered = (t: string | null | undefined) => !!t && !UNREGISTERED.has(t);

interface ZohoAddress {
  attention?: string;
  address?: string;
  street2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  phone?: string;
}

interface ZohoContact {
  contact_id: string;
  contact_name: string;
  company_name?: string;
  contact_type: string;
  status: string;
  email?: string;
  phone?: string;
  mobile?: string;
  website?: string;
  gst_treatment?: string;
  gst_no?: string;
  pan_no?: string;
  place_of_contact?: string;
  payment_terms?: number;
  notes?: string;
  billing_address?: ZohoAddress;
  shipping_address?: ZohoAddress;
  contact_persons?: Array<{
    salutation?: string;
    first_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
    mobile?: string;
    is_primary_contact?: boolean;
  }>;
}

const clean = (v: string | undefined | null, max?: number) => {
  const s = (v ?? "").trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
};

const hasAddress = (a?: ZohoAddress) =>
  !!(a && (a.address || a.city || a.state || a.zip || a.attention));

async function main() {
  const commit = process.argv.includes("--commit");
  // --dir: read another folder of Zoho detail, the same option the invoice,
  // bill and payment loaders take. A catch-up run needs the handful of
  // contacts created since the first load before the documents that use them.
  const dirAt = process.argv.indexOf("--dir");
  const dir = dirAt > -1 ? process.argv[dirAt + 1]! : ".zoho-dump/detail";
  const raw = await readFile(`${dir}/contacts.jsonl`, "utf8");
  const all: ZohoContact[] = raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

  const unknownTreatment = [
    ...new Set(all.map((c) => c.gst_treatment).filter((t) => t && !GST_TREATMENT[t])),
  ];
  if (unknownTreatment.length) {
    throw new Error(`GST treatments with no niko equivalent: ${unknownTreatment.join(", ")}`);
  }

  const done = await db
    .select({ zohoId: zohoIdMap.zohoId })
    .from(zohoIdMap)
    .where(eq(zohoIdMap.entity, "contact"));
  const already = new Set(done.map((d) => d.zohoId));

  // One niko contact per name, however many Zoho records carry it.
  const groups = new Map<string, ZohoContact[]>();
  for (const c of all) {
    const key = c.contact_name.trim().toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  // A group is outstanding only if none of its ids has been imported; a
  // partially imported group would mean an earlier run was interrupted between
  // the contact and its second id-map row, which the transaction prevents.
  const todo = [...groups.values()].filter((g) => !g.some((c) => already.has(c.contact_id)));
  const merges = [...groups.values()].filter((g) => g.length > 1);

  // Every contact on file, whatever brought it here. Rows that already carry a
  // Zoho id are candidates too: a second Zoho record for a party imported
  // earlier is the same merge this script does within one dump, and pointing
  // the new id at the existing contact is what makes its documents resolve.
  const existingRows = await db
    .select({
      id: contacts.id,
      displayName: contacts.displayName,
      type: contacts.type,
      gstin: contacts.gstin,
      gstTreatment: contacts.gstTreatment,
      companyName: contacts.companyName,
      email: contacts.email,
      phone: contacts.phone,
      mobile: contacts.mobile,
      website: contacts.website,
      pan: contacts.pan,
      placeOfSupplyState: contacts.placeOfSupplyState,
      notes: contacts.notes,
    })
    .from(contacts);
  const fullById = new Map(existingRows.map((r) => [r.id, r]));
  const index = indexExisting(existingRows);

  const decisions = new Map<ZohoContact[], Decision>();
  for (const group of todo) decisions.set(group, decideExisting(group, index));

  // Two parties in one dump claiming the same niko contact: the dump says they
  // are different (different names) and the match says they are the same.
  const claimed = new Map<string, ZohoContact[]>();
  for (const [group, d] of decisions) {
    if (d.kind !== "adopt") continue;
    const prior = claimed.get(d.contact.id);
    if (prior) {
      throw new Error(
        `"${prior[0]!.contact_name.trim()}" and "${group[0]!.contact_name.trim()}" both match ` +
          `niko contact ${d.contact.id} ("${d.contact.displayName}"). ` +
          `They cannot both be it — fix the dump, or merge in niko.`,
      );
    }
    claimed.set(d.contact.id, group);
  }

  const adopting = [...decisions.entries()].filter(([, d]) => d.kind === "adopt");
  const creating = [...decisions.entries()].filter(([, d]) => d.kind === "create");

  const customers = all.filter((c) => c.contact_type === "customer").length;
  console.log(`${all.length} Zoho contacts — ${customers} customers, ${all.length - customers} vendors`);
  console.log(`  ${groups.size} distinct names -> ${todo.length} parties not yet mapped`);
  console.log(`      ${creating.length} to create, ${adopting.length} already on file in niko`);
  console.log(`  ${already.size} Zoho ids already imported`);
  console.log(`  ${all.filter((c) => c.contact_persons?.length).length} have contact persons`);
  console.log(`  ${all.filter((c) => hasAddress(c.billing_address)).length} have a billing address`);
  console.log(`  ${all.filter((c) => c.gst_no).length} have a GSTIN, ${all.filter((c) => c.pan_no).length} a PAN`);

  if (merges.length) {
    console.log(`\n  ${merges.length} name(s) held as more than one Zoho record, merging:`);
    for (const g of merges) {
      const kinds = [...new Set(g.map((c) => c.contact_type))];
      console.log(
        `    ${g[0]!.contact_name}  (${g.length} records, ${kinds.join(" + ")})` +
          ` -> ${kinds.length > 1 ? "both" : kinds[0]}`,
      );
    }
  }

  if (adopting.length) {
    console.log(
      `\n  ${adopting.length} party(ies) niko already holds — Zoho's id goes onto the existing` +
        ` contact rather than a second copy:`,
    );
    for (const [group, d] of adopting) {
      const adopt = d as Extract<Decision, { kind: "adopt" }>;
      console.log(
        `    ${group[0]!.contact_name.trim()}  ->  ${adopt.contact.id}` +
          `  ("${adopt.contact.displayName}", matched on ${adopt.on})`,
      );
    }
  }

  if (!commit) {
    console.log("\nDry run — nothing written. Re-run with --commit to apply.");
    await pool.end();
    return;
  }

  let people = 0;
  let addresses = 0;
  let adopted = 0;
  let widened = 0;
  let filled = 0;

  await db.transaction(async (tx) => {
    for (const group of todo) {
      const decision = decisions.get(group)!;
      const kinds = new Set(group.map((g) => g.contact_type));
      const type = kinds.size > 1 ? "both" : kinds.has("customer") ? "customer" : "vendor";

      // Merged records are the same party, so any field only one of them
      // filled in is still true of the whole. Take the first non-empty value
      // for each rather than letting an arbitrary winner blank out real data.
      const first = <K extends keyof ZohoContact>(key: K) =>
        group.map((g) => g[key]).find((v) => v != null && String(v).trim() !== "");

      const fromZoho = {
        companyName: clean(first("company_name") as string),
        email: clean(first("email") as string),
        phone: clean(first("phone") as string),
        mobile: clean(first("mobile") as string),
        website: clean(first("website") as string),
        gstTreatment: (GST_TREATMENT[(first("gst_treatment") as string) ?? ""] ??
          "unregistered_business") as typeof contacts.$inferInsert.gstTreatment,
        gstin: clean(first("gst_no") as string, 15),
        pan: clean(first("pan_no") as string, 10),
        placeOfSupplyState: toGstStateCode(clean(first("place_of_contact") as string, 4) ?? "") || null,
        notes: clean(first("notes") as string),
      };

      let contactId: string;

      if (decision.kind === "adopt") {
        const mine = fullById.get(decision.contact.id)!;
        contactId = mine.id;
        adopted += 1;

        const patch: Record<string, unknown> = {};

        // Widened, never narrowed: a contact niko knows as a customer that
        // Zoho also bills as a vendor is both, and leaving it customer-only
        // would hide real payables from every vendor-scoped list.
        if (mine.type !== "both" && mine.type !== type) {
          patch.type = "both";
          widened += 1;
          console.log(`  ${mine.displayName}: type ${mine.type} -> both`);
        }

        // Blanks only. The row on file is niko's own and may be deliberately
        // maintained — vendor bank details come off the office's sheet, not
        // from Zoho — so nothing that already holds a value is touched.
        for (const key of [
          "companyName", "email", "phone", "mobile", "website",
          "gstin", "pan", "placeOfSupplyState", "notes",
        ] as const) {
          const theirs = fromZoho[key];
          if (theirs != null && !mine[key]) {
            patch[key] = theirs;
            filled += 1;
            console.log(`  ${mine.displayName}: ${key} was blank, took "${theirs}" from Zoho`);
          }
        }
        // A GSTIN on a row still marked unregistered contradicts itself, so
        // the registration status comes across with it.
        if (patch.gstin && !registered(mine.gstTreatment) && registered(fromZoho.gstTreatment)) {
          patch.gstTreatment = fromZoho.gstTreatment;
          console.log(`  ${mine.displayName}: gstTreatment ${mine.gstTreatment} -> ${fromZoho.gstTreatment}`);
        }

        if (Object.keys(patch).length) {
          await tx
            .update(contacts)
            .set({ ...patch, updatedAt: new Date() })
            .where(eq(contacts.id, contactId));
        }
      } else {
        const [row] = await tx
          .insert(contacts)
          .values({
            type,
            // Longest spelling wins, so "NANDAMURI POULTRIES LLP" does not beat
            // the properly cased version on a coin toss.
            displayName: group
              .map((g) => g.contact_name.trim())
              .sort((a, b) => b.length - a.length || a.localeCompare(b))[0]!,
            ...fromZoho,
            paymentTermsDays: Number(first("payment_terms") ?? 0),
            // Left at zero deliberately: no contact in this org carries a Zoho
            // opening balance, and the whole document history is being imported,
            // so anything here would double-count against the invoices and bills.
            openingBalance: "0",
            isActive: group.some((g) => g.status === "active"),
          })
          .returning({ id: contacts.id });
        contactId = row!.id;
      }

      // Every Zoho id points at the one row, so a document naming either half
      // still resolves.
      for (const g of group) {
        await tx.insert(zohoIdMap).values({
          entity: "contact",
          zohoId: g.contact_id,
          eggsyId: contactId,
          label: `${g.contact_type}: ${g.contact_name}`,
        });
      }

      // On an adopted contact the people already on file were entered by
      // somebody at the office; add only the ones that are missing.
      const seenPeople = new Set<string>();
      if (decision.kind === "adopt") {
        const held = await tx
          .select({
            firstName: contactPersons.firstName,
            lastName: contactPersons.lastName,
            email: contactPersons.email,
          })
          .from(contactPersons)
          .where(eq(contactPersons.contactId, contactId));
        for (const p of held) {
          seenPeople.add(`${p.firstName}|${p.lastName ?? ""}|${p.email ?? ""}`.toLowerCase());
        }
      }
      for (const p of group.flatMap((g) => g.contact_persons ?? [])) {
        const firstName = clean(p.first_name) ?? clean(p.last_name);
        if (!firstName) continue; // niko requires a first name; a nameless row says nothing.
        // Merged records often list the same person twice.
        const key = `${firstName}|${p.last_name ?? ""}|${p.email ?? ""}`.toLowerCase();
        if (seenPeople.has(key)) continue;
        seenPeople.add(key);
        await tx.insert(contactPersons).values({
          contactId,
          salutation: clean(p.salutation, 10),
          firstName,
          lastName: clean(p.last_name),
          email: clean(p.email),
          phone: clean(p.phone) ?? clean(p.mobile),
          isPrimary: Boolean(p.is_primary_contact),
        });
        people += 1;
      }

      // Only the first record's addresses: two halves of the same party share
      // an address, and a second identical billing address is noise. On an
      // adopted contact the address on file is the one the office uses.
      const heldKinds = new Set<string>();
      if (decision.kind === "adopt") {
        const held = await tx
          .select({ kind: contactAddresses.kind })
          .from(contactAddresses)
          .where(eq(contactAddresses.contactId, contactId));
        for (const a of held) heldKinds.add(a.kind);
      }
      const base = group[0]!;
      for (const [kind, a] of [
        ["billing", base.billing_address],
        ["shipping", base.shipping_address],
      ] as const) {
        if (!hasAddress(a)) continue;
        if (heldKinds.has(kind)) continue;
        await tx.insert(contactAddresses).values({
          contactId,
          kind,
          attention: clean(a!.attention),
          line1: clean(a!.address),
          line2: clean(a!.street2),
          city: clean(a!.city),
          state: clean(a!.state),
          pincode: clean(a!.zip, 10),
          country: clean(a!.country) ?? "India",
          phone: clean(a!.phone),
          isDefault: kind === "billing",
        });
        addresses += 1;
      }
    }
  });

  console.log(
    `\nCommitted ${creating.length} new contacts, ${adopted} mapped onto contacts already on` +
      ` file (${widened} widened to both, ${filled} blank field(s) filled),` +
      ` ${people} contact persons, ${addresses} addresses.`,
  );
  await pool.end();
}

main().catch(async (err) => {
  console.error(`\n${err.message}`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
