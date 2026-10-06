# Feed mill SCADA → niko

This document is the plan and the operating notes for connecting the feed
mill's SCADA to niko in three stages. It was decided with the user on
6 Oct 2026, and the stages are built in order:

| stage | what | touches the mill? | status |
|---|---|---|---|
| 0 | Discovery: where the data lives | no (read-only survey) | **done** 6 Oct 2026 |
| 1 | Batch data and ingredient usage into niko | no (read-only) | **built on staging**, not yet installed on the PC or deployed to production |
| 2 | A live mill screen in niko, like the SCADA's | no (read-only) | **waiting on the integrator** (OPC UA server) |
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

**Goal:** a niko page drawn like the SCADA's main screen, updating every second
or two:
- WG-1 and WG-2 weights;
- set, actual and in-flight weight per bin (with the bin's material);
- set and actual total, running recipe and formula/destination (e.g. `L3@L4`);
- running batch, completed tonnes, batches ordered;
- mixing time and remaining;
- grinder and mixer amps;
- which sections (RM feeding, batching, mixing, silo) are running, and which hold or alarm is on.

**View only.** The page has no start, stop, hold or reset buttons. Control
stays at the SCADA.

### Plan

1. **The source is WinCC's OPC UA server.** It's in the project already but switched
   off. The integrator enables it with a **read-only user** and confirms
   licensing. It listens on the plant PC; by default WinCC uses port 4862.
2. **The tag list:** take it from the integrator's TIA Portal export (preferred), or browse
   it over OPC UA once the server is on. niko gets a mapping of tag → meaning
   (WG-1, bin 3 actual, grinder amps, …), kept as data like the bin names.
3. **The helper reads it:** the same `niko_scada_agent.py` gains a live loop. It reads the mapped
   tags every 1–2 s over OPC UA (package `asyncua`) and posts a snapshot to
   niko. It sends nothing when nothing has changed.
4. **niko holds only the latest snapshot**, plus a short ring buffer for trends of amps
   and weights. It does not archive every second. A **Feed Mill › Live Mill** page
   draws the mimic from the snapshot, and marks itself stale when no snapshot
   has arrived for 10 s.

### Needs before building

- [ ] **Integrator:** enable the WinCC OPC UA server with a read-only user, and
      confirm the licence.
- [ ] **Integrator:** export the tag list (names, data types, what each is), or
      at least the tags behind the main screen.
- [ ] Decide who may see the live page (suggest `feed_mill.scada`).

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
