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
import { matchTankers, provenance } from "../server/services/house-day-autofill";
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
  const f = judgeStock(parts, 10695);
  ok("Book within 500 kg of the silo fills", f.status === "filled" && f.value === 12597, `${f.status} ${f.value}`);
  const g = judgeStock({ ...parts, unbookedKg: 7100 }, 10695);
  ok("An unbooked tanker stops the stock", g.status === "check" && g.value === null);
  const h = judgeStock({ ...parts, siloKg: 16434 }, 10695);
  ok("A 3.8 t gap stops the stock", h.status === "check");
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
  const p = provenance(auto, { feedConsumedKg: 10682, feedClosingKg: 12610, waterKl: 36.4 }, null, {});
  ok("Proven figures saved as offered need no reason", p.feedConsumedKg?.from === "silo" && p.feedClosingKg?.from === "book" && p.waterKl?.from === "controller");
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

console.log(failures ? `\n${failures} failure(s)` : "\nAll good");
process.exit(failures ? 1 : 0);
