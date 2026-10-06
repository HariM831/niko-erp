# Feed mill SCADA → niko

This document is the plan and the operating notes for connecting the feed
mill's SCADA to niko in three stages. It was decided with the user on
6 Oct 2026, and the stages are built in order:

| stage | what | touches the mill? | status |
|---|---|---|---|
| 0 | Discovery: where the data lives | no (read-only survey) | **done** 6 Oct 2026 |
| 1 | Batch data and ingredient usage into niko | no (read-only) | **built on staging**, not yet installed on the PC or deployed to production |
| 2 | A live mill screen in niko, like the SCADA's | no (read-only) | **built on staging**; waits on WinCC's OPC UA server being switched on |
| 3 | Write recipes from niko to the SCADA | **yes** | **waiting on the integrator** (recipe import inside WinCC) |

**The rule across all three:** niko reads the mill through WinCC and never
talks to the PLC. Stages 1 and 2 only read. Stage 3 is the only stage that
writes, and only through WinCC's own recipe mechanism. The operator still
loads and starts every batch at the SCADA.

---

## The system (from stage 0, `scada-discovery.ps1`)

- **PC:** `DESKTOP-CK6AQJR`, Windows 10 Pro, Windows user `amino`.
  - **Plant LAN:** `192.168.1.102`, no gateway, so isolated.
  - **PLC:** Siemens S7 at **`192.168.1.103`** (S7 protocol, port 102).
  - **Internet:** over Wi-Fi (`192.168.0.x`). aminofarms.com:443 is reachable.
- **SCADA:** Siemens **WinCC Runtime Professional V15.1** (TIA Portal V15.1).
  - **Project:** `D:\HMI_5TG9\HMI_5TG9.mcp`.
  - **Runtime databases:** `CC_HMI_5TG9_26_09_03_12_34_53` and `…R`.
- **SQL Server 2014**, instance `.\WINCC`, Windows authentication:

  | database / table | what | used by |
  |---|---|---|
  | `BATCH.dbo.HISTORY` | **every batch**, one row each, since 9 Jul 2026 (2,809 rows on 6 Oct) | stage 1 |
  | `…R.dbo.UA#BATCHING` | **the recipe screen**: a WinCC user archive (ID, Name, BIN_1..8, LastUser, LastAccess, **Fingerprint**) | stage 3 |
  | `…dbo.MCPTVARIABLEDESC` | the project's 290 tags (names, PLC addresses) | stage 2 |
  | `ReportServer` | Reporting Services; the "AMINOFARMS" batching report reads `HISTORY` | — |

- **`HISTORY` columns:** `dateandtime` (PC local time, IST, no zone), `RNAME` (recipe),
  `QTY` (batch number within the run), `BINSET1..8`, `BINACT1..8` (kg), and
  `BNAME1..8` (**what each bin held in that batch**).
  - **Why the names matter:** the bins are reassigned. Bin 1 was STONE in July and is DORB in October, so a batch is
    always read by its own names, never by today's bin list.
- **Recipes on file (3 Oct 2026):** Layer 1, Layer 2, Layer 3 and Pre Layer. Older batches also
  used `P2`. A batch is about 1,475 kg over 8 bins:
  STONE, DORB, MAIZE (×3), DDGS, SOYA, GNDOC.
  - **Hand-added micros never pass through the bins:** premix, DCP, salt, methionine, lysine and so on.
- **OPC:** WinCC's **OPC UA server is configured** (`D:\HMI_5TG9\OPC\UASERVER\OPCUASERVERWINCCPRO.XML`)
  **but not running**; nothing listens on 4840–4870.
- **Python 3.12** is installed. The ODBC driver `SQL Server` is present.

---

## Stage 1 — batch data and ingredient usage

**Decided 6 Oct 2026: (a) records only.** A SCADA batch moves no stock and
posts nothing. Production orders remain what the books are built on, and SCADA
batches sit beside them for comparison. **History is imported as records**: the
helper's first run sends every row since 9 Jul 2026.

### How it works

- **On the SCADA PC:** `niko_scada_agent.py` runs every minute. It asks niko where to resume,
  reads the next rows of `HISTORY` (SELECT only, read-uncommitted, so it never
  holds a lock WinCC waits on), and posts them to `/api/scada/device/batches`.
- **Authentication:** it uses a **device token**. It pairs once through niko's device registry
  as a **`scada`** device. That role is refused by every gate and canteen
  endpoint, so the token can never read staff names, photos or punches.
- **In niko:**
  - **Storage:** `scada_batches` keeps each batch once (keyed by the PC's time, recipe and batch number), read as IST.
  - **Names:** `scada_names` says what a SCADA name means in niko: a **bin name** is a material (STONE →
    Lime Stone Grits, DOGS → DDGS (Rice), GNDOC → DOGN…), and a **recipe name** is a formula.
    It is kept apart from the items' own aliases, which match vendor bills.
- **The page, Feed Mill › SCADA Batches** (permission `feed_mill.scada`):
  - ingredient usage, set against actual per material, with a variance;
  - totals by day and by recipe;
  - every batch, bin by bin;
  - the SCADA names panel, for linking names to materials and formulas (needs `feed_mill.manage_formulas`).

  A name that isn't linked still counts under its own spelling, so no weighed kilo is dropped.
- **Code:**
  - `server/routes/scada.ts`;
  - `client/src/pages/feed-scada.tsx`;
  - migration `0119_scada_batches.sql`;
  - `scripts/check-scada.ts` (passes on staging).

### Install (once, on the SCADA PC, as the Windows user that runs WinCC)

1. Copy `niko_scada_agent.py` to `C:\niko\`.
2. Install the one package it needs:
   ```
   py -3 -m pip install pyodbc
   ```
3. In niko, go to **Payroll › Devices › Pair a device**. Choose role **scada**,
   site **Dhekiajuli**, and a name such as "Mill SCADA PC". Copy the 8-character
   code; it is valid for 10 minutes.
4. On the SCADA PC:
   ```
   cd C:\niko
   py -3 niko_scada_agent.py pair <CODE>                                    # production
   py -3 niko_scada_agent.py pair <CODE> https://staging.aminofarms.com     # or staging, to try first
   py -3 niko_scada_agent.py once
   ```
   The first `once` sends the whole history in chunks of 500. Run it again and
   it should send nothing new.
5. Start it with Windows, so it keeps copying:
   ```
   schtasks /Create /TN "niko SCADA helper" /SC ONLOGON /RL LIMITED /TR "\"%LOCALAPPDATA%\Programs\Python\Python312\pythonw.exe\" C:\niko\niko_scada_agent.py run"
   ```
   Adjust the `pythonw.exe` path if `py -3 -c "import sys; print(sys.executable)"`
   says otherwise. The task must run as the user that runs WinCC, because the
   helper reads SQL Server with that Windows login.
6. In niko, open **SCADA Batches › SCADA names** and link every bin name and
   recipe.

### Running it

- **Failures:** when niko or the internet is down, the helper logs it to `niko_scada.log` and tries
  again a minute later. The mill never waits on it.
- **Resending and re-pairing:** a batch sent twice is stored once, so deleting `niko_scada.json` and
  pairing again is harmless.
- **Revoking:** revoke the device in **Payroll › Devices**, and the helper stops at its next pass.

### Remaining for stage 1

- [ ] Install on the SCADA PC against staging, link the names, and check a few
      days against the paper batching report.
- [ ] Deploy to production, pair against aminofarms.com, and add the scheduled task.
- [ ] **Later, by decision only, option (b):** fill the actual kg on that day's
      production orders from the SCADA batches, so raw-material consumption is
      what the SCADA weighed. This comes only after the numbers have been
      trusted for a while. Open question for (b): hand-added micros never reach
      the bins, so do their actuals stay at the formula's planned kg?

---

## Stage 2 — live mill screen in niko

**Built on staging (6 Oct 2026). It shows no values until WinCC's OPC UA server is switched on.**

**Feed Mill › Live Mill** (permission `feed_mill.scada`) is laid out like WinCC's
"Batching section" screen:
- **Top:** WG-1 and WG-2, the 8-bin table (name, set, actual, in-flight), set and
  actual total, the recipe, and the batch counters (set, running, completed,
  running bin).
- **Settings:** mixing time and MBG set points, and the amps set point.
- **The plant, drawn:**
  - bins, highlighted while feeding, with their high and low sensors and coarse and fine gates;
  - RM elevators, top screw, grinder and its elevator;
  - weigh hoppers and batch conveyor;
  - mixer elevator and mixer;
  - FF elevator, distribution and the 5 silos with their gates and full sensors.

  Equipment is green while it runs.
- **Right and bottom:** grinder and mixer amps gauges, then mode and holds (auto, emergency,
  batch, mixer and grinder hold, section run commands).
- **View only.** It has no control of any kind. It is marked stale when no
  reading has arrived for 15 s.

### How it works

- **The tag map:** `shared/scada-live.ts` maps each screen element to its WinCC tag, from the
  project's tag list (`scada-tags.ps1`, 6 Oct 2026). Meanings guessed from
  names are marked `(?)`, to confirm against the SCADA when values first arrive.
- **The helper:** niko serves that list at `/api/scada/device/live-tags`. `niko_scada_agent.py run`
  reads those tags from WinCC's OPC UA server on the same PC
  (`opc.tcp://localhost:4861`, from the project's `OPCUASERVERWINCCPRO.XML`) every
  2 s. It is **read only** and writes no tag. It posts to `/api/scada/device/live` when
  something changes, and at least every 10 s.
- **Storage:** niko keeps only the latest snapshot (`scada_live`, migration 0120).
- **Helper commands:**
  - `live` reads the tags once and prints them;
  - `browse` shows the OPC UA server's namespaces, if the tag names don't resolve.

### What's found (`scada-tags.ps1`)

- **290 tags** on connection `HMI_Connection_1` (the S7 PLC), with readable names
  (`BATCHINGDATA1_*`, `COMMONDB_*`, `GRP_1..3DATA_*`, `*_ANIMATION`, `*_realout`…).
- **OPC UA server configured but off.** It is set to port **4861** with anonymous access and
  security "None" allowed, but it is **not in WinCC's startup list**, and nothing
  listens on 4861 or 4862.
- **Screens:** `Batching section_1.PDL` (the main screen), plus TOP and BOTTOM TEMPLATE,
  HOLD, RECIPE/RECIEPE, REPORT, SIDE SCREEN and MAIN.
- **Integrator scripts:** `ScriptAct\datalog.bac` (most likely the batch logging into `HISTORY`)
  and `ScriptLib\BATCH.bmo`.

### To switch it on

1. **Integrator, or someone with WinCC rights:** add **OPC UA Server** to the
   WinCC runtime startup list (Computer properties › Startup), then restart
   runtime. Confirm the licence allows it.
2. **Security, before it runs:**
   - **Port 4861 must stay closed to the network.** The project allows anonymous, unencrypted connections, and an
     OPC UA client can *write* tags. The helper connects from the same PC
     (`localhost`), so Windows Firewall must not allow port 4861 inbound.
   - Better still, turn off anonymous access and give the helper a read-only user.
3. **On the SCADA PC:**
   ```
   py -3 -m pip install asyncua
   py -3 C:\niko\niko_scada_agent.py live      # should print the tag values
   ```
   Then restart the scheduled task, or run `run`.
4. Compare Live Mill with the SCADA screen side by side, and fix any `(?)` tag in
   `shared/scada-live.ts`.

---

## Stage 3 — write recipes from niko

**Goal:** a signed-off niko formula becomes a SCADA recipe without anyone
retyping kg per bin.

### Why it isn't a direct write

The recipe screen is the WinCC **user archive `UA#BATCHING`**. Every row carries a
**Fingerprint** that WinCC checks. Writing that SQL table from outside would
bypass WinCC and could corrupt the archive, so **niko never writes it
directly.** The integrator adds an import on the WinCC side, and WinCC writes
its own archive.

### Plan

1. **niko builds the recipe** from a signed-off formula version (permission `feed_mill.sign_off`
   or a new `feed_mill.push_recipe`; to decide):
   - **batch size:** the SCADA batch, about 1,475 kg (to confirm);
   - **kg per bin**, using the **current bin map** taken from the latest SCADA batch's
     `BNAME1..8`, with several maize bins split as the operator does today (to confirm);
   - a **hand-add list** for the micros, which never go through bins.
2. **Checks before anything is sent:**
   - the bin kg add up to the batch size;
   - every binned material in the formula has a bin;
   - each bin is within its limits;
   - it is not the recipe currently running.
3. **Delivery:** niko publishes the recipe. The helper on the SCADA PC fetches it and
   drops a file in a folder the integrator chooses, for example
   `D:\HMI_5TG9\niko_recipes\Layer 3.csv`.
4. **WinCC imports it** through a button or script the integrator adds, using
   WinCC's own user-archive functions, so the fingerprint stays valid. The
   operator presses **Import from niko**, sees the recipe, then loads and starts it as today.
5. **Read-back:** the helper reads `UA#BATCHING` (SELECT only) and reports to
   niko, which shows **matched** or **not matched** for every bin. The first batch run on it
   (stage 1) confirms the set kg.
6. **Audit:** every push is logged: who, when, which formula version, the kg per bin,
   and the read-back result.

### Needs before building

- [ ] **Integrator:** add the recipe import inside WinCC (folder, file format,
      button). Confirm **how the PLC picks up a recipe**: only when the
      operator loads it (then the import is safe), or live from the archive
      (then it must never change while a batch runs).
- [ ] **Integrator:** bin limits (min and max kg per bin) and fine-weigh settings.
- [ ] **User:** the SCADA batch size; how maize is split across bins 3, 4 and 7;
      who may push recipes.
- [ ] Stage 1 running and trusted, and the SCADA names linked (recipe ↔ formula).

---

## Questions for the SCADA integrator (stages 2 and 3)

1. Can you enable the **WinCC OPC UA server** in `HMI_5TG9` with a **read-only user**?
   Is it licensed on this runtime?
2. Can you export the **tag list**, at least the tags shown on the main batching screen?
3. Can you add an **"Import from niko" recipe import** for the `BATCHING` user archive,
   from a file in a folder we agree, using WinCC's own user-archive
   functions?
4. Does the PLC read a recipe **only when the operator loads it**, or live from the
   archive?
5. What are the **limits per bin**, and how is a material that sits in several
   bins (maize) split?

## Files here

| file | what |
|---|---|
| `scada-discovery.ps1` | stage 0, the read-only survey |
| `niko_scada_agent.py` | the helper (stage 1; stages 2 and 3 extend it) |
| `niko_scada.json` | the helper's token, written by `pair`; never commit it |
| `niko_scada.log` | its log, rotated at 2 MB |
