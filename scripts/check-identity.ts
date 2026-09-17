/**
 * One Aadhaar, one person — and what may be uploaded as a photograph.
 * Inside a transaction that is rolled back.
 *
 * Run: npx tsx scripts/check-identity.ts
 */
import { inArray, sql } from "drizzle-orm";
import { employees } from "@shared/schema";
import { db } from "../server/db";
import { findIdClash, isAcceptableUpload, normAadhaar, normPan } from "../server/services/identity";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
};
class Rollback extends Error {}

console.log("\n  numbers\n");
ok("an Aadhaar is its digits, however typed", normAadhaar("1234 5678-9012") === "123456789012");
ok("a PAN is upper-case alphanumerics", normPan(" abcde 1234f ") === "ABCDE1234F");

console.log("\n  uploads\n");
const b64 = (bytes: number[]) => Buffer.from([...bytes, ...Array(32).fill(0)]).toString("base64");
const png = `data:image/png;base64,${b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])}`;
const jpg = `data:image/jpeg;base64,${b64([0xff, 0xd8, 0xff, 0xe0])}`;
const pdf = `data:application/pdf;base64,${Buffer.from("%PDF-1.7 ....................").toString("base64")}`;
const svg = `data:image/svg+xml;base64,${Buffer.from("<svg onload=alert(1)>").toString("base64")}`;
const liar = `data:image/png;base64,${Buffer.from("<svg onload=alert(1)>.......").toString("base64")}`;
ok("a PNG and a JPEG are photographs", isAcceptableUpload(png, { pdf: false }) && isAcceptableUpload(jpg, { pdf: false }));
ok("a PDF is a document, not a photograph", isAcceptableUpload(pdf, { pdf: true }) && !isAcceptableUpload(pdf, { pdf: false }));
ok("an SVG is refused", !isAcceptableUpload(svg, { pdf: true }));
ok("markup labelled as a PNG is refused by its bytes", !isAcceptableUpload(liar, { pdf: false }));

try {
  await db.transaction(async (tx) => {
    const mk = async (empCode: string, extra: Partial<typeof employees.$inferInsert>) =>
      (await tx.insert(employees).values({ empCode, name: `ZZ Id ${empCode}`, payType: "salaried", ...extra }).returning())[0]!;
    const a = await mk("ZZIDA", { aadharNumber: "999988887777", panNumber: "ZZZPA1234Z" });
    // Stored untidily, as an older import might have left it: lower case.
    const gone = await mk("ZZIDG", { panNumber: "zzzpb1234y", isActive: false });

    console.log("\n  the same person again\n");
    let c = await findIdClash(tx, { aadhar: "9999 8888 7777" });
    ok("the same Aadhaar typed with spaces is a clash", c?.id === a.id && c.field === "Aadhaar");
    c = await findIdClash(tx, { pan: "zzzpa1234z" });
    ok("the same PAN in lower case is a clash", c?.id === a.id && c.field === "PAN");
    c = await findIdClash(tx, { pan: "ZZZPB1234Y" });
    ok("a number stored untidily still clashes, and an inactive holder is named as such", c?.id === gone.id && c.isActive === false);
    c = await findIdClash(tx, { aadhar: "999988887777" }, a.id);
    ok("a person does not clash with themselves", c === null);
    c = await findIdClash(tx, { aadhar: "111122223333", pan: null });
    ok("a new number clashes with nobody", c === null);
    c = await findIdClash(tx, { aadhar: "", pan: "" });
    ok("no number given is no clash", c === null);
    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) { console.error(e); failures++; }
}
const [left] = await db.select({ n: sql<number>`count(*)::int` }).from(employees).where(inArray(employees.empCode, ["ZZIDA", "ZZIDG"]));
ok("the rollback left nothing behind", left!.n === 0);

console.log(failures ? `\n  ${failures} failed\n` : "\n  all good\n");
process.exit(failures ? 1 : 0);
