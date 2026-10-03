/**
 * NIR scans — taking them in from the bench, and working out which truck each
 * one belongs to.
 *
 * The technician types the GR number as the IAS sample name. That is the whole
 * link, and it is typed by hand, so a scan attaches to a receipt line only
 * when everything else agrees as well:
 *
 *   - the folded sample name is the receipt's number;
 *   - the receipt is still waiting on QC;
 *   - the scan was taken after the truck arrived;
 *   - the scan's calibration model is linked to the material on exactly one
 *     of the receipt's lines.
 *
 * Anything short of that is left unplaced, with the reason, for the bench to
 * see. A scan is never forced onto a line, because a wrong attachment would
 * pass QC looking exactly like a right one.
 *
 * The match is NOT stored when a scan arrives. IAS lets a sample be renamed
 * after the scan, and a truck can be scanned before its gross weight is
 * keyed in, so the answer is worked out each time QC asks. Committing QC is
 * what fixes it (`nir_results.receipt_line_id`).
 */
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import {
  items,
  nirModelItems,
  nirModels,
  nirResults,
  officeReceiptLines,
  officeReceipts,
  type NirResult,
} from "@shared/schema";
import { type NirUploadModel, type NirUploadRow, asReceived, dryMatterBase, qcParameterFor, sampleKey } from "@shared/nir";
import type { Db, Tx } from "../db";

/** A bench PC clock a little ahead of the server is not a reason to refuse a scan. */
const CLOCK_SLACK_MS = 30 * 60_000;

/** What QC accepts: the receipt is waiting at Station 3, or will be in a moment. */
const OPEN_FOR_QC = new Set(["gate_in", "weighed_in"]);

// ───────────────────────────────── Ingest ─────────────────────────────────

export async function ingest(
  db: Db | Tx,
  rows: NirUploadRow[],
  models: NirUploadModel[],
  deviceSn: string | null,
  userId: string,
): Promise<{ received: number; stored: number }> {
  for (const m of models) {
    await db
      .insert(nirModels)
      .values({
        shortName: m.shortName,
        modelName: m.modelName,
        version: m.version,
        matterNames: m.matterNames,
        deviceSn,
      })
      .onConflictDoUpdate({
        target: nirModels.shortName,
        set: {
          modelName: m.modelName,
          version: m.version,
          matterNames: m.matterNames,
          deviceSn,
          updatedAt: new Date(),
        },
      });
  }

  let stored = 0;
  for (const r of rows) {
    const values = {
      iasId: r.iasId,
      deviceSn: r.deviceSn,
      model: r.model,
      modelVersion: r.modelVersion,
      sampleName: r.sampleName,
      sampleKey: sampleKey(r.sampleName),
      scannedAt: new Date(r.scannedAt),
      iasStatus: r.iasStatus,
      readings: r.readings,
      flags: r.flags,
      raw: r.raw,
    };
    const out = await db
      .insert(nirResults)
      .values({ resultSn: r.resultSn, uploadedBy: userId, ...values })
      .onConflictDoUpdate({
        target: nirResults.resultSn,
        set: { ...values, updatedAt: new Date() },
        // A scan QC has already used stays as it was used. Renaming it in IAS
        // afterwards must not quietly move a committed reading to another truck.
        setWhere: isNull(nirResults.receiptLineId),
      })
      .returning({ id: nirResults.id });
    stored += out.length;
  }
  return { received: rows.length, stored };
}

// ───────────────────────────────── Placing ────────────────────────────────

export interface ScanView {
  resultSn: string;
  model: string;
  sampleName: string | null;
  scannedAt: string;
  /** The instrument's names and figures, all of them. */
  readings: Record<string, number>;
  /** Instrument names the analyser flagged. */
  flagged: string[];
}

export interface LineNir {
  scans: ScanView[];
  /** Average across the scans, keyed by QC parameter, as received, to 3 places. */
  average: Record<string, number>;
  /** Every reading averaged as the instrument reported it, starch and all. */
  instrument: Record<string, number>;
  /** QC parameters at least one scan was flagged on by the instrument. */
  flagged: string[];
  /** QC parameters the model reports on dry matter, converted with each scan's moisture. */
  fromDryMatter: string[];
}

export interface Unplaced {
  scan: ScanView;
  /** The receipt the sample name pointed at, when it pointed at one. */
  receiptNumber: string | null;
  reason: string;
}

type ReceiptLite = { id: string; number: string; status: string; arrivalAt: Date };
type LineLite = { id: string; receiptId: string; itemId: string | null; itemName: string | null; status: string };

function view(r: NirResult): ScanView {
  const flags = (r.flags ?? {}) as Record<string, number>;
  return {
    resultSn: r.resultSn,
    model: r.model,
    sampleName: r.sampleName,
    scannedAt: r.scannedAt.toISOString(),
    readings: (r.readings ?? {}) as Record<string, number>,
    flagged: Object.entries(flags)
      .filter(([, c]) => Number(c) !== 0)
      .map(([n]) => n),
  };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

const add = (m: Map<string, { total: number; n: number }>, k: string, v: number) => {
  const acc = m.get(k) ?? { total: 0, n: 0 };
  acc.total += v;
  acc.n += 1;
  m.set(k, acc);
};
const means = (m: Map<string, { total: number; n: number }>) =>
  Object.fromEntries([...m].map(([k, { total, n }]) => [k, round3(total / n)]));

/**
 * Average the scans on one line into QC parameters, as received.
 *
 * A dry-matter reading is converted scan by scan with that scan's own
 * moisture, then averaged — the sample that was wetter is discounted by its
 * own water, not by the average's. A dry-matter reading on a scan with no
 * moisture cannot be converted and fills nothing.
 */
export function averageScans(scans: ScanView[]): LineNir {
  const sums = new Map<string, { total: number; n: number }>();
  const raw = new Map<string, { total: number; n: number }>();
  const flagged = new Set<string>();
  const fromDryMatter = new Set<string>();
  for (const s of scans) {
    const moistureName = Object.keys(s.readings).find((n) => !dryMatterBase(n) && qcParameterFor(n) === "moisture");
    const moisture = moistureName == null ? null : s.readings[moistureName]!;
    for (const [name, value] of Object.entries(s.readings)) {
      if (!Number.isFinite(value)) continue;
      add(raw, name, value);
      const base = dryMatterBase(name);
      const param = qcParameterFor(base ?? name);
      if (!param) continue;
      let v = value;
      if (base) {
        if (moisture == null || !Number.isFinite(moisture)) continue;
        v = asReceived(value, moisture);
        fromDryMatter.add(param);
      }
      add(sums, param, v);
      if (s.flagged.includes(name)) flagged.add(param);
    }
  }
  return {
    scans,
    average: means(sums),
    instrument: means(raw),
    flagged: [...flagged],
    fromDryMatter: [...fromDryMatter],
  };
}

/**
 * Where each scan goes — the rules in the file header, and nothing else.
 *
 * Pure, so the QC screen, the bench's unmatched list and the commit all reach
 * the same answer from the same facts.
 */
export function placeScans(
  scans: NirResult[],
  receipts: ReceiptLite[],
  lines: LineLite[],
  modelItems: Map<string, Array<{ itemId: string; itemName: string }>>,
): { placed: Map<string, ScanView[]>; unplaced: Unplaced[] } {
  const byKey = new Map<string, ReceiptLite[]>();
  for (const r of receipts) {
    const k = sampleKey(r.number);
    if (k) byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  const placed = new Map<string, ScanView[]>();
  const unplaced: Unplaced[] = [];
  const miss = (s: NirResult, receiptNumber: string | null, reason: string) =>
    unplaced.push({ scan: view(s), receiptNumber, reason });

  for (const s of scans) {
    const found = s.sampleKey ? byKey.get(s.sampleKey) ?? [] : [];
    if (!found.length) {
      miss(s, null, s.sampleKey
        ? `No goods receipt is numbered “${s.sampleName}”`
        : `Sample name “${s.sampleName ?? ""}” is not a GR number`);
      continue;
    }
    if (found.length > 1) {
      miss(s, null, `“${s.sampleName}” matches ${found.map((r) => r.number).join(" and ")}`);
      continue;
    }
    const receipt = found[0]!;
    if (!OPEN_FOR_QC.has(receipt.status)) {
      miss(s, receipt.number, `${receipt.number} is ${receipt.status.replace(/_/g, " ")}, not waiting on QC`);
      continue;
    }
    if (s.iasStatus != null && s.iasStatus !== 1) {
      miss(s, receipt.number, `IAS marked this scan with status ${s.iasStatus}`);
      continue;
    }
    if (s.scannedAt.getTime() < receipt.arrivalAt.getTime() - CLOCK_SLACK_MS) {
      miss(s, receipt.number, `Scanned before ${receipt.number} arrived at the gate`);
      continue;
    }
    const forModel = modelItems.get(s.model) ?? [];
    if (!forModel.length) {
      miss(s, receipt.number, `NIR model ${s.model} is not linked to a material yet`);
      continue;
    }
    const itemIds = new Set(forModel.map((m) => m.itemId));
    const candidates = lines.filter(
      (l) => l.receiptId === receipt.id && l.itemId && itemIds.has(l.itemId) && l.status === "pending",
    );
    if (!candidates.length) {
      miss(s, receipt.number,
        `Model ${s.model} is for ${forModel.map((m) => m.itemName).join(", ")} — not on ${receipt.number}`);
      continue;
    }
    if (candidates.length > 1) {
      miss(s, receipt.number,
        `${receipt.number} has ${candidates.length} lines of ${candidates[0]!.itemName ?? "this material"} — type those readings by hand`);
      continue;
    }
    const line = candidates[0]!;
    placed.set(line.id, [...(placed.get(line.id) ?? []), view(s)]);
  }
  for (const list of placed.values()) list.sort((a, b) => a.scannedAt.localeCompare(b.scannedAt));
  return { placed, unplaced };
}

export async function loadModelItems(db: Db | Tx) {
  const rows = await db
    .select({ shortName: nirModelItems.shortName, itemId: nirModelItems.itemId, itemName: items.name })
    .from(nirModelItems)
    .innerJoin(items, eq(items.id, nirModelItems.itemId));
  const out = new Map<string, Array<{ itemId: string; itemName: string }>>();
  for (const r of rows) out.set(r.shortName, [...(out.get(r.shortName) ?? []), { itemId: r.itemId, itemName: r.itemName }]);
  return out;
}

/** The unused scans whose sample name folds to this receipt's number. */
async function scansFor(db: Db | Tx, receiptNumber: string) {
  const key = sampleKey(receiptNumber);
  if (!key) return [];
  return db
    .select()
    .from(nirResults)
    .where(and(eq(nirResults.sampleKey, key), isNull(nirResults.receiptLineId)));
}

/** The NIR side of one receipt's QC screen. */
export async function nirForReceipt(
  db: Db | Tx,
  receipt: ReceiptLite,
  lines: LineLite[],
): Promise<{ byLine: Record<string, LineNir>; unplaced: Unplaced[] }> {
  const scans = await scansFor(db, receipt.number);
  if (!scans.length) return { byLine: {}, unplaced: [] };
  const { placed, unplaced } = placeScans(scans, [receipt], lines, await loadModelItems(db));
  const byLine: Record<string, LineNir> = {};
  for (const [lineId, list] of placed) byLine[lineId] = averageScans(list);
  return { byLine, unplaced };
}

/**
 * Fix the scans QC used to the line they were used on, and say what was
 * averaged and what the technician typed over.
 *
 * Every scan named must still place onto this line under the same rules the
 * screen used — a rename in IAS between showing and saving is caught here
 * rather than committed.
 */
export async function consumeScans(
  tx: Tx,
  receipt: ReceiptLite,
  lines: LineLite[],
  lineId: string,
  resultSns: string[],
  readings: Record<string, number | null>,
  userId: string,
): Promise<{
  results: string[];
  average: Record<string, number>;
  instrument: Record<string, number>;
  edited: string[];
  flagged: string[];
  fromDryMatter: string[];
}> {
  const scans = (await scansFor(tx, receipt.number)).filter((s) => resultSns.includes(s.resultSn));
  const { placed } = placeScans(scans, [receipt], lines, await loadModelItems(tx));
  const onLine = placed.get(lineId) ?? [];
  const missing = resultSns.filter((sn) => !onLine.some((s) => s.resultSn === sn));
  if (missing.length) {
    throw new NirMatchError(
      `NIR scan ${missing.join(", ")} no longer belongs to this line — it was used, renamed or relinked. Reload and check.`,
    );
  }
  const nir = averageScans(onLine);
  // Only a field the screen had can have been typed over. A material with no
  // spec has no fields, and its NIR figures are kept as they came.
  const edited = Object.entries(nir.average)
    .filter(([p, v]) => p in readings && (readings[p] == null || Math.abs(Number(readings[p]) - v) > 0.0005))
    .map(([p]) => p);

  const used = await tx
    .update(nirResults)
    .set({ receiptLineId: lineId, usedAt: new Date(), usedBy: userId, updatedAt: new Date() })
    .where(and(inArray(nirResults.resultSn, resultSns), isNull(nirResults.receiptLineId)))
    .returning({ id: nirResults.id });
  if (used.length !== resultSns.length) {
    throw new NirMatchError("Another QC used one of these NIR scans a moment ago. Reload and check.");
  }
  return {
    results: resultSns,
    average: nir.average,
    instrument: nir.instrument,
    edited,
    flagged: nir.flagged,
    fromDryMatter: nir.fromDryMatter,
  };
}

export class NirMatchError extends Error {}

// ─────────────────────────────── The bench view ───────────────────────────

/**
 * What the bench needs to see: the models and what each is linked to, when
 * the last scan came in, and every recent scan that has not found its truck.
 */
export async function benchStatus(db: Db) {
  const since = new Date(Date.now() - 3 * 86_400_000);
  const recent = await db
    .select()
    .from(nirResults)
    .where(and(gte(nirResults.scannedAt, since), isNull(nirResults.receiptLineId)))
    .orderBy(desc(nirResults.scannedAt))
    .limit(200);

  const keys = [...new Set(recent.map((s) => s.sampleKey).filter(Boolean))] as string[];
  // Receipts are few and recent; fold their numbers here rather than teach
  // SQL the same folding and risk the two disagreeing.
  const receipts = keys.length
    ? (
        await db
          .select({
            id: officeReceipts.id,
            number: officeReceipts.number,
            status: officeReceipts.status,
            arrivalAt: officeReceipts.arrivalAt,
          })
          .from(officeReceipts)
          .where(gte(officeReceipts.arrivalAt, new Date(Date.now() - 30 * 86_400_000)))
      ).filter((r) => keys.includes(sampleKey(r.number) ?? ""))
    : [];
  const lines = receipts.length
    ? await db
        .select({
          id: officeReceiptLines.id,
          receiptId: officeReceiptLines.receiptId,
          itemId: officeReceiptLines.itemId,
          itemName: officeReceiptLines.itemName,
          status: officeReceiptLines.status,
        })
        .from(officeReceiptLines)
        .where(inArray(officeReceiptLines.receiptId, receipts.map((r) => r.id)))
    : [];
  const modelItems = await loadModelItems(db);
  const { placed, unplaced } = placeScans(recent, receipts, lines, modelItems);

  const lineReceipt = new Map(lines.map((l) => [l.id, receipts.find((r) => r.id === l.receiptId)?.number ?? null]));
  const waiting = [...placed.entries()].flatMap(([lineId, list]) =>
    list.map((scan) => ({
      scan,
      receiptNumber: lineReceipt.get(lineId) ?? null,
      itemName: lines.find((l) => l.id === lineId)?.itemName ?? null,
    })),
  );

  const models = await db.select().from(nirModels).orderBy(nirModels.shortName);
  const [last] = await db
    .select({ at: nirResults.updatedAt, scannedAt: nirResults.scannedAt })
    .from(nirResults)
    .orderBy(desc(nirResults.updatedAt))
    .limit(1);

  // Feed materials, and anything with a spec. A model may be linked before
  // the material has a spec: its readings are then kept, unjudged, for
  // comparing once one is written (the user, 3 Oct 2026).
  const specItems = await db.execute(sql`
    SELECT i.id, i.name,
           EXISTS (SELECT 1 FROM qc_specs s WHERE s.item_id = i.id AND s.is_active) AS "hasSpec"
      FROM items i
     WHERE i.is_active
       AND (i.is_feed_ingredient OR EXISTS (SELECT 1 FROM qc_specs s WHERE s.item_id = i.id))
     ORDER BY i.name`);

  return {
    lastUploadAt: last?.at?.toISOString() ?? null,
    lastScanAt: last?.scannedAt?.toISOString() ?? null,
    models: models.map((m) => ({
      shortName: m.shortName,
      modelName: m.modelName,
      version: m.version,
      matterNames: m.matterNames as Record<string, string>,
      items: modelItems.get(m.shortName) ?? [],
    })),
    specItems: specItems.rows as Array<{ id: string; name: string; hasSpec: boolean }>,
    waiting,
    unplaced,
  };
}
