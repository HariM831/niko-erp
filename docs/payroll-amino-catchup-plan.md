# Payroll — catching up with Amino (Aug 24 → Sep 16, 2026)

Five changes Amino made after niko's payroll was ported, each of which changes
what a person is paid or whether their day can be recorded at all. Source:
`HariM831/Amino-Farms` at `bd09fa4`. Nothing here is built yet; this is the
plan to agree first. Contract and principles stay those of `docs/payroll-plan.md`
— one people table, derive never store, IST everywhere.

Order of work: 2 → 1 → 4 → 3 → 5. Leavers first because arrears reuses its
"who is in this run" rule; advances and weekly-off are independent; the gate
is client-only.

One migration, `0096_payroll_catchup.sql`, carries every schema change below.

---

## 1. Advance recovery: the EMI is the only lever

**Amino `bc9be3b`, `cd9b896`.** HR recorded ₹2,000 against a ₹3,000 EMI meaning
"deduct less this month"; the run read it as a part payment and took the other
₹1,000 anyway. niko has the same arithmetic today
(`server/services/payroll.ts:148-156, 232`).

### Rule
- The run recovers `min(emiAmount, outstanding, pay left)` per advance, oldest
  first. It does not look at hand-entered repayments for the month.
- The run is the only writer of `advance_repayments`. Rows already entered by
  hand stay, still count towards outstanding, and show tagged **manual**.
- To deduct less, more, or nothing in a month, HR changes the EMI. To close an
  advance out, HR presses **Clear full balance next run**, which sets the EMI to
  the outstanding figure.

### Server
- `processRun`: delete the `manualReps` / `repaidThisMonth` block; `due` becomes
  `Number(adv.emiAmount)`.
- `PATCH /api/payroll/advances/:id` (`pay_inputs`): body `{ emiAmount }`,
  `0 ≤ emiAmount ≤ outstanding`, active advances only. An EMI of 0 is allowed
  and means "skip" — the run already `continue`s on a zero repay.
- Remove `POST /advances/:id/repay`.
- A draft run for the month needs no special handling: it is rebuilt on every
  Process, so a changed EMI applies the next time Process is pressed.

### Client (`pay-inputs.tsx`, Advances tab)
- Remove the Repay dialog.
- Advance row opens **Recovery**: given, recovered, outstanding; the repayment
  history (run month, or "manual"); an EMI field; and under it the schedule the
  figure implies — month by month from the next unconfirmed pay month until the
  balance is nil — redrawn as the figure is typed. Derived, not stored.
- **Clear full balance next run** fills the EMI with the outstanding amount.

### Decision needed
- **Cash handed back at the counter.** Amino removed it outright. If a worker
  does repay in cash, the honest entry is one that reduces the balance and
  leaves that month's EMI alone. Recommended: drop it as Amino did, and add the
  balance-only entry later if it is ever actually needed.

---

## 2. Leavers: a final slip, and nothing after the last day

**Amino `df99ea2`.** niko already has `dateOfLeaving`, the resolver already
returns nothing outside the service window, and proration already divides by
the whole month. Three holes remain.

### Rule
- A person is in the run for a month if they were on the rolls for any day of
  it: `dateOfJoining ≤ month end` **and** (`dateOfLeaving` is null **or**
  `≥ month start`) **and** (`isActive` **or** `dateOfLeaving` falls inside the
  month). Switching someone off after their last day no longer loses the days
  they worked; someone who left in an earlier month and was never switched off
  no longer gets an empty slip.
- A day outside the service window is never paid, whoever wrote the row.
- Zero paid days produces **no slip** and an exception, not an empty slip.
- Approved pay inputs for someone who gets no slip are an exception by name and
  amount, not a silent carry-over.

### Server
- One helper, `onRollsDuring(from, to)`, returning the SQL condition above;
  used by `processRun`'s staff query and by `recomputeRange`'s default set
  (`day-resolution.ts:412`), so the two cannot disagree.
- Out-of-window rows: `manual` and `import` rows are skipped by `writeRange`
  before the window check (`day-resolution.ts:350`), so an imported WO after the
  leaving date stays and is paid. Fix at the **read**, not by deleting: the
  totals queries (`monthTotals`, `wageDayTotals`, and the Time grid's query)
  join the employee and ignore days outside `[dateOfJoining, dateOfLeaving]`.
  Non-destructive on purpose — a mistyped leaving date, once corrected, brings
  HR's overrides back; a delete would not.
- `processRun`: skip the slip when `paidDays = 0` and no pay inputs and no
  arrears; leave the person's inputs `approved`.
- `runExceptions`: besides the per-slip checks, list (a) people on the rolls
  with no slip, as "No paid days — no slip", and (b) approved inputs for the
  month whose employee has no slip, as "₹X approved bonus not paid — no slip".

### Client
- None beyond the two new exception lines appearing in the run review. The
  leaving-date field and its before-joining check already exist.

---

## 3. Arrears: days earned in one month, paid in a later one

**Amino `6f75e27`.** Someone joins on 24 August; nobody runs a payroll for six
days; the money is paid with September. niko's only way to say that today is a
hand-typed bonus, which then sits in every bonus total.

### Shape
A new **kind** of pay input, not a new table. Amino split it out so bonus
reports would not count it; in niko every pay-input report already filters by
`kind`, so the split costs nothing and the lane — approve, the run picks it up,
stamps the run id, flips to paid, reverts with a re-processed draft — is
inherited whole.

### Schema
- `pay_input_kind` gains `arrears` (`ALTER TYPE … ADD VALUE`, which must run
  outside the migration's transaction block — own statement, first in the file).
- `pay_inputs` gains `earned_month int`, `earned_year int`, `days real` — null
  for every other kind; a check constraint requires the first two when
  `kind = 'arrears'` and that the earned month is before the pay month.
- `salary_slips` gains `arrears numeric(14,2) not null default 0`.

### Rule
- Amount suggested, not asked: `GET /api/payroll/arrears/suggest?employeeId&
  earnedMonth&earnedYear` runs the **same** `monthTotals` and the same
  proration as `processRun` for that month — salaried: each of basic, HRA,
  allowances × paid ÷ days in month, rounded separately; daily-wage: the
  per-day-role buckets × rate. Extracted into one function that both the run
  and the suggestion call, so they cannot drift. Returns `{ days, amount,
  working, existingSlip }`.
- `existingSlip` is the double-pay guard: if a slip already exists for the
  earned month, the dialog says so in plain words before the entry is made.
  A second arrears row for the same person and earned month is refused unless
  the first is rejected.
- Days and amount stay editable — attendance for a closed month can still
  change. Typing days re-prorates and shows its working; a reset returns to
  what attendance says.
- Arrears add to net pay and to the expense (salaried → `salary_expense`,
  daily-wage → `wages_expense`). They do **not** enter the PF, ESI or PT base
  of the pay month — Amino's rule, kept: the first partial month of a joiner
  carries no PF.
- A paid row is frozen, as every paid input already is.

### Server
- `processRun`: `arrears = sumKind("arrears")`; into `netBeforeAdvance`, the
  slip, and the run totals. `confirmRun`'s `earnings()` includes it.
- Create/edit routes accept the new kind with its three fields; the existing
  pending-edit route (`routes/payroll.ts:1359`) covers edits.
- Exception (from §2): approved arrears with no slip to land on.

### Client
- Pay Inputs gains an **Arrears** tab beside the others. Dialog: employee
  (defaulting to people who joined in the two months before the pay month, each
  with their joining date; search reaches anyone), earned month as one control
  bounded by joining month … month before pay month, then days and amount
  filled from the suggestion.
- Run review table and payslip show an Arrears line when non-zero; the salary
  register export gains the column.

---

## 4. A personal weekly off

**Amino `afe9aed`.** One person on the day shift rests on Wednesday, not Sunday.
Today that needs a cloned shift; the off day decides WO (paid) against A (not).

### Schema
- `shift_assignments.weekly_off_days int[]` — null means "the shift's own".
  An array, mirroring `shifts.weekly_off_days`, not a single day.

### Server
- `shiftForDate` returns the assignment alongside the shift;
  `isWeeklyOff(day, shift, override?)` uses the override when it is not null.
  An empty array is a real answer: no weekly off.
- `loadContext` selects the new column; assignment create/edit routes accept it
  (each day 0–6, no duplicates).
- Changing it recomputes that person from `effectiveFrom` to today, as an
  assignment change already does.

### Client
- The assign-shift dialog gains "Weekly off" — *Same as shift (Sun)* by
  default, or seven day chips. The assignment list shows the override where
  there is one.
- Out of scope: Amino's preview of future weekly offs on the calendar.

---

## 5. The gate: a way in when the scan cannot happen

**Amino `bbdbce0`.** niko's gate offers the name list only after a failed match
— deliberately (`gate.tsx:431`, "the fallback after a failed scan only"), so
that picking a name never becomes the quick way through. But if the camera is
refused or the face engine fails to load, there is no scan to fail, and nobody
can be recorded at all.

### Rule
- The deliberate part stays: while the camera and engine work, manual selection
  still appears only after a failed scan.
- When `engineState === "failed"` or `cameraError` is set, the gate shows
  **Record by name** in place of the capture button. It opens the existing
  manual dialog.
- Such a punch is `method = "manual"`, carries no embedding, and so teaches
  nothing — already true of `submitPunch` when no face was captured. With the
  camera up but the engine down, the photo is still taken for the audit trail.
- These punches already count in the face-failure report as manual, which is
  what they are.

### Server
- None.

---

## Not in this plan
Found in the same comparison and left for their own decisions: a wrong-person
guard on taught faces; Aadhaar duplicate block; searchable employee picker;
expense date ranges; canteen reports; night-shift handling; and two rules that
already differed at the port — Amino pays a half day in full and forgives a set
number of absences, niko does neither.

## Checks before it ships
- `scripts/check-payroll.ts` extended: EMI ignores a manual row; leaver
  switched off mid-month gets a slip for the days worked; imported WO after the
  leaving date is unpaid; zero-day person gets an exception and no slip;
  arrears suggestion equals the slip a run for that month would have produced,
  to the paisa; re-processing a draft does not pay arrears twice; an assignment
  override turns a Sunday A into P-or-A and a Wednesday into WO.
- Staging first, against a copy of production's people and punches.
