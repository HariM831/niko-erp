"""
The egg benchmark, forecast by TimesFM 2.5.

A pure function: JSON on stdin, JSON on stdout, no database and no network
beyond the one-time weight download. The server owns the schema and the
credentials; this owns the model and nothing else. It can therefore be run by
hand against a file, which is how scripts/forecast/backtest.py uses it.

  echo '{"series":[{"date":"2026-01-01","value":4.5}, ...],"horizon":28}' \
      | .venv-timesfm/bin/python scripts/forecast/egg_price_forecast.py

TimesFM 2.5 (200M, Apache-2.0) rather than TimesFM 3: the 3.0 weights ship
under a non-commercial, non-production licence and this is a production farm.

── Why the model is not simply handed the rate ────────────────────────────

Because measured over 180 origins (Jul 2025 → Jan 2026, 28 days each) it is
worse than doing nothing when it is:

  flat (today's rate held)   MAE ₹0.3114
  TimesFM on the rate        MAE ₹0.3169   ← worse than a flat line
  TimesFM on the yoy delta   MAE ₹0.2380
  the same, anchored         MAE ₹0.2327   ← 25% better than flat

Egg prices run on one strong annual cycle. TimesFM 2.5 is univariate and has
no calendar; 2,048 days is five cycles for it to infer one from, and it does
not. Handing it the year-over-year difference — today against the same day
last year — gives it the seasonality and leaves it the part it is good at,
which is where the deviation from last year is heading. The forecast is then
rebuilt onto last year's known path.

Anchoring is the second half. A path rebuilt that way is free to start
somewhere other than where the market actually is, and tomorrow is not in
doubt: today's rate is the best guess for it. So the model's path is faded in
over the first week. Without it, h1-7 is 22% worse than a flat line; with it,
5.6% worse — while h15-28 stays 34% better.

── The festival calendar, and why it is off ───────────────────────────────

`"calendar": true` subtracts a fitted festival effect before the model sees
the series and adds back the effect of the days being forecast. It is
measured, and it is off by default, because over the same 180 origins it is
worth 0.7% — 0.16 paise an egg:

  yoy + anchor               MAE ₹0.2327   h15-28 ₹0.2836
  the same, + calendar       MAE ₹0.2311   h15-28 ₹0.2761

The long horizon does improve consistently, and week one consistently does
not. Two reasons the rest is so faint: this series is Zoho's *average invoice
price*, which has already smoothed a nine-day Navratri into its mean, and the
year-over-year framing is carrying most of the festival calendar anyway —
Diwali and Bihu land in nearly the same weeks each year. Worth re-testing the
day the input is a raw NECC daily quote.

in   {"series": [{"date": "YYYY-MM-DD", "value": 4.83}, ...],   # daily, dense
      "horizon": 28, "calendar": false}
out  {"model": "timesfm-2.5-200m-yoy", "contextDays": 2048,
      "anchorDate": "YYYY-MM-DD",
      "points": [{"date": ..., "p10": ..., "p50": ..., "p90": ...}, ...]}
"""

import json
import sys
from datetime import date, timedelta

MODEL_ID = "google/timesfm-2.5-200m-pytorch"
MODEL_NAME = "timesfm-2.5-200m-yoy"
# Recorded on every row, so a stored forecast says which framing made it.
MODEL_NAME_CAL = "timesfm-2.5-200m-yoy-cal"
# The window a festival's effect is measured against. 61 scored best of
# 31/61/91/121, and the spread between them was 0.8%.
DETREND_WINDOW = 61
# 2.5 takes up to 16k, but every doubling costs memory on a 4 GB box and the
# gain past a few annual cycles is not visible. 2,048 days is 5.6 years.
MAX_CONTEXT = 2048
MAX_HORIZON = 64
# 364, not 365: it keeps the weekday alignment a 365 would lose.
YEAR = 364
# Days over which the model's path is faded in from today's rate.
ANCHOR_DAYS = 7
# The yoy framing needs a year to difference against and enough left over to
# be a series. Below that there is no forecast worth drawing.
MIN_HISTORY = YEAR + 120

Q_LOW, Q_HIGH = 1, 9  # TimesFM returns [mean, q0.1, q0.2 … q0.9]


def main() -> None:
    req = json.load(sys.stdin)
    series = req["series"]
    horizon = int(req.get("horizon", 28))
    use_calendar = bool(req.get("calendar", False))
    if horizon < 1 or horizon > MAX_HORIZON:
        raise ValueError(f"horizon {horizon} outside 1..{MAX_HORIZON}")
    if len(series) < MIN_HISTORY:
        raise ValueError(f"{len(series)} day(s) of history; the seasonal framing needs {MIN_HISTORY}")

    # The caller hands us a dense daily series; trust but verify, because a
    # hole would be read by the model as a day that simply never happened,
    # and the yoy difference would be aligned to the wrong days.
    days = [date.fromisoformat(p["date"]) for p in series]
    for a, b in zip(days, days[1:]):
        if (b - a).days != 1:
            raise ValueError(f"series is not daily: {a} then {b}")

    import numpy as np
    import timesfm

    values = np.asarray([float(p["value"]) for p in series], dtype=np.float32)
    anchor = days[-1]
    future = [anchor + timedelta(days=h + 1) for h in range(horizon)]

    # Festivals out before the model, back in after — the only door a
    # univariate model leaves open for a covariate.
    calendar_adj = np.zeros(horizon, dtype=np.float32)
    if use_calendar:
        from calendar_effects import CalendarEffects

        effects = CalendarEffects(detrend_window=DETREND_WINDOW).fit(days, values.astype(np.float64))
        values = values - effects.adjust(days).astype(np.float32)
        calendar_adj = effects.adjust(future).astype(np.float32)

    last = float(values[-1])

    # Today against the same day last year, which is what the model sees.
    delta = (values[YEAR:] - values[:-YEAR])[-MAX_CONTEXT:]
    # Last year's same days ahead — history, and therefore known.
    back = np.asarray([values[-YEAR + h] for h in range(horizon)], dtype=np.float32)

    model = timesfm.TimesFM_2p5_200M_torch.from_pretrained(MODEL_ID)
    model.compile(
        timesfm.ForecastConfig(
            max_context=MAX_CONTEXT,
            max_horizon=MAX_HORIZON,
            normalize_inputs=True,
            use_continuous_quantile_head=True,
            force_flip_invariance=True,
            # A difference is signed, so nothing is claimed about its sign;
            # the quantiles are still ordered and saying so costs nothing.
            infer_is_positive=False,
            fix_quantile_crossing=True,
        )
    )

    point, quantiles = model.forecast(horizon=horizon, inputs=[delta])
    p50 = np.asarray(point)[0] + back
    q = np.asarray(quantiles)[0] + back[:, None]
    lo, hi = q[:, Q_LOW], q[:, Q_HIGH]

    # Fade in from today's rate over the first week.
    w = np.clip(np.arange(1, horizon + 1) / ANCHOR_DAYS, 0.0, 1.0)
    p50 = w * p50 + (1 - w) * last
    lo = w * lo + (1 - w) * last
    hi = w * hi + (1 - w) * last

    # Back onto the rate the market will see, festivals included.
    p50, lo, hi = p50 + calendar_adj, lo + calendar_adj, hi + calendar_adj

    points = []
    for h in range(horizon):
        band = sorted((float(lo[h]), float(p50[h]), float(hi[h])))
        points.append(
            {
                "date": future[h].isoformat(),
                "p10": round(band[0], 4),
                "p50": round(band[1], 4),
                "p90": round(band[2], 4),
            }
        )

    json.dump(
        {
            "model": MODEL_NAME_CAL if use_calendar else MODEL_NAME,
            "contextDays": int(len(delta)),
            "anchorDate": anchor.isoformat(),
            "points": points,
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()
