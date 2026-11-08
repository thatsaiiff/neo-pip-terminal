import pytest
from fastapi.testclient import TestClient

from app import main


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "test.sqlite3")
    monkeypatch.setattr(main, "BRIDGE_TOKEN", "unit-test-bridge-token")
    monkeypatch.setattr(main, "LIVE_TRADING_ENABLED", False)
    monkeypatch.setattr(main, "neo_client", None)
    monkeypatch.setattr(main, "neo_authenticated", False)
    main.selected_symbol.update({"symbol": "NIFTY", "exchange_segment": "nse_fo", "source": "demo default", "confidence": 0.0, "updated_at": None})
    with TestClient(main.app) as test_client:
        yield test_client


def sample_order(**overrides):
    order = {
        "symbol": "NIFTY26NOV2625000CE",
        "side": "BUY",
        "lots": 2,
        "lot_size": 65,
        "exchange_segment": "nse_fo",
        "product": "MIS",
        "order_type": "MKT",
        "price": None,
        "trigger_price": None,
        "validity": "DAY",
        "user_confirmed": True,
    }
    order.update(overrides)
    return order


def test_health(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_simulation_order_is_logged_and_qty_calculated(client):
    response = client.post("/api/orders", json=sample_order())
    assert response.status_code == 200
    body = response.json()
    assert body["mode"] == "simulation"
    assert body["status"] == "simulated"
    assert body["quantity"] == 130
    assert "no order sent" in body["message"].lower()
    listed = client.get("/api/orders").json()
    assert len(listed) == 1
    assert listed[0]["quantity"] == 130
    assert listed[0]["broker_order_id"] is None


def test_rejects_unconfirmed_order(client):
    response = client.post("/api/orders", json=sample_order(user_confirmed=False))
    assert response.status_code == 400
    assert "explicitly confirmed" in response.json()["detail"]


def test_limit_requires_price(client):
    response = client.post("/api/orders", json=sample_order(order_type="L", price=None))
    assert response.status_code == 422
    assert "limit price" in response.json()["detail"].lower()


def test_stop_market_requires_trigger(client):
    response = client.post("/api/orders", json=sample_order(order_type="SL-M", trigger_price=None))
    assert response.status_code == 422
    assert "trigger price" in response.json()["detail"].lower()


def test_rejects_bad_side_and_invalid_lots(client):
    bad_side = client.post("/api/orders", json=sample_order(side="BUYSELL"))
    assert bad_side.status_code == 422
    bad_lots = client.post("/api/orders", json=sample_order(lots=0))
    assert bad_lots.status_code == 422


def test_bridge_requires_token(client):
    payload = {"symbol": "RELIANCE-EQ", "exchange_segment": "nse_cm", "source": "test", "confidence": 0.95}
    assert client.post("/api/bridge/symbol", json=payload).status_code == 401
    response = client.post("/api/bridge/symbol", json=payload, headers={"X-Bridge-Token": "unit-test-bridge-token"})
    assert response.status_code == 200
    assert response.json()["selected_symbol"]["symbol"] == "RELIANCE-EQ"


def test_bridge_rejects_low_confidence_and_bad_segment(client):
    low = client.post("/api/bridge/symbol", json={"symbol": "NIFTY", "confidence": 0.2}, headers={"X-Bridge-Token": "unit-test-bridge-token"})
    assert low.status_code == 422
    bad = client.post("/api/bridge/symbol", json={"symbol": "RELIANCE-EQ", "exchange_segment": "random", "confidence": 0.9}, headers={"X-Bridge-Token": "unit-test-bridge-token"})
    assert bad.status_code == 422


def test_auth_rejected_when_live_gate_disabled(client):
    response = client.post("/api/auth/login", json={"totp": "123456", "mpin": "123456"})
    assert response.status_code == 403
    assert "disabled" in response.json()["detail"].lower()


def test_audit_never_contains_sensitive_fields(client):
    main.audit("test_event", {"symbol": "NIFTY", "totp": "123456", "mpin": "654321", "token": "secret"})
    events = client.get("/api/audit").json()
    assert events
    detail = events[0]["detail"]
    assert "symbol" in detail
    assert "totp" not in detail and "mpin" not in detail and "token" not in detail


def test_ui_and_stylesheet_are_served(client):
    page = client.get("/")
    assert page.status_code == 200
    assert "Neo PIP" in page.text
    assert "Review BUY" in page.text
    styles = client.get("/static/styles.css")
    assert styles.status_code == 200
    assert "side-button" in styles.text



def test_live_order_uses_mocked_sdk_once_and_records_order(client, monkeypatch):
    class FakeNeo:
        def __init__(self):
            self.calls = []
        def place_order(self, **kwargs):
            self.calls.append(kwargs)
            return {"stat": "Ok", "nOrdNo": "MOCK-123", "stCode": 200}

    fake = FakeNeo()
    monkeypatch.setattr(main, "LIVE_TRADING_ENABLED", True)
    monkeypatch.setattr(main, "neo_authenticated", True)
    monkeypatch.setattr(main, "neo_client", fake)
    response = client.post("/api/orders", json=sample_order())
    assert response.status_code == 200
    assert response.json()["mode"] == "live"
    assert response.json()["broker_order_id"] == "MOCK-123"
    assert len(fake.calls) == 1
    assert fake.calls[0]["quantity"] == "130"
    assert fake.calls[0]["transaction_type"] == "B"
    assert client.get("/api/orders").json()[0]["mode"] == "live"


def test_live_broker_rejection_shows_errmsg_and_is_logged_locally(client, monkeypatch):
    class FakeNeo:
        def place_order(self, **kwargs):
            return {"stat": "Not_Ok", "emsg": "Insufficient balance", "stCode": 1004}

    monkeypatch.setattr(main, "LIVE_TRADING_ENABLED", True)
    monkeypatch.setattr(main, "neo_authenticated", True)
    monkeypatch.setattr(main, "neo_client", FakeNeo())
    response = client.post("/api/orders", json=sample_order())
    assert response.status_code == 502
    assert "Insufficient balance" in response.json()["detail"]
    rows = client.get("/api/orders").json()
    assert len(rows) == 1
    assert rows[0]["status"] == "rejected"
    assert rows[0]["broker_order_id"] is None


def test_live_broker_errmsg_field_is_not_hidden(client, monkeypatch):
    class FakeNeo:
        def place_order(self, **kwargs):
            return {"stat": "Not_Ok", "errMsg": "unauthorized: session ip doesnt match request ip", "stCode": 1037}

    monkeypatch.setattr(main, "LIVE_TRADING_ENABLED", True)
    monkeypatch.setattr(main, "neo_authenticated", True)
    monkeypatch.setattr(main, "neo_client", FakeNeo())
    response = client.post("/api/orders", json=sample_order())
    assert response.status_code == 502
    assert "1037" in response.json()["detail"]
    assert "session ip doesnt match request ip" in response.json()["detail"]


def test_non_local_host_is_rejected(client):
    response = client.get("/api/health", headers={"Host": "public.example.com"})
    assert response.status_code == 403


def test_rejects_concurrent_order_submission(client, monkeypatch):
    assert main.order_submit_lock.acquire(blocking=False)
    try:
        response = client.post("/api/orders", json=sample_order())
    finally:
        main.order_submit_lock.release()
    assert response.status_code == 409
    assert "already in progress" in response.json()["detail"]


def test_market_order_discards_irrelevant_price_fields(client):
    response = client.post("/api/orders", json=sample_order(order_type="MKT", price=250.0, trigger_price=240.0))
    assert response.status_code == 200
    with main.db() as conn:
        row = conn.execute("SELECT price,trigger_price,request_json FROM orders ORDER BY id DESC LIMIT 1").fetchone()
    assert row["price"] is None and row["trigger_price"] is None
    import json
    request = json.loads(row["request_json"])
    assert request["price"] is None and request["trigger_price"] is None


def test_extension_origin_can_only_use_symbol_bridge(client):
    headers = {"Origin": "chrome-extension://unit-test-extension", "X-Bridge-Token": "unit-test-bridge-token"}
    bridge = client.post("/api/bridge/symbol", json={"symbol": "RELIANCE-EQ", "exchange_segment": "nse_cm", "confidence": 0.95}, headers=headers)
    assert bridge.status_code == 200
    orders = client.get("/api/orders", headers={"Origin": "chrome-extension://unit-test-extension"})
    assert orders.status_code == 403


def test_untrusted_local_origin_is_rejected(client):
    response = client.get("/api/status", headers={"Origin": "http://localhost:3000"})
    assert response.status_code == 403


def test_order_with_ioc_validity(client):
    order = sample_order(validity="IOC")
    response = client.post("/api/orders", json=order)
    assert response.status_code == 200
    with main.db() as conn:
        row = conn.execute("SELECT request_json FROM orders ORDER BY id DESC LIMIT 1").fetchone()
    import json
    parsed = json.loads(row["request_json"])
    assert parsed["validity"] == "IOC"


def test_positions_returns_empty_list_on_no_data(client, monkeypatch):
    class MockNeo:
        def positions(self):
            return {"stat": "Not_Ok", "stCode": 5203, "errMsg": "No Data", "desc": "data not found"}

    monkeypatch.setattr(main, "neo_authenticated", True)
    monkeypatch.setattr(main, "neo_client", MockNeo())
    response = client.get("/api/positions")
    assert response.status_code == 200
    data = response.json()
    assert data["positions"] == []
    assert data["total_mtm"] == 0
    assert data["total_position_pnl"] == 0


def test_audit_events_list(client):
    response = client.get("/api/audit")
    assert response.status_code == 200
    assert isinstance(response.json(), list)


def test_positions_calculates_closed_trade_pnl(client, monkeypatch):
    class MockNeoWithTrade:
        def positions(self):
            return {
                "data": [
                    {
                        "trdSym": "NIFTY 24500 CE",
                        "exSeg": "nse_fo",
                        "prod": "NRML",
                        "buyAmt": "10000",
                        "sellAmt": "7094",
                        "flBuyQty": "50",
                        "flSellQty": "50",
                        "multiplier": "1",
                    }
                ]
            }

    monkeypatch.setattr(main, "neo_authenticated", True)
    monkeypatch.setattr(main, "neo_client", MockNeoWithTrade())

    # Check closed tab
    res_closed = client.get("/api/positions?tab=closed")
    assert res_closed.status_code == 200
    d_closed = res_closed.json()
    assert d_closed["total_today_pnl"] == -2906.0
    assert d_closed["total_realized_pnl"] == -2906.0
    assert d_closed["total_position_pnl"] == -2906.0
    assert d_closed["closed_count"] == 1
    assert len(d_closed["positions"]) == 1
    assert d_closed["positions"][0]["position_pnl"] == -2906.0

    # Check open tab - today's P&L is still -2906.0
    res_open = client.get("/api/positions?tab=open")
    assert res_open.status_code == 200
    d_open = res_open.json()
    assert d_open["total_today_pnl"] == -2906.0
    assert d_open["open_count"] == 0
    assert d_open["closed_count"] == 1


def test_index_quotes_endpoint(client):
    res = client.get("/api/indices/quotes")
    assert res.status_code == 200
    data = res.json()
    assert "indices" in data
    assert len(data["indices"]) == 3
    names = [item["name"] for item in data["indices"]]
    assert "NIFTY" in names
    assert "BANK NIFTY" in names
    assert "SENSEX" in names
    for item in data["indices"]:
        assert item["ltp"] is not None and item["ltp"] > 0


def test_egress_ip_endpoint(client):
    res = client.get("/api/egress-ip")
    assert res.status_code == 200
    data = response = res.json()
    assert data["ok"] is True
    assert "railway_static_ips" in data
    assert len(data["railway_static_ips"]) == 3


def test_search_instruments_all_segments(client, monkeypatch):
    class MockClient:
        def search_scrip(self, exchange_segment, symbol, **kwargs):
            if exchange_segment == "nse_fo":
                return {"data": [{"pSymbol": "123", "pTrdSymbol": "NIFTY24DEC25000CE", "pSymbolName": "NIFTY", "lLotSize": 25}]}
            elif exchange_segment == "nse_cm":
                return {"data": [{"pSymbol": "456", "pTrdSymbol": "RELIANCE", "pSymbolName": "RELIANCE", "lLotSize": 1}]}
            return {"data": []}

    monkeypatch.setattr(main, "_market_data_client", lambda: MockClient())
    res = client.post("/api/instruments/search", json={"query": "NIFTY", "exchange_segment": "all"})
    assert res.status_code == 200
    data = res.json()
    assert "instruments" in data
    assert len(data["instruments"]) >= 1
    segments = [inst["exchange_segment"] for inst in data["instruments"]]
    assert "nse_fo" in segments



