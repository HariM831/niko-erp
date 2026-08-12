import { Router } from "express";
import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
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
import { validateBody } from "../lib/validate";

export const contactsRouter = Router();

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

const contactSchema = z.object({
  type: z.enum(contactType.enumValues),
  displayName: z.string().min(1),
  companyName: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().max(20).optional(),
  mobile: z.string().max(20).optional(),
  website: z.string().optional(),
  gstTreatment: z.enum(gstTreatment.enumValues).optional(),
  gstin: z.string().length(15).optional(),
  pan: z.string().length(10).optional(),
  placeOfSupplyState: z.string().max(4).optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  creditLimit: money.optional(),
  openingBalance: money.optional(),
  notes: z.string().optional(),
  persons: z.array(personSchema).max(10).optional(),
  addresses: z.array(addressSchema).max(10).optional(),
});

// The module permission is "sales" for customers and "purchases" for vendors;
// contact routes accept either, checking against the requested type.
function moduleFor(type: string | undefined) {
  return type === "vendor" ? "purchases" : "sales";
}

contactsRouter.get("/", requirePermission("sales", "view"), async (req, res) => {
  const { type, search, isActive } = req.query as Record<string, string | undefined>;
  const conditions = [];
  if (type === "customer" || type === "vendor") {
    conditions.push(eq(contacts.type, type));
  }
  if (isActive !== undefined) conditions.push(eq(contacts.isActive, isActive === "true"));
  if (search) {
    conditions.push(
      or(
        ilike(contacts.displayName, `%${search}%`),
        ilike(contacts.companyName, `%${search}%`),
        ilike(contacts.phone, `%${search}%`),
        ilike(contacts.gstin, `%${search}%`),
      ),
    );
  }
  const rows = await db
    .select()
    .from(contacts)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(contacts.displayName))
    .limit(500);

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
  res.json({ ...contact, persons, addresses });
});

contactsRouter.post("/", validateBody(contactSchema), async (req, res, next) => {
  const body = req.body as z.infer<typeof contactSchema>;
  requirePermission(moduleFor(body.type), "create")(req, res, async () => {
    try {
      const result = await db.transaction(async (tx) => {
        const { persons, addresses, ...contactData } = body;
        const [contact] = await tx.insert(contacts).values(contactData).returning();
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
      next(err);
    }
  });
});

const contactPatchSchema = contactSchema
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
        const { persons, addresses, ...contactData } = body;
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
