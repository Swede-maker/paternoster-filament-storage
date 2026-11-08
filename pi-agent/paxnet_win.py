"""
paxnet_win - the Windows twin of paxnet.py, used when the master is a Windows PC.

Same public API as paxnet.py (Config, status, scan, join, ap_up, Watchdog, ...)
so paternoster_agent.py does not care which one it got. Instead of nmcli it
drives:

  * netsh wlan                   Wi-Fi scan / join / reading the router password
  * win_net.ps1 (WinRT)          adapter state and Windows Mobile Hotspot

Only used in Wi-Fi mode. When the PC is on a cable, run-agent.ps1 starts the
agent with --no-hotspot and this module is only asked for hostname()/Config().

Hotspot address on Windows is 192.168.137.1 (Pi: 10.42.0.1). Slaves find the
master by name (pax-master.local), so they do not care.

Config: %ProgramData%\\PAX\\paxnet.conf (override with PAXNET_CONF), same INI
keys as /etc/paxnet.conf plus `router_ssid`.
"""
from __future__ import annotations

import configparser
import json
import os
import socket
import subprocess
import tempfile
import threading
import time
import uuid
from typing import Callable, Optional
from xml.sax.saxutils import escape

CONF_PATH = os.environ.get("PAXNET_CONF") or os.path.join(
    os.environ.get("ProgramData", r"C:\ProgramData"), "PAX", "paxnet.conf"
)
HELPER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "win_net.ps1")

BOOT_TIMEOUT_S = 45
RETRY_INTERVAL_S = 60
LOSS_TIMEOUT_S = 45
TICK_S = 10
VALID_MODES = ("auto", "router", "ap")
AP_GATEWAY = "192.168.137.1"

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class NetError(RuntimeError):
    pass


# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------
class Config:
    def __init__(self, path: str = CONF_PATH):
        self.path = path
        self.role = "master"
        self.mode = "auto"
        self.ap_ssid = ""
        self.ap_psk = ""
        self.iface = "wifi"
        self.master_host = "localhost"
        self.router_ssid = ""
        self.load()

    def load(self) -> None:
        cp = configparser.ConfigParser()
        if os.path.exists(self.path):
            cp.read(self.path, encoding="utf-8")
        sec = cp["pax"] if cp.has_section("pax") else {}
        self.role = (sec.get("role", "master") or "master").strip()
        mode = (sec.get("mode", "auto") or "auto").strip()
        self.mode = mode if mode in VALID_MODES else "auto"
        self.ap_ssid = (sec.get("ap_ssid", "") or "").strip() or default_ap_ssid()
        self.ap_psk = (sec.get("ap_psk", "") or "").strip()
        self.iface = (sec.get("iface", "wifi") or "wifi").strip()
        self.master_host = (sec.get("master_host", "localhost") or "localhost").strip()
        self.router_ssid = (sec.get("router_ssid", "") or "").strip()

    def save(self) -> None:
        cp = configparser.ConfigParser()
        cp["pax"] = {
            "role": self.role,
            "mode": self.mode,
            "ap_ssid": self.ap_ssid,
            "ap_psk": self.ap_psk,
            "iface": self.iface,
            "master_host": self.master_host,
            "router_ssid": self.router_ssid,
        }
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        try:
            with open(self.path, "w", encoding="utf-8") as fh:
                cp.write(fh)
        except OSError as exc:
            raise NetError(f"cannot write {self.path}: {exc}") from exc


def default_ap_ssid(iface: str = "wifi") -> str:
    return f"PAX-Setup-{uuid.getnode() & 0xFFFF:04X}"


def hostname() -> str:
    return socket.gethostname()


# --------------------------------------------------------------------------
# Plumbing
# --------------------------------------------------------------------------
def _helper(action: str, env: Optional[dict] = None, timeout: float = 70) -> dict:
    full_env = dict(os.environ)
    if env:
        full_env.update(env)
    try:
        r = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", HELPER, action],
            capture_output=True, text=True, timeout=timeout, env=full_env, creationflags=_NO_WINDOW,
        )
    except subprocess.TimeoutExpired as exc:
        raise NetError(f"win_net.ps1 {action} timed out") from exc
    except FileNotFoundError as exc:
        raise NetError("powershell.exe not found") from exc
    lines = [l for l in (r.stdout or "").splitlines() if l.strip().startswith("{")]
    if not lines:
        raise NetError(f"win_net.ps1 {action}: {(r.stderr or r.stdout or 'no output').strip()[:300]}")
    data = json.loads(lines[-1])
    if not data.get("ok", False):
        raise NetError(str(data.get("error") or f"win_net.ps1 {action} failed"))
    return data


def _netsh(*args: str, timeout: float = 30) -> str:
    r = subprocess.run(
        ["netsh", *args], capture_output=True, text=True, timeout=timeout,
        creationflags=_NO_WINDOW, encoding="utf-8", errors="replace",
    )
    if r.returncode != 0:
        raise NetError((r.stdout or r.stderr or "netsh failed").strip()[:300])
    return r.stdout or ""


def _net() -> dict:
    return _helper("status")


def _wifi_gateway(net: dict) -> Optional[str]:
    w = net.get("wifi") or {}
    return w.get("gateway") if w.get("up") else None


def _hotspot_on(net: dict) -> bool:
    return (net.get("hotspot") or {}).get("state") == "On"


# --------------------------------------------------------------------------
# Public operations (same names as paxnet.py)
# --------------------------------------------------------------------------
def scan(iface: str = "wifi") -> list[dict]:
    """netsh text is localized, but the `SSID n : name` lines and the `NN%`
    signal lines are the same in every language."""
    out = _netsh("wlan", "show", "networks", "mode=bssid")
    current = None
    try:
        w = _net().get("wifi") or {}
        current = w.get("network") if w.get("up") else None
    except NetError:
        pass
    best: dict[str, dict] = {}
    ssid = None
    for raw in out.splitlines():
        line = raw.strip()
        if line.upper().startswith("SSID ") and ":" in line:
            ssid = line.split(":", 1)[1].strip() or None
            if ssid and ssid not in best:
                best[ssid] = {"ssid": ssid, "signal": 0, "security": "WPA2", "inUse": ssid == current}
            continue
        if ssid and line.endswith("%") and ":" in line:
            try:
                sig = int(line.rsplit(":", 1)[1].strip().rstrip("%"))
            except ValueError:
                continue
            best[ssid]["signal"] = max(best[ssid]["signal"], sig)
    return sorted(best.values(), key=lambda e: (-int(e["inUse"]), -e["signal"]))


def validate_creds(ssid: str, psk: str) -> None:
    if not ssid or len(ssid.encode("utf-8")) > 32:
        raise NetError("SSID must be 1-32 bytes")
    if psk and not (8 <= len(psk) <= 63):
        raise NetError("Wi-Fi password must be 8-63 characters (or empty for an open network)")


def _profile_xml(ssid: str, psk: str) -> str:
    name = escape(ssid)
    if psk:
        sec = (
            "<authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption>"
            "<useOneX>false</useOneX></authEncryption>"
            f"<sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>{escape(psk)}</keyMaterial></sharedKey>"
        )
    else:
        sec = "<authEncryption><authentication>open</authentication><encryption>none</encryption><useOneX>false</useOneX></authEncryption>"
    return (
        '<?xml version="1.0"?>'
        '<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">'
        f"<name>{name}</name><SSIDConfig><SSID><name>{name}</name></SSID></SSIDConfig>"
        "<connectionType>ESS</connectionType><connectionMode>auto</connectionMode>"
        f"<MSM><security>{sec}</security></MSM></WLANProfile>"
    )


def save_router_profile(ssid: str, psk: str, iface: str = "wifi") -> None:
    validate_creds(ssid, psk)
    fd, path = tempfile.mkstemp(suffix=".xml")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(_profile_xml(ssid, psk))
        _netsh("wlan", "add", "profile", f"filename={path}", "user=all")
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    cfg = Config()
    cfg.router_ssid = ssid
    cfg.save()


def join(ssid: str, psk: str, iface: str = "wifi") -> None:
    save_router_profile(ssid, psk, iface)
    try:
        _helper("hotspot-down")
    except NetError:
        pass
    _netsh("wlan", "connect", f"name={ssid}", f"ssid={ssid}")
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        time.sleep(4)
        try:
            net = _net()
        except NetError:
            continue
        w = net.get("wifi") or {}
        if w.get("up") and w.get("gateway"):
            return
    raise NetError(f"could not connect to '{ssid}' (wrong password or out of range?)")


def forget_router() -> None:
    cfg = Config()
    if cfg.router_ssid:
        try:
            _netsh("wlan", "delete", "profile", f"name={cfg.router_ssid}")
        except NetError:
            pass
        cfg.router_ssid = ""
        cfg.save()


def ensure_ap_profile(cfg: Config) -> None:
    if not cfg.ap_psk or len(cfg.ap_psk) < 8:
        raise NetError(f"ap_psk missing in {cfg.path} - re-run the Windows installer")
    _helper("hotspot-config", {"PAX_AP_SSID": cfg.ap_ssid, "PAX_AP_PSK": cfg.ap_psk})


def ensure_master_ap_profile(cfg: Config) -> None:
    raise NetError("a Windows PC is always the master; it never joins another master's hotspot")


def ap_up(cfg: Config) -> None:
    if not cfg.ap_psk or len(cfg.ap_psk) < 8:
        raise NetError(f"ap_psk missing in {cfg.path} - re-run the Windows installer")
    _helper("hotspot-up", {"PAX_AP_SSID": cfg.ap_ssid, "PAX_AP_PSK": cfg.ap_psk})


def ap_down(cfg: Config) -> None:
    _helper("hotspot-down")


def ap_active(cfg: Config) -> bool:
    try:
        return _hotspot_on(_net())
    except NetError:
        return False


def router_up(iface: str = "wifi") -> None:
    ssid = saved_router_ssid()
    if not ssid:
        raise NetError("no router saved yet - pick one from the Wi-Fi list first")
    _netsh("wlan", "connect", f"name={ssid}")


def saved_router_ssid() -> Optional[str]:
    """The router chosen in the app, else whatever Wi-Fi the PC is on now."""
    cfg = Config()
    if cfg.router_ssid:
        return cfg.router_ssid
    try:
        w = _net().get("wifi") or {}
        return w.get("network") if w.get("up") and w.get("gateway") else None
    except NetError:
        return None


def saved_router_psk() -> Optional[str]:
    """Read the router password back so the master can push it to slaves.
    `netsh wlan export ... key=clear` writes XML, which is not localized."""
    ssid = saved_router_ssid()
    if not ssid:
        return None
    folder = tempfile.mkdtemp(prefix="pax-wlan-")
    try:
        _netsh("wlan", "export", "profile", f"name={ssid}", "key=clear", f"folder={folder}")
        for fn in os.listdir(folder):
            if not fn.lower().endswith(".xml"):
                continue
            import xml.etree.ElementTree as ET

            root = ET.parse(os.path.join(folder, fn)).getroot()
            for el in root.iter():
                if el.tag.endswith("keyMaterial"):
                    return el.text or ""
            return ""
        return None
    except (NetError, OSError):
        return None
    finally:
        for fn in os.listdir(folder):
            try:
                os.remove(os.path.join(folder, fn))
            except OSError:
                pass
        try:
            os.rmdir(folder)
        except OSError:
            pass


def status(cfg: Config) -> dict:
    net = _net()
    w = net.get("wifi") or {}
    e = net.get("ethernet") or {}
    ssid, ip, gw = None, None, None
    if _hotspot_on(net):
        mode, ssid, ip = "ap", cfg.ap_ssid, AP_GATEWAY
    elif w.get("up") and w.get("gateway"):
        mode, ssid, ip, gw = "router", w.get("network"), w.get("ip"), w.get("gateway")
    elif e.get("up") and e.get("gateway"):
        mode, ip, gw = "router", e.get("ip"), e.get("gateway")
    else:
        mode = "offline"
    return {
        "type": "net.status",
        "role": cfg.role,
        "pin": cfg.mode,
        "mode": mode,
        "ssid": ssid,
        "signal": None,
        "ip": ip,
        "gateway": gw,
        "hostname": hostname(),
        "apSsid": cfg.ap_ssid,
        "routerSaved": bool(saved_router_ssid()),
        "platform": "windows",
        "at": int(time.time() * 1000),
    }


# --------------------------------------------------------------------------
# Watchdog: same state machine as the Pi (see paxnet.Watchdog)
# --------------------------------------------------------------------------
class Watchdog(threading.Thread):
    def __init__(self, cfg: Config, on_change: Optional[Callable[[dict], None]] = None, log=print):
        super().__init__(daemon=True, name="paxnet-win-watchdog")
        self.cfg = cfg
        self.on_change = on_change
        self.log = log
        self._stop = threading.Event()
        self._kick = threading.Event()
        self.last_mode: Optional[str] = None
        self.in_fallback = False
        self._lost_since: Optional[float] = None
        self._next_retry = 0.0
        self._hotspot_failed_logged = False

    def stop(self) -> None:
        self._stop.set()
        self._kick.set()

    def kick(self) -> None:
        self._kick.set()

    def run(self) -> None:
        cfg = self.cfg
        self.log(f"[paxnet-win] watchdog up: pin={cfg.mode} hotspot={cfg.ap_ssid}", flush=True)
        boot_deadline = time.monotonic() + BOOT_TIMEOUT_S
        while not self._stop.is_set():
            try:
                self._tick(boot_deadline)
            except NetError as exc:
                self.log(f"[paxnet-win] {exc}", flush=True)
            except Exception as exc:
                self.log(f"[paxnet-win] unexpected: {exc!r}", flush=True)
            self._kick.wait(TICK_S)
            self._kick.clear()

    def _hotspot_up(self) -> None:
        try:
            ap_up(self.cfg)
            self._hotspot_failed_logged = False
            self.log(f"[paxnet-win] hotspot '{self.cfg.ap_ssid}' is up (app at http://{AP_GATEWAY})", flush=True)
        except NetError as exc:
            if not self._hotspot_failed_logged:
                self.log(f"[paxnet-win] {exc} - will keep trying every {RETRY_INTERVAL_S}s", flush=True)
                self._hotspot_failed_logged = True

    def _tick(self, boot_deadline: float) -> None:
        cfg = self.cfg
        cfg.load()
        now = time.monotonic()
        net = _net()
        hotspot = _hotspot_on(net)
        on_router = _wifi_gateway(net) is not None

        if cfg.mode == "ap":
            if not hotspot:
                self.log("[paxnet-win] pin=ap -> hotspot up", flush=True)
                self._hotspot_up()
            self.in_fallback, self._lost_since, self._next_retry = False, None, 0.0
            self._announce()
            return

        if on_router:
            if self.in_fallback:
                self.log("[paxnet-win] router is back -> leaving fallback", flush=True)
                if hotspot:
                    ap_down(cfg)
            self.in_fallback, self._lost_since, self._next_retry = False, None, 0.0
            self._announce()
            return

        if self._lost_since is None:
            self._lost_since = now
        timeout = BOOT_TIMEOUT_S if now < boot_deadline else LOSS_TIMEOUT_S
        waited = now - self._lost_since

        if cfg.mode == "router":
            if now >= self._next_retry and saved_router_ssid():
                self._try_router()
                self._next_retry = now + RETRY_INTERVAL_S
            if hotspot:
                ap_down(cfg)
            self._announce()
            return

        if not self.in_fallback:
            if waited >= timeout:
                self.in_fallback = True
                self.log(f"[paxnet-win] no router after {waited:.0f}s -> hotspot '{cfg.ap_ssid}'", flush=True)
                self._hotspot_up()
                self._next_retry = now + RETRY_INTERVAL_S
        elif now >= self._next_retry:
            self._next_retry = now + RETRY_INTERVAL_S
            if not hotspot:
                self._hotspot_up()
            self._try_router()
        self._announce()

    def _try_router(self) -> None:
        """Only drop the hotspot if the router is actually in range."""
        target = self.cfg.router_ssid
        if not target:
            return
        try:
            nets = scan()
        except NetError:
            nets = []
        if not any(n["ssid"] == target for n in nets):
            return
        self.log(f"[paxnet-win] router '{target}' in range -> trying it", flush=True)
        try:
            ap_down(self.cfg)
            _netsh("wlan", "connect", f"name={target}")
            for _ in range(8):
                time.sleep(4)
                if _wifi_gateway(_net()):
                    return
            raise NetError("no gateway after connecting")
        except NetError as exc:
            self.log(f"[paxnet-win] router attempt failed: {exc}", flush=True)
            self._hotspot_up()

    def _announce(self) -> None:
        try:
            st = status(self.cfg)
        except NetError:
            return
        if st["mode"] != self.last_mode:
            self.last_mode = st["mode"]
            self.log(f"[paxnet-win] mode -> {st['mode']} ssid={st['ssid']} ip={st['ip']}", flush=True)
            if self.on_change:
                try:
                    self.on_change(st)
                except Exception:
                    pass


if __name__ == "__main__":
    import sys

    c = Config()
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    try:
        if cmd == "status":
            print(json.dumps(status(c), indent=2))
        elif cmd == "scan":
            print(json.dumps(scan(), indent=2))
        elif cmd == "ap-up":
            ap_up(c)
        elif cmd == "ap-down":
            ap_down(c)
        elif cmd == "watch":
            Watchdog(c).run()
        else:
            print(__doc__)
    except NetError as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
