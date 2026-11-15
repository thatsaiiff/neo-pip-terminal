from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from app.research_engine import (
    METRIC_REGISTRY,
    STRATEGIES,
    aggregate_candles,
    calculate_metrics,
    normalize_candles,
    optimize_strategy,
    run_strategy_backtest,
)

IST = ZoneInfo("Asia/Kolkata")


def make_session_rows(day="2026-11-10"):
    start = datetime.fromisoformat(f"{day}T09:15:00").replace(tzinfo=IST)
    underlying = []
    calls = []
    puts = []
    for index in range(375):
        timestamp = int((start + timedelta(minutes=index)).timestamp())
        if index < 15:
            open_price = close = 100.0
            high, low, volume = 100.1, 99.9, 10
        elif index == 15:
            open_price, close, high, low, volume = 100.0, 100.3, 100.4, 99.95, 100
        else:
            open_price = close = 100.3
            high, low, volume = 100.4, 100.2, 10
        underlying.append({"time": timestamp, "open": open_price, "high": high, "low": low, "close": close, "volume": volume})
        call_high = 50.2 if index < 17 else 51.1
        calls.append({"time": timestamp, "open": 50.0, "high": call_high, "low": 49.8, "close": min(call_high, 50.0), "volume": 100,
                      "instrument_key": "NSE_FO|TEST_CALL", "trading_symbol": "TEST 100 CE", "expiry": day,
                      "option_type": "CE", "strike": 100, "lot_size": 1, "exchange_segment": "nse_fo"})
        puts.append({"time": timestamp, "open": 20.0, "high": 20.2, "low": 19.8, "close": 20.0, "volume": 100,
                     "instrument_key": "NSE_FO|TEST_PUT", "trading_symbol": "TEST 100 PE", "expiry": day,
                     "option_type": "PE", "strike": 100, "lot_size": 1, "exchange_segment": "nse_fo"})
    return underlying, calls + puts


def test_registry_contains_five_distinct_option_buying_strategies_and_metric_groups():
    assert set(STRATEGIES) == {"orb", "ema_vwap", "supertrend_rsi", "adx_breakout", "volatility_expansion"}
    assert len(METRIC_REGISTRY["core"]) == 12
    assert len(METRIC_REGISTRY["options"]) >= 7
    assert len(METRIC_REGISTRY["option_analytics"]) == 10
    assert all(metric.get("formula") and metric.get("required_fields") and metric.get("calculation_function") for metric in METRIC_REGISTRY["option_analytics"])
    assert len(METRIC_REGISTRY["execution_analytics"]) >= 8
    assert all(metric.get("formula") and metric.get("required_fields") and metric.get("calculation_function") for metric in METRIC_REGISTRY["execution_analytics"])


def test_normalize_and_aggregate_only_uses_complete_candles():
    start = datetime(2026, 11, 10, 9, 15, tzinfo=IST)
    rows = []
    for i in range(6):
        timestamp = int((start + timedelta(minutes=i)).timestamp())
        rows.append({"time": timestamp, "open": 10, "high": 11 + i, "low": 9, "close": 10.5, "volume": 2})
    normalized = normalize_candles(rows)
    bars = aggregate_candles(normalized, 5)
    assert len(normalized) == 6
    assert len(bars) == 1
    assert bars[0]["open"] == 10
    assert bars[0]["high"] == 15
    assert bars[0]["volume"] == 10


def test_metrics_are_net_based_and_report_unavailable_fields_explicitly():
    first_exit = int(datetime(2026, 11, 10, 10, 0, tzinfo=IST).timestamp())
    second_exit = int(datetime(2026, 11, 11, 10, 0, tzinfo=IST).timestamp())
    trades = [
        {"exit_time": first_exit, "entry_time": first_exit - 120, "net_pnl": 100.0, "gross_pnl": 120.0, "charges": 20.0, "option_type": "CE", "expiry": "2026-11-10", "day_type": "EXPIRY", "r_multiple": 1.0, "lots": 1, "quantity": 1, "entry_price": 50.0, "premium_deployed": 70.0, "holding_minutes": 2, "mfe_inr": 150.0, "mae_inr": 20.0},
        {"exit_time": second_exit, "entry_time": second_exit - 60, "net_pnl": -50.0, "gross_pnl": -30.0, "charges": 20.0, "option_type": "PE", "expiry": "2026-11-11", "day_type": "EXPIRY", "r_multiple": -0.5, "lots": 1, "quantity": 1, "entry_price": 40.0, "premium_deployed": 60.0, "holding_minutes": 1, "mfe_inr": 10.0, "mae_inr": 60.0},
    ]
    report = calculate_metrics(trades, [{"time": first_exit, "equity": 1_000_100.0}, {"time": second_exit, "equity": 1_000_050.0}], 1_000_000.0, ["2026-11-10", "2026-11-11"], {}, 2, 0)
    metric_by_id = {metric["id"]: metric for metric in report["metrics"]}
    assert report["summary"]["net_pnl"] == 50.0
    assert report["summary"]["available_capital_at_end"] == 1_000_050.0
    assert report["summary"]["total_premium_paid"] == 90.0
    assert metric_by_id["profit_factor"]["value"] == 2.0
    assert metric_by_id["expectancy"]["value"] == 25.0
    assert metric_by_id["win_rate"]["value"] == 50.0
    assert metric_by_id["max_drawdown"]["value"] == 0.005
    assert metric_by_id["risk_reward"]["value"] == 2.0
    assert metric_by_id["recovery_factor"]["value"] == 1.0
    assert metric_by_id["average_pnl"]["value"] == 25.0
    assert metric_by_id["consecutive_losses"]["value"] == 1
    assert metric_by_id["return_on_capital"]["value"] == 0.005
    assert metric_by_id["trade_count"]["value"] == 2
    assert metric_by_id["sharpe"]["value"] is not None
    assert metric_by_id["sortino"]["value"] is not None
    assert report["options_metrics"]["delta"]["status"] == "unavailable"
    assert report["drawdown"]["max_drawdown_inr"] == 50.0
    assert report["summary"]["expectancy_r"] == 0.25
    assert report["monthly"]["2026-11"]["risk_reward"] == 2.0
    assert report["by_expiry"]["2026-11-10"]["risk_reward"] is None


def test_strategy_backtest_uses_option_premium_for_pnl_and_keeps_greeks_na():
    underlying, options = make_session_rows()
    report = run_strategy_backtest("orb", underlying, options, {
        "timeframe_minutes": 1,
        "expiry_mode": "both",
        "initial_capital": 100000,
        "risk_pct_per_trade": 0.5,
        "max_lots": 2,
        "stop_atr_multiple": 1,
        "target_r": 2.25,
        "trail_after_r": 0,
        "opening_range_minutes": 15,
        "volume_period": 5,
        "volume_multiple": 0.5,
    })
    assert report["summary"]["total_trades"] == 1
    trade = report["trades"][0]
    assert trade["option_type"] == "CE"
    assert trade["exit_reason"] == "TARGET"
    assert trade["gross_pnl"] > 0
    assert trade["net_pnl"] > 0
    assert trade["exit_price"] > trade["entry_price"]
    assert report["options_metrics"]["delta"]["status"] == "unavailable"


def test_backtest_rejects_missing_exact_option_contract_data():
    underlying, _ = make_session_rows()
    with pytest.raises(ValueError, match="No valid exact option contract candles"):
        run_strategy_backtest("orb", underlying, [], {"timeframe_minutes": 1})


def test_out_of_sample_session_metrics_only_use_selected_dates():
    underlying_a, options_a = make_session_rows("2026-11-10")
    underlying_b, options_b = make_session_rows("2026-11-11")
    for row in options_b:
        row["instrument_key"] += "_NOV11"
    report = run_strategy_backtest("orb", underlying_a + underlying_b, options_a + options_b, {
        "timeframe_minutes": 1, "initial_capital": 100000, "risk_pct_per_trade": 0.5,
        "max_lots": 2, "stop_atr_multiple": 1, "target_r": 2.25, "trail_after_r": 0,
        "opening_range_minutes": 15, "volume_period": 5, "volume_multiple": 0.5,
    }, {"2026-11-11"})
    assert report["data_quality"]["session_count"] == 1
    assert [row["date"] for row in report["daily"]] == ["2026-11-11"]
    assert report["metrics"][[x["id"] for x in report["metrics"]].index("sharpe")]["status"] == "unavailable"


def test_optimizer_keeps_a_later_holdout_out_of_candidate_ranking():
    underlying = []; options = []
    day = date(2026, 11, 2)
    sessions = 0
    while sessions < 8:
        if day.weekday() < 5:
            session_underlying, session_options = make_session_rows(day.isoformat())
            underlying.extend(session_underlying)
            for row in session_options:
                row["instrument_key"] = f"{row['instrument_key']}_{day.isoformat()}"
                row["trading_symbol"] = f"{row['trading_symbol']} {day.isoformat()}"
            options.extend(session_options)
            sessions += 1
        day += timedelta(days=1)
    result = optimize_strategy("orb", underlying, options, {
        "timeframe_minutes": 1, "initial_capital": 100000, "risk_pct_per_trade": 0.5,
        "max_lots": 2, "stop_atr_multiple": 1, "target_r": 2.25, "trail_after_r": 0,
        "opening_range_minutes": 15, "volume_period": 5, "volume_multiple": 0.5,
    }, parameter_space={"opening_range_minutes": [15], "volume_multiple": [0.5], "target_r": [2.25]},
       budget=1, minimum_trades=1)
    assert result["status"] == "evaluated"
    assert result["sample_periods"]["untouched_holdout_sessions"] == 2
    assert result["holdout"]["trades"] == 2
    assert result["top_candidates"][0]["training"]["trades"] == 4
    assert result["walk_forward"]["folds"]
