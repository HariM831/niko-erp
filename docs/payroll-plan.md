# Payroll — plan and API contract

Ported from Amino's payroll, redesigned lean. Schema: `shared/schema/payroll.ts`,
`shared/schema/devices.ts` (migration `0081_payroll`). This document is the contract
the server routes and the client pages are both written against.

## Principles

- **One people table.** `employees.pay_type` is `salaried` or `daily_wage`. Daily-wage
  people carry `wage_role_id` (rate card) and no salary. Everything else — gate,
  attendance, canteen, leave, pay inputs, the run — is pay-type blind unless stated.
- **Attendance is a row per employee-day** (`attendance_days`), written by the resolver.
  Precedence: **punch > holiday > approved leave > weekly off > absent**. A manual HR
  override (`source = manual`) survives recomputes. Punching in on a holiday/weekly-off
  makes the day present (and comp-off eligible).
- **Derive, never store** what can be summed: month totals, advance outstanding,
  leave balances.
- **IST everywhere.** `istDate()` for today; punch dates computed server-side.
- **Permissions**: module `payroll`, actions `view | employees | attendance | pay_inputs |
  run | gate | canteen | devices | settings` (see `shared/permissions.ts`). Every route
  declares its guard with `requirePermission("payroll", action)`.
- **Money is numeric(14,2) strings** from Drizzle; routes return numbers where the
  client needs arithmetic.

## Day resolution (`server/services/day-resolution.ts`)

```
resolveDay(tx, employee, day, ctx) → { status, source, workedHours }
```
- `ctx` preloaded for a range: punches by (employee, day), holidays map (recurring
  expanded), approved leaves, shift assignments + shifts.
- Hours: pair punches chronologically in→out (stray `out` ignored; consecutive `in`s keep
  the earliest). `≥ fullDayHours` → P, `≥ halfDayHours` → H, else (punches but short) → H
  if any pair, A if only an open `in` before today ends… keep Amino's rule: any worked
  interval < half → A. An open `in` on a past day with no `out` → treated as H and listed
  in exceptions.
- No punches: holiday → HO; approved leave covering the day → L; shift weekly-off day → WO;
  otherwise A. Days before `date_of_joining` or after `date_of_leaving` → no row.
- `recomputeEmployeeDay(tx, employeeId, day)` and `recomputeRange(tx, from, to, employeeIds?)`
  upsert `attendance_days`, skipping rows whose `source = manual` or `import`.
- Paid days for a month = P + 0.5·H + WO + HO + L. LOP = A.

## Payroll run (`server/services/payroll.ts`)

`processRun(tx, { month, year, userId })`:
1. Refuse if a `confirmed` run exists for the month. If a draft exists: revert its side
   effects (delete its `advance_repayments`, set its `pay_inputs` back to `approved` with
   `payroll_run_id = null`), delete its slips, reuse the row.
2. Recompute attendance for the month for all active employees, then per employee:
   - `totalDays` = days in month; counts from `attendance_days`.
   - **salaried**: `earnedX = X × paidDays / totalDays` for basic/HRA/allowances.
   - **daily_wage**: `dailyRate` from the role; `earnedBasic = earnedGross = rate × (P + 0.5·H)`;
     no HRA/allowances, no PF/ESI unless the employee flags are on.
   - Pay inputs with status `approved` for the month: bonus, overtime, reimbursement sum
     into earnings; `deduction` → `otherDeductions`. Mark them `paid` with the run id.
   - PF: if `pfEnabled`: base = min(earnedBasic, ceiling or ∞); employee % and employer %.
   - ESI: if `esiEnabled` and earnedGross ≤ esiGrossCeiling: employee %, employer % of earnedGross.
   - PT: first slab whose `upTo` ≥ earnedGross (null = open) → `amount`.
   - `netBeforeAdvance = earnedGross + bonus + overtime + reimbursement − (pf + esi + pt + other)`.
   - Advances: active advances oldest first; recover `min(emi, outstanding, remaining net)`;
     write `advance_repayments` with the run id; close the advance when outstanding hits 0.
   - `netPay`, `totalDeductions` (pf + esi + pt + other + advance), slip inserted.
3. Run totals: gross, deductions, net, employerCost = gross + pfEmployer + esiEmployer.

`confirmRun(tx, runId, userId)` posts ONE journal dated the last day of the month,
source `payroll_run`, reference `PAY-YYYY-MM` (number from series `payroll_run`):
```
Dr salary_expense        Σ earnedGross + bonus + overtime + reimbursement   (salaried slips)
Dr wages_expense         Σ same                                              (daily_wage slips)
Dr pf_employer_expense   Σ pfEmployer
Dr esi_employer_expense  Σ esiEmployer
Cr pf_payable            Σ pfEmployee + pfEmployer
Cr esi_payable           Σ esiEmployee + esiEmployer
Cr pt_payable            Σ professionalTax
Cr salary_payable        Σ netPay + otherDeductions + advanceRecovery
```
(Other deductions and advance recovery stay in salary payable: they are money the company
keeps, already expensed; advances were paid out as an asset movement when given — see below.)
Zero lines are skipped. Sets `status = confirmed`, `journal_entry_id`.
A confirmed run cannot be deleted; a draft can (reverts side effects).

Giving an advance is recorded in `advances` only (cash goes out through a normal payment/
expense the accountant books); recovery reduces salary payable as above.

## Leave (`server/services/leave.ts`)

Balance for a year: CL earned = `clPerMonth × months from max(DOJ, Jan 1) to now` capped 12,
plus `openingCl`; SL likewise capped 6. Comp-off earned = days with status P on a holiday/
weekly-off (source punch) not yet consumed; each must be used within `compOffValidityDays`.
Balance = earned − approved days this calendar year. Validation: CL ≤ `clMaxConsecutive`
consecutive; comp-off needs `compOffWorkDate` in the past and within validity.
Approving writes `attendance_days` (status L, source leave) for the range unless a punch row
or a manual row already exists; rejecting/cancelling removes those rows and recomputes.
An approval also overrides an `import` row — a bulk-imported month must not silently outrank
a decision about specific days, or the approval is invisible and the month still pays LOP.
The consequence: the imported status of an approved day is not recoverable if the leave is
later rejected; the day falls back to what the resolver says (absent, unless a punch exists),
and HR can mark it by hand.

## Session routes — `server/routes/payroll.ts`, mounted `/api/payroll` (after `requireAuth`)

All list endpoints return `{ rows, total }` with `limit`/`offset` when the table grows
(punches, attendance, servings); small masters return plain arrays.

### Masters (`settings` to write, `view` to read)
- `GET/POST /departments`, `PATCH /departments/:id` — `{ id, name, isActive, designations: [{id,name,displayOrder,isActive}] }`
- `POST /departments/:id/designations`, `PATCH /designations/:id` (name, displayOrder, isActive)
- `GET/POST /wage-roles`, `PATCH /wage-roles/:id` — `{ id, name, dailyRate:number, isActive, headcount }`
- `GET/POST /shifts`, `PATCH /shifts/:id`
- `GET /shift-assignments?employeeId|active=1`, `POST /shift-assignments` (closes the open one at from−1), `DELETE /shift-assignments/:id`
- `GET /holidays?year=`, `POST /holidays`, `PATCH /holidays/:id`, `DELETE /holidays/:id`
- `GET /settings`, `PATCH /settings` — the singleton

### Employees (`employees`)
- `GET /employees?q=&department=&payType=&active=1|0` → list WITHOUT photo/docs/descriptor:
  `{ id, empCode, name, payType, department, designation, wageRole, dailyRate, location, dateOfJoining, contactNumber, basicSalary, hra, allowances, gross, pfEnabled, esiEnabled, isActive, hasPhoto, hasFace, shift }`
- `GET /employees/:id` → full row (+ photoUrl, docs, faceEnrolledAt; never the descriptor)
- `POST /employees`, `PATCH /employees/:id` — bump `updatedAt`; `photoHash` maintained when photoUrl changes
- `POST /employees/:id/face` `{ descriptor:number[] }` (gate), `DELETE /employees/:id/face`
- `GET /employees/gallery` (gate) → `[{ id, empCode, name, payType, faceDescriptor, photoUrl }]` for active employees with a face — the kiosk's in-browser gallery
- `POST /employees/import` — rows `[{ empCode, name, payType, department, designation, ... }]`, upsert by empCode

### Punches & attendance (`attendance`; `gate` for the kiosk punch)
- `POST /punches` `{ employeeId, type?, method:'face'|'manual', matchScore?, latitude?, longitude?, accuracyM?, photoUrl? }`
  — type defaults to the opposite of the employee's last punch today; date = IST today; photo kept only if manual or score < `reviewBelowScore`; recomputes the day. Returns the punch + `{ status, workedHours }`.
- `GET /punches?date=&employeeId=&limit&offset` → rows with employee name/code
- `GET /punches/open?before=today` → dangling `in` punches (exceptions)
- `POST /punches/:id/resolve` `{ outAt?: ISO, status?: 'P'|'H'|'A', note }` — inserts the missing `out` (method manual, resolvedBy) or sets a manual day; recomputes
- `GET /attendance/month?year=&month=&department=` → `{ days:[1..n], employees:[{ id, empCode, name, department, days:{ [d]: { status, source, hours } }, totals:{ P,H,A,WO,HO,L,paid,lop } }] }` — the team grid and the monthly table
- `GET /attendance/employee/:id?year=&month=` → `{ days:{ [d]: {status, source, hours, punches:[{id,type,punchedAt,method,matchScore,photoUrl,location}]} }, totals, shift, leaves }` — the calendar
- `POST /attendance/override` `{ employeeId, day, status, note }` (source manual) / `DELETE /attendance/override` `{ employeeId, day }` → recompute
- `POST /attendance/bulk-override` `{ day, status, employeeIds[], note }`
- `POST /attendance/recompute` `{ year, month, employeeId? }`
- `POST /attendance/import` — `[{ empCode, day:'YYYY-MM-DD', status }]` (source import)
- `GET /attendance/today` → `{ present:[...], insideNow:[...], absent:[...], counts }` for the dashboard

### Leave (`attendance` to decide, `view` to read)
- `GET /leave?status=&employeeId=&year=` → rows with employee
- `POST /leave` (apply), `POST /leave/:id/approve` `{ remarks }`, `POST /leave/:id/reject`, `DELETE /leave/:id` (pending only, or approved by attendance holder → reverts days)
- `GET /leave/balance/:employeeId?year=` → `{ CL:{earned,used,balance}, SL:{...}, CompOff:{earned,used,balance,expiring:[...]} }`

### Pay inputs & advances (`pay_inputs`)
- `GET /pay-inputs?year=&month=&kind=&status=` → rows with employee
- `POST /pay-inputs` (overtime: amount = hours × rate computed), `PATCH /pay-inputs/:id` (pending only)
- `POST /pay-inputs/:id/approve` `{ approvedAmount? }`, `/reject`, `DELETE` (not paid)
- `GET /advances?employeeId=&status=` → `{ ..., outstanding, repayments:[...] }`
- `POST /advances`, `POST /advances/:id/repay` `{ amount, month, year, notes }` (manual), `POST /advances/:id/cancel`

### Runs (`run`; `view` to read)
- `GET /runs` → list newest first `{ id, month, year, status, employeeCount, totalGross, totalDeductions, totalNet, totalEmployerCost, processedAt, confirmedAt, journalEntryNumber }`
- `POST /runs/process` `{ month, year }` → run + slips
- `GET /runs/:id` → `{ run, slips:[... with employee name/code/department/payType], exceptions:[{ employeeId, name, issue }] }`
  exceptions: zero paid days, net ≤ 0, missing bank details, daily-wage without a role
- `POST /runs/:id/confirm` → posts the journal
- `DELETE /runs/:id` (draft)
- `GET /runs/:id/bank-file` → CSV (name, account, IFSC, net)
- `GET /slips/:id` → one slip with employee, for the payslip view

### Reports (`view`)
- `GET /reports/wages?from=&to=&role=` → per daily-wage employee: days P/H, amount = rate × (P + 0.5H); totals by role
- `GET /reports/summary?year=` → month by month gross/net/headcount (from confirmed runs)
- `GET /reports/people?from=&to=` → the Home "People" section: `{ totalStaff, presentToday, insideNow:[...], absentToday:[...], byDepartment:[{ department, present, total }], attendancePct, wagesCost }` — "today" is IST today regardless of range; the range drives cost and attendance %.

### Canteen admin (`canteen`) — `server/routes/canteen.ts`, mounted `/api/canteen` (after `requireAuth`)
- `GET/POST /api/canteen/canteens`, `PATCH /api/canteen/canteens/:id`
- `GET /api/canteen/windows?canteenId=`, `PUT /api/canteen/windows` `[{ canteenId|null, meal, startTime, endTime }]`
- `GET /api/canteen/eligibility` → employees with breakfast/dinner flags, `PUT /api/canteen/eligibility/:employeeId`
- `GET /api/canteen/servings?date=&canteenId=&meal=&state=&limit&offset`
- `GET /api/canteen/exceptions?date=` → overrides, guests, second plates, outside-window, attendance_present=false
- `GET /api/canteen/report?from=&to=` → plates by canteen × meal × state, guests, cost per plate (account `canteen_expense` system key if present)

### Devices admin (`devices`) — served by `server/routes/device.ts` (session half)
- `GET /api/device/devices` → `[{ id, name, role, location:{id,code,name}, canteen, installId, deviceModel, appVersionCode, lastSeenAt, revokedAt }]`
- `POST /api/device/pair/codes` `{ deviceName, role, locationId, canteenId?, targetDeviceId? }` → `{ code, last4, expiresAt }`
- `GET /api/device/pair/requests`, `POST /api/device/pair/requests/:id/approve|reject`
- `POST /api/device/devices/:id/rotate-token`, `DELETE /api/device/devices/:id` (revoke)
- `GET/POST /api/device/pins`, `PATCH /api/device/pins/:id` (pin set via `{ pin }`, never returned)
- `GET/POST /api/device/reason-codes`, `PATCH /api/device/reason-codes/:id`

## Device routes — `server/routes/device.ts` (bearer token, mounted BEFORE `requireAuth`)

Wire contract identical to Amino's UNIFIED-00-CONTRACT so the Android app is unchanged.
Bearer `Authorization: Bearer <token>`; `token_hash = sha256(token)`; `last_seen_at` bumped.
- `siteCode` on the wire = `locations.code` of the device's location.
- `personKind` on the wire = `'payroll'` for salaried, `'wage'` for daily_wage.
- `GET /api/device/info`, `GET /api/device/config` (meal windows, staff pins (salt+hash), reason codes, thresholds)
- `GET /api/device/pull/people?since=<cursor>` — cursor-paginated by (updatedAt, id); returns `{ people:[{ id, kind, name, empCode, role, photoHash, faceDescriptor, breakfast, dinner, isActive, updatedAt }], next }`
- `GET /api/device/pull/state?date=` — last punch per person today, plates served today
- `GET /api/device/photo/:personId` — 96 px JPEG via `sharp`
- `POST /api/device/events` `{ events:[{ id, kind:'in'|'out'|'plate', personId, personKind, ts, lat, lng, accuracy, matchScore, photo?, meal?, state?, ... }] }` → `{ accepted, duplicates, corrected, rejected }`; gate devices write punches (idempotent on `client_id`), canteen devices write servings; servings reconciled against the day's punches (`attendance_present`).
- `POST /api/device/enroll` (gate) `{ name, empCode?, kind, photo, descriptor, roleName? }` → creates the employee
- `POST /api/device/pair/claim` `{ code, installId, deviceModel, osVersion, appVersionCode, lat, lng }` → `{ status:'approved', token, ... } | { status:'pending', pendingId }`
- `GET /api/device/pair/:pendingId` — poll; `issuedToken` returned once then nulled

## Client

Nav module **Payroll** (`/payroll`): Overview · Employees · Time · Gate · Pay Inputs · Run ·
Wages · Canteen · Devices. The masters (departments & designations, shifts, holidays, wage
rate card, statutory & policy) are panels under **Settings → Payroll**, where every other
module keeps its masters — not a page inside the module. Pages under `client/src/pages/payroll/`. niko theme:
`card`, `chip`, `table-surface`/`table-head`/`table-th`, `btn-primary/secondary/ghost`,
flat grey headers, no outer borders, `tabular-nums`, 25/page `table-pager`. Use `api()` from
`../../api` and TanStack Query. Dialog from `@/components/ui/dialog`.

- **Overview**: today's presence (present / inside now / absent), this month's run status,
  pending leave & pay inputs, open punches, headcount by department, upcoming holidays.
- **Employees**: list with filters, drawer/form for create/edit (all fields, pay type switch
  shows salary or wage role), photo upload (data URL, resized ≤ 512 px client-side), docs,
  shift assignment, face status; import from CSV/XLS.
- **Time**: tabs Calendar (one employee, month, day cells with status colour + punches, click
  → override), Team grid (all employees × days, bulk override), Leave (apply/approve + balance),
  Exceptions (open punches → resolve), Roster (shift assignments).
- **Gate**: the browser kiosk ported from Amino `gate.tsx` + `client/src/lib/face.ts`
  (@vladmandic/human from CDN, on-device matching, threshold + margin, relearn on drift);
  punches via `POST /api/payroll/punches`. **Face enrolment** page ported from `face-enrollment.tsx`.
- **Pay Inputs**: one table with kind filter, add dialog (kind-specific fields), approve/reject;
  Advances section with outstanding and manual repayment.
- **Run**: pick month → process → review slips table + exceptions → confirm (shows JE number);
  payslip view; bank file download.
- **Wages**: daily-wage report by date range and role.
- **Canteen**: canteens, meal windows, eligibility, today's plates, exceptions review, report.
- **Devices**: registry, pair (code dialog with countdown), pending requests, staff PINs, reason codes.
- **Settings → Payroll** (in the main settings hub): Departments & designations, Shifts,
  Holidays, Wage rate card, Statutory & policy — exported from `pages/payroll/settings.tsx`
  and registered as the `m-payroll` section's extras in `pages/settings.tsx`.
- **Home → People** card from `/api/payroll/reports/people` with drill-down.
