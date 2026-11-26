"""Push notifications for a remote 24/7 engine: trades, warnings, errors.

Set LT_NOTIFY_URL (or save it in Settings) to one of:
  * https://ntfy.sh/<your-secret-topic>    - free phone push via the ntfy app
  * https://discord.com/api/webhooks/...   - Discord channel webhook
  * https://hooks.slack.com/services/...    - Slack incoming webhook
  * any other URL                           - receives JSON {"text": ..., "level": ...}
"""
from __future__ import annotations

import json
import queue
import threading
import urllib.request

LEVELS = {"paper": -1, "trade": 0, "info": 1, "warn": 2, "error": 3}


def build_request(url: str, text: str, level: str):
    title = {"error": "Liquid Trader ⛔", "warn": "Liquid Trader ⚠️"}.get(level, "Liquid Trader")
    if "ntfy" in url:
        prio = {"error": "5", "warn": "4"}.get(level, "3")
        return urllib.request.Request(url, data=text.encode(), method="POST",
                                      headers={"Title": title.encode("ascii", "ignore").decode().strip(),
                                               "Priority": prio, "Tags": "chart_with_upwards_trend"})
    if "discord.com/api/webhooks" in url or "discordapp.com/api/webhooks" in url:
        body = {"content": f"**{title}** {text}"[:1900]}
    elif "hooks.slack.com" in url:
        body = {"text": f"*{title}* {text}"}
    else:
        body = {"text": text, "level": level, "title": title}
    return urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                  headers={"Content-Type": "application/json", "User-Agent": "LiquidTrader"})


class Notifier:
    def __init__(self, url: str = "", min_level: str = "trade"):
        self.url = url
        self.min_level = min_level
        self.q: queue.Queue = queue.Queue(maxsize=200)
        self.last_error = ""
        threading.Thread(target=self._run, daemon=True, name="notify").start()

    def send(self, text: str, level: str = "info"):
        if not self.url or LEVELS.get(level, 1) < LEVELS.get(self.min_level, 0):
            return
        try:
            self.q.put_nowait((text, level))
        except queue.Full:
            pass

    def _run(self):
        while True:
            text, level = self.q.get()
            try:
                with urllib.request.urlopen(build_request(self.url, text, level), timeout=10):
                    pass
                self.last_error = ""
            except Exception as e:  # notifications must never affect trading
                self.last_error = str(e)
