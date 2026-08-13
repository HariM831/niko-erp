import { and, asc, eq, inArray } from "drizzle-orm";
import {
  accounts,
  contacts,
  customFieldOptions,
  customFieldValueOptions,
  customFieldValues,
  customFields,
  items,
  locations,
} from "@shared/schema";
import { LOOKUP_TARGETS, isEntity } from "@shared/entities";
import type { Db, Tx } from "../db";
import { PostingError } from "./posting";

export type CustomField = typeof customFields.$inferSelect;

/** What a caller submits: field id → value, shaped by the field's data type. */
export type CustomFieldInput = Record<string, unknown>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/\S+$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Active field definitions for an entity, in display order. */
export async function fieldsFor(tx: Db | Tx, entity: string): Promise<CustomField[]> {
  return tx
    .select()
    .from(customFields)
    .where(and(eq(customFields.entity, entity), eq(customFields.isActive, true)))
    .orderBy(asc(customFields.sortOrder), asc(customFields.label));
}

/**
 * Validate and persist a record's custom field values, replacing whatever was
 * there. Runs inside the document's own transaction, so a bad value rolls the
 * whole document back rather than leaving it half-saved.
 *
 * `input` absent means "not submitted" and leaves existing values alone; an
 * empty object means "clear them".
 */
export async function saveCustomFieldValues(
  tx: Tx,
  entity: string,
  entityId: string,
  input: CustomFieldInput | undefined,
): Promise<void> {
  if (input === undefined) return;
  const defs = await fieldsFor(tx, entity);
  if (!defs.length && !Object.keys(input).length) return;

  const optionRows = defs.length
    ? await tx
        .select()
        .from(customFieldOptions)
        .where(
          inArray(
            customFieldOptions.fieldId,
            defs.map((d) => d.id),
          ),
        )
    : [];
  const optionsByField = new Map<string, typeof optionRows>();
  for (const o of optionRows) {
    const list = optionsByField.get(o.fieldId) ?? [];
    list.push(o);
    optionsByField.set(o.fieldId, list);
  }

  // Wipe first: replacement semantics keep "cleared" and "never set" the same.
  const existing = await tx
    .select({ id: customFieldValues.id })
    .from(customFieldValues)
    .where(eq(customFieldValues.entityId, entityId));
  if (existing.length) {
    await tx.delete(customFieldValues).where(eq(customFieldValues.entityId, entityId));
  }

  for (const def of defs) {
    const raw = input[def.id];
    const empty =
      raw === undefined ||
      raw === null ||
      raw === "" ||
      (Array.isArray(raw) && raw.length === 0);

    if (empty) {
      if (def.isMandatory) throw new PostingError(`"${def.label}" is required`);
      continue;
    }

    const row = await buildValueRow(tx, def, raw, optionsByField.get(def.id) ?? []);
    const [saved] = await tx
      .insert(customFieldValues)
      .values({ fieldId: def.id, entityId, ...row.columns })
      .returning({ id: customFieldValues.id });

    if (row.optionIds?.length) {
      await tx
        .insert(customFieldValueOptions)
        .values(row.optionIds.map((optionId) => ({ valueId: saved!.id, optionId })));
    }
  }
}

/** Coerce and check one value against its definition. */
async function buildValueRow(
  tx: Tx,
  def: CustomField,
  raw: unknown,
  options: Array<typeof customFieldOptions.$inferSelect>,
): Promise<{ columns: Record<string, unknown>; optionIds?: string[] }> {
  const asText = () => {
    const v = String(raw);
    if (def.maxLength && v.length > def.maxLength) {
      throw new PostingError(`"${def.label}" is longer than ${def.maxLength} characters`);
    }
    return v;
  };

  const asNumber = () => {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new PostingError(`"${def.label}" must be a number`);
    if (def.minValue !== null && n < Number(def.minValue)) {
      throw new PostingError(`"${def.label}" must be at least ${def.minValue}`);
    }
    if (def.maxValue !== null && n > Number(def.maxValue)) {
      throw new PostingError(`"${def.label}" must be at most ${def.maxValue}`);
    }
    return n;
  };

  switch (def.dataType) {
    case "text":
    case "textarea":
    case "phone":
      return { columns: { valueText: asText() } };

    case "email": {
      const v = asText();
      if (!EMAIL.test(v)) throw new PostingError(`"${def.label}" must be an email address`);
      return { columns: { valueText: v } };
    }

    case "url": {
      const v = asText();
      if (!URL_RE.test(v)) throw new PostingError(`"${def.label}" must be a URL`);
      return { columns: { valueText: v } };
    }

    case "number": {
      const n = asNumber();
      if (!Number.isInteger(n)) throw new PostingError(`"${def.label}" must be a whole number`);
      return { columns: { valueNumber: String(n) } };
    }

    case "decimal":
    case "amount":
    case "percent": {
      const n = asNumber();
      if (def.dataType === "percent" && (n < 0 || n > 100)) {
        throw new PostingError(`"${def.label}" must be between 0 and 100`);
      }
      return { columns: { valueNumber: n.toFixed(4) } };
    }

    case "date": {
      const v = String(raw);
      if (!DATE_RE.test(v)) throw new PostingError(`"${def.label}" must be a date`);
      return { columns: { valueDate: v } };
    }

    case "datetime": {
      const d = new Date(String(raw));
      if (Number.isNaN(d.getTime())) throw new PostingError(`"${def.label}" must be a date and time`);
      return { columns: { valueTimestamp: d } };
    }

    case "checkbox":
      return { columns: { valueBool: raw === true || raw === "true" } };

    case "dropdown": {
      const option = options.find((o) => o.id === raw);
      if (!option) throw new PostingError(`"${def.label}" has no such choice`);
      if (!option.isActive) {
        throw new PostingError(`"${option.label}" is no longer available for "${def.label}"`);
      }
      return { columns: { optionId: option.id } };
    }

    case "multiselect": {
      const ids = Array.isArray(raw) ? raw.map(String) : [String(raw)];
      const chosen = ids.map((id) => {
        const option = options.find((o) => o.id === id);
        if (!option) throw new PostingError(`"${def.label}" has no such choice`);
        if (!option.isActive) {
          throw new PostingError(`"${option.label}" is no longer available for "${def.label}"`);
        }
        return option.id;
      });
      return { columns: {}, optionIds: [...new Set(chosen)] };
    }

    case "lookup": {
      const targetId = String(raw);
      const exists = await lookupExists(tx, def.lookupEntity, targetId);
      if (!exists) throw new PostingError(`"${def.label}" points at a record that no longer exists`);
      return { columns: { valueLookupId: targetId } };
    }

    default:
      throw new PostingError(`Unsupported field type on "${def.label}"`);
  }
}

/** Lookup targets are master data, each with its own table and label column. */
const LOOKUP_TABLES = {
  contact: { table: contacts, id: contacts.id, label: contacts.displayName },
  item: { table: items, id: items.id, label: items.name },
  location: { table: locations, id: locations.id, label: locations.name },
  account: { table: accounts, id: accounts.id, label: accounts.name },
} as const;

async function lookupExists(tx: Tx, entity: string | null, id: string): Promise<boolean> {
  const target = entity ? LOOKUP_TABLES[entity as keyof typeof LOOKUP_TABLES] : undefined;
  if (!target) return false;
  const [row] = await tx.select({ id: target.id }).from(target.table).where(eq(target.id, id)).limit(1);
  return !!row;
}

export interface ResolvedValue {
  fieldId: string;
  label: string;
  dataType: string;
  showInPdf: boolean;
  /** Ready to display. */
  display: string;
  /** Ready to put back in a form. */
  raw: unknown;
}

/**
 * A record's custom field values, resolved for display — lookups turned into
 * names, options into labels. Returns fields in definition order so a document
 * shows them the same way every time.
 */
export async function readCustomFieldValues(
  tx: Db | Tx,
  entity: string,
  entityId: string,
): Promise<ResolvedValue[]> {
  const defs = await fieldsFor(tx, entity);
  if (!defs.length) return [];

  const values = await tx
    .select()
    .from(customFieldValues)
    .where(eq(customFieldValues.entityId, entityId));
  if (!values.length) return [];
  const byField = new Map(values.map((v) => [v.fieldId, v]));

  const multi = await tx
    .select({
      valueId: customFieldValueOptions.valueId,
      optionId: customFieldOptions.id,
      label: customFieldOptions.label,
    })
    .from(customFieldValueOptions)
    .innerJoin(customFieldOptions, eq(customFieldOptions.id, customFieldValueOptions.optionId))
    .where(
      inArray(
        customFieldValueOptions.valueId,
        values.map((v) => v.id),
      ),
    );

  const singleOptionIds = values.map((v) => v.optionId).filter((v): v is string => !!v);
  const singleOptions = singleOptionIds.length
    ? await tx
        .select({ id: customFieldOptions.id, label: customFieldOptions.label })
        .from(customFieldOptions)
        .where(inArray(customFieldOptions.id, singleOptionIds))
    : [];

  const out: ResolvedValue[] = [];
  for (const def of defs) {
    const v = byField.get(def.id);
    if (!v) continue;
    const base = {
      fieldId: def.id,
      label: def.label,
      dataType: def.dataType,
      showInPdf: def.showInPdf,
    };

    if (def.dataType === "multiselect") {
      const picks = multi.filter((m) => m.valueId === v.id);
      if (!picks.length) continue;
      out.push({
        ...base,
        display: picks.map((p) => p.label).join(", "),
        raw: picks.map((p) => p.optionId),
      });
    } else if (def.dataType === "dropdown") {
      const option = singleOptions.find((o) => o.id === v.optionId);
      out.push({ ...base, display: option?.label ?? "—", raw: v.optionId });
    } else if (def.dataType === "lookup") {
      const name = await lookupLabel(tx, def.lookupEntity, v.valueLookupId);
      out.push({ ...base, display: name, raw: v.valueLookupId });
    } else if (def.dataType === "checkbox") {
      out.push({ ...base, display: v.valueBool ? "Yes" : "No", raw: !!v.valueBool });
    } else if (v.valueNumber !== null) {
      const n = Number(v.valueNumber);
      const display = def.dataType === "percent" ? `${n}%` : String(n);
      out.push({ ...base, display, raw: n });
    } else if (v.valueDate) {
      out.push({ ...base, display: v.valueDate, raw: v.valueDate });
    } else if (v.valueTimestamp) {
      out.push({ ...base, display: v.valueTimestamp.toISOString(), raw: v.valueTimestamp.toISOString() });
    } else {
      out.push({ ...base, display: v.valueText ?? "", raw: v.valueText });
    }
  }
  return out;
}

async function lookupLabel(
  tx: Db | Tx,
  entity: string | null,
  id: string | null,
): Promise<string> {
  const target = entity ? LOOKUP_TABLES[entity as keyof typeof LOOKUP_TABLES] : undefined;
  if (!target || !id) return "—";
  const [row] = await tx
    .select({ label: target.label })
    .from(target.table)
    .where(eq(target.id, id))
    .limit(1);
  // Soft deletes mean this is rare, but a hard-deleted target must not crash
  // the document it was referenced from.
  return row?.label ?? "(deleted)";
}

/** Guard used by the definition routes. */
export function assertLookupTarget(entity: string | null | undefined): void {
  if (!entity || !isEntity(entity) || !LOOKUP_TARGETS.includes(entity)) {
    throw new PostingError(
      `A lookup field must point at one of: ${LOOKUP_TARGETS.join(", ")}`,
    );
  }
}
