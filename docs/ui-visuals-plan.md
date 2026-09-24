# Shared visuals — plan and component contract

The UI audit of 13 Sep 2026 produced about a hundred and fifty places where a
picture or a simpler layout would beat the table that is there now. Almost all
of them are one of six shapes. Three of the six already exist, each private to
one page: Home draws its own sparkline and progress bar, the item quality spec
draws its own pass / warn / reject band, and house detail draws its own
actual-vs-standard lines. This document is the contract for making those six
shared, so that every later placement is a call, not a drawing.

The audit itself (which screen, which suggestion, effort, whether the data is
already on the page) lives in the published niko UI Audit artifact; this
document covers only the components.

## Principles

- **Tokens, not hex.** Every shared visual takes its colours from the ramps in
  `index.css` — `brand-*`, `soil-*`, `success`, `warning`, `destructive` — so
  the five accent themes carry through. The one exception stays as it is:
  `iot-widgets.tsx` and `shed-conditions.tsx` copy the shed controller's own
  palette in literal hex, because they are re-creations of the vendor's
  screens. New farm charts follow those two files; new charts anywhere else
  follow the tokens.
- **Zoho screens draw only what Zoho draws.** On invoices, bills, customers,
  vendors, banking, budgets and assets a primitive goes where Zoho Books shows
  the same thing (its ageing bar, its PO received-vs-ordered bar, its
  depreciation schedule). Each such placement is read off the real Zoho screen
  first, per the standing rule. Placements marked *Zoho* below are gated on
  that look.
- **No new dependency.** Bars and strips are divs and inline SVG. recharts,
  already in the bundle, is used only for time series.
- **Every visual has an empty state.** Pullet houses P1 and P2 hold no birds;
  a benchmark may have no history; a new flock has no movements. A primitive
  with nothing to draw renders a one-line note in `text-soil-400`, never an
  empty box or a chart of zeros.
- **Colour is never the only encoding.** Every segment, band and marker carries
  its label and number as text (visible or in a `title`), so the meaning
  survives a phone in sunlight and a screen reader.
- **Numbers keep their formatting.** The caller formats (`formatMoney`, a
  unit, a percentage); the primitive lays out. `tabular-nums` throughout.
- **Nothing changes on screen in the first commit.** Home, the quality spec
  and house detail are refactored onto the shared components and must look
  exactly as they do today. That is the test that the primitives are right.

## The six

All in `client/src/components/ui/`, next to `kpi-card.tsx`.

### 1. `ProportionBar` — one strip, parts of a whole

```
<ProportionBar
  segments={[{ label: "Overdue", value: 3194, tone: "danger", display: "₹31.94 cr" }, …]}
  total?     // defaults to the sum; pass it when a remainder should show as a soil-100 gap
  legend?    // "below" (default) | "none" | "inline" (label inside a segment wide enough)
  height?    // 8px default, 6px in a table cell
  onSegment? // (segment) => void — makes segments clickable (the list filters)
/>
```

Segments keep the order given. Tones: `neutral` (soil ramp, stepped so
adjacent segments differ), `brand`, `success`, `warning`, `danger`. A
segment under 4% of the strip gets no inline label and a 2px minimum width
so it is not lost. The legend is label, then display value, in the segment's
tone.

Used as a waterfall too: goods value → deductions → net payable is a
`ProportionBar` whose segments are given in flow order with the deductions in
`warning`. No separate waterfall component.

### 2. `FractionBar` — how much of one thing

```
<FractionBar value max tone? label? over? />
```

A filled share of a track. `value > max` draws the excess as a `danger` tail
past the 100% mark when `over` is `"tail"` (a truck overrunning its PO line,
a budget overspent) or clips at 100% when `over` is `"clip"` (default). The
optional label sits to the right as `value / max` in the caller's format.
Replaces Home's private `Bar` (five callers) with no visible change.

### 3. `BandStrip` — a reading on a min / warn / max track

```
<BandStrip
  lo hi                                  // the axis
  bands={[{ from, to, tone }]}           // coloured stretches, in axis units
  marker?     markerLabel?               // the reading, drawn as ▲ with its value
  ticks?      // [{ at, label, tone? }] — target, warn-at, reject-at
/>
```

Lifted out of `item-quality-spec.tsx`. That file keeps its `axisOf` /
`bandsOf` logic (which side of the axis is "good" for a min-type parameter)
and hands the result to `BandStrip`; its `BandBar` becomes that adapter.
`BandStrip` knows nothing about quality specs, so the same strip carries a
nutrient's min–max requirement with the solved value as the marker, a stock
level against its reorder point, and a shed's days of feed left.

### 4. `Sparkline` — a small line with one emphasised end

```
<Sparkline
  points={[{ x: "2026-09-01", y: 4.83 }, …]}
  width? height?                         // 320 × 60 default; fills its box via viewBox
  band?       // [{ x, lo, hi }] — a shaded range (the forecast p10–p90)
  dashedFrom? // x after which the line is dashed (the forecast tail)
  reference?  // a y drawn as a faint dashed rule (the shed's standard lay %)
  end?        // "dot" (default) | "none"
/>
```

Lifted from `home.tsx`. Home keeps its horizon buttons and its rule about
which forecast days count, and calls the shared `Sparkline` to draw. Benchmark
history, a shed's fourteen-day lay %, a statement's running balance and the
weighbridge indicator's settling weight are the same call with different
points.

### 5. `StandardLine` — actual against the breed standard, over age or time

```
<StandardLine
  data xKey actualKey standardKey
  unit                                   // "g", "ml", "%", "kg"
  xLabel?  height?                       // 250px default
  tooltip? // (row) => string — the house charts add the age week here
/>
```

A recharts `LineChart` wrapper: solid `brand-600` actual with dots, grey
dashed standard with `connectNulls`, the `3 3` grid, the widened `Tooltip`
cast that house detail already carries. House detail's three charts become
three calls; the weekly management summary, body weight, flock cumulative
mortality and the live preview in Breeds & Standards are the same call.

### 6. Totals and group rows — a `ListPage` footer

Not a component. `ListPage` already groups rows (`groupBy`, `groupOrder`)
and `EggOrdersTable` already has a `tfoot`. `ListPage` gains

```
footer?: Partial<Record<keyof T | string, ReactNode>>   // one cell per column key
groupFooter?: (group: string, rows: T[]) => Partial<Record<string, ReactNode>>
```

rendered as a sticky `tfoot` in `table-head` styling, and a subtotal row at
the end of each group. Tables that are not `ListPage` (the loading bay, the
statement, the movements table) add a plain `tfoot` in the same style.

## Where they go first

The full placement list is in the audit. The first module passes use them
here; *ready* means the page already fetches the data, *Zoho* means the
placement is read off the Zoho screen before it is built.

| Primitive | First placements |
|---|---|
| ProportionBar | Invoices and Bills ageing under the Payment Summary (*Zoho*, ready); customer and vendor overview ageing (*Zoho*, ready); Vendor Sheet overdue split (ready); Home finance tile payables ageing (ready); payroll present / absent / not seen (ready); egg size mix on Egg stock (ready); yard spots on the Feed Mill overview (ready); settlement waterfall (ready); Stock on Hand opening → in → out → closing (ready) |
| FractionBar | Invoice paid / total and bill paid / total on the detail (*Zoho*, ready); PO line delivered / ordered on the detail (ready) and on the list (*Zoho*, needs a summed field); gate truck against the PO line's remainder (ready); advance repaid (ready); face enrolment done (ready); asset life consumed (*Zoho*, ready); batch liveability (ready) |
| BandStrip | QC parameters at the weighbridge (ready); solver nutrient requirements (ready); reorder level in Stock on Hand (ready); feed cover on the Houses board (ready); slip-vs-platform variance (ready) |
| Sparkline | Benchmark history with forecast (ready); lay % per shed on the Houses board (ready); statement running balance on customer and vendor (ready); platform weight settling (ready); net pay by month on the Payroll overview (ready) |
| StandardLine | Weekly management summary hen-day % and cumulative mortality (ready); body weight on house detail (ready); curve preview in Breeds & Standards (ready); flock cumulative mortality (needs a dated series) |
| Footer | Loading bay loaded-today totals; statement debit / credit totals; movements totals; Vendor Sheet by vendor; receipts by day; farm store by category |

## Deliberately left out

- **No gauge or ring beyond Home's.** The lay-rate dial is the hero's and stays
  private; a ring elsewhere would be decoration.
- **No heatmap primitive.** The egg calendar already tints its day tiles; the
  benchmark coverage strip is a row of `FractionBar`s at 100% or 0%.
- **No chart on an entry form.** Journals, expenses, payments and the line-item
  form get a `FractionBar` at most (allocated against amount on the payment
  form) and nothing else.
- **No change to the shed palette.** `iot-widgets.tsx` keeps its literal hex.
- **No dashboard library, no new chart library.**

## Order of work

1. `ProportionBar`, `FractionBar`, `BandStrip`; refactor Home's `Bar` and the
   quality spec's `BandBar` onto them. One commit, no visible change.
2. `Sparkline` and `StandardLine`; refactor Home and house detail onto them.
   One commit, no visible change.
3. `ListPage` footer and group footer, first used on the Vendor Sheet grouped
   by vendor.
4. Then the modules, each with its own agreed list: Farms, Sales, Payroll,
   Feed Mill, then the books screens after the Zoho look.

Each step deploys to staging and is checked in the browser before the next.
