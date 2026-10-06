# Request to the SCADA integrator: live values for niko

**Plant:** Amino Farms feed mill, Dhekiajuli. **SCADA PC:** `DESKTOP-CK6AQJR`.
**Project:** TIA Portal V15.1 `D:\DO NOT DELETE\AMINOFARMS\AMINOFARMS`, HMI device
**SCADA [WinCC RT Professional]**.

## What we need

Amino Farms' own system (niko) shows the batching screen read-only on its web
page "Live Mill". To do that, it needs the screen's current tag values. Please add
**one VB script** to the WinCC RT Professional project that writes the current
value of the **133 tags listed below** into **one SQL table** every **2 seconds**
(5 seconds is acceptable). Nothing else in the project needs to change.

This works exactly like your existing batch logging into `BATCH.dbo.HISTORY`
(`ScriptAct\datalog.bac`). A small program on the SCADA PC then *reads* that table
and sends the values to niko.

**What niko never does:** write anything to the PLC, to WinCC tags, or to any table
other than reading this one. No OPC server is needed, and no network port is opened.

## 1. The table (create once, in the existing `BATCH` database on `.\WINCC`)

```sql
USE BATCH;
CREATE TABLE dbo.NIKO_LIVE (
    TagName   nvarchar(100) NOT NULL PRIMARY KEY,
    TagValue  nvarchar(200) NULL,
    UpdatedAt datetime      NOT NULL DEFAULT GETDATE()
);
```

There is one row per tag, overwritten in place, so the table never grows.

## 2. The script

- **Trigger:** cyclic, every **2 s**. Use the shortest cyclic trigger WinCC offers
  for a scheduled task or global action. 5 s is fine if 2 s isn't possible.
- **What it does on each run:**
  - read the 133 tags, from runtime (`HMIRuntime.Tags(name).Read`) or from cache, whichever you prefer;
  - write all of them in **one** SQL statement or transaction: update the row if
    the tag exists, insert it if not;
  - set `UpdatedAt = GETDATE()` on every row it writes, even when the value didn't
    change. niko uses this time to know the values are current.
- **Values:** write them as text, as WinCC shows them. Write booleans as `1`/`0` or
  `True`/`False`; both are accepted. Write text tags (bin names, recipe name)
  unchanged.
- **If a tag can't be read:** write `NULL` for it and carry on with the rest.
- **Database connection:** use the same one as `datalog.bac`. Read access for the
  Windows user `amino` is enough for niko's side.

An outline in VBScript, to adapt to your conventions:

```vb
Dim tags, conn, sql, i, v
tags = Array("BATCHINGDATA1_LOADCELL", "BATCHINGDATA1_LOADCELL-2" ) ' ... all 133 below
Set conn = CreateObject("ADODB.Connection")
conn.Open "Provider=SQLOLEDB;Data Source=.\WINCC;Initial Catalog=BATCH;Integrated Security=SSPI;"
sql = "SET NOCOUNT ON; BEGIN TRAN;"
For i = 0 To UBound(tags)
    v = HMIRuntime.Tags(tags(i)).Read
    sql = sql & "MERGE dbo.NIKO_LIVE AS t USING (SELECT N'" & tags(i) & "' AS n) AS s ON t.TagName = s.n " & _
          "WHEN MATCHED THEN UPDATE SET TagValue = N'" & Replace(CStr(v), "'", "''") & "', UpdatedAt = GETDATE() " & _
          "WHEN NOT MATCHED THEN INSERT (TagName, TagValue) VALUES (s.n, N'" & Replace(CStr(v), "'", "''") & "');"
Next
sql = sql & "COMMIT;"
conn.Execute sql
conn.Close
```

## 3. Check

After download, run this in SQL Server Management Studio. It should return 133 rows with
`UpdatedAt` within the last few seconds, matching what the batching screen shows:

```sql
SELECT TagName, TagValue, UpdatedAt FROM BATCH.dbo.NIKO_LIVE ORDER BY TagName;
```

## The 133 tags

These are the tags behind the batching screen: scales, bin set/actual/in-flight and names, totals,
recipe, batch counters, mixing timers, amps, gates, level sensors, run states,
holds, mode and silos. All of them are already in the project.

```
BATCHINGDATA1_ACTUALBINWG{1}
BATCHINGDATA1_ACTUALBINWG{2}
BATCHINGDATA1_ACTUALBINWG{3}
BATCHINGDATA1_ACTUALBINWG{4}
BATCHINGDATA1_ACTUALBINWG{5}
BATCHINGDATA1_ACTUALBINWG{6}
BATCHINGDATA1_ACTUALBINWG{7}
BATCHINGDATA1_ACTUALBINWG{8}
BATCHINGDATA1_BATCHINGSTEP1
BATCHINGDATA1_BATCHSTART
BATCHINGDATA1_BINC-GATEOUT{1}
BATCHINGDATA1_BINC-GATEOUT{2}
BATCHINGDATA1_BINC-GATEOUT{3}
BATCHINGDATA1_BINC-GATEOUT{4}
BATCHINGDATA1_BINC-GATEOUT{5}
BATCHINGDATA1_BINC-GATEOUT{6}
BATCHINGDATA1_BINC-GATEOUT{7}
BATCHINGDATA1_BINC-GATEOUT{8}
BATCHINGDATA1_BINF-GATEOUT{1}
BATCHINGDATA1_BINF-GATEOUT{2}
BATCHINGDATA1_BINF-GATEOUT{3}
BATCHINGDATA1_BINF-GATEOUT{4}
BATCHINGDATA1_BINF-GATEOUT{5}
BATCHINGDATA1_BINF-GATEOUT{6}
BATCHINGDATA1_BINF-GATEOUT{7}
BATCHINGDATA1_BINF-GATEOUT{8}
BATCHINGDATA1_COMPLETEBATCH
BATCHINGDATA1_CURRENTBATCH
BATCHINGDATA1_CURRENTBIN
BATCHINGDATA1_CURRENTBIN-2
BATCHINGDATA1_HOLD
BATCHINGDATA1_INFLIGHTVALUE{1}
BATCHINGDATA1_INFLIGHTVALUE{2}
BATCHINGDATA1_INFLIGHTVALUE{3}
BATCHINGDATA1_INFLIGHTVALUE{4}
BATCHINGDATA1_INFLIGHTVALUE{5}
BATCHINGDATA1_INFLIGHTVALUE{6}
BATCHINGDATA1_INFLIGHTVALUE{7}
BATCHINGDATA1_INFLIGHTVALUE{8}
BATCHINGDATA1_LOADCELL
BATCHINGDATA1_LOADCELL-2
BATCHINGDATA1_RECEIPEC-SETWG{7}
BATCHINGDATA1_RECEIPEC-SETWG{8}
BATCHINGDATA1_RECEIPESETWG{1}
BATCHINGDATA1_RECEIPESETWG{2}
BATCHINGDATA1_RECEIPESETWG{3}
BATCHINGDATA1_RECEIPESETWG{4}
BATCHINGDATA1_RECEIPESETWG{5}
BATCHINGDATA1_RECEIPESETWG{6}
BATCHINGDATA1_SETBATCHCOUNT
BATCHINGDATA1_SETMIXINGTMR{1}
BATCHINGDATA1_SETMIXINGTMR{2}
BATCHINGDATA1_TOTALACT
BATCHINGDATA1_TOTALSET
BBCON_ANIMATION
COMMONDB_AUTOCMD
COMMONDB_BINNAME{1}
COMMONDB_BINNAME{2}
COMMONDB_BINNAME{3}
COMMONDB_BINNAME{4}
COMMONDB_BINNAME{5}
COMMONDB_BINNAME{6}
COMMONDB_BINNAME{7}
COMMONDB_BINNAME{8}
COMMONDB_BUZZER
COMMONDB_EMERGENCYSTOP
COMMONDB_GINDER-1SP
COMMONDB_RECEIPE_NAME
COMMONDB_SILONAME{1}
COMMONDB_SILONAME{2}
COMMONDB_SILONAME{3}
COMMONDB_SILONAME{4}
COMMONDB_SILONAME{5}
DISTRIBUSION_CHAIN_CONV-2_ANIMATION
DISTRIBUSION_CHAIN_CONV-3_ANIMATION
DISTRIBUSION_CHAIN_CONV_ANIMATION
FFD_SCREW_CONVYOR_ANIMATION
FF_ELEVATOR-1_ANIMATION
FF_TOP_CONVYOR-1_ANIMATION
GRINDERELEVATOR_ANIMATION
GRP_1DATA_BINHIGHSENSOR{1}
GRP_1DATA_BINHIGHSENSOR{2}
GRP_1DATA_BINHIGHSENSOR{3}
GRP_1DATA_BINHIGHSENSOR{4}
GRP_1DATA_BINHIGHSENSOR{5}
GRP_1DATA_BINHIGHSENSOR{6}
GRP_1DATA_BINHIGHSENSOR{7}
GRP_1DATA_BINHIGHSENSOR{8}
GRP_1DATA_BINSCADAGATESEL{1}
GRP_1DATA_BINSCADAGATESEL{2}
GRP_1DATA_BINSCADAGATESEL{3}
GRP_1DATA_BINSCADAGATESEL{4}
GRP_1DATA_BINSCADAGATESEL{5}
GRP_1DATA_BINSCADAGATESEL{6}
GRP_1DATA_BINSCADAGATESEL{7}
GRP_1DATA_BINSCADAGATESEL{8}
GRP_1DATA_DUMPLAMP-1
GRP_1DATA_DUMPLAMP-2
GRP_1DATA_FLAPGATE
GRP_1DATA_GP_1SCADAONCMD
GRP_2DATA_GP_2SCADAONCMD
GRP_2DATA_GRINDERHOLD
GRP_3DATA_FFFLAPGATE
GRP_3DATA_GP_3SCADAONCMD
GRP_3DATA_GRP3GATES{1}
GRP_3DATA_GRP3GATES{2}
GRP_3DATA_GRP3GATES{3}
GRP_3DATA_GRP3GATES{4}
GRP_3DATA_GRP3GATES{5}
GRP_3DATA_GRP3SENSORS{1}
GRP_3DATA_GRP3SENSORS{2}
GRP_3DATA_GRP3SENSORS{3}
GRP_3DATA_GRP3SENSORS{4}
GRP_3DATA_GRP3SENSORS{5}
GRP_3DATA_HOLD
MIXELEVATORSCCON_ANIMATION
MIXELEVATOR_ANIMATION
MIXERAMPS_realout
MIXER_ANIMATION
RM_ELEVATOR-2_ANIMATION
RM_ELEVATOR_ANIMATION
RM_MOTOR-1_ANIMATION
ROTARYHZ_realout
RWMATRLLLFB-1
RWMATRLLLFB-2
RWMATRLLLFB-3
RWMATRLLLFB-4
RWMATRLLLFB-5
RWMATRLLLFB-6
RWMATRLLLFB-7
RWMATRLLLFB-8
grinderamps-2_realout
grinderamps_realout
```
