"""
niko SCADA helper - runs on the feed mill's WinCC PC.

Copies every batch the SCADA logs (BATCH.dbo.HISTORY on the PC's own SQL
Server, the table behind the AMINOFARMS batching report) to niko, where it is
a record beside production: Feed Mill > SCADA Batches.

READ ONLY towards the mill. It runs SELECT statements against HISTORY and
nothing else; it never writes to SQL Server, WinCC or the PLC. Its only
outward connection is HTTPS to niko.

    py -3 -m pip install pyodbc
    py -3 niko_scada_agent.py pair ABCD1234          # once, with a code from niko
    py -3 niko_scada_agent.py once                   # one pass, to try it
    py -3 niko_scada_agent.py run                    # forever (what the scheduled task runs)

The pairing code comes from niko: Payroll > Devices > Pair a device, role
"scada", site Dhekiajuli. The token it returns is kept in niko_scada.json
beside this file; revoking the device in niko stops the helper.
"""
from __future__ import annotations

import json
import logging
import logging.handlers
import platform
import socket
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG = HERE / "niko_scada.json"
LOG = HERE / "niko_scada.log"

DEFAULT_URL = "https://aminofarms.com"
SQL = r"DRIVER={SQL Server};SERVER=.\WINCC;DATABASE=BATCH;Trusted_Connection=yes;APP=niko-scada-helper"
CHUNK = 500
INTERVAL_S = 60

log = logging.getLogger("niko-scada")


def setup_logging() -> None:
    log.setLevel(logging.INFO)
    fh = logging.handlers.RotatingFileHandler(LOG, maxBytes=2_000_000, backupCount=3, encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    log.addHandler(fh)
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
    log.addHandler(sh)


def load_config() -> dict:
    if CONFIG.exists():
        return json.loads(CONFIG.read_text(encoding="utf-8"))
    return {}


def save_config(cfg: dict) -> None:
    CONFIG.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


class Revoked(Exception):
    pass


def http(method: str, url: str, token: str | None = None, body: dict | None = None, timeout: int = 60):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "niko-scada-helper/1")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8") or "null")
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace")
        if e.code == 401 and "device_revoked" in text:
            raise Revoked(text) from e
        raise RuntimeError(f"{method} {url} -> {e.code}: {text[:300]}") from e


# ─────────────────────────────── Pairing ───────────────────────────────

def pair(code: str, base_url: str) -> None:
    install_id = f"scada-{socket.gethostname()}"
    body = {
        "code": code,
        "installId": install_id,
        "deviceModel": f"{platform.node()} (WinCC SCADA PC)",
        "osVersion": platform.platform(),
        "appVersionCode": 1,
    }
    out = http("POST", f"{base_url}/api/device/pair/claim", body=body)
    if out.get("status") == "pending":
        pending = out["pendingId"]
        print("Waiting for an admin to approve this device in niko (Payroll > Devices)...")
        for _ in range(180):
            time.sleep(10)
            out = http("GET", f"{base_url}/api/device/pair/{pending}")
            if out.get("status") != "pending":
                break
    if out.get("status") != "approved" or not out.get("token"):
        raise SystemExit(f"Pairing did not complete: {out}")
    if out.get("role") != "scada":
        raise SystemExit(f"That code is for a '{out.get('role')}' device, not 'scada'. Ask for a SCADA code.")
    save_config({"base_url": base_url, "token": out["token"], "device_id": out.get("deviceId"), "name": out.get("name")})
    print(f"Paired as '{out.get('name')}'. Token saved to {CONFIG}.")


# ─────────────────────────────── Copying ───────────────────────────────

def read_rows(after: str | None) -> list[dict]:
    """The next rows of HISTORY after the cursor, oldest first. SELECT only."""
    import pyodbc  # imported here so `pair` works before pyodbc is installed

    cols = ", ".join(
        [f"BINSET{i}" for i in range(1, 9)] + [f"BINACT{i}" for i in range(1, 9)] + [f"BNAME{i}" for i in range(1, 9)]
    )
    # >= rather than >: a batch logged in the same millisecond as the cursor
    # is not lost; niko ignores the one it already has.
    where = "WHERE dateandtime >= CONVERT(datetime, ?, 121)" if after else ""
    sql = (
        f"SELECT TOP {CHUNK} CONVERT(varchar(23), dateandtime, 121) AS t, RNAME, QTY, {cols} "
        f"FROM dbo.HISTORY {where} ORDER BY dateandtime"
    )
    conn = pyodbc.connect(SQL, timeout=10, readonly=True)
    try:
        cur = conn.cursor()
        # Read without taking locks, so the copy can never hold up the
        # integrator's logging of the batch that is being weighed right now.
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED")
        if after:
            cur.execute(sql, after[:23])
        else:
            cur.execute(sql)
        out = []
        for r in cur.fetchall():
            vals = list(r)
            t, rname, qty = vals[0], vals[1], vals[2]
            sets, acts, names = vals[3:11], vals[11:19], vals[19:27]
            out.append(
                {
                    "time": t,
                    "recipe": (rname or "").strip()[:80],
                    "qty": int(qty) if qty is not None else None,
                    "set": [int(v or 0) for v in sets],
                    "act": [int(v or 0) for v in acts],
                    "names": [(n or "").strip()[:80] or None for n in names],
                }
            )
        return out
    finally:
        conn.close()


def one_pass(cfg: dict) -> int:
    base, token = cfg["base_url"], cfg["token"]
    sent = 0
    while True:
        after = http("GET", f"{base}/api/scada/device/cursor", token)["after"]
        rows = read_rows(after)
        # A pass that finds only the cursor's own row has nothing new.
        fresh = [r for r in rows if r["time"] != (after or "")[:23]] if after else rows
        if not fresh:
            return sent
        out = http("POST", f"{base}/api/scada/device/batches", token, {"rows": rows}, timeout=120)
        sent += out.get("stored", 0)
        log.info("sent %d rows (%d new) up to %s", len(rows), out.get("stored", 0), rows[-1]["time"])
        if len(rows) < CHUNK:
            return sent


def run(forever: bool) -> None:
    cfg = load_config()
    if not cfg.get("token"):
        raise SystemExit("Not paired yet: run  py -3 niko_scada_agent.py pair <CODE>")
    log.info("niko SCADA helper starting (%s)", "forever" if forever else "one pass")
    while True:
        try:
            n = one_pass(cfg)
            if not forever:
                log.info("done, %d new batches", n)
                return
        except Revoked:
            log.error("this device was revoked in niko - stopping")
            raise SystemExit(2)
        except Exception as e:  # keep going; the mill never waits on niko
            log.warning("pass failed: %s", e)
            if not forever:
                raise
        time.sleep(INTERVAL_S)


def main() -> None:
    setup_logging()
    args = sys.argv[1:]
    if not args or args[0] not in ("pair", "once", "run"):
        print(__doc__)
        raise SystemExit(1)
    if args[0] == "pair":
        if len(args) < 2:
            raise SystemExit("usage: niko_scada_agent.py pair <CODE> [base_url]")
        pair(args[1], args[2].rstrip("/") if len(args) > 2 else DEFAULT_URL)
    else:
        run(forever=args[0] == "run")


if __name__ == "__main__":
    main()
