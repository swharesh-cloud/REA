"""Client for the Liquid (liquid.trade) public REST API.

Liquid routes perpetual-futures orders to venues such as Hyperliquid. Every
request is signed with HMAC-SHA256 using an API key and secret issued at
https://sdk.tryliquid.xyz.

Signature payload (newline separated):
    timestamp_ms, nonce, METHOD, canonical_path, canonical_query, sha256(body)

  * canonical_path  - full path including "/v1", URL-decoded, lower-cased,
                      trailing slashes stripped
  * canonical_query - query params sorted by key, form-encoded
  * body            - JSON with keys sorted recursively and no whitespace;
                      the hash of "" is used when there is no body

Headers: X-Liquid-Key, X-Liquid-Timestamp, X-Liquid-Nonce, X-Liquid-Signature.
Responses are wrapped as {"success": bool, "data": ..., "error": {...}}.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

BASE_URL = "https://api-public.liquidmax.xyz/v1"
USER_AGENT = "LiquidTrader/1.0"


class LiquidAPIError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def _normalize_numbers(obj):
    """Make floats serialize the way JavaScript's JSON.stringify does (100.0 -> 100)."""
    if isinstance(obj, float) and obj.is_integer() and abs(obj) < 1e15:
        return int(obj)
    if isinstance(obj, dict):
        return {k: _normalize_numbers(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_normalize_numbers(v) for v in obj]
    return obj


def canonical_body(body) -> str | None:
    if not body:
        return None
    return json.dumps(_normalize_numbers(body), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def canonical_query(query: str) -> str:
    if not query:
        return ""
    pairs = urllib.parse.parse_qsl(query, keep_blank_values=True)
    pairs.sort(key=lambda kv: kv[0])
    return urllib.parse.urlencode(pairs)


def sign(secret: str, method: str, full_path: str, query: str, body_str: str | None,
         timestamp: str, nonce: str) -> str:
    path = urllib.parse.unquote(full_path).lower().rstrip("/")
    body_hash = hashlib.sha256((body_str or "").encode()).hexdigest()
    payload = "\n".join([timestamp, nonce, method.upper(), path, canonical_query(query), body_hash])
    return hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()


class LiquidClient:
    def __init__(self, api_key: str, api_secret: str, base_url: str = BASE_URL,
                 timeout: float = 15.0, min_interval: float = 0.12):
        self.api_key = api_key
        self.api_secret = api_secret
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.min_interval = min_interval  # simple client-side rate limit
        self._lock = threading.Lock()
        self._last = 0.0

    # ---- transport -------------------------------------------------------
    def _throttle(self):
        with self._lock:
            wait = self._last + self.min_interval - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()

    def request(self, method: str, path: str, params: dict | None = None, body: dict | None = None):
        query = urllib.parse.urlencode({k: v for k, v in (params or {}).items() if v is not None})
        prefix = urllib.parse.urlparse(self.base_url).path  # "/v1"
        body_str = canonical_body(body)
        ts = str(int(time.time() * 1000))
        nonce = secrets.token_hex(16)
        headers = {
            "X-Liquid-Key": self.api_key,
            "X-Liquid-Timestamp": ts,
            "X-Liquid-Nonce": nonce,
            "X-Liquid-Signature": sign(self.api_secret, method, prefix + path, query, body_str, ts, nonce),
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        }
        url = self.base_url + path + ("?" + query if query else "")
        data = body_str.encode() if body_str is not None else None
        req = urllib.request.Request(url, data=data, method=method.upper(), headers=headers)
        self._throttle()
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                status, raw = resp.status, resp.read()
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read()
        except urllib.error.URLError as e:
            raise LiquidAPIError(f"Network error: {e.reason}") from e
        try:
            payload = json.loads(raw.decode() or "{}")
        except ValueError:
            raise LiquidAPIError(f"HTTP {status}: non-JSON response", status)
        if status >= 400 or not payload.get("success", False):
            err = payload.get("error") or {}
            msg = err.get("message") or err.get("code") or f"HTTP {status}"
            raise LiquidAPIError(f"Liquid API {status}: {msg}", status)
        return payload.get("data")

    # ---- market data -----------------------------------------------------
    def markets(self):
        return self.request("GET", "/markets")

    def ticker(self, symbol: str):
        return self.request("GET", f"/markets/{urllib.parse.quote(symbol, safe='')}/ticker")

    def orderbook(self, symbol: str, depth: int | None = None):
        return self.request("GET", f"/markets/{urllib.parse.quote(symbol, safe='')}/orderbook",
                            params={"depth": depth})

    def candles(self, symbol: str, interval: str, limit: int = 200, start=None, end=None):
        return self.request("GET", f"/markets/{urllib.parse.quote(symbol, safe='')}/candles",
                            params={"interval": interval, "limit": min(int(limit), 200),
                                    "start": start, "end": end})

    # ---- account ---------------------------------------------------------
    def account(self):
        return self.request("GET", "/account")

    def positions(self):
        return self.request("GET", "/account/positions")

    # ---- trading ---------------------------------------------------------
    def place_order(self, symbol: str, side: str, size_usd: float, type: str = "market",
                    price: float | None = None, leverage: float | None = None,
                    tp: float | None = None, sl: float | None = None):
        """size_usd is USD notional (Liquid's convention)."""
        body = {"symbol": symbol, "side": side, "size": round(float(size_usd), 2), "type": type}
        for k, v in (("price", price), ("leverage", leverage), ("tp", tp), ("sl", sl)):
            if v is not None:
                body[k] = v
        return self.request("POST", "/orders", body=body)

    def cancel_order(self, order_id: str):
        return self.request("DELETE", f"/orders/{urllib.parse.quote(str(order_id), safe='')}")

    def close_position(self, symbol: str, size_coin: float | None = None):
        body = {"size": size_coin} if size_coin is not None else {}
        return self.request("POST", f"/positions/{urllib.parse.quote(symbol, safe='')}/close", body=body)
