"""
Does the forecast need to know when Dussehra is?

The live forecast (raw + Kolkata, backtest.py) is scored over the last 180
days, which in October 2026 hold no Sharad Navratri at all. This scores it
where the question is: every origin from ten days before each Sharad Navratri
to three weeks after its Dussehra, 2020–2025, 28 days ahead.

Against it, the Dussehra-aligned path. Navratri walks through the calendar by
up to three weeks a year, so a "same weeks last year" seasonal step lands on
the wrong side of it. Aligned on Dussehra instead: for an origin k days from
this year's Dussehra, every earlier year's change from Dussehra+k to
Dussehra+k+h is averaged and added on — the shape of a post-Dussehra market,
learned only from years before the origin.

  timesfm            the live model's framing (raw)
  timesfm+dus        the same, plus the aligned path shrunk by `--shrink`
  dussehra-aligned   today's rate plus the aligned path, no model
  flat, seasonal delta (by calendar date) — the baselines

  .venv-timesfm/Scripts/python scripts/forecast/backtest_festival.py --csv bench.csv
"""

import argparse
import csv
import sys
from datetime import date, timedelta

import numpy as np

import backtest as bt

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

H = bt.HORIZON
BEFORE, AFTER = 10, 21  # origins: Navratri start − BEFORE … Dussehra + AFTER


def load(path):
    """date,rate[,source] with or without a header, gaps carried forward."""
    rows = []
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.reader(f):
            if not r or r[0] == "date":
                continue
            rows.append((date.fromisoformat(r[0]), float(r[1])))
    rows.sort()
    out, i, carried, day = [], 0, rows[0][1], rows[0][0]
    while day <= rows[-1][0]:
        while i < len(rows) and rows[i][0] == day:
            carried = rows[i][1]
            i += 1
        out.append((day, carried))
        day += timedelta(days=1)
    return out


def festivals(path="fixtures/india-holidays.csv"):
    """Dussehra, and the first day of the Sharad Navratri before it, per year."""
    dus, nav = {}, {}
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            d = date.fromisoformat(r["date"])
            if r["name"] == "Dussehra":
                dus[d.year] = d
            if r["name"] == "Sharad Navratri":
                nav[d.year] = min(nav.get(d.year, d), d)
    return dus, nav


def aligned_path(vals, dus_idx, o, year, years_before):
    """Mean change over the next H days of earlier years, aligned on their Dussehra."""
    k = o - dus_idx[year]
    paths = []
    for y in years_before:
        if y not in dus_idx:
            continue
        a = dus_idx[y] + k
        if a - 1 < 0 or a + H > len(vals):
            continue
        base = vals[a - 1]  # the day before the aligned origin, as `last` is for the model
        paths.append(vals[a : a + H] - base)
    return np.mean(paths, axis=0) if paths else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True)
    ap.add_argument("--shrink", default="0.5,1.0", help="weights on the aligned path added to the model")
    ap.add_argument("--batch", type=int, default=16)
    args = ap.parse_args()
    shrinks = [float(s) for s in args.shrink.split(",")]

    series = load(args.csv)
    days = [d for d, _ in series]
    vals = np.asarray([v for _, v in series], dtype=np.float32)
    idx = {d: i for i, d in enumerate(days)}
    dus, nav = festivals()
    dus_idx = {y: idx[d] for y, d in dus.items() if d in idx}
    print(f"{len(vals)} days, {days[0]} → {days[-1]}; Dussehra on file: {', '.join(str(d) for y, d in sorted(dus.items()) if d in idx)}")

    model = bt.build(2048, args.batch)
    names = ["flat (last rate)", "seasonal delta", "timesfm"] + [f"timesfm+dus×{s:g}" for s in shrinks] + ["dussehra-aligned"]
    per_year = {y: {n: [] for n in names} for y in range(2020, 2026)}
    for y in range(2020, 2026):
        if y not in dus_idx or y not in nav or nav[y] not in idx:
            continue
        lo, hi = idx[nav[y]] - BEFORE, dus_idx[y] + AFTER
        origins = [o for o in range(lo, hi + 1) if o + H <= len(vals)]
        prior = [p for p in sorted(dus_idx) if p < y]
        for i in range(0, len(origins), args.batch):
            chunk = origins[i : i + args.batch]
            point, _ = bt.forecast_batch(model, [vals[:o] for o in chunk], H, 2048, "raw")
            for j, o in enumerate(chunk):
                actual = vals[o : o + H]
                last = float(vals[o - 1])
                base = bt.baselines(vals[:o], H)
                path = aligned_path(vals, dus_idx, o, y, prior)
                path = np.zeros(H, dtype=np.float32) if path is None else path
                cands = {
                    "flat (last rate)": base["flat (last rate)"],
                    "seasonal delta": base.get("seasonal delta", base["flat (last rate)"]),
                    "timesfm": point[j],
                    "dussehra-aligned": last + path,
                }
                for s in shrinks:
                    cands[f"timesfm+dus×{s:g}"] = point[j] + s * path
                for n in names:
                    per_year[y][n].append(bt.scored(cands[n], actual))
        sys.stdout.write(f"\r  {y}: {len(origins)} origins, {len(prior)} earlier Dussehra(s) to learn from")
        print()

    def avg(ms, k):
        return float(np.mean([m[k] for m in ms]))

    print("\nMAE ₹/egg, origins from 10 days before Navratri to 21 days after Dussehra, 28 days ahead")
    head = f"{'':<22}" + "".join(f"{y:>8}" for y in per_year) + f"{'all':>8}{'h1-7':>8}{'h8-14':>8}{'h15-28':>8}"
    print(head)
    print("-" * len(head))
    allm = {n: [m for y in per_year for m in per_year[y][n]] for n in names}
    for n in sorted(names, key=lambda n: avg(allm[n], "mae")):
        line = f"{n:<22}" + "".join(f"{avg(per_year[y][n], 'mae'):>8.3f}" if per_year[y][n] else f"{'-':>8}" for y in per_year)
        line += f"{avg(allm[n], 'mae'):>8.3f}" + "".join(f"{avg(allm[n], k):>8.3f}" for k in ("h1-7", "h8-14", "h15-28"))
        print(line)
    tf = avg(allm["timesfm"], "mae")
    for n in names:
        if n != "timesfm":
            d = (tf - avg(allm[n], "mae")) / tf * 100
            print(f"  {n:<22} {'better' if d > 0 else 'worse '} than timesfm by {abs(d):.1f}%  (bias {avg(allm[n], 'bias'):+.3f})")


if __name__ == "__main__":
    main()
