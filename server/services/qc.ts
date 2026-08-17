/**
 * Judging a load against the standard for its material.
 *
 * Two things stay strictly apart here, because they answer different questions
 * and rarely share a number:
 *
 *   the SPEC says whether we take it        — pass / warning / reject
 *   the RULE says what we pay for it        — how much comes off, and from where
 *
 * A load may be refused above 16% moisture but charged for above 14%. Most real
 * deliveries land in the gap, which is why the warning band exists: accepted,
 * flagged, and paid for at less than face value.
 *
 * Verdicts are computed, never taken from the operator. What an operator may do
 * is override one — with a reason and the `override` permission — and that
 * override is recorded as an override rather than dressed up as a pass.
 */
import { and, eq, inArray } from "drizzle-orm";
import { deductionRules, qcSpecParams, qcSpecs } from "@shared/schema";
import type { Db, Tx } from "../db";

export type Verdict = "pass" | "warning" | "rejected" | "no_spec";

export interface ParamVerdict {
  parameter: string;
  label: string;
  /** How the reading is expressed, so a screen labels it the way the spec does. */
  unit: string | null;
  direction: "max" | "min";
  reading: number | null;
  target: number | null;
  warnAt: number | null;
  rejectAt: number | null;
  verdict: Verdict;
  /** Written for a technician standing at the bench. */
  detail: string;
}

export interface LineVerdict {
  specId: string | null;
  specVersion: number | null;
  verdict: Verdict;
  params: ParamVerdict[];
  /** Parameters the spec requires a figure for that nobody entered. */
  missing: string[];
}

const n = (v: string | number | null | undefined) => (v == null ? null : Number(v));

/** The active spec for each of these materials, with its parameters. */
export async function loadSpecs(db: Db | Tx, itemIds: string[]) {
  if (!itemIds.length) return new Map<string, { spec: typeof qcSpecs.$inferSelect; params: (typeof qcSpecParams.$inferSelect)[] }>();
  const specs = await db
    .select()
    .from(qcSpecs)
    .where(and(inArray(qcSpecs.itemId, itemIds), eq(qcSpecs.isActive, true)));
  const params = specs.length
    ? await db
        .select()
        .from(qcSpecParams)
        .where(inArray(qcSpecParams.specId, specs.map((s) => s.id)))
    : [];
  return new Map(
    specs.map((spec) => [
      spec.itemId,
      { spec, params: params.filter((p) => p.specId === spec.id).sort((a, b) => a.sortOrder - b.sortOrder) },
    ]),
  );
}

/**
 * Judge one line's readings.
 *
 * A parameter with no reading is not a pass — it is missing. Treating an empty
 * field as acceptable is how an untested load walks through QC looking clean.
 */
export function judgeLine(
  readings: Record<string, number | null | undefined>,
  spec: { spec: { id: string; version: number }; params: (typeof qcSpecParams.$inferSelect)[] } | undefined,
): LineVerdict {
  if (!spec || !spec.params.length) {
    return {
      specId: null,
      specVersion: null,
      verdict: "no_spec",
      params: [],
      missing: [],
    };
  }

  const params: ParamVerdict[] = [];
  const missing: string[] = [];

  for (const p of spec.params) {
    const reading = n(readings[p.parameter]);
    const warnAt = n(p.warnAt);
    const rejectAt = n(p.rejectAt);
    const label = p.label ?? p.parameter;
    // The bench reads these sentences off a screen while a truck waits. A bare
    // "Moisture 15.1 is above 14" makes them check what the number is measured
    // in; carrying the unit means they never have to.
    const withUnit = (v: number) =>
      `${v.toLocaleString("en-IN", { maximumFractionDigits: 3 })}${p.unit ?? ""}`;

    if (reading == null) {
      missing.push(label);
      params.push({
        parameter: p.parameter,
        label,
        unit: p.unit,
        direction: p.direction,
        reading: null,
        target: n(p.target),
        warnAt,
        rejectAt,
        verdict: "no_spec",
        detail: `${label} not measured`,
      });
      continue;
    }

    // "max" parameters fail upwards (moisture); "min" fail downwards (protein).
    const beyond = (limit: number | null) =>
      limit == null ? false : p.direction === "max" ? reading > limit : reading < limit;

    let verdict: Verdict = "pass";
    let detail = `${label} ${withUnit(reading)} within spec`;
    if (beyond(rejectAt)) {
      verdict = "rejected";
      detail =
        p.direction === "max"
          ? `${label} ${withUnit(reading)} is over the limit of ${withUnit(rejectAt!)}`
          : `${label} ${withUnit(reading)} is under the minimum of ${withUnit(rejectAt!)}`;
    } else if (beyond(warnAt)) {
      verdict = "warning";
      detail =
        p.direction === "max"
          ? `${label} ${withUnit(reading)} is above ${withUnit(warnAt!)} but under the limit`
          : `${label} ${withUnit(reading)} is below ${withUnit(warnAt!)} but over the minimum`;
    }

    params.push({
      parameter: p.parameter,
      label,
      unit: p.unit,
      direction: p.direction,
      reading,
      target: n(p.target),
      warnAt,
      rejectAt,
      verdict,
      detail,
    });
  }

  // The worst parameter decides the line: one rejection rejects it.
  const verdict: Verdict = params.some((x) => x.verdict === "rejected")
    ? "rejected"
    : params.some((x) => x.verdict === "warning")
      ? "warning"
      : params.every((x) => x.verdict === "pass") && params.length
        ? "pass"
        : "no_spec";

  return { specId: spec.spec.id, specVersion: spec.spec.version, verdict, params, missing };
}

/**
 * The quality standard for these materials, in the one line a vendor needs.
 *
 * Text on the order rather than a link, and that is the point: a purchase order
 * is a document sent to a vendor, so the standard has to be legible on the paper
 * they were sent. A foreign key would say "whatever the spec is now", which is
 * the one thing it must not say.
 *
 * ONE FIGURE PER PARAMETER, and it is the warning threshold — the point past
 * which money starts coming off. Not the reject limit: the headroom between
 * flagged and refused is ours, and printing it invites a vendor to aim at it.
 * Not the target either, which reads as a promise nobody keeps. Everything else
 * the spec knows — bands, sample counts, what happens at the reject limit — is
 * settled in conversation, not on a page the vendor skims.
 *
 * Nothing here records the version, and it does not need to: specs are
 * versioned with effective dates and only one is ever live, so "which standard
 * applied to this order" is answerable from the order's own date.
 *
 * Returns null when nothing on the order is inspected, so no empty heading is
 * appended to an order for cement.
 */
export async function describeSpecsForOrder(
  db: Db | Tx,
  lines: Array<{ itemId?: string | null; name?: string | null }>,
): Promise<string | null> {
  const itemIds = [...new Set(lines.map((l) => l.itemId).filter((v): v is string => !!v))];
  const specs = await loadSpecs(db, itemIds);
  if (!specs.size) return null;

  const rows: string[] = [];
  // Follows the order's own lines, so the note reads down the document.
  const seen = new Set<string>();
  for (const line of lines) {
    if (!line.itemId || seen.has(line.itemId)) continue;
    seen.add(line.itemId);
    const held = specs.get(line.itemId);
    if (!held?.params.length) continue;

    const stated = held.params
      // A parameter with no warning band states its reject limit instead —
      // better the vendor sees the harder number than no number at all.
      .map((p) => ({ p, limit: p.warnAt ?? p.rejectAt }))
      .filter((x): x is { p: typeof x.p; limit: string } => x.limit != null)
      .map(({ p, limit }) => {
        const label = p.label ?? p.parameter;
        const bound = p.direction === "max" ? "Max" : "Min";
        const num = Number(limit).toLocaleString("en-IN", { maximumFractionDigits: 3 });
        return `${label} : ${bound} ${num}${p.unit ?? ""}`;
      });
    if (stated.length) rows.push(`${line.name ?? "Material"} — ${stated.join(", ")}`);
  }
  if (!rows.length) return null;
  return `Quality standard:\n${rows.join("\n")}`;
}

// ───────────────────────────── Deductions ─────────────────────────────

export interface DeductionInput {
  itemId: string | null;
  vendorId: string | null;
  /** Everything a rule might read: QC readings plus damage and shortage. */
  readings: Record<string, number | null | undefined>;
  /** Weight the deduction is charged against — the allocated net. */
  netKg: number;
  ratePerKg: number;
}

export interface ComputedDeduction {
  ruleId: string;
  ruleVersion: number;
  name: string;
  parameter: string;
  amount: number;
  /** Shown verbatim on the credit note and its journal. */
  basis: string;
}

/** Rules in force, narrowed to the material and vendor in hand. */
export async function loadDeductionRules(db: Db | Tx) {
  return db.select().from(deductionRules).where(eq(deductionRules.isActive, true));
}

/**
 * One line of English for a rule.
 *
 * Written here rather than on the screen that shows it, so the vocabulary of a
 * `basis` is described in the same file that computes it. If the arithmetic in
 * `computeDeductions` changes, the sentence next to it is impossible to miss.
 */
export function describeRule(rule: typeof deductionRules.$inferSelect): string {
  const num = (v: string | number | null | undefined) =>
    v == null ? "0" : Number(v).toLocaleString("en-IN", { maximumFractionDigits: 3 });
  const beyond =
    rule.threshold == null
      ? ""
      : ` ${rule.direction === "max" ? "over" : "under"} ${num(rule.threshold)}`;

  let sentence: string;
  switch (rule.basis) {
    case "pct_of_value":
      // excess × net × rate ÷ 100 — one point past the threshold costs 1%.
      sentence = `1% of line value for each point${beyond}`;
      break;
    case "per_point_per_kg":
      sentence = `₹${num(rule.ratePerPoint)} per kg for each point${beyond}`;
      break;
    case "shortfall_value":
      sentence = `the shortfall × the line rate, beyond ${num(rule.threshold)}`;
      break;
    case "flat":
      sentence = `a flat ₹${num(rule.flatAmount)}${beyond}`;
      break;
  }
  if (rule.minAmount != null) sentence += `, nothing under ₹${num(rule.minAmount)}`;
  return rule.scope === "vehicle" ? `${sentence} — once per truck` : sentence;
}

/**
 * What comes off this line, and why.
 *
 * A rule scoped to a material or a vendor beats a blanket one for the same
 * parameter — a maize-specific moisture rule should not be applied twice
 * alongside the general one.
 */
export function computeDeductions(
  rules: (typeof deductionRules.$inferSelect)[],
  input: DeductionInput,
): ComputedDeduction[] {
  const applicable = rules.filter(
    (r) =>
      (r.itemId == null || r.itemId === input.itemId) &&
      (r.vendorId == null || r.vendorId === input.vendorId),
  );

  // One rule per parameter: the most specific wins.
  const specificity = (r: (typeof deductionRules.$inferSelect)) =>
    (r.itemId ? 2 : 0) + (r.vendorId ? 1 : 0);
  const byParameter = new Map<string, (typeof deductionRules.$inferSelect)>();
  for (const r of applicable) {
    const held = byParameter.get(r.parameter);
    if (!held || specificity(r) > specificity(held)) byParameter.set(r.parameter, r);
  }

  const out: ComputedDeduction[] = [];
  for (const rule of byParameter.values()) {
    const reading = n(input.readings[rule.parameter]);
    if (reading == null) continue;
    const threshold = n(rule.threshold);

    // How far past the point where money starts coming off.
    const excess =
      threshold == null
        ? reading
        : rule.direction === "max"
          ? reading - threshold
          : threshold - reading;
    if (excess <= 0) continue;

    const round = (v: number) => Number(v.toFixed(2));
    const num = (v: number) => v.toLocaleString("en-IN", { maximumFractionDigits: 3 });
    let amount = 0;
    let basis = "";

    switch (rule.basis) {
      case "pct_of_value":
        amount = round((excess * input.netKg * input.ratePerKg) / 100);
        basis = `${num(excess)}% over ${num(threshold ?? 0)} × ${num(input.netKg)} kg × ₹${input.ratePerKg}/kg ÷ 100`;
        break;
      case "per_point_per_kg": {
        const perPoint = n(rule.ratePerPoint) ?? 0;
        amount = round(excess * input.netKg * perPoint);
        basis = `${num(excess)} point(s) over ${num(threshold ?? 0)} × ${num(input.netKg)} kg × ₹${perPoint}`;
        break;
      }
      case "shortfall_value":
        amount = round(excess * input.ratePerKg);
        basis = `${num(excess)} kg short × ₹${input.ratePerKg}/kg`;
        break;
      case "flat":
        amount = round(n(rule.flatAmount) ?? 0);
        basis = `flat charge, ${rule.parameter} beyond ${num(threshold ?? 0)}`;
        break;
    }

    const floor = n(rule.minAmount);
    if (amount <= 0 || (floor != null && amount < floor)) continue;

    out.push({
      ruleId: rule.id,
      ruleVersion: rule.version,
      name: rule.name,
      parameter: rule.parameter,
      amount,
      basis,
    });
  }
  return out;
}
