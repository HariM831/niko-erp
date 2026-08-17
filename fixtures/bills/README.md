# Bill extraction fixtures

Real vendor bills, and what `POST /api/ocr/extract-bill` must return for each.
`expected.json` holds the ground truth; the images sit beside it.

## Images to add

| File | Bill | Status |
|---|---|---|
| `shayan-517.jpg` | Shayan Enterprise 517 · truck AS 01 EC 2633 · 24,380 kg | **needed** |
| `shayan-518.jpg` | Shayan Enterprise 518 · truck AS 26 AC 1223 · 40,790 kg | **needed** |

Save the photographs under exactly these names. `expected.json` keys off them,
so a fixture with no image is a skipped test rather than a silent pass.

Keep them as photographs of the paper — the same angle, glare and creases a
guard's phone produces at a barrier. A flat, cropped, perfectly lit scan tests
a case that never happens.

## Why these two

Both are bills of supply from the same vendor, and both carry the conventions
that make naive reading dangerous:

- The **Qnty column is a bag count** — `401 PM`, `666 Pkt` — not a weight.
- The **billed weight is handwritten** in the particulars cell: `wt 24380`, `wt 40790`.
- The **rate is per quintal**, so per-kg has to be derived.
- **"Party Name: Amino Farms" is the buyer.** The vendor is the letterhead.

Read naively, the bag count lands in quantity and the receipt is wrong by
roughly a factor of sixty.

Reconciliation resolves all of it at once, which is why it is computed
server-side and never claimed by the model:

```
quantityKg / 100 × ratePerQuintal == amount

517:  24,380 / 100 × 2310 = 5,63,178  ✓
518:  40,790 / 100 × 2310 = 9,42,249  ✓
```

On 517 the rate's middle digit is genuinely ambiguous between 2310 and 2810;
only 2310 closes the arithmetic. That is the whole argument for reconciling
rather than trusting a confident read.

## Still missing

A genuine **multi-row** bill. Both of these are single-line, so nothing here
exercises line splitting or a footing check across several rows — and multi-line
is the case the receipt model was rebuilt for. Add one before trusting the
extractor on a mixed load.

Also worth adding eventually: a tax invoice with GST printed on it, so the
tax-folded-into-cost path (see `docs/procurement-plan.md` §3) has a real example
rather than a hypothetical one.

## Running

Extraction is not built yet — this folder is the acceptance criteria it will be
written against. It needs `GEMINI_API_KEY` in `.env`.
