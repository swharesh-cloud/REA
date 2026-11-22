import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from flask import Flask

import builder
import builder_web


def _app(monkeypatch, tmp_path, demo=True):
    monkeypatch.setenv("BUILDER_FIXTURE_BARS", "1")
    monkeypatch.setenv("BUILDER_ROOT", str(tmp_path))
    if demo:
        monkeypatch.setenv("BUILDER_DEMO", "1")
    else:
        monkeypatch.delenv("BUILDER_DEMO", raising=False)
    app = Flask(__name__)
    app.register_blueprint(builder_web.bp)
    return app.test_client()


def test_page_renders_and_backtest_returns_charts(monkeypatch, tmp_path):
    client = _app(monkeypatch, tmp_path)
    page = client.get("/builder")
    assert page.status_code == 200
    body = page.get_data(as_text=True)
    assert "Strategy Builder" in body
    assert "PAPER ONLY" in body
    assert 'id="builder-nav"' in body
    assert "Long when" in body
    result = client.post("/api/builder/backtest", json={
        "script": builder.EXAMPLES[0]["script"],
        "symbols": "SPY, QQQ",
        "start": "2026-10-05",
        "end": "2026-11-13",
        "initial_equity": 100000,
    })
    payload = result.get_json()
    assert payload["ok"] is True
    assert payload["stats"]["trades"] >= 4
    assert payload["stats"]["wins"] >= 1 and payload["stats"]["losses"] >= 1
    assert payload["equity"][0]["value"] == 100000
    assert payload["charts"]["SPY"]["bars"]
    assert any(m["text"] in ("L", "S") for m in payload["charts"]["SPY"]["markers"])


def test_demo_refuses_to_enable_paper(monkeypatch, tmp_path):
    client = _app(monkeypatch, tmp_path, demo=True)
    saved = client.post("/api/builder/strategies", json={
        "script": "name Demo\nlong when close > 1\n",
        "symbols": "SPY",
    })
    row = saved.get_json()["strategy"]
    assert row["paper"] is False
    denied = client.post(f"/api/builder/strategies/{row['id']}/paper", json={"paper": True})
    assert denied.status_code == 400
    assert client.get("/api/builder/strategies").get_json()["strategies"][0]["paper"] is False
