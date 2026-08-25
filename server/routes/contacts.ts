import { Router } from "express";
import { and, asc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  bills,
  contactAddresses,
  contactPersons,
  contacts,
  contactType,
  gstTreatment,
  invoices,
} from "@shared/schema";
import { db } from "../db";
import { requirePermission } from "../lib/rbac";
import { contains } from "../services/document-search";
import { gstStateCode, nonBlank, validateBody } from "../lib/validate";
import { getPreferences } from "../services/preferences";
import { readCustomFieldValues, saveCustomFieldValues } from "../services/custom-fields";
import { PostingError } from "../services/posting";

export const contactsRouter = Router();

/** Thrown inside the transaction so the insert rolls back, caught as a 422. */
class DuplicateContactError extends Error {}

const money = z.string().regex(/^-?\d+(\.\d{1,2})?$/);

const personSchema = z.object({
  salutation: z.string().max(10).optional(),
  firstName: z.string().min(1),
  lastName: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().max(20).optional(),
  isPrimary: z.boolean().optional(),
});

const addressSchema = z.object({
  kind: z.enum(["billing", "shipping"]),
  attention: z.string().optional(),
  line1: z.string().optional(),
  line2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  pincode: z.string().max(10).optional(),
  country: z.string().optional(),
  phone: z.string().max(20).optional(),
  isDefault: z.boolean().optional(),
});

/** A GST-registered treatment: the party is expected to carry a GSTIN. */
const REGISTERED_TREATMENTS = new Set([
  "registered_business",
  "registered_composition",
  "special_economic_zone",
]);

// Kept as a plain object (not the refined `contactSchema` below) so
// contactPatchSchema can still call .omit/.partial/.extend on it — those are
// ZodObject methods, unavailable once .refine() wraps a schema in ZodEffects.
const contactObjectSchema = z.object({
  type: z.enum(contactType.enumValues),
  displayName: nonBlank(),
  companyName: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().max(20).optional(),
  mobile: z.string().max(20).optional(),
  website: z.string().optional(),
  gstTreatment: z.enum(gstTreatment.enumValues).optional(),
  gstin: z
    .string()
    .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "Not a valid GSTIN")
    .optional(),
  pan: z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, "Not a valid PAN").optional(),
  placeOfSupplyState: gstStateCode.optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  creditLimit: money.optional(),
  openingBalance: money.optional(),
  notes: z.string().optional(),
  persons: z.array(personSchema).max(10).optional(),
  addresses: z.array(addressSchema).max(10).optional(),
  /** Custom field values, keyed by field id. */
  customFields: z.record(z.string(), z.any()).optional(),
});

// The cross-field GST check only makes sense where every relevant field is
// guaranteed present in the same request — creation, not a partial edit,
// where gstTreatment and gstin might be patched independently of each other
// and this schema alone can't see what the other one currently holds in the
// database.
const contactSchema = contactObjectSchema
  .refine(
    (c) => !(c.gstTreatment && REGISTERED_TREATMENTS.has(c.gstTreatment) && !c.gstin),
    { message: "A registered GST treatment needs a GSTIN", path: ["gstin"] },
  )
  .refine(
    (c) => !(c.gstTreatment && !REGISTERED_TREATMENTS.has(c.gstTreatment) && c.gstin),
    { message: "This GST treatment does not carry a GSTIN", path: ["gstin"] },
  );

// The module permission is "sales" for customers and "purchases" for vendors;
// contact routes accept either, checking against the requested type.
function moduleFor(type: string | undefined) {
  return type === "vendor" ? "purchases" : "sales";
}

/** The gradient hero strip on the Customers / Vendors lists. */
contactsRouter.get("/summary", requirePermission("sales", "view"), async (req, res) => {
  const type = (req.query.type as string | undefined) === "vendor" ? "vendor" : "customer";
  const typeCond = inArray(contacts.type, [type, "both"]);
  const notGroup = eq(contacts.isGroupCompany, false);

  const [counts] = await db
    .select({
      active: sql<number>`count(*) FILTER (WHERE ${contacts.isActive})::int`,
      newThisMonth: sql<number>`count(*) FILTER (WHERE ${contacts.createdAt} >= date_trunc('month', (now() AT TIME ZONE 'Asia/Kolkata')::date))::int`,
    })
    .from(contacts)
    .where(and(typeCond, notGroup));

  const [outstanding] =
    type === "vendor"
      ? await db
          .select({ total: sql<string>`coalesce(sum(${bills.balanceDue}), 0)` })
          .from(bills)
          .innerJoin(contacts, eq(contacts.id, bills.vendorId))
          .where(and(sql`${bills.status} NOT IN ('draft', 'void')`, notGroup))
      : await db
          .select({ total: sql<string>`coalesce(sum(${invoices.balanceDue}), 0)` })
          .from(invoices)
          .innerJoin(contacts, eq(contacts.id, invoices.customerId))
          .where(and(sql`${invoices.status} NOT IN ('draft', 'void')`, notGroup));

  res.json({
    totalOutstanding: outstanding?.total ?? "0.00",
    active: counts?.active ?? 0,
    newThisMonth: counts?.newThisMonth ?? 0,
  });
});

contactsRouter.get("/", requirePermission("sales", "view"), async (req, res) => {
  const { type, search, isActive } = req.query as Record<string, string | undefined>;
  const conditions = [];
  // A party that trades both ways belongs in both lists, so asking for
  // customers has to return it too.
  if (type === "customer" || type === "vendor") {
    conditions.push(inArray(contacts.type, [type, "both"]));
    // The group's own companies are neither customers nor vendors to the
    // market; their ledger has its own page under Accountant.
    conditions.push(eq(contacts.isGroupCompany, false));
  }
  if (isActive !== undefined) conditions.push(eq(contacts.isActive, isActive === "true"));
  if (search) {
    // contains() escapes the LIKE metacharacters, so a search for "50%" looks
    // for that text rather than matching every contact.
    const term = contains(search);
    conditions.push(
      or(
        ilike(contacts.displayName, term),
        ilike(contacts.companyName, term),
        ilike(contacts.phone, term),
        ilike(contacts.gstin, term),
      ),
    );
  }
  // The quick-search dropdown asks for a handful; the list itself takes the lot.
  const asked = Number((req.query as Record<string, string | undefined>).limit);
  const rows = await db
    .select()
    .from(contacts)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(contacts.displayName))
    .limit(Number.isFinite(asked) && asked > 0 ? asked : 500);

  // "Receivables (BCY)" for customers / "Payables (BCY)" for vendors, Zoho's list-view balance column.
  // Fetched separately and joined in JS: a correlated ${contacts.id} subquery inside .select() renders
  // as an unqualified column, which resolves to the subquery's own table instead of the outer row.
  const [receivables, payables] = await Promise.all([
    db
      .select({ customerId: invoices.customerId, total: sql<string>`SUM(${invoices.balanceDue})` })
      .from(invoices)
      .where(sql`${invoices.status} NOT IN ('draft', 'void')`)
      .groupBy(invoices.customerId),
    db
      .select({ vendorId: bills.vendorId, total: sql<string>`SUM(${bills.balanceDue})` })
      .from(bills)
      .where(sql`${bills.status} NOT IN ('draft', 'void')`)
      .groupBy(bills.vendorId),
  ]);
  const outstandingByContact = new Map<string, string>();
  for (const r of receivables) outstandingByContact.set(r.customerId, r.total);
  for (const r of payables) outstandingByContact.set(r.vendorId, r.total);

  res.json(rows.map((r) => ({ ...r, outstanding: outstandingByContact.get(r.id) ?? "0.00" })));
});

contactsRouter.get("/:id", requirePermission("sales", "view"), async (req, res) => {
  const contact = await db.query.contacts.findFirst({
    where: eq(contacts.id, req.params.id!),
  });
  if (!contact) return res.status(404).json({ error: "Contact not found" });
  const [persons, addresses] = await Promise.all([
    db.select().from(contactPersons).where(eq(contactPersons.contactId, contact.id)),
    db.select().from(contactAddresses).where(eq(contactAddresses.contactId, contact.id)),
  ]);
  const customFieldValues = await readCustomFieldValues(db, "contact", contact.id);
  res.json({ ...contact, persons, addresses, customFieldValues });
});

contactsRouter.post("/", validateBody(contactSchema), async (req, res, next) => {
  const body = req.body as z.infer<typeof contactSchema>;
  requirePermission(moduleFor(body.type), "create")(req, res, async () => {
    try {
      const result = await db.transaction(async (tx) => {
        // displayName carries no unique index, because whether duplicates are
        // allowed is an org preference rather than a schema rule.
        const prefs = await getPreferences(tx);
        if (!prefs.allowDuplicateContactNames) {
          const clash = await tx.query.contacts.findFirst({
            where: eq(contacts.displayName, body.displayName),
          });
          if (clash) {
            throw new DuplicateContactError(
              `A contact named "${body.displayName}" already exists`,
            );
          }
        }
        const { persons, addresses, customFields, ...contactData } = body;
        const [contact] = await tx.insert(contacts).values(contactData).returning();
        await saveCustomFieldValues(tx, "contact", contact!.id, customFields);
        if (persons?.length) {
          await tx
            .insert(contactPersons)
            .values(persons.map((p) => ({ ...p, contactId: contact!.id })));
        }
        if (addresses?.length) {
          await tx
            .insert(contactAddresses)
            .values(addresses.map((a) => ({ ...a, contactId: contact!.id })));
        }
        return contact!;
      });
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof DuplicateContactError || err instanceof PostingError) {
        return res.status(422).json({ error: err.message });
      }
      next(err);
    }
  });
});

const contactPatchSchema = contactObjectSchema
  .omit({ type: true })
  .partial()
  .extend({ isActive: z.boolean().optional() });

contactsRouter.patch("/:id", validateBody(contactPatchSchema), async (req, res, next) => {
  const existing = await db.query.contacts.findFirst({
    where: eq(contacts.id, req.params.id!),
    columns: { id: true, type: true },
  });
  if (!existing) return res.status(404).json({ error: "Contact not found" });
  requirePermission(moduleFor(existing.type), "edit")(req, res, async () => {
    try {
      const body = req.body as z.infer<typeof contactPatchSchema>;
      const result = await db.transaction(async (tx) => {
        const { persons, addresses, customFields, ...contactData } = body;
        await saveCustomFieldValues(tx, "contact", existing.id, customFields);
        const [updated] = await tx
          .update(contacts)
          .set({ ...contactData, updatedAt: new Date() })
          .where(eq(contacts.id, existing.id))
          .returning();
        // Full replacement semantics when arrays are provided.
        if (persons) {
          await tx.delete(contactPersons).where(eq(contactPersons.contactId, existing.id));
          if (persons.length) {
            await tx
              .insert(contactPersons)
              .values(persons.map((p) => ({ ...p, contactId: existing.id })));
          }
        }
        if (addresses) {
          await tx
            .delete(contactAddresses)
            .where(eq(contactAddresses.contactId, existing.id));
          if (addresses.length) {
            await tx
              .insert(contactAddresses)
              .values(addresses.map((a) => ({ ...a, contactId: existing.id })));
          }
        }
        return updated!;
      });
      res.json(result);
    } catch (err) {
      if (err instanceof PostingError) {
        return res.status(422).json({ error: err.message });
      }
      next(err);
    }
  });
});

/** Soft delete — Zoho "mark as inactive". Hard delete is never offered. */
contactsRouter.delete("/:id", async (req, res, next) => {
  const existing = await db.query.contacts.findFirst({
    where: eq(contacts.id, req.params.id!),
    columns: { id: true, type: true },
  });
  if (!existing) return res.status(404).json({ error: "Contact not found" });
  requirePermission(moduleFor(existing.type), "delete")(req, res, async () => {
    try {
      await db
        .update(contacts)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(contacts.id, existing.id));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });
});
