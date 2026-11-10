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
    assert "charges" in d_closed
    assert d_closed["charges"]["govt_charges"] == 23.04
    assert d_closed["total_net_pnl"] == -2929.04

    # Check open tab - today's P&L is still -2906.0
    res_open = client.get("/api/positions?tab=open")
    assert res_open.status_code == 200
    d_open = res_open.json()
    assert d_open["total_today_pnl"] == -2906.0
    assert d_open["total_net_pnl"] == -2929.04
    assert d_open["open_count"] == 0
    assert d_open["closed_count"] == 1


def test_estimated_charges_with_outside_orders(client, monkeypatch):
    class MockNeoWithOrders:
        def positions(self):
            return {
                "data": [
                    {
                        "trdSym": "NIFTY 24500 CE",
                        "exSeg": "nse_fo",
                        "prod": "NRML",
                        "buyAmt": "10000",
                        "sellAmt": "10000",
                        "flBuyQty": "50",
                        "flSellQty": "50",
                        "multiplier": "1",
                    }
                ]
            }

        def order_report(self):
            return {
                "data": [
                    {"nOrdNo": "OUTSIDE-1", "ordSt": "complete"},
                    {"nOrdNo": "OUTSIDE-2", "ordSt": "traded"},
                    {"nOrdNo": "OUTSIDE-3", "ordSt": "rejected"},
                ]
            }

    monkeypatch.setattr(main, "neo_authenticated", True)
    monkeypatch.setattr(main, "neo_client", MockNeoWithOrders())

    res = client.get("/api/positions")
    assert res.status_code == 200
    data = res.json()
    # Turnover = 20000 -> Govt charges = 20000 / 742 = 26.95
    # 2 completed orders outside Neo PIP -> Brokerage = 2 * 10 = 20.0
    # Total charges = 26.95 + 20.0 = 46.95
    assert data["charges"]["govt_charges"] == 26.95
    assert data["charges"]["outside_completed_orders"] == 2
    assert data["charges"]["outside_brokerage"] == 20.0
    assert data["charges"]["total_charges"] == 46.95
    assert data["total_today_pnl"] == 0.0
    assert data["total_net_pnl"] == -46.95


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


def test_market_movers_endpoint(client):
    res = client.get("/api/market/movers")
    assert res.status_code == 200
    data = res.json()
    assert "gainers" in data
    assert "losers" in data
    assert len(data["gainers"]) <= 10
    assert len(data["losers"]) <= 10
    if data["gainers"]:
        first = data["gainers"][0]
        assert "symbol" in first
        assert "change_percent" in first
        assert "ltp" in first


def test_sltp_creation_and_execution(client):
    # Create rule
    res = client.post("/api/sltp", json={
        "symbol": "NIFTY24500CE",
        "exchange_segment": "nse_fo",
        "product": "MIS",
        "side": "BUY",
        "quantity": 50,
        "entry_price": 100.0,
        "sl_price": 95.0,
        "tp_price": 110.0,
    })
    assert res.status_code == 200
    assert res.json()["ok"] is True
    rule_id = res.json()["rule_id"]

    # Check active rules
    res_list = client.get("/api/sltp")
    assert res_list.status_code == 200
    rules = res_list.json()
    assert any(r["id"] == rule_id for r in rules)

    # Check non-triggering LTP (102.0)
    check_res = client.post("/api/sltp/check", json={"symbol": "NIFTY24500CE", "ltp": 102.0})
    assert check_res.status_code == 200
    assert check_res.json()["triggered_count"] == 0

    # Check triggering SL (94.0 <= 95.0)
    sl_res = client.post("/api/sltp/check", json={"symbol": "NIFTY24500CE", "ltp": 94.0})
    assert sl_res.status_code == 200
    assert sl_res.json()["triggered_count"] == 1
    assert sl_res.json()["triggered"][0]["trigger_type"] == "SL"

    # Rule should no longer be active
    res_list2 = client.get("/api/sltp")
    assert not any(r["id"] == rule_id for r in res_list2.json())


def test_limits_endpoint(client):
    res = client.get("/api/limits")
    assert res.status_code == 200
    data = res.json()
    assert "available_cash" in data
    assert data["available_cash"] > 0


def test_exit_all_positions_endpoint(client):
    res = client.post("/api/positions/exit-all")
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert "closed_positions" in data


def test_chart_candles_endpoint(client):
    res = client.get("/api/chart/candles?symbol=NIFTY&interval=5s")
    assert res.status_code == 200
    data = res.json()
    assert "candles" in data
    assert data["symbol"] == "NIFTY"
    assert data["interval"] == "5s"
    if data["ok"] and data["candles"]:
        c = data["candles"][0]
        assert "time" in c
        assert "open" in c
        assert "high" in c
        assert "low" in c
        assert "close" in c


def test_upstox_status_endpoint(client):
    res = client.get("/api/chart/upstox-status")
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert "authenticated" in data
    assert "token_configured" in data


def test_set_upstox_token_endpoint(client):
    res = client.post("/api/chart/upstox-token", json={"token": "test_token_1234567890"})
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["token_configured"] is True
    assert data["token_preview"] is not None

    # Check status endpoint reflects it
    status_res = client.get("/api/chart/upstox-status")
    assert status_res.status_code == 200
    assert status_res.json()["token_configured"] is True


def test_chart_view_endpoint(client):
    res = client.get("/chart")
    assert res.status_code == 200


def test_exit_partial_position_endpoint(client):
    # Place a simulated order first
    client.post(
        "/api/orders",
        json={
            "symbol": "NIFTY24900CE",
            "side": "BUY",
            "lots": 4,
            "lot_size": 25,
            "exchange_segment": "nse_fo",
            "product": "MIS",
            "order_type": "MKT",
            "user_confirmed": True,
        },
    )
    res = client.post("/api/positions/exit-partial", json={"symbol": "NIFTY24900CE", "percentage": 50})
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["percentage"] == 50
    assert data["closed_positions"] >= 1


def test_trail_sl_to_cost_endpoint(client):
    client.post(
        "/api/orders",
        json={
            "symbol": "NIFTY24900PE",
            "side": "BUY",
            "lots": 1,
            "lot_size": 25,
            "exchange_segment": "nse_fo",
            "product": "MIS",
            "order_type": "MKT",
            "user_confirmed": True,
        },
    )
    res = client.post("/api/positions/trail-to-cost", json={"symbol": "NIFTY24900PE"})
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["cost_price"] > 0
    assert "trailed" in data["message"].lower()


def test_live_quote_endpoints(client):
    res = client.get("/api/chart/live-quote?symbol=NIFTY")
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert "ltp" in data
    assert data["ltp"] > 0

    batch_res = client.post(
        "/api/chart/live-quotes",
        json={"items": [{"symbol": "NIFTY"}, {"symbol": "BANKNIFTY"}]}
    )
    assert batch_res.status_code == 200
    b_data = batch_res.json()
    assert b_data["ok"] is True
    assert len(b_data["quotes"]) == 2


def test_chart_search_endpoint(client):
    res = client.get("/api/chart/search?q=24900")
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert len(data["results"]) > 0
    symbols = [r["symbol"] for r in data["results"]]
    assert any("24900" in s for s in symbols)


def test_owner_auth_and_session_status(client, monkeypatch):
    monkeypatch.setenv("OWNER_PIN", "1234")
    # Wrong PIN
    res_bad = client.post("/api/auth/owner-login", json={"mpin": "9999", "totp": ""})
    assert res_bad.status_code == 401

    # Correct PIN
    res_ok = client.post("/api/auth/owner-login", json={"mpin": "1234", "totp": ""})
    assert res_ok.status_code == 200
    token = res_ok.json()["token"]
    assert len(token) == 64

    # Check status with token
    st = client.get("/api/auth/session-status", headers={"X-Owner-Token": token})
    assert st.status_code == 200
    assert st.json()["authenticated"] is True
    assert st.json()["mode"] in {"owner", "live"}

    # Logout
    logout_res = client.post("/api/auth/owner-logout", headers={"X-Owner-Token": token})
    assert logout_res.status_code == 200
    assert logout_res.json()["authenticated"] is False


def test_guest_demo_mode_isolation(client):
    # Unauthenticated session status
    st = client.get("/api/auth/session-status")
    assert st.status_code == 200
    assert st.json()["mode"] == "guest"
    assert st.json()["demo_balance"] == 1000000.0


def test_change_api_keys_and_status(client, monkeypatch):
    monkeypatch.setenv("OWNER_PIN", "2026")
    # Status check
    st = client.get("/api/settings/keys-status")
    assert st.status_code == 200
    assert "upstox_masked" in st.json()
    assert "consumer_key_masked" in st.json()

    # Change keys with correct MPIN
    res = client.post(
        "/api/settings/keys",
        json={
            "consumer_key": "test_consumer_key_xyz",
            "upstox_token": "test_upstox_key_1year",
            "mpin": "2026",
        },
    )
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["upstox_configured"] is True
    assert data["consumer_key_configured"] is True

    # Check status again
    st2 = client.get("/api/settings/keys-status")
    assert st2.json()["upstox_configured"] is True
    assert "••••" in st2.json()["upstox_masked"]


def test_option_chain_normalized_structure(client):
    res = client.get("/api/chart/option-chain?symbol=NIFTY")
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert "chain" in data
    assert "rows" in data
    assert len(data["rows"]) > 0
    first = data["rows"][0]
    assert "strike" in first
    assert "call_symbol" in first
    assert "call_ltp" in first
    assert "put_symbol" in first
    assert "put_ltp" in first
    assert data["spot_price"] > 0


def test_auth_email_check_and_admin_login(client):
    # 1. Admin Email Check
    res_admin = client.post("/api/auth/check-email", json={"email": "osaifala@gmail.com"})
    assert res_admin.status_code == 200
    assert res_admin.json()["is_admin"] is True
    assert res_admin.json()["step"] == "password"

    # 2. Bad Admin Password
    res_bad = client.post("/api/auth/login-admin", json={"email": "osaifala@gmail.com", "password": "wrong"})
    assert res_bad.status_code == 401

    # 3. Correct Admin Password
    res_ok = client.post("/api/auth/login-admin", json={"email": "osaifala@gmail.com", "password": "saif7788"})
    assert res_ok.status_code == 200
    data = res_ok.json()
    assert data["ok"] is True
    assert data["is_admin"] is True
    assert "token" in data
    assert "neo_session" in res_ok.cookies

    # 4. Check Session with Token
    token = data["token"]
    st = client.get("/api/auth/session-status", headers={"X-Owner-Token": token})
    assert st.status_code == 200
    assert st.json()["authenticated"] is True
    assert st.json()["is_admin"] is True


def test_auth_user_otp_flow_and_keys(client):
    # 1. User Email Check (non-admin)
    res_user = client.post("/api/auth/check-email", json={"email": "trader99@test.com"})
    assert res_user.status_code == 200
    assert res_user.json()["is_admin"] is False
    assert res_user.json()["step"] == "otp"
    assert "suggested_username" in res_user.json()

    # 2. Verify OTP with test fallback code
    res_v = client.post("/api/auth/verify-otp", json={
        "email": "trader99@test.com",
        "otp": "778899",
        "username": "SpeedScalper_77"
    })
    assert res_v.status_code == 200
    assert res_v.json()["ok"] is True
    assert res_v.json()["username"] == "SpeedScalper_77"
    assert res_v.json()["paper_balance"] == 1000000.0
    token = res_v.json()["token"]

    # 3. Save Kotak Keys for user
    res_k = client.post(
        "/api/auth/save-kotak-keys",
        json={"consumer_key": "my_kotak_user_key", "mobile": "+919876543210", "ucc": "TESTUCC"},
        headers={"Authorization": f"Bearer {token}"}
    )
    assert res_k.status_code == 200
    assert res_k.json()["ok"] is True


def test_sensex_option_candles_not_index_price(client):
    res = client.get("/api/chart/candles?symbol=SENSEX%2081200%20CE&interval=1m")
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert len(data.get("candles", [])) > 0
    # Option candles should be around 10 - 200, NEVER 24,000+ index price!
    last_candle = data["candles"][-1]
    assert last_candle["close"] < 500.0
    assert last_candle["close"] > 1.0


def test_live_quotes_batch_dictionary_mapping(client):
    res = client.post(
        "/api/chart/live-quotes",
        json={"items": [{"symbol": "NIFTY", "token": "NSE_INDEX|Nifty 50"}]},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert "quotes" in data
    assert "quotes_by_symbol" in data
    assert "NIFTY" in data["quotes_by_symbol"]


def test_root_and_chart_routes(client):
    # Root should serve white-colored trading ticket
    r_root = client.get("/")
    assert r_root.status_code == 200
    assert "TRADING TICKET" in r_root.text
    assert "Trade on Chart" in r_root.text

    # /chart should serve Exness-style terminal
    r_chart = client.get("/chart")
    assert r_chart.status_code == 200
    assert "ex-tabs-bar" in r_chart.text
    assert "mobile-nav-bar" in r_chart.text


def test_option_strike_candle_derivation_fallback(client):
    # Test searching for strike and fetching candles even with arbitrary option strike
    res = client.get("/api/chart/candles?symbol=NIFTY%2025000%20CE%2009%20NOV%2026&interval=1m")
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert len(data.get("candles", [])) > 0


def test_accounting_fifo_lifecycle_and_closed_pnl(client):
    from app.main import db
    from app.accounting import process_execution

    acc = "FIFO_TEST_ACC"
    sym = "NIFTY26NOV25000CE"

    with db() as conn:
        # Golden test: Buy 50 @ 100, Buy 50 @ 110, Sell 40 @ 120, Sell 30 @ 115, Sell 30 @ 90
        process_execution({"account_id": acc, "broker_execution_id": f"{acc}_1", "instrument_key": sym, "trading_symbol": sym, "side": "BUY", "quantity": 50, "price": "100", "execution_time": "2026-11-10T03:50:00Z"}, conn)
        process_execution({"account_id": acc, "broker_execution_id": f"{acc}_2", "instrument_key": sym, "trading_symbol": sym, "side": "BUY", "quantity": 50, "price": "110", "execution_time": "2026-11-10T03:55:00Z"}, conn)
        process_execution({"account_id": acc, "broker_execution_id": f"{acc}_3", "instrument_key": sym, "trading_symbol": sym, "side": "SELL", "quantity": 40, "price": "120", "execution_time": "2026-11-10T04:05:00Z"}, conn)
        process_execution({"account_id": acc, "broker_execution_id": f"{acc}_4", "instrument_key": sym, "trading_symbol": sym, "side": "SELL", "quantity": 30, "price": "115", "execution_time": "2026-11-10T04:15:00Z"}, conn)
        process_execution({"account_id": acc, "broker_execution_id": f"{acc}_5", "instrument_key": sym, "trading_symbol": sym, "side": "SELL", "quantity": 30, "price": "90", "execution_time": "2026-11-10T04:30:00Z"}, conn)
        conn.commit()

    res = client.get(f"/api/positions/closed?account_id={acc}", headers={"X-Owner-Token": "TEST_TOKEN"})
    assert res.status_code == 200
    data = res.json()
    assert "positions" in data
    assert len(data["positions"]) >= 1
    target = next((p for p in data["positions"] if p["account_id"] == acc and p["trading_symbol"] == sym), None)
    assert target is not None
    assert target["gross_realised_pnl"] == "450.00"
    assert target["status"] == "CLOSED"
    assert len(target["matches"]) == 4


def test_accounting_position_reversal(client):
    from app.main import db
    from app.accounting import process_execution, get_open_positions

    acc = "REV_TEST_ACC"
    sym = "BANKNIFTY26NOV52000CE"

    with db() as conn:
        # Buy 50 @ 100, Sell 80 @ 120 -> Long closes (+1000), Short opens (30 @ 120)
        process_execution({"account_id": acc, "broker_execution_id": f"{acc}_1", "instrument_key": sym, "trading_symbol": sym, "side": "BUY", "quantity": 50, "price": "100", "execution_time": "2026-11-10T05:00:00Z"}, conn)
        process_execution({"account_id": acc, "broker_execution_id": f"{acc}_2", "instrument_key": sym, "trading_symbol": sym, "side": "SELL", "quantity": 80, "price": "120", "execution_time": "2026-11-10T05:10:00Z"}, conn)
        conn.commit()

        open_p = get_open_positions(acc, conn)
        assert len(open_p) == 1
        assert open_p[0]["direction"] == "SHORT"
        assert open_p[0]["quantity"] == 30
        assert open_p[0]["average_entry_price"] == "120.0000"


def test_executions_and_pnl_summary_endpoints(client):
    res_exec = client.get("/api/executions")
    assert res_exec.status_code == 200
    assert isinstance(res_exec.json(), list)

    res_sum = client.get("/api/pnl/summary")
    assert res_sum.status_code == 200
    data = res_sum.json()
    assert "all_time" in data
    assert "today" in data


def test_position_exit_single_endpoint(client):
    # Place a simulated order first
    client.post("/api/orders", json={
        "symbol": "NIFTY25000PE",
        "exchange_segment": "nse_fo",
        "product": "NRML",
        "side": "BUY",
        "order_type": "MKT",
        "lots": 1,
        "lot_size": 25,
        "price": 50.0,
        "user_confirmed": True,
    })

    # Call exit endpoint
    res = client.post("/api/positions/NIFTY25000PE/exit", json={"percentage": 100})
    assert res.status_code == 200
    assert res.json()["ok"] is True


def test_is_option_symbol_distinguishes_equities_and_options():
    assert main._is_option_symbol("RELIANCE") is False
    assert main._is_option_symbol("BAJFINANCE") is False
    assert main._is_option_symbol("SHREECEM") is False
    assert main._is_option_symbol("NIFTYBEES") is False
    assert main._is_option_symbol("NIFTY") is False
    assert main._is_option_symbol("NIFTY 25000 CE") is True
    assert main._is_option_symbol("BANKNIFTY 52000 PE") is True
    assert main._is_option_symbol("NIFTY26NOV25000CE") is True
    assert main._is_option_symbol("SENSEX 81200 CE 12 NOV 26") is True


def test_chart_search_equities_and_options_ranking(client, monkeypatch):
    import time as _time

    future_exp_ms = int((_time.time() + 7 * 86400) * 1000)
    sample_instruments = [
        {"trading_symbol": "RELIANCE", "name": "RELIANCE INDUSTRIES LTD", "segment": "NSE_EQ", "instrument_type": "EQ", "instrument_key": "NSE_EQ|INE002A01018", "lot_size": 1},
        {"trading_symbol": "RELINFRA", "name": "RELIANCE INFRASTRUCTURE", "segment": "NSE_EQ", "instrument_type": "EQ", "instrument_key": "NSE_EQ|INE036A01016", "lot_size": 1},
        {"trading_symbol": "RELCAPITAL", "name": "RELIANCE CAPITAL LTD", "segment": "NSE_EQ", "instrument_type": "EQ", "instrument_key": "NSE_EQ|INE013A01015", "lot_size": 1},
        {"trading_symbol": "SHREECEM", "name": "SHREE CEMENT LIMITED", "segment": "NSE_EQ", "instrument_type": "EQ", "instrument_key": "NSE_EQ|INE070A01015", "lot_size": 1},
        {"trading_symbol": "NIFTY 25000 CE 17 NOV 26", "name": "NIFTY", "underlying_symbol": "NIFTY", "segment": "NSE_FO", "instrument_type": "CE", "instrument_key": "NSE_FO|40001", "strike_price": 25000, "expiry": future_exp_ms, "lot_size": 65},
        {"trading_symbol": "SHREECEM 25000 CE 26 NOV 26", "name": "SHREECEM", "underlying_symbol": "SHREECEM", "segment": "NSE_FO", "instrument_type": "CE", "instrument_key": "NSE_FO|49999", "strike_price": 25000, "expiry": future_exp_ms, "lot_size": 25},
    ]
    monkeypatch.setattr(main, "_UPSTOX_NSE_INSTRUMENTS", sample_instruments)
    monkeypatch.setattr(main, "_UPSTOX_FO_UNDERLYINGS", {"RELIANCE", "SHREECEM"})
    monkeypatch.setattr(main, "_get_upstox_option_contracts", lambda *a, **k: [])

    res_rel = client.get("/api/chart/search?q=REL")
    assert res_rel.status_code == 200
    d_rel = res_rel.json()
    assert d_rel["ok"] is True
    assert len(d_rel["results"]) >= 3
    first = d_rel["results"][0]
    assert first["symbol"] == "RELIANCE"
    assert first["lot_size"] == 1
    assert first["source"] == "upstox"
    assert first["token"] == "NSE_EQ|INE002A01018"

    res_opt = client.get("/api/chart/search?q=25000%20CE")
    assert res_opt.status_code == 200
    d_opt = res_opt.json()
    assert d_opt["ok"] is True
    syms = [r["symbol"] for r in d_opt["results"]]
    assert "SHREECEM" not in syms
    assert "NIFTY 25000 CE 17 NOV 26" in syms
    # Index option must rank ahead of any stock option match
    assert syms[0].startswith("NIFTY 25000 CE")


def test_chart_candles_daily_and_days_param(client, monkeypatch):
    monkeypatch.setattr(main, "_UPSTOX_INSTRUMENT_KEY_BY_SYM", {"RELIANCE": "NSE_EQ|INE002A01018"})
    monkeypatch.setattr(main, "_last_candle_quote_cache", {})
    monkeypatch.setattr(main, "_live_quote_cache", {})

    class FakeResp:
        status_code = 200
        def json(self):
            return {
                "status": "success",
                "data": {
                    "candles": [
                        ["2026-11-10T00:00:00+05:30", 1300.0, 1320.0, 1295.0, 1315.0, 450000, 0],
                        ["2026-11-09T00:00:00+05:30", 1280.0, 1298.0, 1275.0, 1290.0, 390000, 0],
                    ]
                },
            }

    class FakeClient:
        def __init__(self, *a, **k):
            pass
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def get(self, url, **k):
            assert "/day/" in url
            assert "INE002A01018" in url
            return FakeResp()

    monkeypatch.setattr(main.httpx, "Client", FakeClient)

    res = client.get("/api/chart/candles?symbol=RELIANCE&interval=1d&days=90")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert len(body["candles"]) == 2
    assert body["candles"][-1]["close"] == 1315.0
    assert body["ltp"] == 1315.0
    assert body["prev_close"] == 1290.0
    assert body["change"] == 25.0


def test_cache_quote_from_candles_uses_previous_ist_day(monkeypatch):
    monkeypatch.setattr(main, "_last_candle_quote_cache", {})
    # Day 1 close at 15:29 IST (09:59 UTC), Day 2 latest close at 10:00 IST (04:30 UTC)
    candles = [
        {"time": 1794218340, "open": 100.0, "high": 105.0, "low": 99.0, "close": 104.0, "volume": 100},   # 2026-11-09 15:29 IST
        {"time": 1794285000, "open": 106.0, "high": 109.0, "low": 105.0, "close": 108.0, "volume": 120},  # 2026-11-10 10:00 IST
        {"time": 1794285060, "open": 108.0, "high": 111.0, "low": 107.0, "close": 110.0, "volume": 130},  # 2026-11-10 10:01 IST
    ]
    main._cache_quote_from_candles("RELIANCE", "NSE_EQ|INE002A01018", candles)
    entry = main._last_candle_quote_cache["RELIANCE_NSE_EQ|INE002A01018"][1]
    assert entry["ltp"] == 110.0
    assert entry["prev_close"] == 104.0
    assert entry["change"] == 6.0


def test_parse_upstox_market_quote_recovers_prev_close_from_net_change():
    # Post-market Upstox quotes return today's settled close inside ohlc.close while net_change holds true delta
    q = main._parse_upstox_market_quote(
        "NIFTY",
        "NSE_INDEX|Nifty 50",
        {"last_price": 25044.65, "net_change": 58.25, "ohlc": {"open": 25076.4, "high": 25084.05, "low": 24838.75, "close": 25044.65}},
        1794292395,
    )
    assert q is not None
    assert q["ltp"] == 25044.65
    assert q["prev_close"] == 24986.4
    assert q["change"] == 58.25
    assert q["change_percent"] == 0.23


def test_signup_signin_and_per_user_isolation(client, monkeypatch):
    monkeypatch.setattr(main, "_get_live_quote_data", lambda sym, token=None: {"ok": True, "symbol": sym, "ltp": 2650.0, "prev_close": 2640.0, "change": 10.0, "change_percent": 0.38})

    r1 = client.post("/api/auth/signup", json={"username": "pune_trader", "password": "secret123", "email": "pune@example.com"})
    assert r1.status_code == 200
    tok1 = r1.json()["token"]
    assert r1.json()["is_admin"] is False

    r2 = client.post("/api/auth/signup", json={"username": "mumbai_trader", "password": "secret456"})
    assert r2.status_code == 200
    tok2 = r2.json()["token"]

    # Wrong password rejected
    bad_signin = client.post("/api/auth/signin", json={"username": "pune_trader", "password": "wrong"})
    assert bad_signin.status_code == 401

    # Pune selects forex and opens a fractional XAUUSD position
    client.post("/api/user/select-market", json={"market": "forex"}, headers={"Authorization": f"Bearer {tok1}"})
    client.post("/api/user/select-market", json={"market": "forex"}, headers={"Authorization": f"Bearer {tok2}"})

    ord_res = client.post(
        "/api/orders?market=forex",
        headers={"Authorization": f"Bearer {tok1}"},
        json={
            "symbol": "XAUUSD",
            "exchange_segment": "forex",
            "product": "NRML",
            "side": "BUY",
            "lots": 0.25,
            "lot_size": 100,
            "order_type": "MKT",
            "user_confirmed": True,
        },
    )
    assert ord_res.status_code == 200
    assert ord_res.json()["ok"] is True

    pos1 = client.get("/api/positions?market=forex", headers={"Authorization": f"Bearer {tok1}"}).json()
    pos2 = client.get("/api/positions?market=forex", headers={"Authorization": f"Bearer {tok2}"}).json()
    assert pos1["open_count"] == 1
    assert pos2["open_count"] == 0
    assert len(client.get("/api/orders?market=forex", headers={"Authorization": f"Bearer {tok1}"}).json()) == 1
    assert len(client.get("/api/orders?market=forex", headers={"Authorization": f"Bearer {tok2}"}).json()) == 0


def test_admin_signin_and_users_analytics(client, monkeypatch):
    # Static chart HTML must NEVER expose admin username or password
    html = client.get("/chart").text
    assert "S@if7246" not in html
    assert "osaifala" not in html

    # Sign up normal trader first
    u_res = client.post("/api/auth/signup", json={"username": "alice_fx", "password": "alice_pwd"})
    assert u_res.status_code == 200
    u_tok = u_res.json()["token"]

    # Non-admin denied access to admin analytics
    denied = client.get("/api/admin/users-analytics", headers={"Authorization": f"Bearer {u_tok}"})
    assert denied.status_code == 403

    # Admin login with configured credentials
    adm = client.post("/api/auth/signin", json={"username": main.ADMIN_USERNAME, "password": main.ADMIN_PASSWORD})
    assert adm.status_code == 200
    adm_body = adm.json()
    assert adm_body["is_admin"] is True
    adm_tok = adm_body["token"]

    analytics = client.get("/api/admin/users-analytics", headers={"Authorization": f"Bearer {adm_tok}"})
    assert analytics.status_code == 200
    data = analytics.json()
    assert data["ok"] is True
    assert data["total_users"] >= 1
    assert any(u["username"] == "alice_fx" for u in data["users"])


def test_forex_sltp_drag_patch_trigger_and_metrics(client, monkeypatch):
    monkeypatch.setattr(main, "_get_live_quote_data", lambda sym, token=None: {"ok": True, "symbol": sym, "ltp": 90000.0, "prev_close": 89000.0, "change": 1000.0, "change_percent": 1.12})
    tok = client.post("/api/auth/signup", json={"username": "fx_scalper", "password": "pw_fx_99"}).json()["token"]
    client.post("/api/user/select-market", json={"market": "forex"}, headers={"Authorization": f"Bearer {tok}"})

    # Place 0.10 lot BTCUSD
    o = client.post(
        "/api/orders?market=forex",
        headers={"Authorization": f"Bearer {tok}"},
        json={"symbol": "BTCUSD", "exchange_segment": "forex", "product": "NRML", "side": "BUY", "lots": 0.10, "lot_size": 100, "order_type": "MKT", "user_confirmed": True},
    )
    assert o.status_code == 200

    # Attach SL/TP rule
    rule = client.post(
        "/api/sltp?market=forex",
        headers={"Authorization": f"Bearer {tok}"},
        json={"symbol": "BTCUSD", "exchange_segment": "forex", "product": "NRML", "side": "BUY", "quantity": 10, "entry_price": 90000.0, "sl_price": 88000.0, "tp_price": 92000.0},
    )
    assert rule.status_code == 200
    rule_id = rule.json()["rule_id"]

    # Simulate dragging TP line to 91500
    patched = client.patch(f"/api/sltp/{rule_id}?market=forex", headers={"Authorization": f"Bearer {tok}"}, json={"tp_price": 91500.0})
    assert patched.status_code == 200
    assert patched.json()["tp_price"] == 91500.0

    # Simulate price reaching TP (91600)
    trig = client.post("/api/sltp/check?market=forex", headers={"Authorization": f"Bearer {tok}"}, json={"symbol": "BTCUSD", "ltp": 91600.0})
    assert trig.status_code == 200
    assert trig.json()["triggered_count"] == 1
    assert trig.json()["triggered"][0]["trigger_type"] == "TP"

    closed = client.get("/api/positions?tab=closed&market=forex", headers={"Authorization": f"Bearer {tok}"}).json()
    assert closed["summary"]["total_positions"] == 1
    assert closed["total_charges"] == 0.0
    assert closed["total_net_pnl"] > 0
    assert closed["win_rate"] == 100.0


def test_pending_limit_order_fills_and_indian_market_hours_guard(client, monkeypatch):
    monkeypatch.setattr(main, "_get_live_quote_data", lambda sym, token=None: {"ok": True, "symbol": sym, "ltp": 2650.0, "prev_close": 2645.0, "change": 5.0, "change_percent": 0.19})
    monkeypatch.setattr(main, "_is_indian_market_open", lambda: False)

    tok = client.post("/api/auth/signup", json={"username": "hours_tester", "password": "pw_hrs_99"}).json()["token"]
    client.post("/api/user/select-market", json={"market": "indian"}, headers={"Authorization": f"Bearer {tok}"})

    # Indian order rejected outside NSE hours
    ind_ord = client.post(
        "/api/orders?market=indian",
        headers={"Authorization": f"Bearer {tok}"},
        json={"symbol": "NIFTY", "exchange_segment": "nse_fo", "product": "MIS", "side": "BUY", "lots": 1, "lot_size": 65, "order_type": "MKT", "user_confirmed": True},
    )
    assert ind_ord.status_code == 400
    assert "09:15" in ind_ord.json()["detail"]

    # Switch to Forex: 24/7 pending Limit Buy triggers automatically on dip
    client.post("/api/user/select-market", json={"market": "forex"}, headers={"Authorization": f"Bearer {tok}"})
    pend = client.post(
        "/api/orders?market=forex",
        headers={"Authorization": f"Bearer {tok}"},
        json={"symbol": "XAUUSD", "exchange_segment": "forex", "product": "NRML", "side": "BUY", "lots": 0.05, "lot_size": 100, "order_type": "L", "price": 2640.0, "user_confirmed": True},
    )
    assert pend.status_code == 200
    assert pend.json()["status"] == "pending"

    fill_res = client.post("/api/sltp/check?market=forex", headers={"Authorization": f"Bearer {tok}"}, json={"symbol": "XAUUSD", "ltp": 2639.5}).json()
    assert fill_res["filled_pending_count"] == 1
    assert client.get("/api/positions?market=forex", headers={"Authorization": f"Bearer {tok}"}).json()["open_count"] == 1


def test_chart_search_forex_and_performance_metrics(client):
    from app import accounting
    res = client.get("/api/chart/search?q=XAU&market=forex")
    assert res.status_code == 200
    syms = [r["symbol"] for r in res.json()["results"]]
    assert "XAUUSD" in syms

    m = accounting.compute_trade_metrics([300.0, -100.0, 200.0], base_capital=10000.0)
    assert m["win_rate"] == 66.67
    assert m["avg_r_multiple"] > 0
    assert m["sharpe_ratio"] > 0











