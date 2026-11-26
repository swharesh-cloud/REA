"""API-key storage: macOS Keychain when available, else a 0600 file. Env vars override both."""
from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess

SERVICE = "LiquidTrader"
IS_MAC = platform.system() == "Darwin" and shutil.which("security") is not None


def data_dir() -> str:
    if platform.system() == "Darwin":
        d = os.path.expanduser("~/Library/Application Support/LiquidTrader")
    else:
        d = os.path.expanduser("~/.liquid-trader")
    os.makedirs(d, mode=0o700, exist_ok=True)
    return d


def _file():
    return os.path.join(data_dir(), "credentials.json")


def _kc_get(account):
    r = subprocess.run(["security", "find-generic-password", "-s", SERVICE, "-a", account, "-w"],
                       capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def _kc_set(account, value):
    subprocess.run(["security", "add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w", value],
                   capture_output=True, check=True)


def _kc_del(account):
    subprocess.run(["security", "delete-generic-password", "-s", SERVICE, "-a", account], capture_output=True)


def load():
    """Return (key, secret, where) or (None, None, None)."""
    k, s = os.environ.get("LIQUID_API_KEY"), os.environ.get("LIQUID_API_SECRET")
    if k and s:
        return k, s, "environment"
    if IS_MAC:
        k, s = _kc_get("api_key"), _kc_get("api_secret")
        if k and s:
            return k, s, "Keychain"
    try:
        with open(_file()) as f:
            d = json.load(f)
        if d.get("key") and d.get("secret"):
            return d["key"], d["secret"], "file"
    except (OSError, ValueError):
        pass
    return None, None, None


def save(key: str, secret: str) -> str:
    if IS_MAC:
        _kc_set("api_key", key)
        _kc_set("api_secret", secret)
        return "Keychain"
    path = _file()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"key": key, "secret": secret}, f)
    return "file"


def clear():
    if IS_MAC:
        _kc_del("api_key")
        _kc_del("api_secret")
    try:
        os.remove(_file())
    except OSError:
        pass
