/**
 * The field-device surface, exercised without HTTP — the route file keeps its
 * logic in exported functions that take a connection, so the whole matrix
 * runs inside one transaction that is rolled back at the end:
 *
 *   tokens:   sha256 hashing, valid / unknown / revoked / wrong-role
 *   pairing:  auto-approve claim → token; second claim goes pending →
 *             admin approves → poll hands the token over exactly once
 *   events:   duplicate event id → duplicates[]; in/in → second corrected
 *             to out; canteen plate reconciled against the day's punches;
 *             a second unauthorised plate refused, an authorised one served
 *   enroll:   a phone-enrolled labourer lands as a daily_wage employee with
 *             a generated W-xxxx code and the named wage role
 *
 * Run: npx tsx scripts/check-device.ts
 */
import { and, eq, like, sql } from "drizzle-orm";
import {
  canteens,
  deviceRequests,
  devices,
  employees,
  locations,
  pairingCodes,
  punches,
  staffPins,
  users,
  wageRoles,
} from "@shared/schema";
import { canteenServings } from "@shared/schema";
import { db } from "../server/db";
import {
  applyEvents,
  approvePairingRequest,
  checkDeviceToken,
  claimPairing,
  enrollPerson,
  hashPin,
  hashToken,
  newToken,
  pollPairing,
} from "../server/routes/device";
import { checkAttendancePresent } from "../server/routes/canteen";
import { istDate } from "../server/services/day-resolution";

let failures = 0;
let n = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${++n}. ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
};

class Rollback extends Error {}

const SCRATCH = "ZZ Device Check";

try {
  await db.transaction(async (tx) => {
    const [user] = await tx.select({ id: users.id }).from(users).limit(1);
    if (!user) throw new Error("need a user to test with");
    const uid = user.id;

    // Scratch world: its own site, canteen, role and people, so nothing the
    // real registry holds can collide with the matrix below.
    const [site] = await tx.insert(locations).values({ code: "ZZDC", name: SCRATCH, type: "farm" }).returning();
    const [canteen] = await tx.insert(canteens).values({ code: "ZZDC-C", name: `${SCRATCH} Canteen`, locationId: site!.id }).returning();
    const [role] = await tx.insert(wageRoles).values({ name: `${SCRATCH} Loader`, dailyRate: "450.00" }).returning();
    const [emp] = await tx
      .insert(employees)
      .values({ empCode: "ZZDC-1", name: `${SCRATCH} Worker`, payType: "daily_wage", wageRoleId: role!.id, locationId: site!.id })
      .returning();
    const pinSalt = "00112233445566778899aabbccddeeff";
    const [pin] = await tx
      .insert(staffPins)
      .values({ name: `${SCRATCH} Supervisor`, locationId: site!.id, saltHex: pinSalt, pinHash: hashPin(pinSalt, "4321"), canAuthorise: true })
      .returning();

    console.log(`\n  testing against ${SCRATCH} (site ${site!.code})\n`);

    /* ══ 1. Tokens ═══════════════════════════════════════════════════════ */
    const gateToken = newToken();
    const [gateRow] = await tx
      .insert(devices)
      .values({ name: `${SCRATCH} Gate`, role: "gate", locationId: site!.id, tokenHash: hashToken(gateToken) })
      .returning();

    ok("token hash is sha256 hex, 64 chars", /^[0-9a-f]{64}$/.test(hashToken(gateToken)) && hashToken("a") === hashToken("a") && hashToken("a") !== hashToken("b"));
    const good = await checkDeviceToken(tx, gateToken);
    ok("a valid token resolves its device with the site code", good.ok && good.device.id === gateRow!.id && good.device.siteCode === "ZZDC");
    const unknown = await checkDeviceToken(tx, newToken());
    ok("an unknown token → 401 without a revoked code", !unknown.ok && unknown.status === 401 && !unknown.body.code);
    const wrongRole = await checkDeviceToken(tx, gateToken, "canteen");
    ok("the right token on the wrong role → 403 wrong_role", !wrongRole.ok && wrongRole.status === 403 && wrongRole.body.code === "wrong_role");
    await tx.update(devices).set({ revokedAt: new Date() }).where(eq(devices.id, gateRow!.id));
    const revoked = await checkDeviceToken(tx, gateToken);
    ok("a revoked token → 401 with code device_revoked", !revoked.ok && revoked.status === 401 && revoked.body.code === "device_revoked");
    await tx.update(devices).set({ revokedAt: null }).where(eq(devices.id, gateRow!.id));

    /* ══ 2. Pairing ══════════════════════════════════════════════════════ */
    // A canteen role has no live device at the site yet → auto-approve.
    const code1 = "ZZAB23CD";
    await tx.insert(pairingCodes).values({
      codeHash: hashToken(code1), codeLast4: code1.slice(-4), deviceName: `${SCRATCH} Counter`, role: "canteen",
      locationId: site!.id, canteenId: canteen!.id, createdBy: uid, expiresAt: new Date(Date.now() + 600_000),
    });
    const claim1 = await claimPairing(tx, { code: "zzab-23cd", installId: "install-A", deviceModel: "Pixel" });
    ok("first claim at an empty site auto-approves with a token", claim1.status === "approved" && !!(claim1 as any).token && (claim1 as any).siteCode === "ZZDC");
    const canteenToken = (claim1 as any).token as string;
    const canteenCheck = await checkDeviceToken(tx, canteenToken, "canteen");
    ok("the issued token authenticates as the canteen device", canteenCheck.ok && canteenCheck.device.canteenId === canteen!.id);
    const claim1again = await claimPairing(tx, { code: code1, installId: "install-A" });
    ok("a claimed code cannot be claimed again", claim1again.status === "invalid");

    // Same role, same site, device now live → the claim must wait for an admin.
    const code2 = "ZZEF45GH";
    await tx.insert(pairingCodes).values({
      codeHash: hashToken(code2), codeLast4: code2.slice(-4), deviceName: `${SCRATCH} Counter 2`, role: "canteen",
      locationId: site!.id, canteenId: canteen!.id, createdBy: uid, expiresAt: new Date(Date.now() + 600_000),
    });
    const claim2 = await claimPairing(tx, { code: code2, installId: "install-B" });
    ok("a second device for a held slot goes pending", claim2.status === "pending" && !!(claim2 as any).pendingId);
    const pendingId = (claim2 as any).pendingId as string;
    const poll1 = await pollPairing(tx, pendingId);
    ok("polling before the decision says pending", poll1.status === "pending");
    const approve = await approvePairingRequest(tx, pendingId, uid);
    ok("the admin approval mints a device", approve.status === 200 && !!(approve.body as any).deviceId);
    const poll2 = await pollPairing(tx, pendingId);
    ok("the next poll hands the token over", poll2.status === "approved" && !!(poll2 as any).token);
    const poll3 = await pollPairing(tx, pendingId);
    ok("the token is handed over exactly once", poll3.status === "expired", `second poll → ${poll3.status}`);
    const approveTwice = await approvePairingRequest(tx, pendingId, uid);
    ok("approving an already-approved request is refused", approveTwice.status === 400);

    /* ══ 3. Gate events ══════════════════════════════════════════════════ */
    const gate = { ...(await tx.select().from(devices).where(eq(devices.id, gateRow!.id)))[0]!, siteCode: "ZZDC" };
    const today = istDate();
    const base = Date.now() - 4 * 3600_000; // this morning, IST-safe for any run time
    const e = (id: string, type: "in" | "out", ts: number, extra: Record<string, unknown> = {}) => ({
      id, type, personKind: "wage", personId: emp!.id, ts, date: today, method: "face", matchScore: 0.9, ...extra,
    });

    const r1 = await applyEvents(tx, gate, [e("evt-1", "in", base)]);
    ok("a clean IN is accepted", r1.accepted.length === 1 && r1.rejected.length === 0 && r1.corrected.length === 0);
    const r2 = await applyEvents(tx, gate, [e("evt-1", "in", base)]);
    ok("the same event id resent lands in duplicates[]", r2.duplicates.length === 1 && r2.accepted.length === 0, r2.duplicates[0]?.reason ?? "");
    const r3 = await applyEvents(tx, gate, [e("evt-2", "in", base + 3600_000)]);
    ok("a second IN is auto-corrected to OUT", r3.accepted.length === 1 && r3.corrected.some((c) => c.id === "evt-2" && c.from === "in" && c.to === "out"));
    const dayRows = await tx.select().from(punches).where(and(eq(punches.employeeId, emp!.id), eq(punches.punchDate, today)));
    ok("the stored punches read in, out", dayRows.length === 2 && dayRows.some((p) => p.type === "in") && dayRows.some((p) => p.type === "out"));
    ok("device punches carry method=device and the event id as client_id", dayRows.every((p) => p.method === "device" && p.deviceId === gate.id) && dayRows.some((p) => p.clientId === "evt-1"));
    ok("a confident match keeps no photo", dayRows.every((p) => p.photoUrl === null));
    const rBad = await applyEvents(tx, gate, [{ id: "evt-bad", type: "meal", personKind: "wage", personId: emp!.id, ts: base, date: today, meal: "lunch", state: "verified", personName: "X" }]);
    ok("a gate device cannot write a plate", rBad.rejected.length === 1, rBad.rejected[0]?.reason ?? "");

    /* ══ 4. Canteen events ═══════════════════════════════════════════════ */
    const canteenDev = { ...canteenCheck.ok ? canteenCheck.device : (undefined as never) };
    const plate = (id: string, extra: Record<string, unknown> = {}) => ({
      id, type: "meal", meal: "lunch", state: "unverified_attendance", personKind: "wage", personId: emp!.id,
      personName: emp!.name, ts: base + 5 * 3600_000, date: today, tokenNumber: "T-1", ...extra,
    });

    ok("the presence rule sees the morning punch", await checkAttendancePresent(tx, emp!.id, today));
    const p1 = await applyEvents(tx, canteenDev, [plate("plate-1")]);
    ok("a plate for a punched-in person is accepted", p1.accepted.length === 1, p1.rejected[0]?.reason ?? "");
    const [served] = await tx.select().from(canteenServings).where(eq(canteenServings.clientId, "plate-1"));
    ok("reconciliation stamps attendance_present = true", served?.attendancePresent === true && !!served?.reconciledAt);
    ok("an unverified plate of a present person is promoted to verified", served?.state === "verified");

    const p2 = await applyEvents(tx, canteenDev, [plate("plate-2")]);
    ok("a second plate without authorisation is refused as a duplicate", p2.accepted.length === 0 && p2.duplicates.some((d) => d.id === "plate-2" && /already served/.test(d.reason)));
    const p3 = await applyEvents(tx, canteenDev, [plate("plate-3", { state: "verified", authorisedBy: pin!.id, reasonCode: "second_plate_ok", extraPlateKind: "second_plate" })]);
    ok("an authorised second plate is accepted", p3.accepted.length === 1, p3.rejected[0]?.reason ?? "");
    const p4 = await applyEvents(tx, canteenDev, [plate("plate-4", { state: "override", reasonCode: "no_pin" })]);
    ok("an override without authorisedBy is rejected", p4.rejected.length === 1, p4.rejected[0]?.reason ?? "");
    const p5 = await applyEvents(tx, canteenDev, [
      { id: "plate-5", type: "meal", meal: "lunch", state: "guest", personKind: "guest", personName: "Visiting Vet", ts: base + 5 * 3600_000, date: today, authorisedBy: pin!.id, reasonCode: "guest", photoUrl: "data:image/jpeg;base64,AAA", guestParty: "Vet team" },
    ]);
    const [guestRow] = await tx.select().from(canteenServings).where(eq(canteenServings.clientId, "plate-5"));
    ok("a guest plate lands with employee_id null", p5.accepted.length === 1 && guestRow?.employeeId === null, p5.rejected[0]?.reason ?? "");

    /* ══ 5. Enrol ════════════════════════════════════════════════════════ */
    const enrolled = await enrollPerson(tx, gate, {
      name: `${SCRATCH} New Hand`, kind: "wage", roleName: role!.name,
      photo: "data:image/jpeg;base64,BBB", descriptor: [0.1, 0.2, 0.3], isActive: true,
    } as any);
    const [newEmp] = await tx.select().from(employees).where(eq(employees.id, enrolled.id));
    ok("enrolment creates a daily_wage employee with a W- code", newEmp?.payType === "daily_wage" && /^W-\d{4}$/.test(enrolled.empCode), enrolled.empCode);
    ok("the named wage role and face are attached", newEmp?.wageRoleId === role!.id && Array.isArray(newEmp?.faceDescriptor) && !!newEmp?.faceEnrolledAt);

    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) {
    console.error(e);
    failures++;
  }
}

// Prove the rollback held.
const [left] = await db.select({ n: sql<number>`count(*)::int` }).from(devices).where(like(devices.name, `${SCRATCH}%`));
ok("the rollback left nothing behind", (left?.n ?? 0) === 0);

console.log(failures ? `\n  ${failures} failed\n` : "\n  all good\n");
process.exit(failures ? 1 : 0);
