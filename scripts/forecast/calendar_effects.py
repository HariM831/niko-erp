"""
What the festival calendar does to the egg rate, learned from the rate.

TimesFM 2.5 is univariate — it takes a series and nothing else. (Covariates
are a TimesFM 3 feature, and those weights are non-commercial.) So the
calendar goes in the only way it can: the festival effect is estimated from
history, subtracted before the model sees the series, and added back onto the
forecast for days whose festivals are already known — which is all of them,
the calendar being a calendar.

The estimate is a ridge regression of the *detrended* rate on two indicators
per festival class:

  during_<class>   the rate on the festival's own days
  after_<class>    the week following it, because a market that stopped
                   buying eggs for nine nights does not resume gently

Detrending is a centred 21-day median, so the regression sees the bump around
a festival rather than the level of the year it fell in. Ridge rather than a
plain mean per class because the classes overlap — Durga Puja sits inside
Navratri, Kati Bihu beside Diwali — and independent means would credit the
same rupee to both.

Fitted only on the data before the forecast origin. That is not a detail: fit
it on everything and the backtest is scoring a model that has seen the answer.
"""

from __future__ import annotations

import csv
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np

CALENDAR = "fixtures/india-holidays.csv"
DETREND_WINDOW = 21  # odd, centred
AFTER_DAYS = 7
# Pulls a class with few observations toward no effect at all. In days: a
# class seen 180 times is barely touched, one seen 10 times is halved.
RIDGE = 10.0


def load_calendar(path: str = CALENDAR) -> dict[date, frozenset[str]]:
    # Resolved against the repo as well as the working directory: the server
    # spawns this from the app root, a person runs it from wherever they are.
    found = Path(path)
    if not found.exists():
        found = Path(__file__).resolve().parents[2] / path
    by_day: dict[date, set[str]] = defaultdict(set)
    with open(found, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            by_day[date.fromisoformat(row["date"])].add(row["class"])
    return {d: frozenset(c) for d, c in by_day.items()}


def _detrend(values: np.ndarray, window: int) -> np.ndarray:
    """Value minus the centred median around it. Edges fall back to the mean."""
    n = len(values)
    half = window // 2
    out = np.empty(n, dtype=np.float64)
    for i in range(n):
        lo, hi = max(0, i - half), min(n, i + half + 1)
        out[i] = values[i] - np.median(values[lo:hi])
    return out


class CalendarEffects:
    """Festival effects in ₹/egg, fitted on one stretch of history."""

    def __init__(
        self,
        calendar: dict[date, frozenset[str]] | None = None,
        detrend_window: int = DETREND_WINDOW,
        ridge: float = RIDGE,
    ):
        self.calendar = calendar if calendar is not None else load_calendar()
        self.detrend_window = detrend_window
        self.ridge = ridge
        self.classes: list[str] = sorted({c for cs in self.calendar.values() for c in cs})
        self.beta: np.ndarray | None = None

    # ── the design matrix ────────────────────────────────────────────────
    def _columns(self, days: list[date]) -> np.ndarray:
        k = len(self.classes)
        x = np.zeros((len(days), 2 * k), dtype=np.float64)
        index = {c: i for i, c in enumerate(self.classes)}
        for row, d in enumerate(days):
            here = self.calendar.get(d, frozenset())
            for c in here:
                x[row, index[c]] = 1.0
            # The week after a festival, for classes not still running today.
            recent: set[str] = set()
            for back in range(1, AFTER_DAYS + 1):
                recent |= self.calendar.get(d - timedelta(days=back), frozenset())
            for c in recent - here:
                x[row, k + index[c]] = 1.0
        return x

    # ── fit / apply ──────────────────────────────────────────────────────
    def fit(self, days: list[date], values: np.ndarray, x: np.ndarray | None = None) -> "CalendarEffects":
        r = _detrend(np.asarray(values, dtype=np.float64), self.detrend_window)
        x = self._columns(days) if x is None else x
        xtx = x.T @ x + self.ridge * np.eye(x.shape[1])
        self.beta = np.linalg.solve(xtx, x.T @ r)
        return self

    def adjust(self, days: list[date], x: np.ndarray | None = None) -> np.ndarray:
        """₹/egg the calendar accounts for on each day. Zero before fitting."""
        if self.beta is None:
            return np.zeros(len(days))
        return (self._columns(days) if x is None else x) @ self.beta

    def columns(self, days: list[date]) -> np.ndarray:
        """The design matrix, so a caller with a long series can build it once."""
        return self._columns(days)

    def table(self) -> list[tuple[str, float, float]]:
        """(class, during ₹, after ₹) — for printing, and for arguing with."""
        if self.beta is None:
            return []
        k = len(self.classes)
        return [(c, float(self.beta[i]), float(self.beta[k + i])) for i, c in enumerate(self.classes)]
