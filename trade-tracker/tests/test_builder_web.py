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
    assert payload["histogram"] and payload["by_symbol"][0]["symbol"] == "SPY"
    assert client.get("/builder-static/builder.css").status_code == 200
    assert client.get("/builder-static/builder.js").status_code == 200


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


def test_compare_and_job_progress(monkeypatch, tmp_path):
    client = _app(monkeypatch, tmp_path, demo=False)
    sync = client.post("/api/builder/backtest", json={
        "script": "long when close > 10\ntake profit 1%\nstop 5%\n",
        "symbols": "SPY",
        "start": "2026-10-05",
        "end": "2026-10-06",
        "compare": [{"label": "Wide", "take_profit_pct": 2, "stop_pct": 3}],
    }).get_json()
    assert sync["ok"] is True
    assert sync["compare"][0]["label"] == "Wide"
    assert "stats" in sync["compare"][0]
    started = client.post("/api/builder/backtest/jobs", json={
        "script": builder.EXAMPLES[2]["script"],
        "symbols": ["SPY"],
        "start": "2026-10-05",
        "end": "2026-10-20",
    }).get_json()
    assert started["ok"] is True
    job = {}
    for _ in range(40):
        job = client.get("/api/builder/backtest/jobs/" + started["job"]).get_json()
        if job.get("status") in ("done", "error"):
            break
        import time
        time.sleep(0.05)
    assert job["status"] == "done"
    assert job["result"]["ok"] is True


def test_universes_do_not_touch_orders_when_gapfade_is_missing(monkeypatch, tmp_path):
    client = _app(monkeypatch, tmp_path, demo=False)
    catalog = client.get("/api/builder/universes").get_json()
    assert catalog["cap"] == 200
    assert any(item["id"] == "orb" and item["live"] for item in catalog["universes"])
    missing = client.post("/api/builder/universes/orb").get_json()
    assert missing["ok"] is False
    assert "gapfade" in missing["error"]
