# Head items and sub-types: compound feed and eggs

The ask: compound feeds (the formula outputs — Chick, Grower, Layer 1,
Prelayer) should sit under a head item **Poultry Feed**; eggs are **purchased
ungraded** and **sold graded** (Jumbo, Large, Medium, Small, Extra Large), and
the graded SKUs belong under one head too. A plan, not code.

---

## 1. The mechanism: a parent pointer, nothing more

Add `items.parentItemId` — a nullable self-reference, exactly the pattern
`locations.parentLocationId` already uses for bays inside a mill. An item with
children is a **head item**; an item with a parent is a **sub-item**. No
variants table, no jsonb options, no SKU matrix: two levels is what the
business has, and a pointer models it.

Rules that make it safe rather than decorative:

- **A head item does not transact.** No bill line, no stock movement, no
  formula line may name an item that has children. The head is a label over
  its children, and letting both carry stock would double-count the moment
  someone posts to the wrong level. Enforced in `resolveLineAccounts` /
  `moveStock` with a named refusal ("Poultry Feed groups five feeds — pick
  one").
- **One level deep.** A sub-item cannot itself be a parent. A grandchild is
  the first step toward a variant matrix nobody asked for.
- **Sub-items inherit the head's category** (and the head's accounts as
  defaults) so a family cannot straddle two categories.
- Existing screens change little: the items list groups children under their
  head (indent or a "part of" chip); pickers show sub-items only, since heads
  cannot transact.

## 2. Compound feed under "Poultry Feed"

- The existing **Poultry Feed** item becomes the head. It currently carries no
  stock and no open documents, so converting it to a non-transacting head is
  free. ("Chick Feed", purchased finished feed, likely joins as a child too.)
- The four formula outputs — Chick, Grower, Layer 1, Prelayer — get
  `parentItemId = Poultry Feed`. Nothing else about them changes: they stay
  the tracked items production receives into and transfers draw from.
- Formulas keep pointing at the **sub-item**, never the head — the head-item
  rule above makes this automatic.
- Payoff: "how much compound feed do we hold" is a rollup over one parent id;
  the feed group on any report is a join, not a name-pattern match.

## 3. Eggs: purchased ungraded, sold graded

Today's master has the family scattered: `Egg's (Purchases)`, `Egg's Jumbo`,
`Egg's Large`, `Egg's Medium`, `Egg's Small`, `Eggs — Extra Large` (two naming
styles, one near-duplicate pair of Layer Birds items sits beside them).

- Head item **Eggs** (produce). Children: the five graded SKUs, normalised to
  one naming style (`Eggs — Jumbo` … `Eggs — Extra Large`), all `isSold`,
  priced by the daily benchmark when Sales lands.
- **`Egg's (Purchases)` stays a separate child** flagged `isPurchased` — it is
  the ungraded inbound stream (bought eggs and, later, own lay from Farms).
  Purchased eggs are never sold as-is; they exist to be graded.
- **Grading is a document, not a rename.** A small Farms-module document
  (GRD-xxxxx): input, N ungraded eggs; output, counts per graded SKU;
  difference, breakage written off by name. Stock moves via the same
  `postInventoryMovement` seam production uses — ungraded out, graded in,
  value apportioned by count, breakage to an expense account. Until Farms
  exists this can live as a stub under Inventory.
- Own lay (Farms, later) receives into the same ungraded child, so grading
  has one inlet whatever the source.

## 4. Sequence

| Step | What | Size |
|---|---|---|
| H1 | `parentItemId` migration + head-item transact guard + inherit rules | small |
| H2 | Items list grouping; parent picker on the item form (heads only) | small |
| H3 | Poultry Feed family wired (data, no schema) | trivial |
| H4 | Eggs family wired + names normalised | trivial |
| H5 | Grading document (ungraded → graded + breakage) | medium — the only real build |

H1–H4 are an afternoon. H5 is the one with accounting in it and is genuinely
Farms work; building it as a stub earlier only if grading can't wait.

## 5. Open questions

1. **Does "Poultry Feed" the purchasable item die?** Plan assumes it becomes a
   pure head. If loose poultry feed is still sometimes bought as itself, it
   needs a "Poultry Feed — bought" child instead.
2. **Dirty/cracked eggs** — Amino's invoices carry a `Dirty` grade. Sixth
   child, or breakage? Affects the grading document's outputs.
3. **The Layer Birds near-duplicate** (`…Bovans)` vs `…Bovans).`) — merge
   candidates once heads exist; one likely deactivates.
4. **Does grading value by count or by weight?** Count is simpler and matches
   how the mill sells; weight is truer. Plan assumes count.
