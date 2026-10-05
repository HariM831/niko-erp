# IAS NIR → niko integration plan

Status: **built 3 Oct 2026** (transport A, gate QC only, GR auto-match). See "Built" at the end.

Source examined: `IAS-pro2_ProF-2.1.0.33α-0708.zip` (IAS Pro2 desktop software,
v2.1.0.33α, built 8 Jul 2026). I read it without running it: configs, logs and
its database. The zip is not a clean installer. It is a copy of a folder that has
already been used, so it includes a live `pro2.db`, logs from 15 Jul, 1 Oct and
3 Oct 2026, and one real scan.

## What the IAS software is

- A Qt desktop app for Windows (`IAS_Pro2.exe`). It talks to the NIR analyser over
  Ethernet. The logs show instrument spec `LC64H30` and serial `KFAL34N0` at
  `169.254.70.150`, a link-local address, so the analyser is cabled straight to
  the PC.
- The transport is proprietary: ZeroMQ plus msgpack (`libzmq.dll`,
  `qmsgpack0.dll`). We should not try to speak it ourselves.
- **It has no LIMS or ERP output.** The binaries contain no HTTP endpoint, OPC,
  MQTT or webhook settings. Their only network calls go to the vendor's cloud
  (`tiso.ias-nir.com/api/inter/...`), for model downloads and backups.
- The instrument does have a *Modbus TCP* module, but only a slave-address field
  is exposed. There is no register map, so it can't be used without vendor
  documentation.
- **Every scan is written to `pro2.db`, a plain SQLite file** (not encrypted)
  that sits next to the exe. This is the integration point.
- It also writes raw spectra as CSV files to
  `D:/Data/<SN>/gatherData/<model>/<date>/…csv`. niko doesn't need these.

### The result record: `DBResult`

| column | example | meaning |
|---|---|---|
| `id` | 1 | autoincrement. Our cursor |
| `devicesn` | `KFAL34N0` | which analyser |
| `modelname` | `SOYAREFINEDOILIN` | calibration model short name, i.e. *what material it thought it was scanning* |
| `samplename` | `Sfrf20` | the model's sample prefix. Not a free-text sample ID in this scan |
| `resultsn` | `Sfrf2026071521-00213` | unique result number. Our idempotency key |
| `generatedate` | `2026-07-15T21:11:41.196` | local (IST) scan time |
| `items` | JSON | the readings (below) |
| `status`, `indicatorstatus`, `creater` | 1, –, – | |

`items` JSON:

```json
{
  "ResultValues": {"1":"0.026","2":"0.347","3":"200.00", ...},   // what the screen shows
  "TestValues":   {"1":0.0259675,"2":0.346963,"3":200, ...},     // same, unrounded
  "RealValues":   {"1":"0.0259675","2":"0.236963","3":"210.832", ...}, // raw model output
  "ResultColors": {"1":0,"2":0,"3":3, ...},                       // 0 = normal, 3 = flagged (?)
  "ShowMatter":   ["1","2", ...],
  "ScanTime": "2026-07-15 21:11:41.196", "ShortName": "SOYAREFINEDOILIN", "Version": "2.0.0.1"
}
```

Readings are keyed `"1"`, `"2"`, …. The *names* behind those numbers are
per-model, and the instrument sends them when it connects (the July log has the
full list):

| model | readings |
|---|---|
| SoyadocIN / SoydocIN (soya DOC) | ash, fibre, moisture, oil, protein, SS, UA |
| SoyaseedIN / SoyseedIN | fibre, moisture, oil, protein |
| SOYA CRUDE / REFINED OIL | moisture, FFA, IV, PV, SAP, RI, phosphatides, colour, (sedimentation) |
| Test Model | Test1–4 |

`RealValues` differs from `ResultValues`. FFA reads 0.237 raw and 0.347 shown;
IV reads 210.8 raw and 200 shown; SAP reads −20.8 raw and 0 shown. The software
applies a slope/bias correction (the "斜率K / 截距B" setting) and clamps to the
model's range. **niko should take `TestValues`, which is what the technician
sees, unrounded.** It should also carry `ResultColors`, so that a reading the
instrument itself flagged is never shown as clean.

## Where it lands in niko

This doesn't need a new module. Station 3 (QC) on office receipts already has
the slot:

- `office_receipt_lines.qc_moisture_pct / qc_protein_pct / qc_fiber_pct / qc_fat_pct`
  plus `qc_other_params` (jsonb) for ash, SS, UA and the rest
- `qc_specs` / `qc_spec_params` judge the reading; `judgeLine()` computes the
  verdict; deduction rules price it. **None of this changes.**

The NIR only replaces *typing the numbers*. The technician still submits the QC
step, and the verdict is still computed rather than taken from the instrument.

### Proposed flow

1. The technician scans the truck's sample on the NIR as usual.
2. The NIR feed (below) puts the row into a new table, `nir_results`, raw and
   unjudged: `result_sn` (unique), `device_sn`, `model`, `scanned_at`, `readings`
   jsonb (name → value), `flags` jsonb, `receipt_line_id` (null until used).
3. On the QC screen for a receipt line, niko lists **recent scans whose model is
   mapped to that line's item** (say the last 2 hours) and the technician picks
   one. niko never attaches a scan on its own: two maize trucks in an hour would
   match equally well, and a wrong match would be accepted without anyone
   noticing.
4. Picking a scan fills in the readings form, with the source shown
   (`NIR · Sfrf2026…-00213 · 21:11`). The technician can still correct a
   number, but a corrected value is stored as edited and is not passed off as
   the instrument's.
5. On submit, the line keeps `nir_result_sn`, the scan is marked used, and it
   can't be picked for a second line.

### Mapping (data, not code)

- **model → item**: e.g. `SoyadocIN` → *Soyabean Meal*. One model may serve
  several items, but each item has only one model.
- **reading name → QC parameter**: `Moisture`/`moisture` → `moisture`,
  `Protein` → `protein`, `fibre`/`Fibre` → `fiber`, `oil`/`Oil` → `fat`, and
  `ash`, `SS`, `UA` go into other params. The instrument's spelling is not
  consistent (`fibre` vs `Fibre`, `SoyseedIIN`), so we match on the mapping
  table, never on a hardcoded string.
- Readings not mapped to anything are kept on `nir_results` and shown, but not
  fed into the verdict.

## Getting the rows from the lab PC to niko

**A. Browser reads `pro2.db` directly (recommended).** This follows the
weighbridge pattern: no install, and Chrome on the lab PC does the work. The QC
page asks once for the file (File System Access API) and keeps the handle in
IndexedDB. While the page is open it re-reads the file every few seconds,
parses it with sql.js, and posts rows with `id >` the last cursor to niko. A
torn read during a write is simply retried. The grant is per-origin, the same as
Web Serial.

*Limits:* nothing syncs while no QC page is open. That is acceptable, because
scans only matter when somebody is doing QC. Chrome may ask the user to
re-confirm file access after a restart.

**B. A small Windows agent** on the lab PC that tails `DBResult` and posts
to niko with a device token. Scans sync with no page open, but it is one more
thing to install, update and keep running on a PC we don't control.

**C. Modbus TCP from the instrument.** This is only possible if the vendor
supplies the register map. It also skips the PC entirely, along with the
slope/bias correction the PC applies, so the numbers might not match the
screen. Not recommended.

**D. Manual CSV export and upload.** The app has an export with a CSV
template. It works today with no code, but it is the typing problem with extra
steps.

## Things that are not right yet, before any code

1. **The analyser has no calibration for our materials.** The installed models
   are soya oil (crude and refined), soya DOC, soyabean and a test model. These
   are oil-plant calibrations. There is nothing for maize, DORB, rice
   polish, fish meal, MBM or finished feed. Unless the vendor supplies (or we
   build) calibrations for the materials we actually buy, the integration has
   almost nothing to carry. This is the first question for the vendor.
2. The `pro2.db` login is `admin` / `admin`, stored in plaintext. Change it on
   the lab PC, since anybody at that PC can edit or delete results.
3. The one scan on file (15 Jul 2026, refined soya oil) is a demo. It must not
   be imported.

## Decided (3 Oct 2026)

- Transport **A**: Chrome reads `pro2.db`.
- Scope: **gate QC only**.
- Matching: the technician types the **GR number as the IAS sample name**, and
  niko matches it automatically. This replaces the "technician picks the scan"
  step above.

### Auto-match rules (proposed)

- Normalise the sample name before matching: `gr26`, `GR-26` and `GR 00026`
  all mean `GR-00026`.
- A scan attaches automatically only when all of these hold:
  - the GR exists and is awaiting QC (`weighed_in`);
  - the scan's model maps to an item on one of that GR's lines;
  - exactly one such line exists;
  - the scan time is after the GR's gate-in.

  If any check fails, the scan goes to an **unmatched** list with the reason.
  It is never forced onto a line.
- **Typo guard:** a typo that hits another *open* GR still passes the checks
  above. The model→item check catches most of these. What's left is a slip
  between two open trucks of the same material. A printed barcode closes that
  gap (see below).
- **Sample names are edited after the scan:** IAS can rename a result later
  (`updateSampleName`). The cursor therefore re-reads the last few hours of rows
  every pass instead of only `id > last`. A renamed scan re-matches, and if it
  was already attached to a line it is detached.
- **Repeat scans** of the same truck are averaged, and `qc_sample_count` is the
  number of scans (decided 3 Oct 2026).
- **Autofill only.** A match fills the readings in. Saving QC stays with the QC
  person.
- No barcode: the NIR sits at the weighbridge desk (decided 3 Oct 2026).
- The database uses the rollback journal, not WAL (header bytes 18–19 = 1).
  New rows are in the main file, so reading `pro2.db` alone is enough.

## Decisions needed

1. Which materials will be calibrated, and when? (This decides whether the
   integration is worth building now.)
2. Where is the analyser going to sit, and which PC runs IAS? Is it the same PC
   that runs niko's QC station?
3. Transport: A (browser), B (agent), or D (CSV for now)?
4. Should the NIR also be used **after** the gate, for finished feed checks
   against the formula and per-lot nutrient values for the formulator? Or is it
   only for receiving QC for now?
5. Is `TestValues` the right figure? (Confirm with the vendor what
   `ResultColors = 3` means, and whether the slope/bias correction is theirs or
   ours to set.)

## Built (3 Oct 2026)

- `nir_models`, `nir_model_items` and `nir_results` tables, plus
  `office_receipt_lines.qc_nir`: the scans used, their average, the fields
  typed over, and the fields the instrument flagged. Migration 0116.
- `client/src/lib/nir-feed.ts`: reads `pro2.db` with sql.js every 5 s while
  the Weighment page is open, on any tab. It re-reads the last 3 days so that
  renames are picked up, and posts only scans that are new or changed.
- `POST /api/office/nir/results` takes the uploads. `GET /api/office/nir/status`
  serves the bench list. `PUT /api/office/nir/models/:shortName/items` links a
  model to a material and needs `office.manage_rules`.
- `server/services/nir.ts`: `placeScans` holds the match rules. They are
  worked out on every QC read, and `consumeScans` re-checks them when QC is
  saved.
- QC tab:
  - a status pill showing whether the IAS file is being read;
  - readings filled in from the averaged scans, with a field the QC person
    typed over outlined in amber;
  - unplaced scans for the open truck, with the reason;
  - a bench panel listing every unplaced scan and the model links.
- `scripts/check-nir.ts`.

Still open: the vendor's calibrations for our materials; what `ResultColors`
codes and `DBResult.status` mean. Only status 1 is matched, and any other
status is shown as the reason.

## Phase 1: readings asked for from niko (5 Oct 2026)

The operator no longer types a GR into IAS (the user, 5 Oct 2026). On the QC
panel, **Take NIR reading** on a receipt line creates a `nir_requests` row.
Scans that reach niko for the first time while it waits are claimed for that
line (`nir_results.claimed_line_id`), whatever their sample name, provided:

- the model is linked to the line's material. A scan with the wrong model is
  refused, and the request shows "Scanned with Corn — Maize needs X";
- IAS gave the scan status 1;
- the scan is not dated more than 10 min before the request. An older scan is
  a backlog being read, not this truck.

Repeat scans are averaged. One analyser, so asking for another line stops the
first. A request expires 30 min after it was made or after its last scan, and
saving QC closes it. A claim beats a typed GR, so a request also settles the
"two lines of one material" case. The typed GR stays as the fallback.

What the operator still does in IAS: select the model niko names, and press
scan. **Phase 2** removes that with the vendor's Modbus TCP register map
(select product, trigger scan, status, results), driven by a small program on
the bench PC. The user is asking the vendor for the map.
