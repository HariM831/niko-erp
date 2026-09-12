"""
Does TimesFM beat doing nothing?

Two questions, both answered against the imported benchmark history and
neither against the future:

  1. The held-out month. Cut the last 28 days off, forecast them from what
     came before, and put the forecast next to what actually happened.
  2. Walk-forward. Do the same from many origins across the last year, so the
     answer is not one lucky month.

Scored against what somebody would otherwise do — hold today's rate flat, hold
last week's average, and two versions of "the same weeks last year" — because
a foundation model that cannot beat a flat line on a slow-moving series has
not earned a place on the home page. Scored separately at 7, 14 and 28 days,
because those are the three the tile offers and they are not one question.

  .venv-timesfm/bin/python scripts/forecast/backtest.py
  .venv-timesfm/bin/python scripts/forecast/backtest.py --contexts 512,2048
"""

import argparse
import csv
import json
import sys
from datetime import date, timedelta

import numpy as np

from calendar_effects import CalendarEffects, load_calendar

# A Windows console is cp936/cp1252 and this prints ₹ and box rules.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

CSV = "fixtures/egg-benchmark-history.csv"
MODEL_ID = "google/timesfm-2.5-200m-pytorch"
HORIZON = 28
BUCKETS = [(1, 7), (8, 14), (15, 28)]
YEAR = 364  # keeps the weekday alignment a 365 would lose
ANCHOR_DAYS = 7  # days over which the model's path is faded in from today's rate
CAL = None       # the festival calendar, loaded once in main()
DETREND = 61     # the window the festival effect is measured against


def load_dense(path):
    """The CSV, gaps carried forward — the series the business reads."""
    rows = []
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            rows.append((date.fromisoformat(r["date"]), float(r["rate_per_egg"])))
    rows.sort()
    out, i, carried = [], 0, rows[0][1]
    day = rows[0][0]
    while day <= rows[-1][0]:
        while i < len(rows) and rows[i][0] == day:
            carried = rows[i][1]
            i += 1
        out.append((day, carried))
        day += timedelta(days=1)
    return out


def mae(pred, actual):
    return float(np.mean(np.abs(np.asarray(pred, float) - np.asarray(actual, float))))


def scored(pred, actual):
    """MAE overall and per horizon bucket, plus bias and MAPE."""
    pred, actual = np.asarray(pred, float), np.asarray(actual, float)
    err = pred - actual
    out = {
        "mae": float(np.mean(np.abs(err))),
        "mape": float(np.mean(np.abs(err) / actual) * 100),
        "bias": float(np.mean(err)),
    }
    for a, b in BUCKETS:
        out[f"h{a}-{b}"] = mae(pred[a - 1 : b], actual[a - 1 : b])
    return out


def baselines(context, horizon):
    """What somebody would do without a model."""
    last = float(context[-1])
    out = {
        "flat (last rate)": np.full(horizon, last),
        "7-day mean": np.full(horizon, float(np.mean(context[-7:]))),
    }
    if len(context) > YEAR + horizon:
        year_ago = np.asarray([context[-YEAR + h] for h in range(horizon)], float)
        out["last year"] = year_ago
        # The shape of last year's same weeks, started from today's rate. On a
        # series with one strong annual cycle this is the baseline to beat.
        out["seasonal delta"] = last + (year_ago - float(context[-YEAR - 1]))
    return out


def forecast_batch(model, contexts, horizon, max_context, variant="raw", frames=None):
    """
    One batch through the model, in one of several framings.

    raw     — the rate itself.
    log     — the log of it, exponentiated back. A rate that moves in
              percentages rather than paise is a rate the model should see
              multiplicatively.
    yoy     — the year-over-year difference, added back onto last year's known
              path. TimesFM 2.5 has no notion that this series repeats annually
              and 2,048 days is only five cycles for it to infer one from; this
              hands it the seasonality instead of asking it to find it.
    +anchor — fade the path in from today's rate over the first week.
    +cal    — subtract the fitted festival effect before the model sees the
              series and add back the effect of the days being forecast, whose
              festivals are already known. TimesFM 2.5 cannot take a covariate,
              so this is the only door the calendar has.

    `frames` carries per-context (context_days, future_days, context_columns,
    future_columns) for the +cal framing — the design matrix is built once by
    the caller over the whole series and sliced, because rebuilding it per
    origin costs more than the forecast does.
    """
    calendar_adj = []
    if variant.endswith("+cal"):
        adjusted = []
        for (c, frame) in zip(contexts, frames):
            ctx_days, fut_days, ctx_x, fut_x = frame
            fit = CalendarEffects(calendar=CAL, detrend_window=DETREND).fit(
                ctx_days, np.asarray(c, dtype=np.float64), x=ctx_x
            )
            adjusted.append(np.asarray(c, dtype=np.float32) - fit.adjust(ctx_days, x=ctx_x).astype(np.float32))
            calendar_adj.append(fit.adjust(fut_days, x=fut_x).astype(np.float32))
        contexts = adjusted
        variant = variant[: -len("+cal")]

    prepared, rebuild = [], []
    for c in contexts:
        c = np.asarray(c, dtype=np.float32)
        if variant == "raw":
            prepared.append(c[-max_context:])
            rebuild.append(np.zeros(horizon, dtype=np.float32))
        elif variant == "log":
            prepared.append(np.log(c[-max_context:]))
            rebuild.append(np.zeros(horizon, dtype=np.float32))
        elif variant.startswith("yoy"):
            d = c[YEAR:] - c[:-YEAR]
            prepared.append(d[-max_context:])
            # Last year's same days, which are history and therefore known.
            rebuild.append(np.asarray([c[-YEAR + h] for h in range(horizon)], dtype=np.float32))
        else:
            raise ValueError(variant)

    point, quant = model.forecast(horizon=horizon, inputs=prepared)
    point, quant = np.asarray(point), np.asarray(quant)
    if variant == "log":
        point, quant = np.exp(point), np.exp(quant)
    elif variant.startswith("yoy"):
        back = np.stack(rebuild)
        point = point + back
        quant = quant + back[:, :, None]

    if variant.endswith("+anchor"):
        # Reconstructing through last year's path leaves the forecast free to
        # start somewhere other than where the market actually is. Tomorrow is
        # not in doubt — today's rate is the best guess for it — so the model's
        # path is faded in over the first week rather than joined abruptly.
        last = np.asarray([float(np.asarray(c)[-1]) for c in contexts], dtype=np.float32)[:, None]
        w = np.clip(np.arange(1, horizon + 1) / ANCHOR_DAYS, 0.0, 1.0)[None, :]
        point = w * point + (1 - w) * last
        quant = w[:, :, None] * quant + (1 - w[:, :, None]) * last[:, :, None]

    if calendar_adj:
        # Back onto the rate the market will actually see, festivals included.
        back = np.stack(calendar_adj)
        point = point + back
        quant = quant + back[:, :, None]
    return point, quant


def build(max_context, batch):
    import timesfm

    model = timesfm.TimesFM_2p5_200M_torch.from_pretrained(MODEL_ID)
    model.compile(
        timesfm.ForecastConfig(
            max_context=max_context,
            max_horizon=HORIZON,
            normalize_inputs=True,
            use_continuous_quantile_head=True,
            force_flip_invariance=True,
            infer_is_positive=True,
            fix_quantile_crossing=True,
            per_core_batch_size=batch,
        )
    )
    return model


def table(rows, title):
    print(f"\n{title}")
    head = f"{'':<20}{'MAE':>9}{'MAPE':>8}{'bias':>9}" + "".join(f"{f'h{a}-{b}':>9}" for a, b in BUCKETS)
    print(head)
    print("-" * len(head))
    best = min(rows, key=lambda k: rows[k]["mae"])
    for name, r in sorted(rows.items(), key=lambda kv: kv[1]["mae"]):
        line = (
            f"{name:<20}{r['mae']:>9.4f}{r['mape']:>7.2f}%{r['bias']:>+9.4f}"
            + "".join(f"{r[f'h{a}-{b}']:>9.4f}" for a, b in BUCKETS)
        )
        print(line + ("  ←" if name == best else ""))


def main():
    global CAL, DETREND
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default=CSV)
    ap.add_argument("--origins", type=int, default=180, help="walk-forward origins, one per day back")
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--contexts", default="2048", help="comma-separated context lengths to compare")
    ap.add_argument(
        "--variants",
        default="raw",
        help="comma-separated: raw, log, yoy, yoy+anchor, and any of those +cal",
    )
    ap.add_argument("--detrend", type=int, default=DETREND, help="festival effect window, in days")
    ap.add_argument("--json", help="write the numbers here as well")
    args = ap.parse_args()

    contexts = [int(c) for c in args.contexts.split(",")]
    variants = args.variants.split(",")

    DETREND = args.detrend
    if any(v.endswith("+cal") for v in variants):
        CAL = load_calendar()
    series = load_dense(args.csv)
    days = [d for d, _ in series]
    vals = np.asarray([v for _, v in series], dtype=np.float32)
    print(f"{len(vals)} daily points, {days[0]} → {days[-1]}")

    report = {"series": {"points": len(vals), "from": days[0].isoformat(), "to": days[-1].isoformat()}}

    # One design matrix over the whole series; every origin slices it. Built
    # here because rebuilding it per origin costs more than the model does.
    columns = CalendarEffects(calendar=CAL, detrend_window=DETREND).columns(days) if CAL else None

    def frame(o: int):
        """(context days, forecast days, and their rows of the design matrix)"""
        return (days[:o], days[o : o + HORIZON], columns[:o], columns[o : o + HORIZON])

    models = {c: build(c, args.batch) for c in contexts}

    # ── 1. The held-out month ─────────────────────────────────────────────
    cut = len(vals) - HORIZON
    context, actual = vals[:cut], vals[cut:]
    print(f"\n══ Held-out month: {days[cut]} → {days[-1]}, forecast from {days[cut - 1]} ══")

    rows, held = {}, {}
    for c, model in models.items():
        for variant in variants:
            point, quant = forecast_batch(model, [context], HORIZON, c, variant, [frame(cut)] if CAL else None)
            p50 = point[0]
            lo = np.minimum(quant[0][:, 1], quant[0][:, 9])
            hi = np.maximum(quant[0][:, 1], quant[0][:, 9])
            name = f"TimesFM {variant} ctx {c}"
            rows[name] = scored(p50, actual)
            rows[name]["coverage"] = float(np.mean((actual >= lo) & (actual <= hi)) * 100)
            held[(c, variant)] = (p50, lo, hi)
    for name, b in baselines(context, HORIZON).items():
        rows[name] = scored(b, actual)

    wide = (max(contexts), variants[0])
    p50, lo, hi = held[wide]
    print(f"{'day':<12}{'actual':>9}{'TimesFM':>10}{'err':>8}{'p10':>8}{'p90':>8}")
    for h in range(HORIZON):
        print(
            f"{days[cut + h].isoformat():<12}{actual[h]:>9.3f}{p50[h]:>10.3f}"
            f"{p50[h] - actual[h]:>+8.3f}{lo[h]:>8.3f}{hi[h]:>8.3f}"
        )
    print(f"(the run shown above is {wide[1]} ctx {wide[0]})")
    table(rows, "Held-out month, ₹/egg:")
    for name, r in rows.items():
        if "coverage" in r:
            print(f"  {name}: p10–p90 held {r['coverage']:.0f}% of days")
    report["heldout"] = {"from": days[cut].isoformat(), "to": days[-1].isoformat(), "methods": rows}

    # ── 2. Walk-forward ───────────────────────────────────────────────────
    origins = [o for o in (len(vals) - HORIZON - k for k in range(args.origins)) if o > YEAR + 60]
    print(f"\n══ Walk-forward: {len(origins)} origins, {days[min(origins)]} → {days[max(origins)]} ══")

    acc = {name: [] for name in baselines(vals[: origins[0]], HORIZON)}
    cover = {}
    for c, model in models.items():
        for variant in variants:
            name = f"TimesFM {variant} ctx {c}"
            acc[name] = []
            cover[name] = []
            for i in range(0, len(origins), args.batch):
                chunk = origins[i : i + args.batch]
                point, quant = forecast_batch(
                    model, [vals[:o] for o in chunk], HORIZON, c, variant, [frame(o) for o in chunk] if CAL else None
                )
                for j, o in enumerate(chunk):
                    a = vals[o : o + HORIZON]
                    lo = np.minimum(quant[j][:, 1], quant[j][:, 9])
                    hi = np.maximum(quant[j][:, 1], quant[j][:, 9])
                    acc[name].append(scored(point[j], a))
                    cover[name].append(float(np.mean((a >= lo) & (a <= hi)) * 100))
                sys.stdout.write(f"\r  {name}: {min(i + args.batch, len(origins))}/{len(origins)} origins")
                sys.stdout.flush()
            print()

    for o in origins:
        a = vals[o : o + HORIZON]
        for name, b in baselines(vals[:o], HORIZON).items():
            acc[name].append(scored(b, a))

    rows = {
        name: {k: float(np.mean([s[k] for s in ms])) for k in ms[0]}
        for name, ms in acc.items()
        if ms
    }
    table(rows, f"Walk-forward over {len(origins)} origins, ₹/egg:")
    for name, cv in cover.items():
        print(f"  {name}: p10–p90 held {float(np.mean(cv)):.0f}% of days (80% nominal)")

    flat = rows["flat (last rate)"]
    for name in [k for k in rows if k.startswith("TimesFM")]:
        tf = rows[name]
        print(f"\n{name} against a flat line:")
        for key in ["h1-7", "h8-14", "h15-28", "mae"]:
            d = (flat[key] - tf[key]) / flat[key] * 100
            label = "overall" if key == "mae" else key
            print(f"  {label:<8} {'better' if d > 0 else 'WORSE '} by {abs(d):>5.1f}%   (₹{tf[key]:.4f} vs ₹{flat[key]:.4f})")

    report["walkforward"] = {
        "origins": len(origins),
        "from": days[min(origins)].isoformat(),
        "to": days[max(origins)].isoformat(),
        "methods": rows,
        "coverage": {k: float(np.mean(v)) for k, v in cover.items()},
    }

    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2)
        print(f"\nwritten to {args.json}")


if __name__ == "__main__":
    main()
