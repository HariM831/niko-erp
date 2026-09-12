"""
The calendar the egg market actually runs on, written out once as a fixture.

Egg demand in India is moved by festivals far more than by the Gregorian
calendar: nine days of Navratri empty the shelves of eggs, Durga Puja and
Bihu fill them again. Most of those dates are lunar and move ten to twenty
days a year, which is exactly what the forecast's year-over-year framing
cannot see — last year's Diwali is not aligned with this year's.

Source is the `holidays` package (India, subdivision AS for Assam), which
carries proper lunar tables well past 2030. What it does not carry, and the
market cares about, is derived or fixed here:

  navratri    nine days ending the day before Dussehra, and the nine ending
              at Ram Navami. The two biggest demand troughs of the year.
  durga_puja  Dussehra − 5 … Dussehra. Assam's own fortnight, and a feast.
  shravan     the vegetarian lunar month. APPROXIMATE: anchored off
              Janmashtami (Bhadrapada Krishna Ashtami), so it is the 30 days
              ending nine days before it. Within a day or two, not exact.
  bihu_bohag  13–16 April, and bihu_kati 17–18 October: Assamese solar dates,
              fixed in the Gregorian year, and absent from the package.

The output is committed so that production never depends on the package —
and so a wrong date can be corrected by hand, which matters more than
regenerating cleanly.

  .venv-timesfm/bin/python scripts/forecast/build_holiday_calendar.py
"""

import csv
import sys
from datetime import date, timedelta

import holidays

OUT = "fixtures/india-holidays.csv"
FROM_YEAR, TO_YEAR = 2018, 2032
SUBDIV = "AS"  # Assam: the farm's market, and Bihu with it

# Everything the package names, mapped onto the handful of classes the market
# reacts to. A festival not listed here lands in "public" — a day off, which
# on its own barely moves a rate.
CLASS_OF = {
    "Diwali (Deepavali)": "diwali",
    "Dussehra": "durga_puja",
    "Holi": "holi",
    "Magh Bihu": "bihu_magh",
    "Id-ul-Fitr": "eid",
    "Id-ul-Zuha (Bakrid)": "eid",
    "Christmas": "christmas",
}


def span(a: date, b: date):
    d = a
    while d <= b:
        yield d
        d += timedelta(days=1)


def main() -> None:
    rows: dict[tuple[str, str], str] = {}  # (date, class) → name, so a day can carry two

    def put(d: date, cls: str, name: str) -> None:
        rows.setdefault((d.isoformat(), cls), name)

    for year in range(FROM_YEAR, TO_YEAR + 1):
        cal = holidays.India(subdiv=SUBDIV, years=year)
        named: dict[str, date] = {}
        for d, names in sorted(cal.items()):
            for name in names.split("; "):
                named.setdefault(name, d)
                put(d, CLASS_OF.get(name, "public"), name)

        # ── Derived windows ────────────────────────────────────────────────
        dussehra = named.get("Dussehra")
        if dussehra:
            # Navratri: the nine nights that end the day before Vijayadashami.
            for d in span(dussehra - timedelta(days=9), dussehra - timedelta(days=1)):
                put(d, "navratri", "Sharad Navratri")
            # Durga Puja proper: Shashthi through Dashami.
            for d in span(dussehra - timedelta(days=5), dussehra):
                put(d, "durga_puja", "Durga Puja")

        ram_navami = named.get("Ram Navami")
        if ram_navami:
            for d in span(ram_navami - timedelta(days=8), ram_navami):
                put(d, "navratri", "Chaitra Navratri")

        janmashtami = named.get("Janmashtami (Vaishnava)")
        if janmashtami:
            # Approximate — see the module docstring.
            end = janmashtami - timedelta(days=9)
            for d in span(end - timedelta(days=29), end):
                put(d, "shravan", "Shravan (approx)")

        diwali = named.get("Diwali (Deepavali)")
        if diwali:
            for d in span(diwali - timedelta(days=2), diwali + timedelta(days=1)):
                put(d, "diwali", "Diwali week")

        magh = named.get("Magh Bihu")
        if magh:
            for d in span(magh - timedelta(days=1), magh + timedelta(days=1)):
                put(d, "bihu_magh", "Magh Bihu")

        # Assamese solar dates the package does not carry.
        for d in span(date(year, 4, 13), date(year, 4, 16)):
            put(d, "bihu_bohag", "Bohag Bihu")
        for d in span(date(year, 10, 17), date(year, 10, 18)):
            put(d, "bihu_kati", "Kati Bihu")

        # The turn of the year, when the market is closed as much as feasting.
        for d in span(date(year, 12, 24), date(year, 12, 31)):
            put(d, "christmas", "Christmas–New Year")
        put(date(year, 1, 1), "christmas", "New Year's Day")

        for name in ("Id-ul-Fitr", "Id-ul-Zuha (Bakrid)"):
            if name in named:
                for d in span(named[name] - timedelta(days=1), named[name] + timedelta(days=1)):
                    put(d, "eid", name)

    with open(OUT, "w", newline="\n", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["date", "class", "name"])
        for (d, cls), name in sorted(rows.items()):
            w.writerow([d, cls, name])

    classes: dict[str, int] = {}
    for (_, cls) in rows:
        classes[cls] = classes.get(cls, 0) + 1
    print(f"{OUT}: {len(rows)} day-classes, {FROM_YEAR}–{TO_YEAR}", file=sys.stderr)
    for cls, n in sorted(classes.items(), key=lambda kv: -kv[1]):
        print(f"  {cls:<12} {n:>5} days  ({n / (TO_YEAR - FROM_YEAR + 1):.0f}/yr)", file=sys.stderr)


if __name__ == "__main__":
    main()
