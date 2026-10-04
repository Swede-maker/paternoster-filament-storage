"""
paxnet — Wi-Fi management for PAX Raspberry Pis on NetworkManager (Bookworm+).

Everything here is a thin, defensive wrapper around `nmcli`. It gives the agent:

  * scan()                 → list of nearby SSIDs
  * join(ssid, psk)        → save the workshop router as profile `pax-router` and connect
  * ap_up() / ap_down()    → bring the standalone hotspot (profile `pax-ap`) up / down
  * status()               → what are we on right now: router / ap / master-ap / offline
  * set_mode() / get_mode()→ the operator's pin: "auto" | "router" | "ap"
  * Watchdog               → the boot-time fallback + periodic retry state machine

Roles
-----
master  Owns the hotspot. Falls back to `pax-ap` when the router is gone so a
        phone can still reach the app.
slave   Never runs a hotspot. Falls back to the *master's* hotspot (profile
        `pax-master-ap`) so it stays reachable and can receive new router
        credentials from the master without anyone touching it.

Profiles (NetworkManager connection names)
------------------------------------------
  pax-router     the workshop router (STA). autoconnect, priority 100.
  pax-ap         master only — the standalone hotspot. ipv4.method shared →
                 NM runs DHCP + NAT, gateway 10.42.0.1. Never autoconnects: the
                 watchdog brings it up deliberately.
  pax-master-ap  slave only — STA profile for the master's hotspot. autoconnect,
                 priority 10 (loses to pax-router when both are in range).

Config
------
/etc/paxnet.conf   INI, written by install.sh, read here.
  [pax]
  role     = master|slave
  mode     = auto|router|ap        (operator pin; this module rewrites it)
  ap_ssid  = PAX-Setup-1A2B        (master; slaves store the master's here too)
  ap_psk   = ...
  iface    = wlan0

Privileges
----------
The agent runs as an unprivileged user. nmcli needs polkit/root for connection
changes, so every call goes through `sudo -n nmcli ...`. install.sh drops a
sudoers rule allowing exactly that binary with no password. If sudo is missing
or refuses, the call fails loudly with the stderr text — never silently.

This module deliberately has no dependencies beyond the stdlib so it runs on a
Pi Zero 2 W without a venv.
"""

from __future__ import annotations

import configparser
import os
import re
import subprocess
import threading
import time
from typing import Callable, Optional

CONF_PATH = "/etc/paxnet.conf"

PROFILE_ROUTER = "pax-router"
PROFILE_AP = "pax-ap"
PROFILE_MASTER_AP = "pax-master-ap"

# Boot grace: how long the router gets to hand us a default gateway before we
# give up and fall back. Bookworm's NetworkManager usually associates within
# ~10 s; 45 s covers a slow DHCP server and a router that is itself still
# booting after a power cut (the common case in a workshop).
BOOT_TIMEOUT_S = 45
# While in fallback, how often to peek for the router again.
RETRY_INTERVAL_S = 60
# When the router disappears mid-session, how long before falling back.
LOSS_TIMEOUT_S = 45

NMCLI_TIMEOUT_S = 25

Mode = str  # "auto" | "router" | "ap"
Role = str  # "master" | "slave"

VALID_MODES = ("auto", "router", "ap")


class NetError(RuntimeError):
    pass


# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------
class Config:
    def __init__(self, path: str = CONF_PATH):
        self.path = path
        self.role: Role = "master"
        self.mode: Mode = "auto"
        self.ap_ssid: str = ""
        self.ap_psk: str = ""
        self.iface: str = "wlan0"
        self.master_host: str = "pax-master.local"
        self.load()

    def load(self) -> None:
        cp = configparser.ConfigParser()
        if os.path.exists(self.path):
            cp.read(self.path)
        sec = cp["pax"] if cp.has_section("pax") else {}
        self.role = (sec.get("role", "master") or "master").strip()
        mode = (sec.get("mode", "auto") or "auto").strip()
        self.mode = mode if mode in VALID_MODES else "auto"
        self.ap_ssid = (sec.get("ap_ssid", "") or "").strip()
        self.ap_psk = (sec.get("ap_psk", "") or "").strip()
        self.iface = (sec.get("iface", "wlan0") or "wlan0").strip()
        self.master_host = (sec.get("master_host", "pax-master.local") or "pax-master.local").strip()
        if not self.ap_ssid:
            self.ap_ssid = default_ap_ssid(self.iface)

    def save(self) -> None:
        cp = configparser.ConfigParser()
        cp["pax"] = {
            "role": self.role,
            "mode": self.mode,
            "ap_ssid": self.ap_ssid,
            "ap_psk": self.ap_psk,
            "iface": self.iface,
            "master_host": self.master_host,
        }
        # The file holds the hotspot password: root-only. Writing needs sudo
        # when we are unprivileged, so go through `tee` under the same sudoers
        # rule family install.sh sets up.
        body = _ini_to_str(cp)
        try:
            with open(self.path, "w") as fh:
                fh.write(body)
            os.chmod(self.path, 0o600)
        except PermissionError:
            r = subprocess.run(
                ["sudo", "-n", "tee", self.path],
                input=body,
                text=True,
                capture_output=True,
                timeout=10,
            )
            if r.returncode != 0:
                raise NetError(f"cannot write {self.path}: {r.stderr.strip() or 'permission denied'}")
            subprocess.run(["sudo", "-n", "chmod", "600", self.path], capture_output=True, timeout=10)


def _ini_to_str(cp: configparser.ConfigParser) -> str:
    import io

    buf = io.StringIO()
    cp.write(buf)
    return buf.getvalue()


def default_ap_ssid(iface: str = "wlan0") -> str:
    """`PAX-Setup-XXXX` from the last two bytes of the Wi-Fi MAC — stable across
    reboots and reinstalls, so slaves provisioned once keep finding it."""
    try:
        with open(f"/sys/class/net/{iface}/address") as fh:
            mac = fh.read().strip().replace(":", "").upper()
        return f"PAX-Setup-{mac[-4:]}"
    except Exception:
        return "PAX-Setup"


# --------------------------------------------------------------------------
# nmcli plumbing
# --------------------------------------------------------------------------
def _nmcli(*args: str, timeout: float = NMCLI_TIMEOUT_S, privileged: bool = True) -> str:
    """Run nmcli and return stdout. Raises NetError with nmcli's own message."""
    cmd = ["nmcli", *args]
    if privileged and os.geteuid() != 0:
        cmd = ["sudo", "-n", *cmd]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError as exc:
        raise NetError(f"{exc.filename} not found — is NetworkManager installed? (Raspberry Pi OS Bookworm+)")
    except subprocess.TimeoutExpired:
        raise NetError(f"nmcli timed out after {timeout:.0f}s: {' '.join(args)}")
    if r.returncode != 0:
        err = (r.stderr or r.stdout).strip()
        if "a password is required" in err or "sudo:" in err:
            err = "sudo refused nmcli — re-run install.sh to install the sudoers rule"
        raise NetError(err or f"nmcli failed ({r.returncode})")
    return r.stdout


def _split_terse(line: str) -> list[str]:
    """nmcli -t escapes ':' inside fields as '\\:'."""
    out, cur, esc = [], "", False
    for ch in line:
        if esc:
            cur += ch
            esc = False
        elif ch == "\\":
            esc = True
        elif ch == ":":
            out.append(cur)
            cur = ""
        else:
            cur += ch
    out.append(cur)
    return out


def _profile_exists(name: str) -> bool:
    try:
        out = _nmcli("-t", "-f", "NAME", "con", "show", privileged=False)
    except NetError:
        return False
    return any(_split_terse(l)[0] == name for l in out.splitlines() if l)


def _active_profile(iface: str) -> Optional[str]:
    try:
        out = _nmcli("-t", "-f", "NAME,DEVICE", "con", "show", "--active", privileged=False)
    except NetError:
        return None
    for l in out.splitlines():
        parts = _split_terse(l)
        if len(parts) >= 2 and parts[1] == iface:
            return parts[0]
    return None


def _ipv4(iface: str) -> tuple[Optional[str], Optional[str]]:
    """(address, gateway) for iface via nmcli device show."""
    try:
        out = _nmcli("-t", "-f", "IP4.ADDRESS,IP4.GATEWAY", "dev", "show", iface, privileged=False)
    except NetError:
        return None, None
    addr = gw = None
    for l in out.splitlines():
        k, _, v = l.partition(":")
        if k.startswith("IP4.ADDRESS") and v and not addr:
            addr = v.split("/")[0]
        elif k == "IP4.GATEWAY" and v:
            gw = v
    return addr, gw or None


def _current_wifi(iface: str) -> tuple[Optional[str], Optional[int]]:
    """(ssid, signal%) of the network we are associated with, if any."""
    try:
        out = _nmcli("-t", "-f", "IN-USE,SSID,SIGNAL", "dev", "wifi", "list", "ifname", iface, privileged=False)
    except NetError:
        return None, None
    for l in out.splitlines():
        parts = _split_terse(l)
        if len(parts) >= 3 and parts[0].strip() == "*":
            try:
                sig = int(parts[2])
            except ValueError:
                sig = None
            return parts[1] or None, sig
    return None, None


def hostname() -> str:
    try:
        return open("/etc/hostname").read().strip() or os.uname().nodename
    except Exception:
        return os.uname().nodename


# --------------------------------------------------------------------------
# Public operations
# --------------------------------------------------------------------------
def scan(iface: str = "wlan0") -> list[dict]:
    """Rescan and return [{ssid, signal, security, inUse}], strongest first,
    one entry per SSID, hidden networks dropped."""
    out = _nmcli(
        "-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY",
        "dev", "wifi", "list", "ifname", iface, "--rescan", "yes",
        timeout=30,
    )
    best: dict[str, dict] = {}
    for l in out.splitlines():
        parts = _split_terse(l)
        if len(parts) < 4:
            continue
        in_use, ssid, sig, sec = parts[0].strip() == "*", parts[1], parts[2], parts[3]
        if not ssid:
            continue
        try:
            signal = int(sig)
        except ValueError:
            signal = 0
        entry = {"ssid": ssid, "signal": signal, "security": sec.strip() or "open", "inUse": in_use}
        prev = best.get(ssid)
        if prev is None or signal > prev["signal"] or in_use:
            if prev and prev["inUse"]:
                entry["inUse"] = True
            best[ssid] = entry
    return sorted(best.values(), key=lambda e: (-int(e["inUse"]), -e["signal"]))


def validate_creds(ssid: str, psk: str) -> None:
    if not ssid or len(ssid.encode("utf-8")) > 32:
        raise NetError("SSID must be 1–32 bytes")
    if psk and not (8 <= len(psk) <= 63):
        raise NetError("Wi-Fi password must be 8–63 characters (or empty for an open network)")


def save_router_profile(ssid: str, psk: str, iface: str = "wlan0") -> None:
    """Create/replace `pax-router` WITHOUT activating it. Used by slaves when the
    master pushes credentials, and by join() before it connects."""
    validate_creds(ssid, psk)
    if _profile_exists(PROFILE_ROUTER):
        _nmcli("con", "delete", PROFILE_ROUTER)
    args = [
        "con", "add", "type", "wifi", "ifname", iface, "con-name", PROFILE_ROUTER,
        "ssid", ssid,
        "connection.autoconnect", "yes",
        "connection.autoconnect-priority", "100",
        "connection.autoconnect-retries", "0",  # 0 = forever
    ]
    if psk:
        args += ["wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.psk", psk]
    _nmcli(*args)


def join(ssid: str, psk: str, iface: str = "wlan0") -> None:
    """Save the router as `pax-router` and connect. Brings the hotspot down
    first (one radio, one mode). Raises NetError with nmcli's reason if the
    association fails (wrong password shows up as 'Secrets were required')."""
    save_router_profile(ssid, psk, iface)
    for p in (PROFILE_AP, PROFILE_MASTER_AP):
        if _active_profile(iface) == p:
            try:
                _nmcli("con", "down", p)
            except NetError:
                pass
    _nmcli("con", "up", PROFILE_ROUTER, timeout=60)


def forget_router() -> None:
    if _profile_exists(PROFILE_ROUTER):
        _nmcli("con", "delete", PROFILE_ROUTER)


def ensure_ap_profile(cfg: Config) -> None:
    """Master: make sure `pax-ap` exists with the configured SSID/psk."""
    if not cfg.ap_psk or len(cfg.ap_psk) < 8:
        raise NetError("ap_psk missing in /etc/paxnet.conf — re-run install.sh --role master")
    if _profile_exists(PROFILE_AP):
        _nmcli("con", "modify", PROFILE_AP, "802-11-wireless.ssid", cfg.ap_ssid, "wifi-sec.psk", cfg.ap_psk)
        return
    _nmcli(
        "con", "add", "type", "wifi", "ifname", cfg.iface, "con-name", PROFILE_AP,
        "ssid", cfg.ap_ssid,
        "802-11-wireless.mode", "ap",
        "802-11-wireless.band", "bg",
        "ipv4.method", "shared",
        "ipv6.method", "disabled",
        "wifi-sec.key-mgmt", "wpa-psk",
        "wifi-sec.psk", cfg.ap_psk,
        "connection.autoconnect", "no",
    )


def ensure_master_ap_profile(cfg: Config) -> None:
    """Slave: STA profile for the master's hotspot, low priority."""
    if not cfg.ap_ssid or not cfg.ap_psk:
        raise NetError("master hotspot credentials missing — install with --role slave --ap-ssid/--ap-psk or wait for the master to push them")
    if _profile_exists(PROFILE_MASTER_AP):
        _nmcli("con", "modify", PROFILE_MASTER_AP, "802-11-wireless.ssid", cfg.ap_ssid, "wifi-sec.psk", cfg.ap_psk)
        return
    _nmcli(
        "con", "add", "type", "wifi", "ifname", cfg.iface, "con-name", PROFILE_MASTER_AP,
        "ssid", cfg.ap_ssid,
        "wifi-sec.key-mgmt", "wpa-psk",
        "wifi-sec.psk", cfg.ap_psk,
        "connection.autoconnect", "yes",
        "connection.autoconnect-priority", "10",
        "connection.autoconnect-retries", "0",
    )


def ap_up(cfg: Config) -> None:
    ensure_ap_profile(cfg)
    if _active_profile(cfg.iface) == PROFILE_ROUTER:
        _nmcli("con", "down", PROFILE_ROUTER)
    _nmcli("con", "up", PROFILE_AP, timeout=40)


def ap_down(cfg: Config) -> None:
    if _active_profile(cfg.iface) == PROFILE_AP:
        _nmcli("con", "down", PROFILE_AP)


def ap_active(cfg: Config) -> bool:
    return _active_profile(cfg.iface) == PROFILE_AP


def router_up(iface: str = "wlan0") -> None:
    if not _profile_exists(PROFILE_ROUTER):
        raise NetError("no router saved yet — pick one from the Wi-Fi list first")
    _nmcli("con", "up", PROFILE_ROUTER, timeout=60)


def status(cfg: Config) -> dict:
    """Snapshot for the app. Mode meanings:
       router     on the workshop router
       ap         (master) serving the standalone hotspot
       master-ap  (slave) camped on the master's hotspot
       offline    radio up but nothing active
    """
    active = _active_profile(cfg.iface)
    ip, gw = _ipv4(cfg.iface)
    ssid, signal = (None, None)
    if active == PROFILE_AP:
        mode = "ap"
        ssid = cfg.ap_ssid
    else:
        ssid, signal = _current_wifi(cfg.iface)
        if active == PROFILE_MASTER_AP:
            mode = "master-ap"
        elif active and ip:
            mode = "router"
        else:
            mode = "offline"
    return {
        "type": "net.status",
        "role": cfg.role,
        "pin": cfg.mode,
        "mode": mode,
        "ssid": ssid,
        "signal": signal,
        "ip": ip,
        "gateway": gw,
        "hostname": hostname(),
        "apSsid": cfg.ap_ssid,
        "routerSaved": _profile_exists(PROFILE_ROUTER),
        "at": int(time.time() * 1000),
    }


def saved_router_ssid() -> Optional[str]:
    if not _profile_exists(PROFILE_ROUTER):
        return None
    try:
        out = _nmcli("-t", "-f", "802-11-wireless.ssid", "con", "show", PROFILE_ROUTER, privileged=False)
        _, _, v = out.strip().partition(":")
        return v or None
    except NetError:
        return None


def saved_router_psk() -> Optional[str]:
    """Master only: read back the router password so it can be pushed to
    slaves. Needs privileges (--show-secrets)."""
    if not _profile_exists(PROFILE_ROUTER):
        return None
    try:
        out = _nmcli("-s", "-t", "-f", "802-11-wireless-security.psk", "con", "show", PROFILE_ROUTER)
        _, _, v = out.strip().partition(":")
        return v or ""
    except NetError:
        return None


# --------------------------------------------------------------------------
# Watchdog: boot fallback + periodic retry
# --------------------------------------------------------------------------
class Watchdog(threading.Thread):
    """
    State machine, evaluated every few seconds in a daemon thread:

      auto   : have gateway → fine. No gateway for BOOT/LOSS_TIMEOUT → fallback
               (master: pax-ap up; slave: NM autoconnects pax-master-ap on its
               own, we just keep retrying the router). In fallback, every
               RETRY_INTERVAL try `pax-router` again; if it takes, drop the AP.
      router : never fall back. Keep the AP down. Just keep retrying the router.
      ap     : master: keep the hotspot up, never try the router.
               slave: treated like auto (a slave has no hotspot to pin).

    `on_change(status_dict)` fires whenever the computed mode flips, so the
    agent can broadcast a fresh `net.status` to connected apps.
    """

    def __init__(self, cfg: Config, on_change: Optional[Callable[[dict], None]] = None, log=print):
        super().__init__(daemon=True, name="paxnet-watchdog")
        self.cfg = cfg
        self.on_change = on_change
        self.log = log
        self._stop = threading.Event()
        self._kick = threading.Event()
        self.last_mode: Optional[str] = None
        self.in_fallback = False

    def stop(self) -> None:
        self._stop.set()
        self._kick.set()

    def kick(self) -> None:
        """Re-evaluate now (called after join/mode changes)."""
        self._kick.set()

    def _has_gateway(self) -> bool:
        _, gw = _ipv4(self.cfg.iface)
        return gw is not None and _active_profile(self.cfg.iface) in (PROFILE_ROUTER,)

    def run(self) -> None:
        cfg = self.cfg
        self.log(f"[paxnet] watchdog up: role={cfg.role} pin={cfg.mode} ap={cfg.ap_ssid}", flush=True)
        boot_deadline = time.monotonic() + BOOT_TIMEOUT_S
        lost_since: Optional[float] = None
        next_retry = 0.0

        while not self._stop.is_set():
            try:
                self._tick(boot_deadline, lost_since, next_retry)
                # _tick returns via attributes for readability
                lost_since = self._lost_since
                next_retry = self._next_retry
            except NetError as exc:
                self.log(f"[paxnet] {exc}", flush=True)
            except Exception as exc:  # never let the watchdog die
                self.log(f"[paxnet] unexpected: {exc!r}", flush=True)
            self._kick.wait(5)
            self._kick.clear()

    _lost_since: Optional[float] = None
    _next_retry: float = 0.0

    def _tick(self, boot_deadline: float, lost_since: Optional[float], next_retry: float) -> None:
        cfg = self.cfg
        cfg.load()  # pick up pin changes written by the agent
        now = time.monotonic()
        active = _active_profile(cfg.iface)
        on_router = self._has_gateway()
        is_master = cfg.role == "master"

        # ---- pinned AP (master) -------------------------------------------
        if is_master and cfg.mode == "ap":
            if active != PROFILE_AP:
                self.log("[paxnet] pin=ap → hotspot up", flush=True)
                ap_up(cfg)
            self.in_fallback = False
            self._lost_since, self._next_retry = None, 0.0
            self._announce()
            return

        # ---- pinned router / auto -----------------------------------------
        if on_router:
            if self.in_fallback:
                self.log("[paxnet] router is back → leaving fallback", flush=True)
            self.in_fallback = False
            if is_master and active == PROFILE_AP:
                ap_down(cfg)
            self._lost_since, self._next_retry = None, 0.0
            self._announce()
            return

        # Not on the router.
        if lost_since is None:
            lost_since = now
        booting = now < boot_deadline
        timeout = BOOT_TIMEOUT_S if booting else LOSS_TIMEOUT_S
        waited = now - lost_since

        if cfg.mode == "router":
            # Never fall back: just keep nudging the router profile.
            if now >= next_retry and _profile_exists(PROFILE_ROUTER):
                self._try_router()
                next_retry = now + RETRY_INTERVAL_S
            if is_master and active == PROFILE_AP:
                ap_down(cfg)
            self._lost_since, self._next_retry = lost_since, next_retry
            self._announce()
            return

        # auto
        if not self.in_fallback:
            if waited >= timeout or not _profile_exists(PROFILE_ROUTER):
                self.in_fallback = True
                if is_master:
                    self.log(
                        f"[paxnet] no router after {waited:.0f}s → standalone AP '{cfg.ap_ssid}'",
                        flush=True,
                    )
                    ap_up(cfg)
                else:
                    self.log(f"[paxnet] no router after {waited:.0f}s → waiting on master hotspot", flush=True)
                    # NM autoconnects pax-master-ap by priority; make sure the
                    # profile exists so it can.
                    try:
                        ensure_master_ap_profile(cfg)
                    except NetError as exc:
                        self.log(f"[paxnet] {exc}", flush=True)
                next_retry = now + RETRY_INTERVAL_S
        else:
            if now >= next_retry and _profile_exists(PROFILE_ROUTER):
                self._try_router()
                next_retry = now + RETRY_INTERVAL_S

        self._lost_since, self._next_retry = lost_since, next_retry
        self._announce()

    def _try_router(self) -> None:
        """Probe the saved router. Master: only if it is actually in range —
        dropping the hotspot to find out would kick every phone off for
        nothing. Slave: NM handles priority; a `con up` is enough."""
        cfg = self.cfg
        target = saved_router_ssid()
        if not target:
            return
        try:
            nets = scan(cfg.iface)
        except NetError:
            nets = []
        if cfg.role == "master" and not any(n["ssid"] == target for n in nets):
            return
        self.log(f"[paxnet] router '{target}' in range → trying it", flush=True)
        try:
            if cfg.role == "master":
                ap_down(cfg)
            _nmcli("con", "up", PROFILE_ROUTER, timeout=60)
        except NetError as exc:
            self.log(f"[paxnet] router attempt failed: {exc}", flush=True)
            if cfg.role == "master":
                ap_up(cfg)

    def _announce(self) -> None:
        try:
            st = status(self.cfg)
        except NetError:
            return
        if st["mode"] != self.last_mode:
            self.last_mode = st["mode"]
            self.log(f"[paxnet] mode → {st['mode']} ssid={st['ssid']} ip={st['ip']}", flush=True)
            if self.on_change:
                try:
                    self.on_change(st)
                except Exception:
                    pass


# --------------------------------------------------------------------------
# CLI (handy for debugging on the Pi: python3 paxnet.py status|scan|ap-up|...)
# --------------------------------------------------------------------------
def _cli() -> None:
    import json
    import sys

    cfg = Config()
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    try:
        if cmd == "status":
            print(json.dumps(status(cfg), indent=2))
        elif cmd == "scan":
            print(json.dumps(scan(cfg.iface), indent=2))
        elif cmd == "ap-up":
            ap_up(cfg)
        elif cmd == "ap-down":
            ap_down(cfg)
        elif cmd == "join":
            join(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "", cfg.iface)
        elif cmd == "mode":
            m = sys.argv[2]
            if m not in VALID_MODES:
                raise NetError(f"mode must be one of {VALID_MODES}")
            cfg.mode = m
            cfg.save()
        elif cmd == "watch":
            Watchdog(cfg).run()
        else:
            print(__doc__)
    except NetError as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    _cli()
