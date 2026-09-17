# Payroll — finishing the catch-up, and bringing Amino's history across

Two pieces of work, planned together because the second depends on the first:

- **Part 1 — the rest of what Amino has and niko lacks** (nine items).
- **Part 2 — Amino's payroll history into niko**, people included, so niko is the
  one place payroll lives.

Nothing here is built. Sources: `HariM831/Amino-Farms` at `bd09fa4`; niko at
`5c4cd3e`. `docs/payroll-amino-catchup-plan.md` covers the five items already
live (advance EMI, leavers, arrears, personal weekly off, record-by-name).

## Rulings already given (17 Sep 2026)

- A half day is paid as half a day. Amino paid it in full; niko does not.
- Absences are unpaid. No "permitted leaves" forgiveness.
- The browser Canteen Gate gets built.
- The Android phone app was a failure: nothing is built for it and none of its
  machinery (devices, pairing, tokens, operators, its face data) is migrated.
  Its code in niko is left alone.
- Attendance and canteen plates the phone app *recorded* come across as
  history — people were paid on them.

## Rulings still needed

Each has my recommendation; the plan below assumes it. Say which to change.
**1–4 were confirmed as recommended on 17 Sep 2026.** 5–12 stand on the
recommendation unless changed.

| # | Question | Recommendation |
|---|---|---|
| 1 | **Cutover.** Does Amino run September's payroll and niko start on 1 October, or does niko take over mid-September? | **1 October.** A mid-month switch puts niko's half-day rule on days people worked under Amino's. |
| 2 | **Leave on cutover day.** Amino credits the whole year's CL/SL on 1 January; niko accrues month by month. For someone who joined before 2026 that is 12 vs 9 CL today; the two meet on 31 December. | **Carry opening balances as they are, keep niko's monthly accrual**, and print every person's difference so nobody is surprised. |
| 3 | **Night shift.** Carry an exit after midnight back to the day the shift started — by a flat 16-hour rule (Amino's), or only when the person is on an overnight shift? | **Shift-aware.** The flat rule takes a day worker who forgot to punch out at 17:00 and turns his 08:00 return into a 15-hour shift. Applies to daily-wage workers too. |
| 4 | **A name picked by hand, with a face captured — may it teach the gallery?** Amino: never. niko today: always. | **Yes, but only if the face does not look like somebody else, and does look at least a little like the person picked.** The people who never auto-match are the ones teaching is for. |
| 5 | **After a failed scan, may people with no enrolled face be offered in the name list?** Today a new joiner cannot be punched at the gate at all. | **Yes, in their own "Not enrolled" group.** They could never have matched, so it opens no shortcut. |
| 6 | **Same Aadhaar on two people.** Two wage workers in Amino already share one. | **Block it, with a deliberate override** for whoever holds the employees permission. |
| 7 | **Canteen Gate:** guests and second plates from the browser? Breakfast/dinner for someone not on the list? | **No guests or second plates in the first version. Off-list: warn, serve, and record it** so it shows under Exceptions. |
| 8 | **Canteen report export** — CSV, or a real .xlsx (a new dependency)? | **CSV.** It opens in Excel and matches the bank-file export niko already has. |
| 9 | **May the gate's browser keep the face roster on the device between loads?** It saves a multi-MB download on every reload; it also means face data sits in that browser's storage. | **Yes, cleared on logout and refreshed daily.** |
| 10 | **Punch photos from Amino** — all (~200 MB), or only the ones niko itself would keep (manual punches and low-score matches)? | **Only those.** |
| 11 | **Expense claims approved in Amino but never paid** — pay them in niko's first run? | **Yes**, dated to niko's first open month, listed for you first. |
| 12 | **Wage workers' past pay.** Amino keeps no record of what wage workers were paid — its wages report prices days at today's rates. | **Days and punches only; no invented slips.** The money is in Zoho. |

---

# Part 1 — the remaining items

Build order is dependency order. One migration, `0097_payroll_completion.sql`,
carries every schema change in both parts.

## 1.0 Groundwork (S)

- `shared/face.ts`: `FACE_DIM = 1024`, `MATCH_THRESHOLD = 0.60`,
  `MATCH_MARGIN = 0.05`. Today the threshold is written down twice. niko's 0.60
  stays — Amino's 0.65 was never retuned; its August work found the *margin*
  was what rejected people.
- `isUsableEmbedding` also requires `length === FACE_DIM`. Enrolment accepts
  exactly 1024 numbers.
- Photo retention: niko tells devices "45 days" and clears nothing. The hourly
  tick that already prunes taught faces also nulls `punches.photo_url` and
  `canteen_servings.photo_url` older than 45 IST days. Rows stay.
- The canteen state label "Name matched" → "Manual", and both canteen tables
  render the shared label instead of the raw state.

## 1.1 Night shifts (M) — first, because it is broken today

**What is wrong now.** The gate files every punch under today. A 20:00 entry
and a 06:00 exit land on two dates: the first day ends on an open entry (a half
day and an exception), the second starts with a stray exit. And HR cannot fix
it: the Resolve dialog builds the exit time on the entry's date, 06:00 is
before 20:00, and the server refuses.

**Rule.** `punches.punch_date` is the day the *shift* belongs to, not the
calendar date. niko's Resolve route already writes the HR exit that way; only
the gate breaks it.

- A punch with no earlier punch today, where yesterday ended on an open,
  unresolved entry no more than 16 hours old — **and** (ruling 3) that person's
  shift yesterday was overnight (`endTime <= startTime`), or they have no shift
  and the entry was at 15:00 or later — is that shift's exit. It is stored under
  yesterday and yesterday is re-resolved. Sending "in" instead is refused:
  *"… is still IN from yesterday 20:04 (night shift) — next punch must be OUT"*.
- While that window is open, yesterday reads "present so far", not a half day,
  and is not listed as an exception.
- Because the pairing key is the stored date, the calendar, the team grid, the
  totals and the run all get it with no change to the resolver's pairing.

**Server.** `carryOverIn` and `punchDayFor` in `day-resolution.ts`;
`POST /punches` uses them; `ResolveContext` gains `now`; `/punches/open` skips
open entries inside the window; `/attendance/today` counts them as inside;
`GET /punches?date=&carryover=1` returns them for the gate. The Resolve route
gains a 24-hour cap. `rehomeStrayOuts(from, to)` — run by the existing
Recompute button — moves a stray leading exit back to the open entry it closes,
for history and for punches that arrive out of order.

**Client.** Gate: carried entries show "yesterday · night shift" and suggest
OUT. Resolve dialog: "Out was on the next day" checkbox, preset with 06:00 when
the entry was at 15:00 or later; a live "≈ N h → full / half / absent" line.

## 1.2 The gate's name list, and the wrong-person guard (M + S, one dialog)

**Wrong person.** `findFaceConflict(selectedId, embedding)` scores a captured
face against everyone's enrolment and taught captures. A conflict is another
person at ≥ 0.60 who beats the picked person by ≥ 0.05.

- Manual punch with a captured face and a conflict → **409**, nothing saved:
  *"This face looks like A (E012), not B. Pick the correct worker, or punch B
  without teaching."* The dialog reopens on the photo with the capture kept and
  a "Punch without teaching" button.
- Auto-matched punch with a conflict → the punch is saved, the face is not
  taught. A punch is never refused for this.
- (Ruling 4) A manual capture also teaches only if it scores ≥ 0.50 against the
  picked person's own gallery — the hole Amino's own diagnostic names: a face
  resembling nobody passes the conflict check. The punch and photo are saved
  either way; the response says `taught: true|false`.
- If the check itself fails, the punch goes through untaught.

**Name list.** `GET /employees/names` (gate permission): id, code, name,
`hasFace` for active people — no photos, no vectors. When scanning is
impossible the dialog lists everyone. After a failed scan it lists the enrolled
first, then (ruling 5) a "Not enrolled" group. Scanning also counts as
impossible when nobody is enrolled. `punches.manual_reason`
(`no_match | engine_failed | camera_blocked | not_enrolled`) so the face-failure
report stops counting a dead camera as a failed face.

## 1.3 Faster gate (S + S–M)

- Match index: unit vectors built once per roster change instead of every norm
  on every scan; Amino's later plain-array version (1.5×), with `dim` fixed at
  `FACE_DIM` rather than taken from the first vector seen. Lives in a DOM-free
  `shared/face-match.ts` so the Canteen Gate uses it and a check can prove it
  agrees with the plain matcher.
- (Ruling 9) The cursor-built roster is kept in IndexedDB with its cursor and a
  model tag; a reload fetches only changes. Full refresh after 24 h or a model
  change; cleared on logout.

## 1.4 Searchable employee picker (S–M)

One component, five forms. `EmployeeSelect` is rebuilt on niko's existing
`SearchSelect`, which gains: keep emp-code order; every typed word must appear
in "code name" (so `0114` finds codes containing it, not a dozen lookalikes);
an optional pinned group. The arrears dialog pins **Recent joiners** — joined
in the two months before the pay month, newest first, "joined 4 Aug" beside
each — and hides the rest until something is typed.

## 1.5 Expense claims: dates, and editing (S–M)

`pay_inputs.date_from` / `date_to`, reimbursements only; one date means a
one-day claim; backwards is refused. Required on new claims. The pay month
stays the explicit month — the dates describe, they do not drive the run.
A pending input gets an **Edit** button (the route exists; nothing calls it).
The edit's "still pending" test moves into the UPDATE itself, so an edit racing
an approval cannot move an approved amount; null in an edit means "unchanged".

## 1.6 Duplicate IDs, and what may be uploaded (S–M)

Aadhaar is compared as 12 digits, PAN as upper-case alphanumerics, on create,
edit (only when that field changes — so existing duplicates do not lock a
record) and per row in the import. (Ruling 6) **422**: *"A (E012) is already on
file with this Aadhaar number — reactivate or edit that person instead"*, with
an override for the employees permission. No unique index: Amino's data already
holds a shared number. Photos and documents must be real png/jpeg/webp/gif (or
PDF for documents) by their bytes, not their label.

## 1.7 Canteen (S + S–M + S + L)

- **Reports.** Month-by-month plates, newest first; a date range by meal with
  totals; `?format=csv`. Cost per plate stays.
- **Night-shift breakfast.** A shift is overnight when it ends at or before it
  starts. `canteen_meal_eligibility.breakfast_auto` is a separate flag the
  system alone writes; effective breakfast is `breakfast OR breakfast_auto`, so
  what HR set can never be disturbed — Amino needed a follow-up fix for exactly
  that. Re-evaluated on assignment change, on a shift's hours changing, and once
  a day (Amino only looked at the moment of the write, so a future-dated
  assignment granted nothing and an expired one never revoked).
- **Canteen Gate** (browser, the only recorder). New page and permission
  `canteen_punch`; either it or `canteen` opens the gate, and the gate's routes
  do not also demand `payroll.view`.
  - The **server** decides the meal from the clock (`mealForTime`: the window
    the time is in, else the nearest window edge, flagged outside-window). The
    browser sends no meal. Amino's bug — a 07:37 plate recorded as lunch while
    the page was still loading — cannot happen.
  - A plate: browser-minted id (a retry is the same plate), canteen, IST date,
    meal, person, `verified` or `name_matched`, score, token `WEB-xxxxxx`,
    outside-window, present-today, `served_by` = the logged-in user, no device.
    Second plate for the same meal → "already served at 07:41, token …".
  - Present-today also counts a night worker still inside from yesterday (1.1).
  - (Ruling 7) Off-list breakfast/dinner: warn, serve, mark `ineligible`.
  - `canteen_servings.device_id` stops being required, and the servings list
    stops inner-joining devices — otherwise browser plates exist and appear on
    no screen.

## 1.8 Face diagnostics (S)

The separation report skips wrong-length vectors (one today would turn it to
NaN), adds the mean-centred comparison and a salaried/daily-wage split, and
lists stored captures scoring under 0.50 against their owner's enrolment — with
who they look like.

## Checks

`check-payroll.ts`: a 20:00→06:00 shift is one full day on the first date and
one paid day in the run; 17 hours is not carried; a day worker's forgotten exit
is not carried; claim edits after approval refused; a null in an edit changes
nothing. New `check-face-guard.ts` (synthetic vectors): wrong length refused,
A's face under B refused by hand and untaught by scan, a stranger's face saved
but untaught. New `check-canteen.ts`: meal from clock at 07:37 / 10:30 / 23:30,
a client-sent meal ignored, duplicate and replay, the plate visible in the
list, off-list flagged, night worker present at 07:30, auto-breakfast granted
and withdrawn with HR's flags untouched. `check-employee-picker.ts`: the match
rule and the joiner cutoff across a year end. Everything on staging first, and
through the browser, as the last round was.

---

# Part 2 — Amino's history

## What is there

Amino's payroll is about ten weeks old: 118 of 121 employees were created in
July 2026, 59 of 64 wage workers in August. At most three runs. Small enough
that every export is a **full** export and every import an upsert — there is no
delta to get wrong.

## The central decision: how past days arrive

Amino stores attendance per person-month as a map of day → code, written by its
engine, by HR, and by a biometric spreadsheet (codes like `HLD`, `POW`,
`COMP OFF` and their misspellings). niko would resolve the same days
differently: half days, a forgotten exit, a holiday with a short punch, a wage
worker's lone punch. So history arrives as **both**:

- **Punches**, as evidence — every row, browser, phone and HR, each marked with
  where it came from.
- **Days**, as the answer — the export runs *Amino's own resolver* (a pure
  module, imported as-is) and emits one row per person-day; niko stores them
  with `source = 'import'`, which niko's resolver never touches. Coverage is
  every in-service day of every closed month, so niko can never write there.
  Leave codes become `L` with the raw code kept in the note.

**Slips are the record of what was paid** and are never recomputed. A confirmed
run with no journal already works in niko: the journal link is optional,
nothing sweeps for it, and a confirmed month refuses reprocessing. Imported
runs are inserted confirmed, **never through `confirmRun`**, so nothing posts —
those salaries are already in the books from Zoho.

## Mapping

| Amino | niko | Notes |
|---|---|---|
| employees, wage_workers, wage_roles | employees, wage_roles | Existing import, fixed: carries `date_of_leaving`; **inserts new people and reports differences for existing ones** instead of overwriting what HR has edited in niko. |
| — | `amino_id_map` (new, droppable) | Wage workers get `W-0001…` by enrolment order; one deleted worker would shift every later code and attach history to the wrong person. The map is anchored once and everything resolves through it. |
| departments, designations, shifts, holidays | same | Holidays de-duplicated; unique (date, name) added. |
| shift_assignments | shift_assignments | **Amino's empty off-day list means "use the shift's"; niko's means "no weekly off".** Empty → null. |
| attendance_punches, wage_punches | punches | `source` = `amino_browser / amino_phone_legacy / amino_phone_unified / amino_hr`; Amino row id → `client_id` (idempotent). Amino's UTC-without-zone timestamps exported with an explicit `Z`. Face vectors: none imported. Photos per ruling 10. |
| attendance_records, wage_day_overrides | attendance_days (`import`) + JSON archive | As above. Monthly total columns archived, not imported — Amino's own payroll never reads them. |
| leave_applications | leave_applications | Inserted directly; `approveLeave` would recompute over imported days. |
| employee_bonuses, _overtime, salary_arrears, expense_claims | pay_inputs | Claims have no pay month in Amino: a paid one takes its run's month, an unpaid one niko's first open month (ruling 11). Claim dates land in 1.5's new columns. |
| employee_advances, advance_repayments | advances, advance_repayments | Outstanding is derived in niko. Where Amino's stored balance disagrees with its own repayments (an old clamp bug), one labelled balancing row is written and printed. |
| payroll_runs, salary_slips | same | `processed` → `confirmed`; drafts reported, not imported. Run gross recomputed niko's way (Amino's excludes bonus/overtime); both printed. PT and TDS live only in Amino's breakdown JSON: PT is lifted out, the rest becomes other deductions, and `net = earnings − deductions` is asserted per slip. The breakdown and name/department snapshot go in `salary_slips.legacy`. `payroll_runs.imported_from` lets the screen say "Imported from Amino — journalised in Zoho". |
| salary_components | JSON archive | Earning components never affected pay in Amino. Per-person PT/PF overrides and TDS have no home in niko; the export counts whether any exist. |
| canteens, meal windows, eligibility, servings | same | Eligibility rows may be keyed by emp code (an Amino fix never migrated old rows): resolve by id, then code. Servings keep their source; operators and PINs are not migrated, so the one-plate index is rebuilt to ignore imported rows. |
| devices, pairing codes, tokens, requests, operators | **not migrated** | Per your ruling. |

## The two scripts

- **Amino repo:** `scripts/export-payroll-history-for-niko.ts`. Read-only, one
  repeatable-read transaction, `SET TIME ZONE 'UTC'`. Output
  `payroll-export/` — one JSON with a manifest and counts by source, the
  resolved days, an identity block; `archive/`; `photos/`; `docs/`. No token or
  PIN hashes, no face vectors. **It has to be run on Replit**, by you or
  Kishore; I will ask before pushing it to that repository.
- **niko:** `scripts/check-payroll-export.ts` (reconcile the file against
  itself), then `scripts/import-payroll-history-from-amino.ts` — dry by default,
  `--apply`, one transaction. Refuses if niko already holds its own punches or
  days on or before the export's last day, or a run for an imported month.

**Order:** migration → people top-up → id map → masters and shifts → leave →
punches → days → advances → pay inputs → runs and slips → canteen. Then
recompute the closed months and assert it wrote **nothing**; the only real
recompute is the open month.

## How you check it

Printed side by side, Amino against niko: per month, slips, gross (both
definitions), net, deductions, advance recovery; per person-month, resolved paid
and unpaid days against the slip, with the half-day count that explains any
gap; punches by month and source; advance outstanding per person; leave earned,
used and balance under both accrual rules; plates by month and source; and
everything skipped — unknown day codes, unmapped ids, duplicate holidays. Each
line is something you can hold against one of Amino's own screens.

## Cutover

Freeze in Amino from the export until niko is live: no payroll processing, no
attendance spreadsheet upload, no HR overrides, no leave approvals, no gate
punches. A later top-up is just the export run again. Amino prunes punch photos
daily at 45 days, so the longer the wait, the fewer there are to bring.

## Cannot be known without Amino's database

Row counts; how many runs and their status; punches and plates by source;
whether day codes exist beyond the known list; whether stored advance balances
agree with their repayments; whether anyone is on TDS or a PT other than ₹200;
whether any wage worker was deleted. The export prints all of these — so the
first thing it produces is a **report to read before anything is imported**.

---

## Sequence

1. Part 1, in the order above, to staging; checks and a browser pass; production.
2. The export script → you run it on Replit → read its report together.
3. Import into staging; you compare against Amino's screens; then production
   on the cutover date.
