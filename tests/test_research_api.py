from datetime import datetime, timedelta
from io import BytesIO
from zoneinfo import ZoneInfo
import zipfile
import csv
import json

import pytest
from fastapi.testclient import TestClient

from app import main, research_data

IST = ZoneInfo("Asia/Kolkata")


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "research.sqlite3")
    with TestClient(main.app) as test_client:
        yield test_client


def sample_candles(day="2026-11-10"):
    start = datetime.fromisoformat(f"{day}T09:15:00").replace(tzinfo=IST)
    underlying = []
    options = []
    for index in range(375):
        timestamp = int((start + timedelta(minutes=index)).timestamp())
        if index < 15:
            close = 100.0; high = 100.1; low = 99.9; volume = 10
        elif index == 15:
            close = 100.3; high = 100.4; low = 99.95; volume = 100
        else:
            close = 100.3; high = 100.4; low = 100.2; volume = 10
        underlying.append({"time": timestamp, "open": 100.3 if index > 15 else 100.0, "high": high, "low": low, "close": close, "volume": volume})
        call_high = 51.1 if index >= 17 else 50.2
        for instrument_key, symbol, option_type, premium, premium_high in [
            ("NSE_FO|TEST_CALL", "TEST 100 CE", "CE", 50.0, call_high),
            ("NSE_FO|TEST_PUT", "TEST 100 PE", "PE", 20.0, 20.2),
        ]:
            options.append({"time": timestamp, "underlying": "NIFTY", "instrument_key": instrument_key,
                            "trading_symbol": symbol, "expiry": day, "option_type": option_type,
                            "strike": 100, "lot_size": 1, "exchange_segment": "nse_fo",
                            "open": premium, "high": premium_high, "low": premium - 0.2,
                            "close": min(premium_high, premium), "volume": 100})
    return underlying, options


def run_payload(underlying, options):
    return {"underlying_candles": underlying, "option_candles": options, "strategies": ["orb"],
            "settings": {"timeframe_minutes": 1, "initial_capital": 100000, "risk_pct_per_trade": 0.5,
                         "max_lots": 2, "stop_atr_multiple": 1, "target_r": 2.25, "trail_after_r": 0,
                         "opening_range_minutes": 15, "volume_period": 5, "volume_multiple": 0.5},
            "data_source": "Upstox historical CSV test label"}


def test_research_pages_save_share_and_exports(client):
    underlying, options = sample_candles()
    response = client.post("/api/research/backtests/run", json=run_payload(underlying, options))
    assert response.status_code == 200, response.text
    body = response.json()
    run_id = body["run_id"]
    assert body["report"]["strategies"][0]["trades"]
    assert client.get("/research").status_code == 200
    assert client.get(f"/research/results/{run_id}").status_code == 200

    shared = client.post(f"/api/research/backtests/{run_id}/share", json={"expires_days": 2, "strategy_id": "orb"})
    assert shared.status_code == 200, shared.text
    share_path = shared.json()["share_url"]
    assert share_path.startswith("/results/") and share_path.endswith("/orb")
    assert client.get(share_path).status_code == 200
    token = share_path.split("/")[2]
    public = client.get(f"/api/research/shared/{token}")
    assert public.status_code == 200
    assert [item["strategy_id"] for item in public.json()["run"]["report"]["strategies"]] == ["orb"]
    shared_xlsx = client.get(f"/api/research/shared/{token}/report.xlsx")
    assert shared_xlsx.status_code == 200 and shared_xlsx.content.startswith(b"PK")
    shared_pdf = client.get(f"/api/research/shared/{token}/report.pdf")
    assert shared_pdf.status_code == 200 and shared_pdf.content.startswith(b"%PDF-1.4")
    shared_csv = client.get(f"/api/research/shared/{token}/trades.csv")
    assert shared_csv.status_code == 200 and "net_pnl" in shared_csv.text

    csv = client.get(f"/api/research/backtests/{run_id}/trades.csv?strategy_id=orb")
    assert csv.status_code == 200 and "net_pnl" in csv.text
    xlsx = client.get(f"/api/research/backtests/{run_id}/report.xlsx?strategy_id=orb")
    assert xlsx.status_code == 200
    with zipfile.ZipFile(BytesIO(xlsx.content)) as archive:
        assert "xl/workbook.xml" in archive.namelist()
        assert "xl/worksheets/sheet2.xml" in archive.namelist()
        assert b"Metric Registry" in archive.read("xl/workbook.xml")
    pdf = client.get(f"/api/research/backtests/{run_id}/report.pdf?strategy_id=orb")
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF-1.4")
    assert b"METRIC DEFINITIONS AND FORMULAS" in pdf.content


def test_invalid_shared_token_is_not_found(client):
    assert client.get("/api/research/shared/not-a-share-token").status_code == 404


def test_execution_status_separates_rust_gateway_from_live_prerequisites(client):
    response = client.get("/api/execution/status")
    assert response.status_code == 200, response.text
    execution = response.json()["execution"]
    assert execution["order_dispatch_enabled"] is execution["available"]
    assert execution["live_trading_gate_enabled"] is main.LIVE_TRADING_ENABLED
    assert execution["kotak_session_authenticated"] is bool(main.neo_authenticated and main.neo_client is not None)
    assert execution["live_execution_prerequisites_met"] is bool(
        execution["available"]
        and main.LIVE_TRADING_ENABLED
        and main.neo_authenticated
        and main.neo_client is not None
    )


def test_saved_large_local_dataset_can_be_discovered_validated_and_backtested(client, tmp_path, monkeypatch):
    underlying, options = sample_candles()
    export_root = tmp_path / "exports"
    dataset_dir = export_root / "banknifty_1m"
    dataset_dir.mkdir(parents=True)
    monkeypatch.setattr(research_data, "EXPORT_ROOT", export_root)

    for filename, rows in [
        ("banknifty_index_1m.csv", underlying),
        ("banknifty_options_1m.csv", options),
    ]:
        with (dataset_dir / filename).open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)
    (dataset_dir / "metadata.json").write_text(json.dumps({
        "index_bar_count": len(underlying),
        "option_bar_count": len(options),
        "option_contracts_with_candles": 2,
        "contract_master_row_count": 2,
        "index_range": ["2026-11-10T09:15:00+05:30", "2026-11-10T15:29:00+05:30"],
        "option_candle_range": ["2026-11-10", "2026-11-10"],
    }), encoding="utf-8")

    discovered = client.get("/api/research/local-datasets")
    assert discovered.status_code == 200, discovered.text
    assert discovered.json()["datasets"][0]["id"] == "banknifty_1m"

    validated = client.post("/api/research/local-datasets/banknifty_1m/validate")
    assert validated.status_code == 200, validated.text
    assert validated.json()["underlying"]["rows"] == len(underlying)
    assert validated.json()["options"]["rows"] == len(options)
    assert validated.json()["underlying"]["invalid_ohlc"] == 0
    assert validated.json()["options"]["duplicate_bars"] == 0

    payload = run_payload(underlying, options)
    payload.pop("underlying_candles")
    payload.pop("option_candles")
    payload["dataset_id"] = "banknifty_1m"
    result = client.post("/api/research/backtests/run", json=payload)
    assert result.status_code == 200, result.text
    strategy_result = result.json()["report"]["strategies"][0]
    assert strategy_result["data_quality"]["valid_underlying_bars"] == len(underlying)
