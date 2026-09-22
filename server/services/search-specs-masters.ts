/**
 * What the master lists — Customers, Vendors, Items — expose to the advanced
 * search.
 *
 * Kept apart from search-specs.ts because these are not documents: no lines,
 * no number, no date. What they do have is detail kept one table over — a
 * contact's people and addresses — and Zoho's dialog searches those as if they
 * were the contact's own fields, so the custom builders below reach across.
 *
 * Zoho's contact search also offers Customer Type, MSME Registered?, GST
 * treatment and place of supply. niko keeps no business/individual flag and no
 * MSME flag, and GST is out by design, so those are absent rather than present
 * and filtering nothing.
 */
import { type SQL, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { contactAddresses, contactPersons, contacts, itemCategory, items } from "@shared/schema";
import { db } from "../db";
import { contains, type DocumentSearch } from "./document-search";

/** Contacts that have at least one person matching. */
const viaPersons = (cond: SQL | undefined) =>
  inArray(contacts.id, db.select({ id: contactPersons.contactId }).from(contactPersons).where(cond));

/** "active" / "inactive", as the Status select sends it, against an is_active column. */
const activeStatus =
  (col: PgColumn) =>
  (get: (k: string) => string | undefined): SQL | undefined => {
    const v = get("status");
    if (v === "active") return eq(col, true);
    if (v === "inactive") return eq(col, false);
    return undefined;
  };

/**
 * A phone number is typed however the person remembers it — "98640 12345",
 * "+91-9864012345" — and stored however it was first entered. Once the term
 * carries digits, both sides are compared as digits alone, so spacing and the
 * country code's punctuation stop deciding whether a number is found.
 */
const phoneMatches = (col: PgColumn, term: string): SQL => {
  const digits = term.replace(/\D/g, "");
  return digits
    ? sql`regexp_replace(coalesce(${col}, ''), '[^0-9]', '', 'g') LIKE ${`%${digits}%`}`
    : ilike(col, contains(term));
};

export const contactSearch: DocumentSearch = {
  advanced: {
    displayName: { kind: "text", col: contacts.displayName },
    companyName: { kind: "text", col: contacts.companyName },
    // Zoho's First/Last Name are its contact persons'. niko keeps several per
    // contact, and a match on any of them finds the contact.
    firstName: {
      kind: "custom",
      build: (get) => {
        const v = get("firstName");
        return v ? viaPersons(ilike(contactPersons.firstName, contains(v))) : undefined;
      },
    },
    lastName: {
      kind: "custom",
      build: (get) => {
        const v = get("lastName");
        return v ? viaPersons(ilike(contactPersons.lastName, contains(v))) : undefined;
      },
    },
    // The contact's own address, or the one a person of theirs writes from.
    email: {
      kind: "custom",
      build: (get) => {
        const v = get("email");
        return v
          ? or(ilike(contacts.email, contains(v)), viaPersons(ilike(contactPersons.email, contains(v))))
          : undefined;
      },
    },
    status: { kind: "custom", build: activeStatus(contacts.isActive) },
    // Every place a number is kept: the work phone, the mobile, a person's,
    // an address's. The list's own Phone column reads three of them for the
    // same reason — no one of them is filled often enough on its own.
    phone: {
      kind: "custom",
      build: (get) => {
        const v = get("phone");
        if (!v) return undefined;
        return or(
          phoneMatches(contacts.phone, v),
          phoneMatches(contacts.mobile, v),
          viaPersons(phoneMatches(contactPersons.phone, v)),
          inArray(
            contacts.id,
            db
              .select({ id: contactAddresses.contactId })
              .from(contactAddresses)
              .where(phoneMatches(contactAddresses.phone, v)),
          ),
        );
      },
    },
    // Billing or shipping, any line of it — a town is what people remember.
    address: {
      kind: "custom",
      build: (get) => {
        const v = get("address");
        if (!v) return undefined;
        const t = contains(v);
        return inArray(
          contacts.id,
          db
            .select({ id: contactAddresses.contactId })
            .from(contactAddresses)
            .where(
              or(
                ilike(contactAddresses.attention, t),
                ilike(contactAddresses.line1, t),
                ilike(contactAddresses.line2, t),
                ilike(contactAddresses.city, t),
                ilike(contactAddresses.state, t),
                ilike(contactAddresses.pincode, t),
              ),
            ),
        );
      },
    },
    pan: { kind: "text", col: contacts.pan },
    notes: { kind: "text", col: contacts.notes },
  },
};

export const itemSearch: DocumentSearch = {
  advanced: {
    name: { kind: "text", col: items.name },
    sku: { kind: "text", col: items.sku },
    // Zoho's item has one description per side; niko keeps a general one as
    // well, and a person searching does not know which box it was typed in.
    description: {
      kind: "anyText",
      cols: [items.description, items.salesDescription, items.purchaseDescription],
    },
    rate: { kind: "numberRange", col: items.sellingPrice },
    purchaseRate: { kind: "numberRange", col: items.costPrice },
    status: { kind: "custom", build: activeStatus(items.isActive) },
    salesAccountId: { kind: "eq", col: items.salesAccountId },
    purchaseAccountId: { kind: "eq", col: items.purchaseAccountId },
    // Keyed apart from the list's own `category` view parameter, so a category
    // picked here narrows the view rather than silently replacing it.
    itemCategory: {
      kind: "custom",
      build: (get) => {
        const v = get("itemCategory");
        if (v === "none") return isNull(items.category);
        if (v && (itemCategory.enumValues as readonly string[]).includes(v)) {
          return eq(items.category, v as (typeof itemCategory.enumValues)[number]);
        }
        return undefined;
      },
    },
  },
};
