import { Router } from "express";
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { customFieldOptions, customFieldValues, customFields } from "@shared/schema";
import { CUSTOM_FIELD_ENTITIES, ENTITIES, LOOKUP_TARGETS } from "@shared/entities";
import { db } from "../db";
import { requirePermission } from "../lib/rbac";
import { validateBody } from "../lib/validate";
import { PostingError } from "../services/posting";
import { assertLookupTarget } from "../services/custom-fields";

export const customFieldsRouter = Router();

/** Zoho caps the org at 135; a per-entity cap is what keeps a form usable. */
const MAX_FIELDS_PER_ENTITY = 25;

const NEEDS_OPTIONS = ["dropdown", "multiselect"];

const fieldSchema = z.object({
  entity: z.enum(CUSTOM_FIELD_ENTITIES as [string, ...string[]]),
  label: z.string().min(1).max(60),
  dataType: z.enum([
    "text",
    "textarea",
    "email",
    "url",
    "phone",
    "number",
    "decimal",
    "amount",
    "percent",
    "date",
    "datetime",
    "checkbox",
    "dropdown",
    "multiselect",
    "lookup",
    "multiselect_lookup",
    "autonumber",
  ]),
  isMandatory: z.boolean().optional(),
  showInPdf: z.boolean().optional(),
  helpText: z.string().max(200).optional(),
  maxLength: z.number().int().min(1).max(5000).optional(),
  minValue: z.string().optional(),
  maxValue: z.string().optional(),
  lookupEntity: z.string().optional(),
  options: z.array(z.string().min(1).max(80)).max(100).optional(),
  numberPrefix: z.string().max(20).optional(),
  numberPadding: z.number().int().min(1).max(10).optional(),
});

/** The catalogue the settings screen renders its tabs from. */
customFieldsRouter.get("/entities", requirePermission("settings", "view"), (_req, res) => {
  res.json({
    entities: ENTITIES.filter((e) => CUSTOM_FIELD_ENTITIES.includes(e.key)),
    lookupTargets: LOOKUP_TARGETS,
    maxPerEntity: MAX_FIELDS_PER_ENTITY,
  });
});

customFieldsRouter.get("/", requirePermission("settings", "view"), async (req, res) => {
  const { entity } = req.query as Record<string, string | undefined>;
  const rows = await db
    .select()
    .from(customFields)
    .where(entity ? eq(customFields.entity, entity) : undefined)
    .orderBy(asc(customFields.entity), asc(customFields.sortOrder), asc(customFields.label));

  const options = rows.length
    ? await db.select().from(customFieldOptions).orderBy(asc(customFieldOptions.sortOrder))
    : [];
  const usage = rows.length
    ? await db
        .select({ fieldId: customFieldValues.fieldId, n: sql<number>`count(*)::int` })
        .from(customFieldValues)
        .groupBy(customFieldValues.fieldId)
    : [];
  const usageByField = new Map(usage.map((u) => [u.fieldId, Number(u.n)]));

  res.json(
    rows.map((f) => ({
      ...f,
      options: options.filter((o) => o.fieldId === f.id),
      usageCount: usageByField.get(f.id) ?? 0,
    })),
  );
});

customFieldsRouter.post(
  "/",
  requirePermission("settings", "create"),
  validateBody(fieldSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof fieldSchema>;
    try {
      if (body.dataType === "lookup" || body.dataType === "multiselect_lookup") {
        assertLookupTarget(body.lookupEntity);
      }
      if (NEEDS_OPTIONS.includes(body.dataType) && !body.options?.length) {
        throw new PostingError(`A ${body.dataType} field needs at least one choice`);
      }

      const created = await db.transaction(async (tx) => {
        const [countRow] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(customFields)
          .where(eq(customFields.entity, body.entity));
        const n = Number(countRow?.n ?? 0);
        if (n >= MAX_FIELDS_PER_ENTITY) {
          throw new PostingError(
            `${body.entity} already has ${MAX_FIELDS_PER_ENTITY} custom fields, which is the limit`,
          );
        }

        const [field] = await tx
          .insert(customFields)
          .values({
            entity: body.entity,
            label: body.label,
            dataType: body.dataType,
            isMandatory: body.isMandatory ?? false,
            showInPdf: body.showInPdf ?? false,
            helpText: body.helpText,
            maxLength: body.maxLength,
            minValue: body.minValue,
            maxValue: body.maxValue,
            lookupEntity: ["lookup", "multiselect_lookup"].includes(body.dataType)
              ? body.lookupEntity
              : null,
            numberPrefix: body.dataType === "autonumber" ? (body.numberPrefix ?? "") : null,
            numberPadding: body.numberPadding ?? 5,
            sortOrder: n,
          })
          .returning();

        if (body.options?.length) {
          await tx.insert(customFieldOptions).values(
            body.options.map((label, i) => ({ fieldId: field!.id, label, sortOrder: i })),
          );
        }
        return field!;
      });
      res.status(201).json(created);
    } catch (err) {
      if (err instanceof PostingError) return res.status(422).json({ error: err.message });
      if (err instanceof Error && err.message.includes("uq_custom_field_label")) {
        return res.status(422).json({ error: `"${body.label}" already exists on this module` });
      }
      throw err;
    }
  },
);

const patchSchema = fieldSchema
  .omit({ entity: true, dataType: true, options: true })
  .partial()
  .extend({ isActive: z.boolean().optional(), sortOrder: z.number().int().min(0).optional() });

/**
 * Label, mandatory-ness and the rest stay editable. Entity and data type do
 * not: changing the type of a field that already holds values would leave
 * those values in the wrong column with no way to read them back.
 */
customFieldsRouter.patch(
  "/:id",
  requirePermission("settings", "edit"),
  validateBody(patchSchema),
  async (req, res) => {
    try {
      const [row] = await db
        .update(customFields)
        .set(req.body)
        .where(eq(customFields.id, req.params.id!))
        .returning();
      if (!row) return res.status(404).json({ error: "Field not found" });
      res.json(row);
    } catch (err) {
      if (err instanceof Error && err.message.includes("uq_custom_field_label")) {
        return res.status(422).json({ error: "Another field on this module has that name" });
      }
      throw err;
    }
  },
);

customFieldsRouter.delete("/:id", requirePermission("settings", "delete"), async (req, res) => {
  const [used] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(customFieldValues)
    .where(eq(customFieldValues.fieldId, req.params.id!));
  const n = Number(used?.n ?? 0);
  if (n > 0) {
    return res.status(422).json({
      error: `${n} record${n === 1 ? " holds" : "s hold"} a value for this field — deactivate it instead`,
    });
  }
  const [row] = await db
    .delete(customFields)
    .where(eq(customFields.id, req.params.id!))
    .returning({ id: customFields.id });
  if (!row) return res.status(404).json({ error: "Field not found" });
  res.json({ ok: true });
});

customFieldsRouter.post(
  "/:id/options",
  requirePermission("settings", "edit"),
  validateBody(z.object({ label: z.string().min(1).max(80) })),
  async (req, res) => {
    const field = await db.query.customFields.findFirst({
      where: eq(customFields.id, req.params.id!),
    });
    if (!field) return res.status(404).json({ error: "Field not found" });
    if (!NEEDS_OPTIONS.includes(field.dataType)) {
      return res.status(422).json({ error: "This field type has no choices" });
    }
    try {
      const [row] = await db
        .insert(customFieldOptions)
        .values({ fieldId: field.id, label: req.body.label })
        .returning();
      res.status(201).json(row);
    } catch (err) {
      if (err instanceof Error && err.message.includes("uq_custom_field_option")) {
        return res.status(422).json({ error: `"${req.body.label}" is already a choice` });
      }
      throw err;
    }
  },
);

customFieldsRouter.patch(
  "/options/:optionId",
  requirePermission("settings", "edit"),
  validateBody(
    z.object({ label: z.string().min(1).max(80).optional(), isActive: z.boolean().optional() }),
  ),
  async (req, res) => {
    const [row] = await db
      .update(customFieldOptions)
      .set(req.body)
      .where(eq(customFieldOptions.id, req.params.optionId!))
      .returning();
    if (!row) return res.status(404).json({ error: "Choice not found" });
    res.json(row);
  },
);
