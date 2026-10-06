# Feed mill SCADA → niko

The mill's SCADA PC (`DESKTOP-CK6AQJR`, Siemens WinCC RT Professional V15.1)
logs every batch to `BATCH.dbo.HISTORY` on its own SQL Server (`.\WINCC`).
`niko_scada_agent.py` copies those rows to niko, where they appear under
**Feed Mill › SCADA Batches**.

They are records only: nothing moves stock or posts (decided 6 Oct 2026).
The helper only runs SELECTs against `HISTORY`, and it never writes to SQL
Server, WinCC or the PLC.

## Files

| file | what |
|---|---|
| `scada-discovery.ps1` | step 0, the read-only survey that found `HISTORY`, the `UA#BATCHING` recipe archive and the dormant OPC UA server |
| `niko_scada_agent.py` | the helper |
| `niko_scada.json` | the helper's token, written by `pair`; never commit it |
| `niko_scada.log` | its log, rotated at 2 MB |

## Install (once, on the SCADA PC, as the user that runs WinCC)

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
   py -3 niko_scada_agent.py pair <CODE>
   py -3 niko_scada_agent.py once
   ```
   The first `once` sends the whole history (about 2,800 batches since
   9 Jul 2026) in chunks of 500. Run it again and it should send nothing new.
5. Start it with Windows, so it keeps copying:
   ```
   schtasks /Create /TN "niko SCADA helper" /SC ONLOGON /RL LIMITED /TR "\"%LOCALAPPDATA%\Programs\Python\Python312\pythonw.exe\" C:\niko\niko_scada_agent.py run"
   ```
   Adjust the `pythonw.exe` path if `py -3 -c "import sys; print(sys.executable)"`
   says otherwise. The helper reads SQL Server as the logged-in Windows user,
   so the task must run as the user that runs WinCC.

## Running it

- **Schedule and failures:** it checks every minute. When niko or the internet is down it logs the
  failure and tries again, so the mill never waits on it.
- **Resuming:** niko tells the helper where to resume, and a batch sent twice is stored once.
  Deleting `niko_scada.json` and pairing again is harmless.
- **Revoking:** revoke the device in **Payroll › Devices**, and the helper stops at its next
  pass.
- **Access:** a `scada` device token is refused by every gate and canteen endpoint, so it
  can never read staff names, photos or punches.
