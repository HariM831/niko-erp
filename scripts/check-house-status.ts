/**
 * The one-click status: the verdict on a shed now, and its last 24 hours.
 *
 * The verdict is pure and checked on its own. The day replay reads samples, so
 * it runs against a scratch house (as check-iot.ts does) that is removed at the
 * end, its samples going with it on the cascade.
 *
 * Run: npx tsx scripts/check-house-status.ts
 */
import { eq } from "drizzle-orm";
import { houses, iotHouseSample, locations, stockLocations } from "@shared/schema";
import { db } from "../server/db";
import { dayStatus, verdictNow, type NowInput } from "../server/services/iot/status";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) failures++;
};

/* ── The verdict ────────────────────────────────────────────────────────── */

const NOW = Date.parse("2026-09-24T10:00:00Z");
const fresh = new Date(NOW - 3 * 60_000);
const base: NowInput = {
  tempC: 27,
  targetTempC: 26,
  humidityPct: 60,
  co2Ppm: 900,
  fetchedAt: fresh,
  controllerLive: true,
  feelsLike: { bft: 26.5, band: "ok", wetBulbC: 21.5 },
};

console.log("verdict now");
{
  const v = verdictNow(base, NOW);
  ok("a comfortable shed is ok, with nothing to say", v.verdict === "ok" && v.reasons.length === 0, JSON.stringify(v.reasons));
}
{
  const v = verdictNow({ ...base, feelsLike: { bft: 31.4, band: "severe", wetBulbC: 28.1 } }, NOW);
  ok("the feels-like band sets the verdict", v.verdict === "severe" && v.reasons[0]!.includes("31.4"), v.reasons.join(" · "));
}
{
  const v = verdictNow({ ...base, tempC: 30.5 }, NOW);
  ok("4.5 °C over target is severe even when feels-like is ok", v.verdict === "severe", v.reasons.join(" · "));
  const w = verdictNow({ ...base, tempC: 28.5 }, NOW);
  ok("2.5 °C over target is watch", w.verdict === "watch");
  const c = verdictNow({ ...base, tempC: 22 }, NOW);
  ok("4 °C under target is watch — cold counts too", c.verdict === "watch" && c.reasons[0]!.includes("under"));
}
{
  ok("CO₂ over 2500 is severe", verdictNow({ ...base, co2Ppm: 2700 }, NOW).verdict === "severe");
  ok("humidity over 82 is watch", verdictNow({ ...base, humidityPct: 85 }, NOW).verdict === "watch");
}
{
  // 33 °C at 75%: THI about 87 — severe by Thom, but the fans say the birds are fine.
  const v = verdictNow({ ...base, tempC: 33, targetTempC: 32, humidityPct: 75 }, NOW);
  ok("a severe THI alone raises the shed only to watch", v.verdict === "watch" && v.reasons.some((r) => r.startsWith("THI")), `${v.thi?.thi}`);
}
{
  ok("a switched-off controller is offline", verdictNow({ ...base, controllerLive: false }, NOW).verdict === "offline");
  const s = verdictNow({ ...base, fetchedAt: new Date(NOW - 45 * 60_000) }, NOW);
  ok("a reading 45 minutes old is offline, and says how old", s.verdict === "offline" && s.reasons[0] === "no reading for 45 min");
  ok("never read is offline", verdictNow({ ...base, fetchedAt: null }, NOW).verdict === "offline");
  ok("an unknown controller state does not by itself mark a shed offline", verdictNow({ ...base, controllerLive: null }, NOW).verdict === "ok");
}

/* ── The last 24 hours ──────────────────────────────────────────────────── */

console.log("\nlast 24 hours");
let scratch: { houseId: string; stockLocationId: string } | null = null;
try {
  const [site] = await db.select().from(locations).limit(1);
  if (!site) throw new Error("no locations to hang a test house on");
  const [stock] = await db
    .insert(stockLocations)
    .values({ locationId: site.id, code: "ZZSTAT", name: "check-house-status scratch", kind: "house" })
    .returning();
  const [house] = await db
    .insert(houses)
    .values({ locationId: site.id, stockLocationId: stock!.id, code: "ZZ-STATUS", purpose: "layer", isActive: false, displayOrder: 9999 })
    .returning();
  scratch = { houseId: house!.id, stockLocationId: stock!.id };

  /*
   * 24 hours at five minutes, target 26 °C, still air (no ladder kept).
   * Cool all night and morning; from 12 to 3 hours ago a hot spell at 34 °C and
   * 55% — feels-like well into critical, and 8 °C over target. Then a two-hour
   * hole with no samples at all, and the last hour cool again.
   */
  const now = new Date(NOW);
  const rows: Array<typeof iotHouseSample.$inferInsert> = [];
  for (let m = 24 * 60 - 5; m >= 0; m -= 5) {
    const at = new Date(NOW - m * 60_000);
    const hoursAgo = m / 60;
    if (hoursAgo < 3 && hoursAgo >= 1) continue; // the hole
    const hot = hoursAgo <= 12 && hoursAgo >= 3;
    rows.push({
      houseId: house!.id,
      at,
      tempC: hot ? 34 : 25,
      targetTempC: 26,
      humidityPct: hot ? 55 : 60,
      co2Ppm: 1000,
      pressurePa: 20,
      ventLevel: hot ? 30 : 8,
      pumpOn: hot ? 1 : 0,
      mortalityToday: 4,
      waterPerBirdMl: 240,
      feedPerBirdG: 108,
      birdAgeDays: 301,
    });
  }
  await db.insert(iotHouseSample).values(rows);

  const d = (await dayStatus([house!.id], now)).get(house!.id)!;
  ok("every sample is read", d.samples === rows.length, `${d.samples}`);
  ok("the two-hour hole is not counted as covered", Math.abs(d.hoursCovered - 22) < 0.2, `${d.hoursCovered} h`);
  ok("the hot spell is critical", d.worst === "critical", d.worst);
  ok("about nine hours critical", Math.abs(d.hoursByLevel.critical - 9) < 0.2, `${d.hoursByLevel.critical} h`);
  ok("the rest is ok", Math.abs(d.hoursByLevel.ok - 13) < 0.2, `${d.hoursByLevel.ok} h`);
  ok("the worst moment says why", !!d.worstReason && d.worstReason.includes("feels-like"), d.worstReason ?? "");
  ok("temperature range", d.tempMin === 25 && d.tempMax === 34, `${d.tempMin}–${d.tempMax}`);
  ok("8 °C over target at the peak", d.overTargetMax === 8, `${d.overTargetMax}`);
  ok("the pads ran through the hot spell", Math.abs((d.padsHours ?? 0) - 9) < 0.2, `${d.padsHours} h`);
  ok("no ladder kept, so air speed is flagged as unknown", d.airSpeedKnown === false);
  ok("the latest flock figures come through", d.mortalityToday === 4 && d.waterPerBirdMl === 240 && d.birdAgeDays === 301);
  ok("24 hour cells", d.hours.length === 24);
  // The hole runs from 3 to 1 hours ago; the sample AT 3 hours ago opens cell 21, so cell 22 alone is empty.
  ok("the hole's hour has no level", d.hours[22]!.level === null && d.hours[22]!.samples === 0, d.hours.map((h) => h.level?.[0] ?? "-").join(""));
  ok("the hot hours are critical cells", d.hours.filter((h) => h.level === "critical").length >= 9);

  // A single hot sample in a cool day does not colour the day.
  await db.delete(iotHouseSample).where(eq(iotHouseSample.houseId, house!.id));
  const cool = rows.map((r) => ({ ...r, tempC: 25, humidityPct: 60 }));
  cool[100] = { ...cool[100]!, tempC: 36 };
  await db.insert(iotHouseSample).values(cool);
  const one = (await dayStatus([house!.id], now)).get(house!.id)!;
  ok("one five-minute blip does not make the day critical", one.worst === "ok", `${one.worst}, ${one.hoursByLevel.critical} h critical`);

  const none = (await dayStatus([stock!.id], now)).get(stock!.id)!;
  ok("a house with no samples reads as none, not as fine-and-empty", none.samples === 0 && none.hoursCovered === 0);
} catch (e) {
  console.error(e);
  failures++;
} finally {
  if (scratch) {
    await db.delete(houses).where(eq(houses.id, scratch.houseId));
    await db.delete(stockLocations).where(eq(stockLocations.id, scratch.stockLocationId));
  }
}

console.log(failures ? `\n  ${failures} failed\n` : "\n  all good\n");
process.exit(failures ? 1 : 0);
