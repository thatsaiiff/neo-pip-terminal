import pytest

from app import research_data
from app.execution import (
    calculate_option_position_size,
    dispatch_kotak_mutation,
    is_rust_execution_available,
    risk_halt_code,
    rust_execution_status,
)


class FakeKotak:
    def __init__(self):
        self.calls = []

    def place_order(self, **kwargs):
        self.calls.append(("place_order", kwargs))
        return {"stat": "Ok", "nOrdNo": "MOCK-ORDER"}

    def cancel_order(self, **kwargs):
        self.calls.append(("cancel_order", kwargs))
        return {"stat": "Ok"}


class TimeoutKotak:
    def __init__(self):
        self.calls = 0

    def place_order(self, **kwargs):
        self.calls += 1
        raise TimeoutError("mock broker timeout")


def test_execution_engine_reports_native_status():
    status = rust_execution_status()
    assert status["available"] is is_rust_execution_available()
    if status["available"]:
        assert status["runtime"] == "rust-pyo3"
        assert status["order_dispatch_enabled"] is True
    else:
        assert status["order_dispatch_enabled"] is False


def test_rust_gateway_validates_and_dispatches_order_once():
    if not is_rust_execution_available():
        pytest.skip("Build the Rust execution module to test the PyO3 broker gateway.")
    broker = FakeKotak()
    response = dispatch_kotak_mutation(
        broker,
        "place_order",
        exchange_segment="nse_fo",
        product="MIS",
        price="0",
        order_type="MKT",
        quantity="25",
        validity="DAY",
        trading_symbol="BANKNIFTY26JUN50000CE",
        transaction_type="B",
    )
    assert response["stat"] == "Ok"
    assert len(broker.calls) == 1
    tag = broker.calls[0][1]["tag"]
    assert tag.startswith("NP") and len(tag) == 22


def test_rust_gateway_rejects_unknown_mutation():
    if not is_rust_execution_available():
        pytest.skip("Build the Rust execution module to test mutation allowlisting.")
    with pytest.raises(ValueError, match="only permits"):
        dispatch_kotak_mutation(FakeKotak(), "modify_order", order_id="MOCK-ORDER")


def test_rust_gateway_does_not_retry_ambiguous_broker_call():
    if not is_rust_execution_available():
        pytest.skip("Build the Rust execution module to test ambiguous dispatch handling.")
    broker = TimeoutKotak()
    with pytest.raises(TimeoutError, match="mock broker timeout"):
        dispatch_kotak_mutation(
            broker,
            "place_order",
            exchange_segment="nse_fo",
            product="MIS",
            price="0",
            order_type="MKT",
            quantity="25",
            validity="DAY",
            trading_symbol="BANKNIFTY26JUN50000CE",
            transaction_type="B",
        )
    assert broker.calls == 1
    assert rust_execution_status()["recent_dispatches"][0]["status"] == "UNKNOWN"


def test_rust_risk_checks_and_option_lot_sizing():
    assert risk_halt_code(
        daily_net_pnl=-100.0,
        daily_loss_limit=100.0,
        drawdown_pct=0.0,
        max_drawdown_pct=30.0,
        loss_streak=0,
        max_consecutive_losses=3,
        unresolved_orders=0,
        unmarked_positions=0,
    ) == "DAILY_LOSS"
    size = calculate_option_position_size(
        initial_capital=1_000_000,
        risk_pct_per_trade=0.5,
        entry_price=100,
        stop_price=90,
        lot_size=25,
        max_lots=10,
    )
    assert size["lots"] == 10
    assert size["quantity"] == 250
    assert size["risk_cash"] == 2500


def test_local_dataset_manifest_and_validation_use_bounded_paths(tmp_path, monkeypatch):
    folder = tmp_path / "banknifty_1m"
    folder.mkdir()
    underlying = folder / "banknifty_index_1m.csv"
    options = folder / "banknifty_options_1m.csv"
    (folder / "metadata.json").write_text(
        '{"index_bar_count":40,"option_bar_count":40,"option_contracts_with_candles":1,"contract_master_row_count":1}',
        encoding="utf-8",
    )
    underlying.write_text(
        "time,open,high,low,close,volume\n2026-11-10T09:15:00+05:30,100,102,99,101,10\n",
        encoding="utf-8",
    )
    options.write_text(
        "time,underlying,instrument_key,trading_symbol,expiry,option_type,strike,lot_size,exchange_segment,open,high,low,close,volume\n"
        "2026-11-10T09:15:00+05:30,BANKNIFTY,NSE_FO|TEST,BANKNIFTY 50000 CE,2026-11-10,CE,50000,15,nse_fo,100,102,99,101,10\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(research_data, "EXPORT_ROOT", tmp_path)
    manifest = research_data.local_dataset_manifest()
    assert manifest["datasets"][0]["id"] == "banknifty_1m"
    assert manifest["datasets"][0]["underlying_rows"] == 40
    report = research_data.inspect_local_dataset("banknifty_1m")
    assert report["underlying"]["rows"] == 1
    assert report["options"]["rows"] == 1
    assert report["underlying"]["invalid_ohlc"] == 0
    assert report["options"]["duplicate_bars"] == 0
