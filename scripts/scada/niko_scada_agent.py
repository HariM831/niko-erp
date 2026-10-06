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
    py -3 niko_scada_agent.py live                   # read the live tags once and print them
    py -3 niko_scada_agent.py browse                 # show what WinCC's OPC UA server offers

Live values (Feed Mill > Live Mill) need WinCC's OPC UA server running on this
PC, and one more package:  py -3 -m pip install asyncua
Without either, the helper carries on copying batches and says so in its log.
The OPC UA side is READ ONLY too: it reads tag values and writes none.

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
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG = HERE / "niko_scada.json"
LOG = HERE / "niko_scada.log"

DEFAULT_URL = "https://aminofarms.com"
# WinCC's OPC UA server on this same PC (the project's OPCUASERVERWINCCPRO.XML says 4861).
OPC_URL = "opc.tcp://localhost:4861"
LIVE_EVERY_S = 2
LIVE_KEEPALIVE_S = 10
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


# ─────────────────────────────── Live values ───────────────────────────────

class Live:
    """WinCC's tags over OPC UA, read only. Connects lazily and reconnects on failure."""

    def __init__(self, tags: list[str]):
        self.tags = tags
        self.client = None
        self.nodes: dict[str, object] = {}
        self.next_try = 0.0

    def _plain(self, v):
        if v is None or isinstance(v, (bool, int, float, str)):
            return v
        if hasattr(v, "isoformat"):
            return v.isoformat()
        return str(v)[:200]

    def connect(self) -> bool:
        if self.client is not None:
            return True
        if time.time() < self.next_try:
            return False
        try:
            from asyncua.sync import Client  # imported here: batches work without it
        except ImportError:
            log.warning("live values off: asyncua not installed (py -3 -m pip install asyncua)")
            self.next_try = time.time() + 3600
            return False
        try:
            c = Client(OPC_URL, timeout=10)
            c.connect()
        except Exception as e:
            log.warning("live values off: cannot reach WinCC OPC UA at %s (%s)", OPC_URL, e)
            self.next_try = time.time() + 30
            return False
        self.client = c
        self.nodes = self._resolve(c)
        log.info("OPC UA connected: %d of %d tags found", len(self.nodes), len(self.tags))
        missing = [t for t in self.tags if t not in self.nodes]
        if missing:
            log.info("not found on the OPC UA server: %s", ", ".join(missing[:40]))
        return True

    def _resolve(self, c) -> dict:
        """Work out how this WinCC names its tags (namespace and prefix), then find each one."""
        ns_count = len(c.get_namespace_array())
        patterns = [(ns, fmt) for ns in range(1, ns_count) for fmt in ("t|{}", "{}")]
        probe = self.tags[0]
        chosen = None
        for ns, fmt in patterns:
            try:
                c.get_node(f"ns={ns};s={fmt.format(probe)}").read_value()
                chosen = (ns, fmt)
                break
            except Exception:
                continue
        found = {}
        if chosen is None:
            log.warning("could not find %s on the OPC UA server in any namespace - run 'browse'", probe)
            return found
        ns, fmt = chosen
        log.info("WinCC tags are ns=%d;s=%s", ns, fmt.format("<tag>"))
        for t in self.tags:
            node = c.get_node(f"ns={ns};s={fmt.format(t)}")
            try:
                node.read_value()
                found[t] = node
            except Exception:
                pass
        return found

    def read(self) -> dict:
        names = list(self.nodes)
        values = self.client.read_values([self.nodes[n] for n in names])
        return {n: self._plain(v) for n, v in zip(names, values)}

    def drop(self, why: str) -> None:
        log.warning("OPC UA connection lost (%s) - reconnecting", why)
        try:
            self.client.disconnect()
        except Exception:
            pass
        self.client = None
        self.nodes = {}
        self.next_try = time.time() + 10


def run(forever: bool) -> None:
    cfg = load_config()
    if not cfg.get("token"):
        raise SystemExit("Not paired yet: run  py -3 niko_scada_agent.py pair <CODE>")
    base, token = cfg["base_url"], cfg["token"]
    log.info("niko SCADA helper starting (%s)", "forever" if forever else "one pass")
    live = None
    if forever:
        try:
            tags = http("GET", f"{base}/api/scada/device/live-tags", token)["tags"]
            live = Live(tags)
        except Revoked:
            raise
        except Exception as e:
            log.warning("live values off: could not get the tag list from niko (%s)", e)
    last_sent: dict | None = None
    last_post = 0.0
    next_batches = 0.0
    while True:
        now = time.time()
        if now >= next_batches:
            next_batches = now + INTERVAL_S
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
        if live is not None and live.connect() and live.nodes:
            try:
                values = live.read()
            except Exception as e:
                live.drop(str(e))
            else:
                if values != last_sent or now - last_post >= LIVE_KEEPALIVE_S:
                    try:
                        at = datetime.now(timezone.utc).isoformat()
                        http("POST", f"{base}/api/scada/device/live", token, {"at": at, "values": values}, timeout=15)
                        last_sent, last_post = values, now
                    except Revoked:
                        log.error("this device was revoked in niko - stopping")
                        raise SystemExit(2)
                    except Exception as e:
                        log.warning("live post failed: %s", e)
        time.sleep(LIVE_EVERY_S if live is not None else INTERVAL_S)


def live_once() -> None:
    """Read the live tags once and print them - to check the OPC UA side by hand."""
    cfg = load_config()
    tags = http("GET", f"{cfg['base_url']}/api/scada/device/live-tags", cfg["token"])["tags"]
    live = Live(tags)
    if not live.connect():
        raise SystemExit("could not connect - see the log line above")
    for name, value in sorted(live.read().items()):
        print(f"{name:45} {value}")


def browse() -> None:
    """What WinCC's OPC UA server offers: namespaces and the top of its address space."""
    from asyncua.sync import Client

    c = Client(OPC_URL, timeout=10)
    c.connect()
    try:
        for i, ns in enumerate(c.get_namespace_array()):
            print(f"ns={i}  {ns}")
        objects = c.nodes.objects
        for child in objects.get_children()[:40]:
            print(f"  {child.nodeid.to_string():50} {child.read_browse_name().Name}")
            for g in child.get_children()[:15]:
                print(f"      {g.nodeid.to_string():46} {g.read_browse_name().Name}")
    finally:
        c.disconnect()


def main() -> None:
    setup_logging()
    args = sys.argv[1:]
    if not args or args[0] not in ("pair", "once", "run", "live", "browse"):
        print(__doc__)
        raise SystemExit(1)
    if args[0] == "pair":
        if len(args) < 2:
            raise SystemExit("usage: niko_scada_agent.py pair <CODE> [base_url]")
        pair(args[1], args[2].rstrip("/") if len(args) > 2 else DEFAULT_URL)
    elif args[0] == "live":
        live_once()
    elif args[0] == "browse":
        browse()
    else:
        run(forever=args[0] == "run")


if __name__ == "__main__":
    main()
