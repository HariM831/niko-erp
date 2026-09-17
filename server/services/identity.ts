/**
 * Is this the same person again?
 *
 * An Aadhaar or a PAN belongs to one human, so the same number on a second
 * record is nearly always one person enrolled twice — two identities at one
 * gate, two sets of attendance, and eventually two slips. Compared as the
 * number itself, not as it was typed: "1234 5678 9012" is "123456789012".
 *
 * Deliberately not a unique index. Amino's data came across with two wage
 * workers sharing a number — a family card, or a mistake nobody has sorted out
 * — and an index would have refused the import and would still refuse every
 * edit to either of them. So the check is made when a number is SET, leaves
 * records that already clash alone, and can be overruled on purpose.
 */
import { and, ne, sql } from "drizzle-orm";
import { employees } from "@shared/schema";
import type { Db, Tx } from "../db";

type Conn = Db | Tx;

export const normAadhaar = (raw: string | null | undefined) => (raw ?? "").replace(/\D/g, "");
export const normPan = (raw: string | null | undefined) => (raw ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();

export interface IdClash {
  field: "Aadhaar" | "PAN";
  id: string;
  name: string;
  empCode: string;
  isActive: boolean;
}

export async function findIdClash(
  conn: Conn,
  ids: { aadhar?: string | null; pan?: string | null },
  exceptId?: string,
): Promise<IdClash | null> {
  const probes: Array<[IdClash["field"], string, ReturnType<typeof sql>]> = [];
  const aadhar = normAadhaar(ids.aadhar);
  const pan = normPan(ids.pan);
  if (aadhar) probes.push(["Aadhaar", aadhar, sql`regexp_replace(coalesce(${employees.aadharNumber}, ''), '[^0-9]', '', 'g')`]);
  if (pan) probes.push(["PAN", pan, sql`upper(regexp_replace(coalesce(${employees.panNumber}, ''), '[^A-Za-z0-9]', '', 'g'))`]);
  for (const [field, value, column] of probes) {
    const [hit] = await conn
      .select({ id: employees.id, name: employees.name, empCode: employees.empCode, isActive: employees.isActive })
      .from(employees)
      .where(and(sql`${column} = ${value}`, exceptId ? ne(employees.id, exceptId) : undefined))
      .limit(1);
    if (hit) return { field, ...hit };
  }
  return null;
}

export const clashMessage = (c: IdClash) =>
  `${c.name} (${c.empCode}) is already on file with this ${c.field} number${c.isActive ? "" : " (inactive)"} — reactivate or edit that person instead`;

/* ── What may be uploaded as a photograph or a document ─────────────────── */

const MAGIC: Array<[string, (b: Buffer) => boolean]> = [
  ["image/png", (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/gif", (b) => b.subarray(0, 4).toString("latin1") === "GIF8"],
  ["image/webp", (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP"],
  ["application/pdf", (b) => b.subarray(0, 5).toString("latin1") === "%PDF-"],
];

/**
 * A data URL that is what it says it is, judged by its first bytes and not by
 * its label. An SVG is refused outright: it is markup, it can carry script, and
 * these are shown back to HR inside the app. Anything that is not a data URL at
 * all is left to the caller — a stored path is not this function's business.
 */
export function isAcceptableUpload(url: string, opts: { pdf: boolean }): boolean {
  if (!url.startsWith("data:")) return true;
  const m = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,(.+)$/is.exec(url);
  if (!m) return false;
  const mime = m[1]!.toLowerCase() === "image/jpg" ? "image/jpeg" : m[1]!.toLowerCase();
  if (mime === "application/pdf" && !opts.pdf) return false;
  const check = MAGIC.find(([type]) => type === mime);
  if (!check) return false;
  try {
    return check[1](Buffer.from(m[2]!.slice(0, 64), "base64"));
  } catch {
    return false;
  }
}
