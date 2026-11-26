"""24/7 operation: single-instance lock and a macOS launchd background service.

The background service runs the engine headless (no window) and is restarted
by launchd if it ever exits. It is wrapped in `caffeinate -i -s` so the Mac does
not idle-sleep while it runs. The app window just connects to it.
"""
from __future__ import annotations

import os
import platform
import plistlib
import subprocess
import sys

LABEL = "com.liquidtrader.engine"
DEFAULT_PORT = 8765
IS_MAC = platform.system() == "Darwin"


def plist_path():
    return os.path.expanduser(f"~/Library/LaunchAgents/{LABEL}.plist")


def log_path():
    if IS_MAC:
        return os.path.expanduser("~/Library/Logs/LiquidTrader.log")
    return "sudo journalctl -u liquid-trader -f   (systemd) / docker logs liquid-trader"


# ---- single instance -----------------------------------------------------
_lock_fd = None


def acquire_lock(data_dir: str) -> bool:
    """Only one engine may trade the same bots. Returns False if another engine holds the lock."""
    global _lock_fd
    import fcntl
    path = os.path.join(data_dir, "engine.lock")
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return False
    os.ftruncate(fd, 0)
    os.write(fd, str(os.getpid()).encode())
    _lock_fd = fd
    return True


def release_lock():
    global _lock_fd
    if _lock_fd is not None:
        import fcntl
        fcntl.flock(_lock_fd, fcntl.LOCK_UN)
        os.close(_lock_fd)
        _lock_fd = None


def write_port(data_dir: str, port: int):
    with open(os.path.join(data_dir, "engine.port"), "w") as f:
        f.write(str(port))


def read_port(data_dir: str):
    try:
        with open(os.path.join(data_dir, "engine.port")) as f:
            return int(f.read().strip())
    except (OSError, ValueError):
        return None


# ---- launchd --------------------------------------------------------------
def service_plist(python=None, workdir=None, port=DEFAULT_PORT) -> dict:
    python = python or sys.executable
    workdir = workdir or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return {
        "Label": LABEL,
        "ProgramArguments": ["/usr/bin/caffeinate", "-i", "-s", python, "-m", "liquid_trader",
                             "--headless", "--port", str(port)],
        "WorkingDirectory": workdir,
        "RunAtLoad": True,
        "KeepAlive": True,            # restart whenever it exits or crashes
        "ThrottleInterval": 10,
        "ProcessType": "Interactive",  # don't let macOS throttle it as a background job
        "StandardOutPath": log_path(),
        "StandardErrorPath": log_path(),
        "EnvironmentVariables": {"PYTHONUNBUFFERED": "1"},
    }


DAEMON_PLIST = f"/Library/LaunchDaemons/{LABEL}.plist"


def daemon_plist(user: str, home: str, python=None, workdir=None, port=DEFAULT_PORT) -> dict:
    """Boot-level service: starts when the Mac powers on, before anyone logs in (Mac-as-server mode).
    Runs as your user (not root). The login Keychain isn't available before login, so the API key
    is read from a private 0600 file instead (LT_CREDENTIAL_STORE=file)."""
    p = service_plist(python, workdir, port)
    logs = os.path.join(home, "Library/Logs/LiquidTrader.log")
    p.update({
        "UserName": user,
        "GroupName": "staff",
        "StandardOutPath": logs,
        "StandardErrorPath": logs,
        "EnvironmentVariables": {"PYTHONUNBUFFERED": "1", "HOME": home, "USER": user,
                                 "LT_CREDENTIAL_STORE": "file"},
    })
    p.pop("ProcessType", None)
    return p


def service_status() -> dict:
    agent = os.path.exists(plist_path())
    daemon = os.path.exists(DAEMON_PLIST)
    running = False
    if IS_MAC and agent:
        r = subprocess.run(["launchctl", "list", LABEL], capture_output=True, text=True)
        running = r.returncode == 0 and '"PID"' in r.stdout
    if daemon and os.environ.get("LT_CREDENTIAL_STORE") == "file":
        running = True  # we are the boot-level daemon
    return {"supported": IS_MAC, "installed": agent or daemon, "running": running,
            "mode": "boot" if daemon else "login" if agent else None,
            "plist": DAEMON_PLIST if daemon else plist_path(), "log": log_path(), "pid": os.getpid()}


def install_service(port=DEFAULT_PORT) -> dict:
    if os.path.exists(DAEMON_PLIST):
        raise RuntimeError("The boot-level server service is installed (mac_server_setup.sh --at-boot). "
                           "Manage it with mac_server_setup.sh.")
    if not IS_MAC:
        raise RuntimeError("The background service uses macOS launchd. On Linux, use the systemd unit in "
                           "the README instead.")
    os.makedirs(os.path.dirname(plist_path()), exist_ok=True)
    os.makedirs(os.path.dirname(log_path()), exist_ok=True)
    with open(plist_path(), "wb") as f:
        plistlib.dump(service_plist(port=port), f)
    subprocess.run(["launchctl", "unload", plist_path()], capture_output=True)
    r = subprocess.run(["launchctl", "load", "-w", plist_path()], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"launchctl load failed: {r.stderr.strip()}")
    return service_status()


def uninstall_service() -> dict:
    if os.path.exists(DAEMON_PLIST):
        raise RuntimeError("The boot-level service needs admin rights to remove: run ./mac_server_setup.sh --undo")
    if IS_MAC and os.path.exists(plist_path()):
        subprocess.run(["launchctl", "unload", "-w", plist_path()], capture_output=True)
        os.remove(plist_path())
    return service_status()


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    fn = {"install": install_service, "uninstall": uninstall_service, "status": service_status}[cmd]
    print(fn())
