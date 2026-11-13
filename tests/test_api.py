import time
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
    # Untrusted / test domains rejected cleanly
    bad_user = client.post("/api/auth/check-email", json={"email": "trader99@test.com"})
    assert bad_user.status_code == 400

    # 1. User Email Check (trusted Gmail domain)
    res_user = client.post("/api/auth/check-email", json={"email": "trader99@gmail.com"})
    assert res_user.status_code == 200
    assert res_user.json()["is_admin"] is False
    assert res_user.json()["step"] == "otp"
    assert "suggested_username" in res_user.json()

    # Hardcoded 778899 must be rejected; only real DB OTP accepted
    bad_v = client.post("/api/auth/verify-otp", json={
        "email": "trader99@gmail.com",
        "otp": "778899",
        "username": "SpeedScalper_77",
    })
    assert bad_v.status_code == 400

    with main.db() as conn:
        real_otp = conn.execute("SELECT otp FROM email_otps WHERE email = 'trader99@gmail.com' ORDER BY id DESC LIMIT 1").fetchone()["otp"]

    # 2. Verify OTP with real cryptographic code from email_otps
    res_v = client.post("/api/auth/verify-otp", json={
        "email": "trader99@gmail.com",
        "otp": real_otp,
        "username": "SpeedScalper_77",
    })
    assert res_v.status_code == 200
    assert res_v.json()["ok"] is True
    assert res_v.json()["username"] == "SpeedScalper_77"
    assert res_v.json()["email_verified"] is True
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
    idx_res = client.get("/api/chart/candles?symbol=SENSEX&interval=1m")
    assert idx_res.status_code == 200
    idx_candles = idx_res.json().get("candles", [])
    assert len(idx_candles) > 0
    spot = float(idx_candles[-1]["close"])
    assert spot > 24000.0

    # Deep ITM/historic 81200 CE must still reflect option pricing (never raw 24,000+ index spot)
    res = client.get("/api/chart/candles?symbol=SENSEX%2081200%20CE&interval=1m")
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert len(data.get("candles", [])) > 0
    last_candle = data["candles"][-1]
    assert 1.0 < last_candle["close"] < spot * 0.25

    # Current ATM SENSEX CE option must always stay below 500 and never leak index spot
    atm_strike = int(round(spot / 100.0) * 100)
    atm_res = client.get(f"/api/chart/candles?symbol=SENSEX%20{atm_strike}%20CE&interval=1m")
    assert atm_res.status_code == 200
    atm_data = atm_res.json()
    assert atm_data["ok"] is True and len(atm_data.get("candles", [])) > 0
    atm_last = atm_data["candles"][-1]["close"]
    assert 1.0 < atm_last < 500.0


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


def _signup_verified(client, username: str, password: str, email: str):
    req = client.post("/api/auth/request-signup-otp", json={"username": username, "password": password, "email": email})
    assert req.status_code == 200, req.text
    with main.db() as conn:
        row = conn.execute("SELECT otp FROM email_otps WHERE LOWER(email) = ? AND purpose = 'signup' ORDER BY id DESC LIMIT 1", (email.lower(),)).fetchone()
    assert row is not None
    res = client.post("/api/auth/signup", json={"username": username, "password": password, "email": email, "otp": row["otp"]})
    assert res.status_code == 200, res.text
    return res


def test_signup_signin_and_per_user_isolation(client, monkeypatch):
    monkeypatch.setattr(main, "_get_live_quote_data", lambda sym, token=None: {"ok": True, "symbol": sym, "ltp": 2650.0, "prev_close": 2640.0, "change": 10.0, "change_percent": 0.38})

    r1 = _signup_verified(client, "pune_trader", "secret123", "pune.trader@gmail.com")
    tok1 = r1.json()["token"]
    assert r1.json()["is_admin"] is False
    assert r1.json()["email_verified"] is True

    r2 = _signup_verified(client, "mumbai_trader", "secret456", "mumbai.trader@outlook.com")
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

    # Sign up verified normal trader first
    u_res = _signup_verified(client, "alice_fx", "alice_pwd", "alice.fx@yahoo.com")
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
    tok = _signup_verified(client, "fx_scalper", "pw_fx_99", "fx.scalper@icloud.com").json()["token"]
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

    tok = _signup_verified(client, "hours_tester", "pw_hrs_99", "hours.tester@proton.me").json()["token"]
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


def test_unauthenticated_and_non_admin_isolation_on_main_site_endpoints(client, monkeypatch):
    # Sign up regular trader while PYTEST_CURRENT_TEST is active, also log an owner-like audit event
    main.audit("broker_login_success", {"account_id": "KOTAK_OWNER", "environment": "prod"})
    res_up = _signup_verified(client, "sec_trader", "pw_sec_99", "sec.trader@zoho.com")
    tok = res_up.json()["token"]
    client.post("/api/user/select-market", json={"market": "indian"}, headers={"Authorization": f"Bearer {tok}"})

    # Seed a closed position directly under KOTAK_OWNER
    with main.db() as conn:
        conn.execute("""
            INSERT INTO positions (id, account_id, instrument_key, trading_symbol, product_type, lifecycle_number, direction, open_quantity, average_entry_price, realised_gross_pnl, realised_net_pnl, total_charges, status, opened_at, closed_at)
            VALUES ('pos_owner_secret', 'KOTAK_OWNER', 'NSE_FO|NIFTY|NRML', 'NIFTY25000CE', 'NRML', 1, 'LONG', 0, '100.0', '5000.0', '4960.0', '40.0', 'CLOSED', '2026-11-10T09:15:00Z', '2026-11-10T09:20:00Z')
        """)
        conn.commit()

    # Simulate production runtime (no PYTEST_CURRENT_TEST override) + globally authenticated Kotak session
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.setattr(main, "neo_authenticated", True)
    monkeypatch.setattr(main, "neo_egress_ip", "1.2.3.4")

    # 1. Unauthenticated caller must get masked /api/status and 401 on all sensitive portfolio/audit routes
    st_unauth = client.get("/api/status")
    assert st_unauth.status_code == 200
    st_json = st_unauth.json()
    assert st_json["authenticated"] is False
    assert st_json["broker_authenticated"] is False
    assert st_json["kotak_egress_ip"] is None
    assert st_json["mode"] == "simulation"

    for path in ["/api/positions", "/api/positions/closed", "/api/executions", "/api/pnl/summary", "/api/orders", "/api/funds", "/api/sltp", "/api/audit"]:
        r = client.get(path)
        assert r.status_code == 401, f"Expected 401 for unauth GET {path}, got {r.status_code}"

    # 2. Signed-in non-admin user must NOT see Admin Kotak status, KOTAK_OWNER closed positions, or owner audit events
    headers = {"Authorization": f"Bearer {tok}"}
    st_user = client.get("/api/status", headers=headers).json()
    assert st_user["authenticated"] is True
    assert st_user["is_admin"] is False
    assert st_user["broker_authenticated"] is False
    assert st_user["kotak_egress_ip"] is None

    closed_override = client.get("/api/positions/closed?account_id=KOTAK_OWNER", headers=headers)
    assert closed_override.status_code == 200
    assert closed_override.json()["positions"] == []

    det_override = client.get("/api/positions/pos_owner_secret", headers=headers)
    assert det_override.status_code == 404

    audit_user = client.get("/api/audit", headers=headers).json()
    assert all(ev.get("event_type") != "broker_login_success" for ev in audit_user)


def test_trusted_email_domain_validation_and_mandatory_otp_signup(client):
    # 1. Disposable, fake, typo, and untrusted domains must all be rejected on OTP request & signup
    for bad_email in [
        "spammer@mailinator.com",
        "temp@yopmail.com",
        "user@10minutemail.com",
        "fake@trader.local",
        "bad@example.com",
        "typo@gmal.com",
        "random@unknownuntrusted.xyz",
    ]:
        r = client.post("/api/auth/request-signup-otp", json={
            "username": "baduser1", "password": "pw_good_1", "email": bad_email
        })
        assert r.status_code == 400, f"Should reject untrusted/disposable domain {bad_email}: {r.text}"

    # 2. Signup without OTP or wrong OTP is rejected cleanly (never issues unverified account)
    no_otp = client.post("/api/auth/signup", json={
        "username": "otp_enforced", "password": "pw_good_1", "email": "real.user@gmail.com"
    })
    assert no_otp.status_code == 422

    req = client.post("/api/auth/request-signup-otp", json={
        "username": "otp_enforced", "password": "pw_good_1", "email": "real.user@gmail.com"
    })
    assert req.status_code == 200
    assert "otp" not in req.json()  # OTP must NEVER be exposed in HTTP response!

    wrong = client.post("/api/auth/signup", json={
        "username": "otp_enforced", "password": "pw_good_1", "email": "real.user@gmail.com", "otp": "000000"
    })
    assert wrong.status_code == 400

    # Verify with real OTP from email_otps -> succeeds and marks email_verified=1
    with main.db() as conn:
        real_otp = conn.execute("SELECT otp FROM email_otps WHERE email = 'real.user@gmail.com' ORDER BY id DESC LIMIT 1").fetchone()["otp"]
    ok_res = client.post("/api/auth/signup", json={
        "username": "otp_enforced", "password": "pw_good_1", "email": "real.user@gmail.com", "otp": real_otp
    })
    assert ok_res.status_code == 200
    assert ok_res.json()["email_verified"] is True

    # OTP replay rejected
    replay = client.post("/api/auth/signup", json={
        "username": "otp_enforced2", "password": "pw_good_1", "email": "real.user@gmail.com", "otp": real_otp
    })
    assert replay.status_code == 400


def test_forgot_password_and_email_delivery_channels(client, monkeypatch):
    _signup_verified(client, "reset_user", "oldpass123", "reset.user@iitb.ac.in")

    # Request password reset OTP
    req = client.post("/api/auth/forgot-password", json={"email": "reset.user@iitb.ac.in"})
    assert req.status_code == 200
    with main.db() as conn:
        reset_otp = conn.execute("SELECT otp FROM email_otps WHERE email = 'reset.user@iitb.ac.in' AND purpose = 'reset' ORDER BY id DESC LIMIT 1").fetchone()["otp"]

    # Wrong OTP fails
    bad_rst = client.post("/api/auth/reset-password", json={"email": "reset.user@iitb.ac.in", "otp": "111111", "new_password": "newpass999"})
    assert bad_rst.status_code == 400

    # Real OTP resets password
    ok_rst = client.post("/api/auth/reset-password", json={"email": "reset.user@iitb.ac.in", "otp": reset_otp, "new_password": "newpass999"})
    assert ok_rst.status_code == 200

    assert client.post("/api/auth/signin", json={"username": "reset_user", "password": "oldpass123"}).status_code == 401
    assert client.post("/api/auth/signin", json={"username": "reset_user", "password": "newpass999"}).status_code == 200

    # Verify Brevo HTTPS mail path when BREVO_API_KEY + EMAIL_FROM set
    sent_payloads = []
    class FakeResp:
        status_code = 201
        text = "{}"
    class FakeClient:
        def __init__(self, *a, **kw): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def post(self, url, headers=None, json=None):
            sent_payloads.append((url, headers, json))
            return FakeResp()

    monkeypatch.setattr(main, "BREVO_API_KEY", "xkeysib-test")
    monkeypatch.setattr(main, "EMAIL_FROM", "saif@gmail.com")
    monkeypatch.setattr(main.httpx, "Client", FakeClient)
    assert main.send_otp_email("demo@gmail.com", "654321", username="demo") is True
    assert sent_payloads[0][0] == "https://api.brevo.com/v3/smtp/email"
    assert "654321" in sent_payloads[0][2]["subject"]


def test_pending_stop_limit_patch_and_auto_sltp_activation(client, monkeypatch):
    _signup_verified(client, "pend_trader", "pass1234", "pend.trader@gmail.com")
    s_res = client.post("/api/auth/signin", json={"username": "pend_trader", "password": "pass1234"})
    assert s_res.status_code == 200
    hdrs = {"Authorization": f"Bearer {s_res.json()['token']}"}

    # Stub live LTP = 4100.0 for XAUUSD
    monkeypatch.setattr(main, "_get_live_quote_data", lambda sym: {"last_price": 4100.0, "ltp": 4100.0})

    # Place Pending BUY STOP (above LTP) with attached SL & TP
    o_res = client.post(
        "/api/orders?market=forex",
        headers=hdrs,
        json={
            "symbol": "XAUUSD",
            "exchange_segment": "forex",
            "side": "BUY",
            "lots": 0.1,
            "lot_size": 100,
            "product": "NRML",
            "order_type": "SL-M",
            "trigger_price": 4110.0,
            "sl_price": 4095.0,
            "tp_price": 4140.0,
            "auto_sltp": True,
            "user_confirmed": True,
        },
    )
    assert o_res.status_code == 200
    oid = o_res.json()["id"]

    # Modify order below LTP -> PATCH auto-classifies to L (Buy Limit)
    p1 = client.patch(f"/api/orders/{oid}?market=forex", headers=hdrs, json={"price": 4090.0, "trigger_price": 4090.0})
    assert p1.status_code == 200
    assert p1.json()["order_type"] == "L"

    # Modify order back above LTP -> PATCH auto-classifies to SL-M (Buy Stop)
    p2 = client.patch(f"/api/orders/{oid}?market=forex", headers=hdrs, json={"price": 4110.0, "trigger_price": 4110.0})
    assert p2.status_code == 200
    assert p2.json()["order_type"] == "SL-M"

    # Tick crosses 4112.0 (>= 4110.0 trigger) -> fills BUY STOP & creates active SL/TP rule
    t_res = client.post("/api/sltp/check?market=forex", headers=hdrs, json={"symbol": "XAUUSD", "ltp": 4112.0})
    assert t_res.status_code == 200
    sltp_list = client.get("/api/sltp?market=forex", headers=hdrs).json()
    assert any(r["symbol"] == "XAUUSD" and float(r["sl_price"]) == 4095.0 and float(r["tp_price"]) == 4140.0 for r in sltp_list)


def test_signup_otp_resume_and_resend_preserves_password_hash(client):
    req = client.post(
        "/api/auth/request-signup-otp",
        json={"username": "resume_fx", "password": "secret_pass_9", "email": "resume.fx@gmail.com", "name": "Resume Trader"},
    )
    assert req.status_code == 200
    assert "check in spam if still not received" in req.json()["message"].lower()

    # Resend must preserve pending_pw_hash & pending_name
    resend = client.post("/api/auth/resend-otp", json={"email": "resume.fx@gmail.com", "purpose": "signup"})
    assert resend.status_code == 200
    assert "check in spam if still not received" in resend.json()["message"].lower()

    with main.db() as conn:
        row = conn.execute(
            "SELECT otp, pending_username, pending_pw_hash FROM email_otps WHERE LOWER(email) = 'resume.fx@gmail.com' ORDER BY id DESC LIMIT 1"
        ).fetchone()
    assert row is not None
    assert row["pending_username"] == "resume_fx"
    assert row["pending_pw_hash"] and row["pending_pw_hash"] != "secret_pass_9"

    # Simulate mobile browser tab reload where DOM password input is empty -> completes with OTP + saved pending hash
    ok = client.post(
        "/api/auth/signup",
        json={"username": "resume_fx", "password": "", "email": "resume.fx@gmail.com", "otp": row["otp"]},
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["email_verified"] is True

    # Verify user can sign in with their original password afterwards
    si = client.post("/api/auth/signin", json={"username": "resume_fx", "password": "secret_pass_9"})
    assert si.status_code == 200


def test_paper_wallet_deposit_withdraw_and_withdraw_all(client):
    _signup_verified(client, "wallet_fx", "wallet_pw_1", "wallet.fx@gmail.com")
    si = client.post("/api/auth/signin", json={"username": "wallet_fx", "password": "wallet_pw_1"})
    assert si.status_code == 200
    hdrs = {"Authorization": f"Bearer {si.json()['token']}"}

    # Select Forex ($10,000 initial) -> Deposit $2,500.50 -> Balance $12,500.50
    client.post("/api/user/select-market", headers=hdrs, json={"market": "forex"})
    d1 = client.post("/api/paper-wallet/adjust", headers=hdrs, json={"action": "deposit", "amount": 2500.50, "market": "forex"})
    assert d1.status_code == 200, d1.text
    assert d1.json()["balance"] == 12500.50
    assert client.get("/api/funds?market=forex", headers=hdrs).json()["balance"] == 12500.50

    # Withdraw $5,000 -> Balance $7,500.50
    w1 = client.post("/api/paper-wallet/adjust", headers=hdrs, json={"action": "withdraw", "amount": 5000.0, "market": "forex"})
    assert w1.status_code == 200
    assert w1.json()["balance"] == 7500.50

    # Withdraw more than remaining ($999,999) -> subtracts down cleanly to $0.00 (never negative)
    w_over = client.post("/api/paper-wallet/adjust", headers=hdrs, json={"action": "withdraw", "amount": 999999.0, "market": "forex"})
    assert w_over.status_code == 200
    assert w_over.json()["balance"] == 0.0
    assert client.get("/api/funds?market=forex", headers=hdrs).json()["available_margin"] == 0.0

    # Deposit back $1,500 -> Withdraw All -> $0.00
    d2 = client.post("/api/paper-wallet/adjust", headers=hdrs, json={"action": "deposit", "amount": 1500.0, "market": "forex"})
    assert d2.status_code == 200 and d2.json()["balance"] == 1500.0
    wa = client.post("/api/paper-wallet/adjust", headers=hdrs, json={"action": "withdraw_all", "market": "forex"})
    assert wa.status_code == 200 and wa.json()["balance"] == 0.0

    # Indian paper wallet stays independent and works identically
    ind_dep = client.post("/api/paper-wallet/adjust", headers=hdrs, json={"action": "deposit", "amount": 250000.0, "market": "indian"})
    assert ind_dep.status_code == 200 and ind_dep.json()["balance"] == 1250000.0
    assert client.get("/api/funds?market=forex", headers=hdrs).json()["balance"] == 0.0

    # Zero amount rejected for deposit/withdraw
    bad = client.post("/api/paper-wallet/adjust", headers=hdrs, json={"action": "deposit", "amount": 0, "market": "forex"})
    assert bad.status_code == 400


def test_indian_intraday_candles_merged_for_1m_and_sensex(client, monkeypatch):
    monkeypatch.setattr(main, "UPSTOX_ACCESS_TOKEN", "test_upstox_tok")
    monkeypatch.setattr(main, "_is_indian_market_open", lambda now_dt=None: True)
    seen_urls = []

    class FakeResp:
        def __init__(self, payload, status_code=200):
            self._payload = payload
            self.status_code = status_code
        def json(self):
            return self._payload

    now_dt = main.datetime.now(main.IST_TZ).replace(hour=9, minute=20, second=0, microsecond=0)
    t_hist = (now_dt - main.timedelta(days=2)).strftime("%Y-%m-%dT15:29:00+05:30")
    t_intra = now_dt.strftime("%Y-%m-%dT09:16:00+05:30")

    class FakeClient:
        def __init__(self, *a, **k):
            pass
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def get(self, url, **k):
            seen_urls.append(url)
            if "/historical-candle/intraday/" in url:
                return FakeResp({"data": {"candles": [[t_intra, 82100.0, 82200.0, 82050.0, 82166.86, 0, 0]]}})
            if "/historical-candle/" in url:
                return FakeResp({"data": {"candles": [[t_hist, 81090.0, 81110.0, 81080.0, 81106.65, 0, 0]]}})
            return FakeResp({}, status_code=404)

    monkeypatch.setattr(main.httpx, "Client", FakeClient)
    monkeypatch.setattr(
        main,
        "_get_live_quote_data",
        lambda sym, token=None: {"ltp": 82225.5, "prev_close": 81106.65, "change": 1118.85, "change_percent": 1.38, "is_fallback": False},
    )

    for iv in ("1m", "5m"):
        res = client.get(f"/api/chart/candles?symbol=SENSEX&interval={iv}&days=5")
        assert res.status_code == 200, res.text
        data = res.json()
        assert data["ok"] is True
        cs = data["candles"]
        assert len(cs) >= 2
        # Must contain today's live intraday/tick candle close (NOT stuck at previous day 81106.65!)
        assert cs[-1]["close"] == 82225.5
    assert any("/historical-candle/intraday/" in u for u in seen_urls)

    # Also test live bar rollover helper when wall clock moves to next candle bucket
    base_ts = int(main.time.time()) // 60 * 60 - 60
    bars = [{"time": base_ts, "open": 4040.0, "high": 4042.0, "low": 4039.0, "close": 4041.0, "volume": 10}]
    rolled = main._merge_live_tick_into_candles(bars, 4043.25, "1m", 2, is_live_session=True)
    assert len(rolled) == 2
    assert rolled[-1]["open"] == 4041.0
    assert rolled[-1]["close"] == 4043.25
    assert rolled[-1]["high"] == 4043.25


def test_admin_kotak_limits_pascal_case_list_and_errors(client, monkeypatch):
    adm = client.post("/api/auth/signin", json={"username": main.ADMIN_USERNAME, "password": main.ADMIN_PASSWORD})
    assert adm.status_code == 200
    adm_tok = adm.json()["token"]
    headers = {"Authorization": f"Bearer {adm_tok}"}

    class FakeKotakClient:
        def __init__(self, payload):
            self.payload = payload

        def limits(self):
            return self.payload

    # 1. Kotak Neo v2 PascalCase string fields with commas
    monkeypatch.setattr(main, "neo_authenticated", True)
    monkeypatch.setattr(
        main,
        "neo_client",
        FakeKotakClient({
            "stat": "Ok",
            "Category": "CLIENT_SPECIAL",
            "Net": "1,25,430.75",
            "CollateralValue": "50,000.00",
            "MarginUsed": "12,000.25",
            "NotionalCash": "0",
        }),
    )
    res = client.get("/api/funds?market=indian", headers=headers)
    assert res.status_code == 200
    d = res.json()
    assert d["ok"] is True and d["funds_error"] is False
    assert d["available_cash"] == 125430.75
    assert d["available_margin"] == 125430.75
    assert d["collateral"] == 50000.0
    assert d["used_margin"] == 12000.25
    assert d["total_equity"] == 137431.0  # Net + MarginUsed without double-counting CollateralValue

    # 2. Raw list payload with NotionalCash + RmsPayInAmt (Net absent)
    monkeypatch.setattr(
        main,
        "neo_client",
        FakeKotakClient([
            {"Category": "CLIENT_SPECIAL", "NotionalCash": "40,000.00", "RmsPayInAmt": "10000", "MarginUsed": "5000", "CollateralValue": "0"}
        ]),
    )
    res_list = client.get("/api/limits?market=indian", headers=headers)
    assert res_list.status_code == 200
    d2 = res_list.json()
    assert d2["ok"] is True
    assert d2["available_cash"] == 45000.0
    assert d2["used_margin"] == 5000.0

    # 3. Kotak error payload surfaces real broker error instead of misleading 0.0
    monkeypatch.setattr(main, "neo_client", FakeKotakClient({"stat": "Not_Ok", "emsg": "IP not whitelisted"}))
    res_err = client.get("/api/funds?market=indian", headers=headers)
    assert res_err.status_code == 200
    d3 = res_err.json()
    assert d3["ok"] is False and d3["funds_error"] is True
    assert "IP not whitelisted" in d3["error"]


def test_kotak_contract_resolution_bse_fo_sensex_and_nse_cm_equity(client, monkeypatch):
    class FakeKotakScripClient:
        def __init__(self):
            self.calls = []
            self.searches = []

        def search_scrip(self, exchange_segment="", symbol="", option_type=None, strike_price=None, **kwargs):
            self.searches.append((exchange_segment, symbol, option_type, strike_price))
            if exchange_segment == "bse_fo" and "SENSEX" in symbol.upper():
                return [
                    {
                        "pSymbol": 824344,
                        "pTrdSymbol": "SENSEX26N1285000CE",
                        "pExchSeg": "bse_fo",
                        "pSymbolName": "SENSEX",
                        "pOptionType": "ce",
                        "dStrikePrice;": 8500000.0,
                        "pExpiryDate": "12Nov2026",
                        "lLotSize": 20,
                    }
                ]
            if exchange_segment == "nse_cm" and "RELIANCE" in symbol.upper():
                return [
                    {
                        "pSymbol": 2885,
                        "pTrdSymbol": "RELIANCE-EQ",
                        "pExchSeg": "nse_cm",
                        "pSymbolName": "RELIANCE",
                        "pGroup": "EQ",
                        "lLotSize": 1,
                    }
                ]
            return []

        def place_order(self, **kwargs):
            self.calls.append(kwargs)
            return {"stat": "Ok", "nOrdNo": f"KOTAK-{len(self.calls)}", "stCode": 200}

    fake = FakeKotakScripClient()
    monkeypatch.setattr(main, "LIVE_TRADING_ENABLED", True)
    monkeypatch.setattr(main, "neo_authenticated", True)
    monkeypatch.setattr(main, "neo_client", fake)

    # 1. Even if caller sent nse_fo + display symbol + stale lot_size=10, backend resolves bse_fo + SENSEX26N1285000CE + qty=20
    res_ce = client.post(
        "/api/orders",
        json={
            "symbol": "SENSEX 85000 CE 12 NOV 26",
            "instrument_token": "BSE_FO|824344",
            "exchange_segment": "nse_fo",
            "side": "BUY",
            "lots": 1,
            "lot_size": 10,
            "product": "NRML",
            "order_type": "MKT",
            "user_confirmed": True,
        },
    )
    assert res_ce.status_code == 200, res_ce.text
    assert fake.calls[-1]["exchange_segment"] == "bse_fo"
    assert fake.calls[-1]["trading_symbol"] == "SENSEX26N1285000CE"
    assert fake.calls[-1]["quantity"] == "20"
    assert fake.calls[-1]["transaction_type"] == "B"

    # 2. Sell 85000 CE at Market resolves cleanly too
    res_ce_sell = client.post(
        "/api/orders",
        json={
            "symbol": "SENSEX 85000 CE",
            "instrument_token": "BSE_FO|824344",
            "exchange_segment": "bse_fo",
            "side": "SELL",
            "lots": 1,
            "lot_size": 20,
            "product": "NRML",
            "order_type": "MKT",
            "user_confirmed": True,
        },
    )
    assert res_ce_sell.status_code == 200, res_ce_sell.text
    assert fake.calls[-1]["exchange_segment"] == "bse_fo"
    assert fake.calls[-1]["trading_symbol"] == "SENSEX26N1285000CE"
    assert fake.calls[-1]["quantity"] == "20"
    assert fake.calls[-1]["transaction_type"] == "S"

    # 3. Equity display symbol resolves to -EQ trading symbol on nse_cm
    res_eq = client.post(
        "/api/orders",
        json={
            "symbol": "RELIANCE",
            "instrument_token": "NSE_EQ|INE002A01018",
            "exchange_segment": "nse_cm",
            "side": "BUY",
            "lots": 2,
            "lot_size": 1,
            "product": "MIS",
            "order_type": "MKT",
            "user_confirmed": True,
        },
    )
    assert res_eq.status_code == 200, res_eq.text
    assert fake.calls[-1]["exchange_segment"] == "nse_cm"
    assert fake.calls[-1]["trading_symbol"] == "RELIANCE-EQ"
    assert fake.calls[-1]["quantity"] == "2"


def test_kotak_live_positions_enrichment_executions_closed_and_summary(client, monkeypatch):
    adm = client.post("/api/auth/signin", json={"username": main.ADMIN_USERNAME, "password": main.ADMIN_PASSWORD})
    assert adm.status_code == 200
    headers = {"Authorization": f"Bearer {adm.json()['token']}"}

    open_row_no_ltp = {
        "trdSym": "SENSEX26N1281000PE",
        "exSeg": "bse_fo",
        "prod": "NRML",
        "tok": "824311",
        "flBuyQty": "20",
        "flSellQty": "0",
        "buyAmt": "1100.00",
        "sellAmt": "0.00",
    }
    direct_calc = main._calculate_single_position(open_row_no_ltp, ltp=75.0)
    assert direct_calc["display_symbol"] == "SENSEX 81000 PE"
    assert direct_calc["side"] == "BUY"
    assert direct_calc["average_price"] == 55.0
    assert direct_calc["ltp"] == 75.0
    assert direct_calc["m2m"] == 400.0

    class FakeKotakPortfolioClient:
        def positions(self):
            return {
                "stat": "Ok",
                "data": [
                    {**open_row_no_ltp, "ltp": "75.0"},
                    {
                        "trdSym": "SENSEX26N1282000CE",
                        "exSeg": "bse_fo",
                        "prod": "NRML",
                        "tok": "824322",
                        "flBuyQty": "20",
                        "flSellQty": "20",
                        "buyAmt": "2000.00",
                        "sellAmt": "2400.00",
                    },
                ],
            }

        def trade_report(self):
            return {
                "stat": "Ok",
                "data": [
                    {
                        "trdSym": "SENSEX26N1281000PE",
                        "trnsTp": "B",
                        "fldQty": "20",
                        "avgPrc": "55.00",
                        "prod": "NRML",
                        "exSeg": "bse_fo",
                        "flId": "EX-1",
                        "nOrdNo": "K-1",
                        "flDtTm": "2026-11-11 10:15:00",
                    },
                    {
                        "trdSym": "SENSEX26N1282000CE",
                        "trnsTp": "B",
                        "fldQty": "20",
                        "avgPrc": "100.00",
                        "prod": "NRML",
                        "exSeg": "bse_fo",
                        "flId": "EX-2",
                        "nOrdNo": "K-2",
                        "flDtTm": "2026-11-11 09:45:00",
                    },
                    {
                        "trdSym": "SENSEX26N1282000CE",
                        "trnsTp": "S",
                        "fldQty": "20",
                        "avgPrc": "120.00",
                        "prod": "NRML",
                        "exSeg": "bse_fo",
                        "flId": "EX-3",
                        "nOrdNo": "K-3",
                        "flDtTm": "2026-11-11 10:05:00",
                    },
                ],
            }

    monkeypatch.setattr(main, "LIVE_TRADING_ENABLED", True)
    monkeypatch.setattr(main, "neo_authenticated", True)
    monkeypatch.setattr(main, "neo_client", FakeKotakPortfolioClient())

    # 1. /api/positions returns enriched open Kotak positions + realized/unrealized totals
    res_pos = client.get("/api/positions?market=indian", headers=headers)
    assert res_pos.status_code == 200, res_pos.text
    d_pos = res_pos.json()
    assert d_pos["open_count"] == 1
    assert d_pos["closed_count"] == 1
    assert len(d_pos["positions"]) == 1
    p0 = d_pos["positions"][0]
    assert p0["symbol"] == "SENSEX26N1281000PE"
    assert p0["display_symbol"] == "SENSEX 81000 PE"
    assert p0["side"] == "BUY"
    assert p0["average_price"] == 55.0
    assert p0["ltp"] == 75.0
    assert p0["m2m"] == 400.0
    assert d_pos["total_unrealized_pnl"] == 400.0
    assert d_pos["total_realized_pnl"] == 400.0

    # 2. /api/positions/closed serves closed Kotak positions
    res_closed = client.get("/api/positions/closed?market=indian", headers=headers)
    assert res_closed.status_code == 200, res_closed.text
    d_closed = res_closed.json()
    assert len(d_closed["positions"]) == 1
    assert d_closed["positions"][0]["symbol"] == "SENSEX26N1282000CE"
    assert d_closed["positions"][0]["realized_pnl"] == 400.0
    assert d_closed["summary"]["gross_realised_pnl"] == 400.0

    # 3. /api/executions serves Kotak fills
    res_exec = client.get("/api/executions?market=indian", headers=headers)
    assert res_exec.status_code == 200, res_exec.text
    d_exec = res_exec.json()
    assert len(d_exec) == 3
    assert d_exec[0]["display_symbol"] == "SENSEX 81000 PE"
    assert d_exec[0]["side"] == "BUY"
    assert d_exec[0]["quantity"] == 20
    assert d_exec[0]["price"] == 55.0

    # 4. /api/pnl/summary aggregates live Kotak realized P&L and win/loss counts
    res_sum = client.get("/api/pnl/summary?market=indian", headers=headers)
    assert res_sum.status_code == 200, res_sum.text
    d_sum = res_sum.json()
    assert d_sum["total_realised_gross_pnl"] == 400.0
    assert d_sum["winning_trades"] == 1
    assert d_sum["losing_trades"] == 0


def test_kotak_live_order_reflects_and_sltp_places_updates_and_triggers(client, monkeypatch):
    adm = client.post("/api/auth/signin", json={"username": main.ADMIN_USERNAME, "password": main.ADMIN_PASSWORD})
    assert adm.status_code == 200
    headers = {"Authorization": f"Bearer {adm.json()['token']}"}

    class FakeKotakLifecycleClient:
        def __init__(self):
            self.orders_sent = []
            self.open_qty = 0

        def search_scrip(self, exchange_segment="", symbol="", option_type=None, strike_price=None, **kwargs):
            if exchange_segment == "bse_fo" and "SENSEX" in symbol.upper():
                return [
                    {
                        "pSymbol": 824311,
                        "pTrdSymbol": "SENSEX26N1281000PE",
                        "pExchSeg": "bse_fo",
                        "pSymbolName": "SENSEX",
                        "pOptionType": "pe",
                        "dStrikePrice;": 8100000.0,
                        "pExpiryDate": "12Nov2026",
                        "lLotSize": 20,
                    }
                ]
            return []

        def place_order(self, **kwargs):
            self.orders_sent.append(kwargs)
            tx = str(kwargs.get("transaction_type") or "B").upper()
            q = int(float(kwargs.get("quantity") or 0))
            if tx == "B":
                self.open_qty += q
            elif tx == "S":
                self.open_qty = max(0, self.open_qty - q)
            return {"stat": "Ok", "nOrdNo": f"KOTAK-ORD-{len(self.orders_sent)}", "stCode": 200}

        def positions(self):
            if self.open_qty <= 0:
                return {"stat": "Ok", "data": []}
            return {
                "stat": "Ok",
                "data": [
                    {
                        "trdSym": "SENSEX26N1281000PE",
                        "exSeg": "bse_fo",
                        "prod": "NRML",
                        "tok": "824311",
                        "flBuyQty": str(self.open_qty),
                        "flSellQty": "0",
                        "buyAmt": str(self.open_qty * 76.0),
                        "sellAmt": "0.00",
                        "ltp": "82.0",
                    }
                ],
            }

        def order_report(self):
            return {
                "stat": "Ok",
                "data": [
                    {
                        "nOrdNo": "KOTAK-PEND-1",
                        "trdSym": "SENSEX26N1281000PE",
                        "trnsTp": "B",
                        "qty": "20",
                        "prod": "NRML",
                        "prcTp": "L",
                        "prc": "70.00",
                        "trgPrc": "0",
                        "ordSt": "open",
                        "ordDtTm": "2026-11-11 12:10:00",
                    }
                ],
            }

    fake = FakeKotakLifecycleClient()
    monkeypatch.setattr(main, "LIVE_TRADING_ENABLED", True)
    monkeypatch.setattr(main, "neo_authenticated", True)
    monkeypatch.setattr(main, "neo_client", fake)

    # 1. Place BUY on chart with custom SL & TP (auto_sltp=False -> Order Window custom SL/TP must still persist!)
    res_buy = client.post(
        "/api/orders?market=indian",
        headers=headers,
        json={
            "symbol": "SENSEX 81000 PE",
            "instrument_token": "BSE_FO|824311",
            "exchange_segment": "bse_fo",
            "side": "BUY",
            "lots": 1,
            "lot_size": 20,
            "product": "NRML",
            "order_type": "MKT",
            "sl_price": 68.0,
            "tp_price": 98.0,
            "auto_sltp": False,
            "user_confirmed": True,
        },
    )
    assert res_buy.status_code == 200, res_buy.text
    assert fake.open_qty == 20

    # 2. Bought order immediately reflects in /api/positions and /api/orders with chart-matchable fields
    res_pos = client.get("/api/positions?market=indian", headers=headers)
    assert res_pos.status_code == 200
    d_pos = res_pos.json()
    assert d_pos["open_count"] == 1
    assert d_pos["positions"][0]["symbol"] == "SENSEX26N1281000PE"
    assert d_pos["positions"][0]["display_symbol"] == "SENSEX 81000 PE"
    assert d_pos["positions"][0]["average_price"] == 76.0

    res_ords = client.get("/api/orders?market=indian", headers=headers)
    assert res_ords.status_code == 200
    d_ords = res_ords.json()
    assert d_ords[0]["display_symbol"] == "SENSEX 81000 PE"
    assert d_ords[0]["price"] == 70.0
    assert d_ords[0]["status"] == "pending"

    # 3. Initial SL/TP rule exists; creating chart +TP / +SL under Kotak symbol cleanly replaces alias rule & updates
    res_sltp = client.get("/api/sltp?market=indian", headers=headers)
    assert res_sltp.status_code == 200
    rules0 = res_sltp.json()
    assert len(rules0) == 1
    assert rules0[0]["sl_price"] == 68.0 and rules0[0]["tp_price"] == 98.0

    res_create = client.post(
        "/api/sltp?market=indian",
        headers=headers,
        json={
            "symbol": "SENSEX26N1281000PE",
            "exchange_segment": "bse_fo",
            "product": "NRML",
            "side": "BUY",
            "quantity": 20,
            "entry_price": 76.0,
            "sl_price": 70.0,
            "tp_price": None,
        },
    )
    assert res_create.status_code == 200
    rid = res_create.json()["rule_id"]

    res_patch = client.patch(
        f"/api/sltp/{rid}?market=indian",
        headers=headers,
        json={"sl_price": 71.5, "tp_price": 95.0},
    )
    assert res_patch.status_code == 200
    assert res_patch.json()["sl_price"] == 71.5
    assert res_patch.json()["tp_price"] == 95.0

    # Only ONE active rule remains after alias replacement
    rules_after = client.get("/api/sltp?market=indian", headers=headers).json()
    assert len(rules_after) == 1 and rules_after[0]["id"] == rid

    # 4. Live quote trigger check via display symbol ('SENSEX 81000 PE') matches rule stored under 'SENSEX26N1281000PE' and exits via Kotak!
    res_trig = client.post(
        "/api/sltp/check?market=indian",
        headers=headers,
        json={"symbol": "SENSEX 81000 PE", "ltp": 96.0},
    )
    assert res_trig.status_code == 200, res_trig.text
    d_trig = res_trig.json()
    assert d_trig["triggered_count"] == 1
    assert d_trig["triggered"][0]["trigger_type"] == "TP"
    assert len(fake.orders_sent) == 2
    assert fake.orders_sent[-1]["transaction_type"] == "S"
    assert fake.orders_sent[-1]["trading_symbol"] == "SENSEX26N1281000PE"
    assert fake.orders_sent[-1]["quantity"] == "20"
    assert fake.open_qty == 0


def test_upstox_v3_feed_decoder_and_realtime_sensex_quotes(client, monkeypatch):
    import struct
    import time

    def _varint(n: int) -> bytes:
        out = bytearray()
        while True:
            b = n & 0x7F
            n >>= 7
            out.append(b | (0x80 if n else 0))
            if not n:
                return bytes(out)

    def _pb_var(fn: int, v: int) -> bytes:
        return _varint((fn << 3) | 0) + _varint(v)

    def _pb_dbl(fn: int, v: float) -> bytes:
        return _varint((fn << 3) | 1) + struct.pack("<d", v)

    def _pb_bytes(fn: int, raw: bytes) -> bytes:
        return _varint((fn << 3) | 2) + _varint(len(raw)) + raw

    # Construct authentic Upstox V3 protobuf binary frame with BSE_INDEX|SENSEX (indexFF) & BSE_FO|822068 (marketFF)
    sensex_ltpc = _pb_dbl(1, 81988.45) + _pb_var(2, 1794383000123) + _pb_dbl(4, 81106.65)
    sensex_d1 = _pb_bytes(1, b"1d") + _pb_dbl(2, 82248.68) + _pb_dbl(3, 82520.40) + _pb_dbl(4, 81955.16) + _pb_dbl(5, 81988.45) + _pb_var(7, 1794335400000)
    sensex_idx_ff = _pb_bytes(1, sensex_ltpc) + _pb_bytes(2, _pb_bytes(1, sensex_d1))
    sensex_feed = _pb_bytes(2, _pb_bytes(2, sensex_idx_ff))
    sensex_entry = _pb_bytes(1, b"BSE_INDEX|SENSEX") + _pb_bytes(2, sensex_feed)

    ce_ltpc = _pb_dbl(1, 294.75) + _pb_var(2, 1794383000456) + _pb_var(3, 20) + _pb_dbl(4, 196.75)
    ce_d1 = _pb_bytes(1, b"1d") + _pb_dbl(2, 341.70) + _pb_dbl(3, 607.60) + _pb_dbl(4, 278.00) + _pb_dbl(5, 294.75) + _pb_var(6, 39682560) + _pb_var(7, 1794335400000)
    ce_mkt_ff = _pb_bytes(1, ce_ltpc) + _pb_bytes(4, _pb_bytes(1, ce_d1)) + _pb_var(6, 39682560)
    ce_feed = _pb_bytes(2, _pb_bytes(1, ce_mkt_ff))
    ce_entry = _pb_bytes(1, b"BSE_FO|822068") + _pb_bytes(2, ce_feed)

    frame = _pb_var(1, 1) + _pb_bytes(2, sensex_entry) + _pb_bytes(2, ce_entry) + _pb_var(3, 1794383000500)
    msg_type, cur_ts, decoded = main.decode_upstox_v3_feed(frame)
    assert msg_type == 1 and cur_ts == 1794383000500
    assert decoded["BSE_INDEX|SENSEX"]["ltp"] == 81988.45
    assert decoded["BSE_INDEX|SENSEX"]["prev_close"] == 81106.65
    assert decoded["BSE_INDEX|SENSEX"]["high"] == 82520.40
    assert decoded["BSE_FO|822068"]["ltp"] == 294.75
    assert decoded["BSE_FO|822068"]["volume"] == 39682560

    # Wire live WS cache into Upstox hub -> /api/chart/live-quotes must serve instant ticks without calling outdated _cached_indices
    ws_map = {}
    now = time.time()
    for k, v in decoded.items():
        ws_map[k] = {**v, "received_at": now}
    monkeypatch.setattr(main, "_UPSTOX_WS_QUOTES", ws_map)
    monkeypatch.setattr(main, "_UPSTOX_WS_SUBSCRIBED_KEYS", {"BSE_INDEX|SENSEX", "BSE_FO|822068"})
    monkeypatch.setattr(main, "_upstox_ws_connected", True)
    monkeypatch.setattr(main, "_upstox_ws_connected_at", now - 5.0)
    monkeypatch.setattr(main, "_live_quote_cache", {})
    monkeypatch.setattr(main, "UPSTOX_ACCESS_TOKEN", "test-upstox-token")
    # Put an old stale price in _cached_indices and prove live WS beats it!
    monkeypatch.setattr(main, "_cached_indices", [{"name": "SENSEX", "ltp": 80000.0, "change": 0.0, "change_percent": 0.0}])
    monkeypatch.setattr(main, "_cached_indices_ts", now - 100.0)

    res = client.post(
        "/api/chart/live-quotes",
        json={"items": [{"symbol": "SENSEX", "token": "BSE_INDEX|SENSEX"}, {"symbol": "SENSEX 82300 CE", "token": "BSE_FO|822068"}]},
    )
    assert res.status_code == 200
    qm = res.json()["quotes_by_symbol"]
    assert qm["SENSEX"]["ltp"] == 81988.45
    assert qm["SENSEX"]["source"] == "upstox_ws_v3"
    assert qm["SENSEX"]["is_fallback"] is False
    assert qm["SENSEX 82300 CE"]["ltp"] == 294.75
    assert qm["SENSEX 82300 CE"]["volume"] == 39682560


def test_audit_hardening_rate_limiter_and_diagnostics(client, monkeypatch):
    """Verify security rate limiter and admin diagnostics observability endpoints."""
    # 1. Diagnostics endpoint requires admin access
    unauth = client.get("/api/admin/diagnostics")
    assert unauth.status_code == 403

    # With admin token
    admin_tok = "audit_admin_token_test"
    main._ACTIVE_OWNER_SESSIONS[admin_tok] = {
        "created_at": time.time(),
        "last_active": time.time(),
        "email": main.ADMIN_EMAIL,
        "is_admin": True,
    }
    diag = client.get("/api/admin/diagnostics", headers={"X-Owner-Token": admin_tok})
    assert diag.status_code == 200
    d_data = diag.json()
    assert d_data["ok"] is True
    assert "broker_session" in d_data
    assert "market_data_feed" in d_data
    assert "database_metrics" in d_data
    assert d_data["database_metrics"]["wal_enabled"] is True
    assert d_data["database_metrics"]["foreign_keys_enabled"] is True

    # 2. Rate limiter sliding window function test
    test_key = "test_rate_ip_1"
    assert main.check_rate_limit(test_key, max_calls=3, window_seconds=10.0) is True
    assert main.check_rate_limit(test_key, max_calls=3, window_seconds=10.0) is True
    assert main.check_rate_limit(test_key, max_calls=3, window_seconds=10.0) is True
    # 4th call exceeds limit
    assert main.check_rate_limit(test_key, max_calls=3, window_seconds=10.0) is False

    # 3. Verify security headers in response
    health_resp = client.get("/api/health")
    assert health_resp.headers.get("X-Content-Type-Options") == "nosniff"
    assert health_resp.headers.get("X-Frame-Options") in {"DENY", "SAMEORIGIN"}
    assert "X-Request-ID" in health_resp.headers


def test_mcx_and_commodity_option_strike_and_sltp_live_execution(client, monkeypatch):
    """Verify 3-digit and commodity option strikes parse correctly and SL/TP executes live order."""
    # 1. Test MCX commodity option strike parsing
    from app.main import parse_option_sym, _normalize_kotak_exchange_segment
    p_ng = parse_option_sym("NATURALGAS 240 PE")
    assert p_ng == ("NATURALGAS", 240.0, "PE")
    p_cop = parse_option_sym("COPPER 810 CE")
    assert p_cop == ("COPPER", 810.0, "CE")
    p_crude = parse_option_sym("CRUDEOIL 6200 CE")
    assert p_crude == ("CRUDEOIL", 6200.0, "CE")

    # Segment mapping to mcx_fo
    seg_ng = _normalize_kotak_exchange_segment("mcx", "NATURALGAS 240 PE")
    assert seg_ng == "mcx_fo"
    seg_crude = _normalize_kotak_exchange_segment("mcx_fo", "CRUDEOIL 6200 CE")
    assert seg_crude == "mcx_fo"

    # 2. Test live SL/TP trigger executing market exit order
    called_order = []
    class MockNeoClient:
        def positions(self):
            return {
                "stat": "Ok",
                "data": [{
                    "trdSym": "CRUDEOIL26NOV6200CE",
                    "exSeg": "mcx_fo",
                    "prod": "NRML",
                    "netQty": "100",
                    "flBuyQty": "100",
                    "flSellQty": "0",
                    "buyAmt": "20000",
                    "sellAmt": "0",
                }]
            }
        def place_order(self, **kwargs):
            called_order.append(kwargs)
            return {"stat": "Ok", "nOrdNo": "999888777", "emsg": "Order submitted"}

    monkeypatch.setattr(main, "neo_client", MockNeoClient())
    monkeypatch.setattr(main, "neo_authenticated", True)
    monkeypatch.setattr(main, "LIVE_TRADING_ENABLED", True)

    with main.db() as conn:
        conn.execute("DELETE FROM sltp_rules WHERE account_id = 'KOTAK_OWNER'")
        main._upsert_active_sltp_rule(
            conn,
            account_id="KOTAK_OWNER",
            symbol="CRUDEOIL 6200 CE",
            exchange_segment="mcx_fo",
            product="NRML",
            side="BUY",
            quantity=100,
            entry_price=200.0,
            sl_price=180.0,
            tp_price=250.0,
            market_mode="indian",
        )
        conn.commit()

    # Trigger with LTP 175.0 (SL hit: <= 180.0)
    res = client.post("/api/sltp/check", json={"symbol": "CRUDEOIL 6200 CE", "ltp": 175.0})
    assert res.status_code == 200
    r_data = res.json()
    assert r_data["triggered_count"] == 1
    assert r_data["triggered"][0]["trigger_type"] == "SL"
    # Confirm Kotak live place_order was invoked with SELL 100
    assert len(called_order) == 1
    assert called_order[0]["transaction_type"] == "S"
    assert called_order[0]["quantity"] == "100"
    assert called_order[0]["exchange_segment"] == "mcx_fo"


def test_round_to_tick_and_exchange_tick_sizes():
    # NSE/BSE options and equities strictly require 0.05 multiples
    assert main.round_to_tick(125.43, 0.05) == 125.45
    assert main.round_to_tick(125.42, 0.05) == 125.40
    assert main.round_to_tick(515.62, 0.05) == 515.60
    assert main.round_to_tick(515.63, 0.05) == 515.65
    assert main.round_to_tick(0.0, 0.05) == 0.0
    assert main.round_to_tick(None, 0.05) is None

    # Exchange tick sizes
    assert main.get_exchange_tick_size("SENSEX26N1282400PE", "BSE_FO") == 0.05
    assert main.get_exchange_tick_size("NIFTY24NOV25000CE", "NSE_FO") == 0.05
    assert main.get_exchange_tick_size("RELIANCE", "NSE_EQ") == 0.05
    assert main.get_exchange_tick_size("CRUDEOIL 6200 CE", "MCX_FO") == 0.05
    assert main.get_exchange_tick_size("CRUDEOIL FUT", "MCX_FO") == 1.0
    assert main.get_exchange_tick_size("NATURALGAS FUT", "MCX_FO") == 0.10
    assert main.get_exchange_tick_size("EURUSD", "FOREX") == 0.0001
    assert main.get_exchange_tick_size("USDJPY", "FOREX") == 0.01


def test_kotak_exit_live_position_matching(client, monkeypatch):
    called_order = []
    class FakeNeoClient:
        def positions(self):
            return {
                "stat": "Ok",
                "data": [
                    {
                        "trdSym": "SENSEX26N1282400PE",
                        "prod": "NRML",
                        "exSeg": "bse_fo",
                        "netQty": "20",
                        "buyAmt": "10000.0",
                        "sellAmt": "0.0",
                        "flBuyQty": "20",
                        "flSellQty": "0",
                        "cfBuyQty": "0",
                        "cfSellQty": "0",
                    }
                ]
            }
        def place_order(self, **kwargs):
            called_order.append(kwargs)
            return {"stat": "Ok", "nOrdNo": "EX-LIVE-999"}

    monkeypatch.setattr(main, "neo_client", FakeNeoClient())
    monkeypatch.setattr(main, "neo_authenticated", True)
    monkeypatch.setattr(main, "LIVE_TRADING_ENABLED", True)

    # Calling exit with SENSEX underlying name matches SENSEX26N1282400PE open position
    res = client.post("/api/positions/SENSEX/exit", json={"percentage": 100})
    assert res.status_code == 200
    assert res.json()["ok"] is True
    assert len(called_order) == 1
    assert called_order[0]["trading_symbol"] == "SENSEX26N1282400PE"
    assert called_order[0]["transaction_type"] == "S"
    assert called_order[0]["quantity"] == "20"
    assert called_order[0]["order_type"] == "MKT"
    assert called_order[0]["price"] == "0"


def test_exit_nonexistent_position_returns_404(client, monkeypatch):
    monkeypatch.setattr(main, "neo_client", None)
    monkeypatch.setattr(main, "neo_authenticated", False)
    monkeypatch.setattr(main, "LIVE_TRADING_ENABLED", False)

    res = client.post("/api/positions/NONEXISTENT_XYZ/exit", json={"percentage": 100})
    assert res.status_code == 404
    assert "No open position found" in res.json()["detail"]


def test_algo_bot_atr_filter_and_crossover_signal():
    from app.algo_bot import evaluate_crossover_signal

    # Case 1: Low ATR (< 10) -> Should return NONE due to ATR filter
    low_atr_candles = []
    base = 100.0
    for i in range(25):
        # Range is only 2 points per candle -> ATR << 10
        low_atr_candles.append({
            "open": base, "high": base + 1.0, "low": base - 1.0, "close": base + 0.5,
            "volume": 500,
        })
        base += 0.5
    res = evaluate_crossover_signal(low_atr_candles, fast_period=9, slow_period=15, min_atr=10.0, rr_ratio=2.25)
    assert res["signal"] == "NONE"
    assert "ATR filter active" in res["reason"]

    # Case 2: High ATR (> 10) with Bullish EMA 9/15 crossover & high volume -> Should trigger BUY with 1:2.25 RR
    high_atr_candles = []
    # 25 flat/declining bars with 15-pt volatility
    for i in range(25):
        high_atr_candles.append({
            "open": 200.0, "high": 215.0, "low": 195.0, "close": 198.0,
            "volume": 1000,
        })
    # Fresh breakout bar crossing fast EMA above slow EMA with 3x volume
    high_atr_candles.append({
        "open": 200.0, "high": 235.0, "low": 198.0, "close": 230.0,
        "volume": 4500,
    })
    sig = evaluate_crossover_signal(high_atr_candles, fast_period=9, slow_period=15, min_atr=10.0, rr_ratio=2.25)
    assert sig["signal"] == "BUY"
    assert sig["rr_ratio"] == 2.25
    assert abs(sig["reward"] - sig["risk"] * 2.25) <= 0.05
    assert sig["tp_price"] > sig["entry_price"]
    assert sig["sl_price"] < sig["entry_price"]


def test_algo_bot_circuit_breaker_halts_at_10k_loss(client, monkeypatch):
    from app.algo_bot import QuantitativeAlgoBot

    squared_off = []
    def fake_square_off():
        squared_off.append(True)

    bot = QuantitativeAlgoBot(
        db_conn_factory=main.db,
        executor_fn=lambda p: {"ok": True},
        square_off_all_fn=fake_square_off,
    )
    bot.config.max_loss_limit = 10000.0

    # Mock P&L with ₹10,500 total loss (including charges)
    monkeypatch.setattr(
        bot,
        "compute_current_pnl_with_charges",
        lambda: {"realized_net": -9800.0, "unrealized_mtm": -400.0, "charges": 300.0, "net_pnl": -10200.0},
    )

    is_halted = bot.check_circuit_breaker()
    assert is_halted is True
    assert bot.status == "HALTED_MAX_LOSS"
    assert bot.circuit_breaker_triggered is True
    assert "CRITICAL CIRCUIT BREAKER TRIPPED" in (bot.halt_reason or "")
    assert len(squared_off) == 1

    # Reset circuit breaker
    reset_res = bot.reset_circuit_breaker()
    assert reset_res["ok"] is True
    assert bot.circuit_breaker_triggered is False
    assert bot.status == "STOPPED"


def test_algo_api_endpoints(client):
    status_res = client.get("/api/algo/status")
    assert status_res.status_code == 200
    st = status_res.json()
    assert "status" in st
    assert st["config"]["atr_threshold"] == 10.0
    assert st["config"]["rr_ratio"] == 2.25
    assert st["config"]["max_loss_limit"] == 10000.0

    # Config update
    cfg_res = client.post("/api/algo/config", json={"fast_ema": 9, "slow_ema": 15, "rr_ratio": 2.25})
    assert cfg_res.status_code == 200
    assert cfg_res.json()["rr_ratio"] == 2.25

    # Backtest endpoint
    bt_res = client.get("/api/algo/backtest")
    assert bt_res.status_code == 200
    report = bt_res.json()["report"]
    assert "portfolio" in report
    port = report["portfolio"]
    assert port["target_rr"] >= 6.5
    assert port["win_rate_pct"] >= 25.0
    assert port["max_drawdown_pct"] < 30.0
    assert port["sharpe_ratio"] >= 1.3
























