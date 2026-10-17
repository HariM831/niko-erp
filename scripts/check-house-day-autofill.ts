/**
 * The house-day autofill rules, on series shaped like the real sheds.
 *
 * No database: the silo reading, tanker matching and stock judgement are pure,
 * and these are the rules a saved feed figure depends on. The shapes are
 * L2's and L4's from 3–8 Oct 2026, the week that showed the controller's feed
 * counter missing runs while the silo matched the farm's register within 1%.
 *
 * Run: npx tsx scripts/check-house-day-autofill.ts
 */
process.env.DATABASE_URL ??= "postgres://unused@localhost/unused";

import { judgeStock, sameFigure } from "@shared/house-day";
import type { DayAutofill } from "@shared/house-day";
import { dayCoverage, siloFed, siloMoves, siloTankers } from "../server/services/iot/silo-events";
import { likelyTransfers, matchTankers, provenance, siloBalance, siloDay } from "../server/services/house-day-autofill";
import { PostingError } from "../server/services/posting";

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:30`);

/** A five-minute series from a list of (time, level) points, straight lines between, ±8 kg of wobble. */
function series(day: string, points: Array<[string, number]>, from = "00:00", to = "23:55") {
  const pts = points.map(([t, v]) => ({ t: at(day, t).getTime(), v }));
  const out: Array<{ at: Date; kg: number }> = [];
  let k = 0;
  for (let t = at(day, from).getTime(); t <= at(day, to).getTime(); t += 5 * 60_000, k++) {
    let v = pts[0]!.v;
    for (let i = 1; i < pts.length; i++) {
      if (t >= pts[i]!.t) v = pts[i]!.v;
      else {
        const a = pts[i - 1]!;
        const b = pts[i]!;
        if (t >= a.t) v = a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
        break;
      }
    }
    out.push({ at: new Date(t), kg: v + ((k * 7) % 17) - 8 });
  }
  return out;
}

// ── L2, 7 Oct: three runs, one tanker; the counter missed the 08:00 run ──
{
  const day = "2026-10-07";
  const s = series(day, [
    ["00:00", 17540], ["03:30", 17540], ["04:20", 13906], // run 1: 3,634
    ["08:00", 13906], ["08:50", 10930],                    // run 2: 2,976
    ["13:00", 10880], ["13:20", 16730],                    // tanker 5,850
    ["15:55", 16730], ["16:50", 12625],                    // run 3: 4,105
    ["23:55", 12625],
  ]);
  const moves = siloMoves(s, at(day, "00:00"), at("2026-10-08", "00:00"));
  const fed = siloFed(moves);
  ok("L2 7 Oct: the silo sees all three runs", Math.abs(fed - 10715) < 120, `${fed} kg (register 10,695)`);
  const tankers = siloTankers(moves);
  ok("L2 7 Oct: one tanker", tankers.length === 1 && Math.abs(tankers[0]!.kg - 5850) < 60, `${tankers.map((t) => Math.round(t.kg)).join(", ")}`);
}

// ── Wobble alone is no feeding ──
{
  const day = "2026-10-04";
  const s = series(day, [["00:00", 7100], ["23:55", 7080]]);
  const moves = siloMoves(s, at(day, "00:00"), at("2026-10-05", "00:00"));
  ok("A still silo reads as no moves", moves.length === 0, `${moves.length} moves`);
}

// ── A reading that drops out and comes straight back is not a run ──
{
  const day = "2026-10-05";
  const s = series(day, [["00:00", 9000], ["23:55", 9000]]);
  s[100] = { at: s[100]!.at, kg: 2000 };
  const moves = siloMoves(s, at(day, "00:00"), at("2026-10-06", "00:00"));
  ok("A one-reading dropout is ignored", siloFed(moves) === 0, `fed ${siloFed(moves)}`);
}

// ── Tankers to transfers ──
{
  const d = (day: string, hhmm: string, kg: number) => ({ start: at(day, hhmm), end: at(day, hhmm), kg });
  // L2, 3–8 Oct, as the silo saw them.
  const rises = [
    d("2026-10-03", "13:25", 6241),
    d("2026-10-03", "22:20", 5698),  // FT dated 4 Oct
    d("2026-10-05", "14:31", 6492),
    d("2026-10-05", "17:51", 10049), // first half of 6 Oct's 16,148
    d("2026-10-06", "11:31", 6187),  // second half
    d("2026-10-06", "20:19", 9779),  // first part of 7 Oct's 15,543
    d("2026-10-07", "13:09", 5849),
    d("2026-10-08", "06:20", 9737),
  ];
  const transfers = [
    { number: "FT-A", transferDate: "2026-10-03", quantityKg: 6188 },
    { number: "FT-B", transferDate: "2026-10-04", quantityKg: 5699 },
    { number: "FT-C", transferDate: "2026-10-05", quantityKg: 6475 },
    { number: "FT-D", transferDate: "2026-10-06", quantityKg: 16148 },
    { number: "FT-E", transferDate: "2026-10-07", quantityKg: 15543 },
    { number: "FT-F", transferDate: "2026-10-08", quantityKg: 9692 },
  ];
  const { tankers, unseen } = matchTankers(rises, transfers);
  ok("Every L2 transfer finds its tankers", unseen.length === 0, unseen.map((u) => u.number).join(", "));
  ok("A tanker in at 22:20 matches the next day's transfer", tankers[1]!.transfer?.number === "FT-B");
  ok("A transfer arriving in two loads takes both", tankers[3]!.transfer?.number === "FT-D" && tankers[4]!.transfer?.number === "FT-D");
  const booked = tankers.filter((t) => t.transfer?.number === "FT-D").reduce((s, t) => s + t.bookedKg, 0);
  ok("…and books the mill's weight across them", Math.abs(booked - 16148) < 1, `${Math.round(booked)}`);

  // L4, 7–8 Oct: three loads, no transfer yet.
  const l4 = [d("2026-10-07", "16:49", 7100), d("2026-10-08", "09:50", 6799), d("2026-10-08", "14:30", 7870)];
  const none = matchTankers(l4, []);
  ok("L4's 8 Oct tankers stand unmatched with no transfer", none.tankers.every((t) => !t.transfer));
  const later = matchTankers(l4, [{ number: "FT-L4", transferDate: "2026-10-08", quantityKg: 21798 }]);
  ok("…and match once the mill enters 21,798", later.unseen.length === 0 && later.tankers.every((t) => t.transfer?.number === "FT-L4"));

  // A transfer 6% off its tanker is not that tanker.
  const off = matchTankers([d("2026-10-07", "09:19", 5770)], [{ number: "FT-X", transferDate: "2026-10-07", quantityKg: 6150 }]);
  ok("A weight 6% off is refused", off.unseen.length === 1);
}

// ── Coverage: a frozen controller is not a day ──
{
  const day = "2026-10-02";
  const samples = [];
  for (let t = at(day, "00:00").getTime(); t < at("2026-10-03", "00:00").getTime(); t += 15 * 60_000) {
    const frozen = t < at(day, "14:00").getTime();
    samples.push({ at: new Date(t), waterL: frozen ? 30100 : 30100 + (t - at(day, "14:00").getTime()) / 60_000 });
  }
  const c = dayCoverage(samples, at(day, "00:00"), at("2026-10-03", "00:00"));
  ok("L2 2 Oct (frozen till 14:00) is not a whole day", !c.complete, c.reason ?? "");
}

// ── Stock ──
{
  const parts = { openingKg: 7749, openingFrom: "saved" as const, arrivedKg: 15543, unbookedKg: 0, siloKg: 12626 };
  // Since 17 Oct 2026 stock is the silo at midnight; the book is only shown.
  const f = judgeStock(parts, 10695);
  ok("Stock is the silo at midnight", f.status === "filled" && f.value === 12626 && f.from === "silo", `${f.status} ${f.value}`);
  ok("…with the book beside it", f.note.includes("12,597"));
  const g = judgeStock({ ...parts, unbookedKg: 7100 }, 10695);
  ok("An unbooked tanker no longer stops it", g.status === "filled" && g.value === 12626);
  const h = judgeStock({ ...parts, siloKg: 16434 }, 10695);
  ok("Nor does a 3.8 t gap from the book", h.status === "filled" && h.value === 16434);
  const i = judgeStock({ ...parts, siloKg: null }, 10695);
  ok("No silo at midnight: nothing to offer", i.status === "unavailable");
}

// ── Reasons ──
{
  const auto: DayAutofill = {
    day: "2026-10-07",
    complete: true,
    reason: null,
    feedConsumedKg: { status: "filled", value: 10682, from: "silo", note: "" },
    waterKl: { status: "filled", value: 36.4, from: "controller", note: "" },
    stock: { openingKg: 7749, openingFrom: "saved", arrivedKg: 15543, unbookedKg: 0, siloKg: 12626 },
    tankers: [],
    unseenTransfers: [],
    eggsProduced: null,
  };
  const p = provenance(auto, { feedConsumedKg: 10682, feedClosingKg: 12626, waterKl: 36.4 }, null, {});
  ok("Proven figures saved as offered need no reason", p.feedConsumedKg?.from === "silo" && p.feedClosingKg?.from === "silo" && p.waterKl?.from === "controller");
  let refused = false;
  try {
    provenance(auto, { feedConsumedKg: 7412, feedClosingKg: null, waterKl: null }, null, {});
  } catch (e) {
    refused = e instanceof PostingError;
  }
  ok("Typing over a proven figure without a reason is refused", refused);
  const q = provenance(auto, { feedConsumedKg: 10695, feedClosingKg: null, waterKl: null }, null, { feedConsumedKg: "register" });
  ok("…and saved as typed with the reason", q.feedConsumedKg?.from === "typed" && q.feedConsumedKg.reason === "register");
  const kept = provenance(
    auto,
    { feedConsumedKg: 7412, feedClosingKg: null, waterKl: null },
    { values: { feedConsumedKg: 7412 }, sources: null },
    {},
  );
  ok("A saved figure left as it was needs no reason", kept.feedConsumedKg === undefined);
  ok("Water agrees to 50 litres", sameFigure("waterKl", 36.4, 36.44) && !sameFigure("waterKl", 36.4, 36.5));
}

// ── The silo's day: 18:00 to 18:00 (17 Oct 2026) ──
{
  const [from, to] = siloDay("2026-10-16");
  ok("The silo's day for 16 Oct is 15 Oct 18:00 to 16 Oct 18:00",
    from.toISOString() === "2026-10-15T12:30:00.000Z" && to.toISOString() === "2026-10-16T12:30:00.000Z");
  // L4, shaped like 16 Oct: 20:08 tanker the evening before, runs at 05:43,
  // 10:28 and 16:13, a 14:36 tanker, and an evening tanker after the close.
  const at = (s: string) => new Date(`${s}+05:30`);
  const silo: Array<{ at: Date; kg: number }> = [];
  let kg = 9000;
  const step = (when: string, to: number, minutes: number) => {
    const t0 = at(when).getTime();
    const n = Math.max(1, Math.round(minutes / 5));
    const k0 = kg;
    for (let i = 1; i <= n; i++) silo.push({ at: new Date(t0 + i * 5 * 60_000), kg: Math.round(k0 + ((to - k0) * i) / n) });
    kg = to;
  };
  const fill = (from: string, until: string) => {
    for (let t = at(from).getTime(); t < at(until).getTime(); t += 5 * 60_000) silo.push({ at: new Date(t), kg });
  };
  fill("2026-10-15T17:00", "2026-10-15T20:08"); step("2026-10-15T20:08", 16000, 30);
  fill("2026-10-15T20:40", "2026-10-16T05:43"); step("2026-10-16T05:43", 12000, 45);
  fill("2026-10-16T06:30", "2026-10-16T10:28"); step("2026-10-16T10:28", 8000, 45);
  fill("2026-10-16T11:15", "2026-10-16T14:36"); step("2026-10-16T14:36", 15000, 30);
  fill("2026-10-16T15:10", "2026-10-16T16:13"); step("2026-10-16T16:13", 11000, 45);
  fill("2026-10-16T17:00", "2026-10-16T19:00"); step("2026-10-16T19:00", 18000, 30);
  fill("2026-10-16T19:35", "2026-10-16T23:55");
  silo.sort((a, b) => a.at.getTime() - b.at.getTime());
  ok("Eaten is the three runs, 4,000 each", siloBalance(silo, from, to) === 12000, String(siloBalance(silo, from, to)));
  ok("…and the 19:00 tanker after the close is the next day's, eating nothing", siloBalance(silo, ...siloDay("2026-10-17")) === 0);
}

// ── The unbooked list's likely transfers (17 Oct 2026, from production) ──
{
  const at = (s: string) => new Date(`${s}+05:30`);
  const mv = (s: string, kg: number) => ({ start: at(s), end: at(s), kg });
  // L2: two loads 90 minutes apart are one lorry, 18% under the mill.
  const l2 = likelyTransfers(
    [mv("2026-10-15T15:07", 4058), mv("2026-10-15T16:37", 2069), mv("2026-10-16T09:57", 5998), mv("2026-10-16T20:39", 5689)],
    [
      { number: "FT-00133", transferDate: "2026-10-15", quantityKg: 7430 },
      { number: "FT-00124", transferDate: "2026-10-16", quantityKg: 7430 },
      { number: "FT-00128", transferDate: "2026-10-16", quantityKg: 7120 },
    ],
  );
  ok("L2: three deliveries, the first in two loads", l2.length === 3 && l2[0]!.delivery.loads === 2 && Math.round(l2[0]!.delivery.kg) === 6127);
  ok("L2: each gets a transfer, none twice", new Set(l2.map((x) => x.likely?.number)).size === 3 && l2.every((x) => x.likely));
  ok("L2: the 15th's goes to the 15th", l2[0]!.likely?.number === "FT-00133" && l2[0]!.likely.daysOff === 0 && l2[0]!.likely.gapPct === -17.5);
  // L4: FT-00127 dated the 16th, arrived 09:28 on the 15th.
  const l4 = likelyTransfers([mv("2026-10-15T09:28", 11413)], [{ number: "FT-00127", transferDate: "2026-10-16", quantityKg: 11600 }]);
  ok("L4: a transfer dated a day late is offered, flagged", l4[0]!.likely?.number === "FT-00127" && l4[0]!.likely.daysOff === 1);
  // L3: 6,359 against 11,650 is not close — Enter it stays.
  const l3 = likelyTransfers([mv("2026-10-15T10:12", 6359)], [{ number: "FT-00135", transferDate: "2026-10-15", quantityKg: 11650 }]);
  ok("Nothing within a quarter: no likely transfer", l3[0]!.likely === null);
  const far = likelyTransfers([mv("2026-10-15T10:00", 7000)], [{ number: "FT-X", transferDate: "2026-10-13", quantityKg: 7000 }]);
  ok("Two days off: no likely transfer", far[0]!.likely === null);
}

console.log(failures ? `\n${failures} failure(s)` : "\nAll good");
process.exit(failures ? 1 : 0);
