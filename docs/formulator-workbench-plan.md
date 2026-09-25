# Formulator workbench — plan

Agreed 24 Sep 2026 from the mockup "Formulator Workbench" (a private artifact
built on staging's Layer 1). The solver screen becomes a workbench: the live
recipe and the solved mix side by side, against the standard, with the cost of
the difference and every reason a solve can go wrong shown before it does.

## Why

Read off staging's Layer 1 on 24 Sep 2026:

- The live recipe misses 11 of the Layer 1 standard's 12 nutrients, and the
  screen could not say so — it showed nothing until Solve.
- A least-cost solve drops the premix, salt and sodium bicarbonate to 0%: no
  bound in the standard needs them, so to the solver they are pure cost. The
  saved lines carry no limits, so a solve quietly removed the vitamins.
- Editing a solved percentage re-analysed nothing — neither nutrients nor cost.
- Nothing compared the solved mix with the recipe it would replace.
- Unpriced and unanalysed materials surfaced only after Solve, as footnotes.

## Decisions

1. **Additives start locked.** A formula line whose item carries no value for
   any nutrient the standard bounds — premix, salt, sodium bicarbonate, a
   pigment — opens locked at its amount in the live recipe. That is exactly the
   set a least-cost solve would otherwise drop. Any lock can be undone.
2. **Locks are saved.** A lock is an inclusion limit with min = max; it travels
   on the formula line like any other limit, so the next version opens locked.
3. **Easing a bound is for this solve only.** When a solve fails, the screen
   offers to re-solve with the clashing nutrient eased to what the materials
   reach. The standard is never changed. A mix saved from an eased solve says
   so in the save dialog.

## Server

- `POST /api/feed/formulator/analyse` — `{ stage, itemIds, mix }` → the mix's
  nutrients against the standard, its cost (for `feed_mill.costs` holders),
  and per material: name, whether it is a feed ingredient, whether it has a
  price, how many nutrients are on file, and whether it contributes to any
  bounded nutrient. Same prices and profiles as the solve, so a figure on the
  screen never disagrees with one the solver would produce.
- `solve` accepts `ease: { [nutrient]: { min?, max? } }`, applied for that
  solve only, and returns the bounds it was held to with `eased` listing what
  moved.
- A locked material is solved even without a price (fixed at its percentage,
  costed at zero, and reported as unpriced) and even when not marked a feed
  ingredient — a lock is a decision to include it, and dropping it would
  change the recipe behind the user's back.

## Screen

- A sticky bar: formula and version, the stage, cost per finished kg now →
  solved with the difference per tonne, Solve and Save.
- Readiness chips before Solve: no price, no nutrients on file, not a feed
  ingredient, how many locked.
- Materials: ₹/kg, lock, min, max, now %, solved % (editable), change bar.
- Against the standard: asked (eased shown), now, solved, a strip with both
  marks on the nutrient's window.
- A failed solve highlights the clashing rows and offers "try with this bound
  eased" and "add a material".
- Below: what the new version changes, and each left-out material's
  break-even price against today's.
- History tab and the save dialog stay as they are.

## Not in this

- Editing the standard from this screen.
- Scenarios saved side by side.
- Any change to production or costing.

## What the solve is held to (25 Sep 2026)

The solve binds six figures only: ME, calcium, available phosphorus, dig.
lysine, dig. Met+Cys and crude fibre (`SOLVE_ON` in shared/feed.ts). Every
other figure in the standard is worked out for the live and solved mix and
shown under "Checked" as met or not met, in amber, never red. It never binds
and never blocks a solve.

- **Met+Cys** is derived: a material's methionine plus cystine, and the
  standard's methionine plus cystine rows (the loader stored cystine as
  (Met+Cys) − Met, so the sum is the guide's figure).
- **Crude fibre** is a ceiling on bulk, so it is not scaled with intake. The
  Hy-Line guide gives no fibre figure. Until a maximum is set in Settings ›
  Feed Standards the row shows the mix's fibre with "no limit set".
- **Additives open locked** when they carry none of the six (or are marked
  fixed-dose). Threonine or valine sources would now open locked too.
- **Watch for uncapped supplements.** With cystine no longer held on its own,
  DL-Methionine (3,564 kcal/kg on file, above maize) is an energy source to
  the solver. An energy-starved solve with no cap on it pours it in: Layer 1
  eased to the frontier came out 57% DL-Methionine. A max on its formula line
  (0.5% tried) gives a sane answer.
