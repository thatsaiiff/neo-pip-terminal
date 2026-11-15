"""Auditable intraday option research engine.

Signals are calculated from closed underlying candles. Orders fill on a later
option candle, and P&L is calculated from the supplied listed option prices.
The engine never manufactures missing premiums, quotes, Greeks, or IV values.
"""

from __future__ import annotations

import bisect
import itertools
import math
import random
import statistics
from collections import Counter, defaultdict
from datetime import date, datetime, time as dt_time, timedelta
from decimal import Decimal
from typing import Any, Iterable
from zoneinfo import ZoneInfo

from app.accounting import calculate_statutory_charges

IST = ZoneInfo("Asia/Kolkata")

STRATEGIES: dict[str, dict[str, Any]] = {
    "orb": {
        "name": "Opening range breakout",
        "summary": "Trades a confirmed break of the first 15 minute range with volume confirmation.",
        "signals": "Close crosses the opening range high or low after the range is complete.",
        "parameters": ["opening_range_minutes", "volume_multiple"],
    },
    "ema_vwap": {
        "name": "EMA and VWAP momentum",
        "summary": "Combines a fast and slow EMA cross with session VWAP direction.",
        "signals": "EMA cross and close on the matching side of session VWAP.",
        "parameters": ["fast_ema", "slow_ema"],
    },
    "supertrend_rsi": {
        "name": "Supertrend and RSI",
        "summary": "Confirms Supertrend direction with RSI momentum.",
        "signals": "Supertrend changes direction while RSI confirms above or below 50.",
        "parameters": ["supertrend_period", "supertrend_multiplier", "rsi_period"],
    },
    "adx_breakout": {
        "name": "ADX trend breakout",
        "summary": "Requires directional strength and a close beyond a prior range.",
        "signals": "ADX threshold, directional movement agreement, and range breakout.",
        "parameters": ["adx_period", "adx_threshold", "breakout_lookback"],
    },
    "volatility_expansion": {
        "name": "Volatility expansion",
        "summary": "Looks for a volatility squeeze followed by an ATR backed price break.",
        "signals": "Bollinger width squeeze followed by a break and expanding ATR.",
        "parameters": ["bollinger_period", "squeeze_lookback", "atr_expansion_multiple"],
    },
}


CORE_METRICS: list[dict[str, Any]] = [
    {"id": "win_rate", "name": "Win rate", "definition": "Winning closed trades divided by all closed trades.", "formula": "wins / closed trades × 100", "unit": "%", "benchmark": 50.0, "interpretation": "Evaluate together with average win, average loss and expectancy."},
    {"id": "profit_factor", "name": "Profit factor", "definition": "Positive net trade P&L divided by the absolute value of negative net trade P&L.", "formula": "sum(positive net P&L) / abs(sum(negative net P&L))", "unit": "ratio", "benchmark": 1.5, "interpretation": "Above 1 means sampled net gains exceed sampled net losses."},
    {"id": "expectancy", "name": "Expectancy", "definition": "Average net result per closed trade after modeled costs.", "formula": "sum(net trade P&L) / closed trades", "unit": "INR per trade", "benchmark": 0.0, "interpretation": "Positive sample expectancy is not a forecast."},
    {"id": "max_drawdown", "name": "Maximum drawdown", "definition": "Largest peak to trough decline in the available equity curve.", "formula": "max(peak equity − equity) and percent of peak", "unit": "INR and %", "benchmark": 20.0, "interpretation": "Lower drawdown means a smaller observed peak-to-trough loss."},
    {"id": "risk_reward", "name": "Realized win/loss ratio", "definition": "Average net winning trade divided by the magnitude of average net losing trade.", "formula": "average win / abs(average loss)", "unit": "ratio", "benchmark": 1.0, "interpretation": "Must be read with win rate and costs."},
    {"id": "sharpe", "name": "Sharpe ratio", "definition": "Annualized mean daily excess return divided by daily return standard deviation.", "formula": "mean(daily return − daily risk-free rate) / stdev(excess daily return) × sqrt(252)", "unit": "ratio", "benchmark": 1.0, "interpretation": "Uses observed trading-session returns and the configured annual risk-free rate."},
    {"id": "sortino", "name": "Sortino ratio", "definition": "Annualized mean daily return above target divided by downside deviation from the minimum acceptable return.", "formula": "mean(daily return − daily MAR) / downside deviation × sqrt(252)", "unit": "ratio", "benchmark": 1.0, "interpretation": "Uses a configurable annual minimum acceptable return converted to a daily target."},
    {"id": "recovery_factor", "name": "Recovery factor", "definition": "Net profit divided by maximum absolute drawdown.", "formula": "net profit / max drawdown in INR", "unit": "ratio", "benchmark": 2.0, "interpretation": "Measures net profit relative to the largest observed capital decline."},
    {"id": "average_pnl", "name": "Average net P&L per trade", "definition": "Net strategy P&L divided by the number of closed trades.", "formula": "net profit / closed trades", "unit": "INR per trade", "benchmark": 0.0, "interpretation": "Transaction costs are already included in net trade P&L."},
    {"id": "consecutive_losses", "name": "Maximum consecutive losses", "definition": "Largest uninterrupted sequence of closed trades with negative net P&L.", "formula": "max consecutive trades where net P&L < 0", "unit": "trades", "benchmark": 3.0, "interpretation": "Lower is preferable; the value is sample dependent."},
    {"id": "return_on_capital", "name": "Return on allocated capital", "definition": "Net P&L divided by the configured starting capital.", "formula": "net profit / allocated capital × 100", "unit": "%", "benchmark": 0.0, "interpretation": "Uses the fixed allocated capital, not only premium deployed."},
    {"id": "trade_count", "name": "Closed trades", "definition": "Number of completed simulated option positions.", "formula": "count(closed trades)", "unit": "trades", "benchmark": 100.0, "interpretation": "Sample size warning is shown below the configured threshold."},
]

OPTION_METRIC_DEFINITIONS = {
    "delta": "Option price sensitivity to the underlying. Requires contract delta observations.",
    "theta": "Theoretical option price sensitivity to time decay. Requires contract theta observations.",
    "vega": "Option price sensitivity to implied volatility. Requires contract vega observations.",
    "gamma": "Rate of change in delta. Requires contract gamma observations.",
    "iv": "Contract implied volatility from the supplied observation series.",
    "iv_rank": "Current contract IV relative to its observed lookback minimum and maximum.",
    "iv_percentile": "Share of observed lookback IV values below the current contract IV.",
}

METRIC_REGISTRY: dict[str, Any] = {
    "version": "1.0",
    "core": [
        {**item,
         "calculation_function": f"calculate_metrics:{item['id']}",
         "required_fields": {"win_rate": ["net_pnl"], "profit_factor": ["net_pnl"], "expectancy": ["net_pnl"],
                             "max_drawdown": ["equity_curve", "initial_capital"], "risk_reward": ["net_pnl"],
                             "sharpe": ["daily_equity_returns", "risk_free_rate_pct"], "sortino": ["daily_equity_returns", "minimum_acceptable_return_pct"],
                             "recovery_factor": ["net_pnl", "max_drawdown_inr"], "average_pnl": ["net_pnl"],
                             "consecutive_losses": ["net_pnl", "exit_time"], "return_on_capital": ["net_pnl", "initial_capital"],
                             "trade_count": ["net_pnl"]}[item["id"]],
         "data_quality_status": "evaluated per run"}
        for item in CORE_METRICS
    ],
    "options": [
        {"id": key, "name": "Implied volatility" if key == "iv" else key.replace("_", " ").title(), "definition": definition,
         "formula": "Arithmetic mean of supplied entry observations; exits are summarized separately", "unit": "contract specific", "benchmark": None,
         "calculation_function": f"calculate_metrics:options_metrics.{key}",
         "required_fields": [f"{key}_entry", f"{key}_exit"],
         "data_quality_status": "evaluated per run",
         "interpretation": "Not populated when the historical contract observation is missing."}
        for key, definition in OPTION_METRIC_DEFINITIONS.items()
    ],
    "option_analytics": [
        {"id": "delta_exposure", "name": "Delta exposure and buckets", "definition": "Entry and exit delta means plus net trade results in absolute-delta buckets.", "formula": "bucket by absolute entry delta; sum net trade P&L per bucket", "unit": "delta / INR", "benchmark": None, "calculation_function": "calculate_metrics:options_metrics.pnl_by_delta_bucket", "required_fields": ["delta_entry", "net_pnl"], "data_quality_status": "evaluated per run", "interpretation": "Contract-specific delta is required; directional CE/PE exposure is reported separately."},
        {"id": "theta_exposure", "name": "Theta and holding duration", "definition": "Theta observations summarized at entry/exit and grouped by holding duration and DTE.", "formula": "mean supplied theta; sum net P&L by duration/DTE group", "unit": "contract theta / INR", "benchmark": None, "calculation_function": "calculate_metrics:options_metrics.holding_duration_theta", "required_fields": ["theta_entry", "theta_exit", "holding_minutes", "dte_sessions"], "data_quality_status": "evaluated per run", "interpretation": "Theoretical theta sensitivity is not treated as the actual realized time-decay loss."},
        {"id": "vega_volatility", "name": "Vega and IV change", "definition": "Vega exposure and P&L grouped by observed contract IV regime and IV expansion/contraction.", "formula": "mean supplied vega; group net P&L by IV rank and exit IV minus entry IV", "unit": "contract vega / INR", "benchmark": None, "calculation_function": "calculate_metrics:options_metrics.pnl_by_iv_change", "required_fields": ["vega_entry", "iv_entry", "iv_exit", "net_pnl"], "data_quality_status": "evaluated per run", "interpretation": "Index volatility is not substituted for option-contract IV."},
        {"id": "gamma_expiry", "name": "Gamma by DTE and side", "definition": "Gamma entry/exit means grouped by sessions to expiry and option side.", "formula": "arithmetic mean of supplied contract gamma by group", "unit": "contract gamma", "benchmark": None, "calculation_function": "calculate_metrics:greeks_by_dte.gamma", "required_fields": ["gamma_entry", "gamma_exit", "dte_sessions", "option_type"], "data_quality_status": "evaluated per run", "interpretation": "Expiry gamma estimates require contract-specific Greek observations."},
        {"id": "iv_rank_percentile", "name": "IV rank and percentile", "definition": "Contract IV position against supplied or calculated same-contract history.", "formula": "(current IV − lookback minimum) / (lookback maximum − minimum) × 100; percentile is the share of prior observations below current IV", "unit": "%", "benchmark": None, "calculation_function": "calculate_metrics:options_metrics.iv_rank_history", "required_fields": ["instrument_key", "expiry", "iv_entry", "historical_contract_iv_series"], "data_quality_status": "evaluated per run", "interpretation": "Unavailable unless a consistent contract-specific IV lookback is present."},
        {"id": "capital_deployed", "name": "Premium capital and utilization", "definition": "Premium paid, peak and average premium deployed, and remaining allocated capital.", "formula": "sum(entry premium × quantity); summarize deployed premium against allocated capital", "unit": "INR / %", "benchmark": None, "calculation_function": "calculate_metrics:summary.capital_required", "required_fields": ["entry_price", "quantity", "premium_deployed", "initial_capital"], "data_quality_status": "evaluated per run", "interpretation": "Premium and charges are shown; venue-specific margin rules are not inferred."},
        {"id": "expiry_performance", "name": "Expiry-wise results", "definition": "Net P&L, win rate, profit factor, expectancy, trade count and drawdown by actual contract expiry.", "formula": "group trades by contract expiry; compute net P&L metrics and peak-to-trough equity change", "unit": "INR / %", "benchmark": None, "calculation_function": "calculate_metrics:by_expiry", "required_fields": ["expiry", "net_pnl", "exit_time", "initial_capital"], "data_quality_status": "evaluated per run", "interpretation": "Expiry calendars must be present in contract rows and are not reconstructed by this metric."},
        {"id": "dte_performance", "name": "Days to expiry", "definition": "Calendar/session DTE and performance, holding duration and Greeks grouped by DTE.", "formula": "calendar or session distance from entry date to supplied contract expiry; group trade metrics", "unit": "sessions / days / INR", "benchmark": None, "calculation_function": "calculate_metrics:by_dte", "required_fields": ["entry_time", "expiry", "dte_calendar", "dte_sessions", "net_pnl"], "data_quality_status": "evaluated per run", "interpretation": "Trading-session distance uses observed sessions in the uploaded data."},
        {"id": "tail_risk", "name": "Options tail risk", "definition": "Worst observed losses, historical VaR and expected shortfall, bootstrap drawdown and explicit gap/liquidity limitations.", "formula": "empirical loss quantile and mean beyond quantile; resample closed trade P&L sequences", "unit": "INR / %", "benchmark": None, "calculation_function": "calculate_metrics:tail_risk", "required_fields": ["net_pnl", "initial_capital", "option_bid_ask_depth"], "data_quality_status": "evaluated per run", "interpretation": "Tail estimates require adequate sample size; executable gap/liquidity stress is N/A without quote depth."},
        {"id": "execution_slippage", "name": "Slippage and liquidity", "definition": "Observed quote-midpoint adverse costs summarized by time and entry volume; scenario sensitivity is separate.", "formula": "buy adverse cost = max(fill − midpoint, 0) × quantity; sell adverse cost = max(midpoint − fill, 0) × quantity", "unit": "INR", "benchmark": None, "calculation_function": "calculate_metrics:execution_metrics.slippage", "required_fields": ["bid", "ask", "fill_price", "quantity", "volume"], "data_quality_status": "evaluated per run", "interpretation": "Absent quotes make measured slippage unavailable; scenario stress is not an observed fill."},
    ],
    "execution": [
        {"id": "latency", "name": "Signal and fill latency", "definition": "Simulator uses the first available option bar after a closed signal bar; this is a modelled delay, not measured broker latency.", "formula": "fill candle timestamp − signal candle close timestamp", "unit": "seconds", "calculation_function": "calculate_metrics:execution_metrics.average_signal_to_fill_seconds", "required_fields": ["signal_time", "entry_time"], "data_quality_status": "modeled from candle time"},
        {"id": "slippage", "name": "Slippage", "definition": "Adverse difference between quote midpoint and simulated fill. Requires bid and ask observations.", "formula": "buy: max(fill − midpoint, 0); sell: max(midpoint − fill, 0), multiplied by quantity", "unit": "INR", "calculation_function": "calculate_metrics:execution_metrics.slippage_cost_inr", "required_fields": ["bid", "ask", "fill_price", "quantity"], "data_quality_status": "N/A without quotes"},
        {"id": "fill_rate", "name": "Simulated fill rate", "definition": "Filled eligible signals divided by eligible signals. Historical OHLC fill rules are not broker fill data.", "formula": "closed simulated fills / eligible signals × 100", "unit": "%", "calculation_function": "calculate_metrics:execution_metrics.simulated_fill_rate_pct", "required_fields": ["eligible_signals", "option_candles"], "data_quality_status": "modeled from candle fill rule"},
        {"id": "mfe_mae", "name": "MFE and MAE", "definition": "Maximum favorable and adverse option premium movement during the recorded holding interval.", "formula": "max premium − entry; entry − min premium during holding interval", "unit": "INR", "calculation_function": "calculate_metrics:execution_metrics.mfe_mae_scatter", "required_fields": ["option_high", "option_low", "entry_price", "holding_interval"], "data_quality_status": "evaluated per run"},
    ],
    "execution_analytics": [
        {"id": "order_to_fill_latency", "name": "Order to fill latency", "definition": "Elapsed time from a submitted historical order to broker execution.", "formula": "fill timestamp − order submission timestamp", "unit": "seconds", "calculation_function": "unavailable_without_broker_execution_records", "required_fields": ["order_timestamp", "fill_timestamp"], "data_quality_status": "N/A from OHLC bars"},
        {"id": "rejected_and_partial_orders", "name": "Rejected and partial fills", "definition": "Broker-reported rejected order and partial-fill counts.", "formula": "count broker rejection and partial-fill execution records", "unit": "orders", "calculation_function": "unavailable_without_broker_execution_records", "required_fields": ["broker_order_status", "fill_quantity", "requested_quantity"], "data_quality_status": "N/A from OHLC bars"},
        {"id": "entry_exit_spread", "name": "Entry and exit spread", "definition": "Observed ask minus bid at the simulated entry and exit timestamps.", "formula": "ask − bid", "unit": "INR per unit", "calculation_function": "calculate_metrics:execution_metrics.average_entry_spread", "required_fields": ["bid", "ask"], "data_quality_status": "N/A without quotes"},
        {"id": "holding_duration", "name": "Average holding duration", "definition": "Elapsed time between simulated option entry and exit.", "formula": "mean(exit timestamp − entry timestamp)", "unit": "minutes", "calculation_function": "calculate_metrics:execution_metrics.average_holding_minutes", "required_fields": ["entry_time", "exit_time"], "data_quality_status": "evaluated per run"},
        {"id": "exit_reason_frequency", "name": "Exit reason frequency", "definition": "Count of exits attributed to stop, target, trail, trend reversal or time-based closure.", "formula": "count trades by simulator exit reason", "unit": "trades", "calculation_function": "calculate_metrics:execution_metrics.exit_reason_counts", "required_fields": ["exit_reason"], "data_quality_status": "evaluated per run"},
        {"id": "profit_capture", "name": "Profit capture ratio", "definition": "Gross realized P&L relative to the sum of observed maximum favorable excursions.", "formula": "sum(gross trade P&L) / sum(MFE) × 100", "unit": "%", "calculation_function": "calculate_metrics:execution_metrics.profit_capture_ratio_pct", "required_fields": ["gross_pnl", "mfe_inr"], "data_quality_status": "evaluated per run"},
        {"id": "transaction_costs", "name": "Transaction cost totals", "definition": "Modeled statutory charges per completed position and across the sample.", "formula": "sum(entry charges + exit charges)", "unit": "INR", "calculation_function": "calculate_metrics:execution_metrics.total_transaction_cost", "required_fields": ["charges"], "data_quality_status": "evaluated per run"},
        {"id": "net_to_gross", "name": "Net to gross profit", "definition": "Net strategy profit after modeled charges divided by positive gross trade profit.", "formula": "net strategy P&L / sum(positive gross trade P&L)", "unit": "ratio", "calculation_function": "calculate_metrics:execution_metrics.net_to_gross_profit_ratio", "required_fields": ["net_pnl", "gross_pnl"], "data_quality_status": "evaluated per run"},
        {"id": "slippage_time_liquidity", "name": "Slippage by time and liquidity", "definition": "Average observed adverse quote slippage grouped by entry hour and supplied entry volume.", "formula": "mean(adverse slippage cost) per group", "unit": "INR per trade", "calculation_function": "calculate_metrics:execution_metrics.slippage_by_time_of_day", "required_fields": ["bid", "ask", "fill_price", "entry_volume"], "data_quality_status": "N/A without quotes"},
    ],
}


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError, OverflowError):
        return None


def _canonical_underlying(value: Any) -> str:
    raw = "".join(ch for ch in str(value or "").upper() if ch.isalnum())
    if raw in {"NIFTY", "NIFTY50"}: return "NIFTY"
    if raw in {"BANKNIFTY", "NIFTYBANK"}: return "BANKNIFTY"
    if raw in {"SENSEX", "BSESENSEX"}: return "SENSEX"
    return raw


def _epoch(value: Any) -> int:
    if isinstance(value, (int, float)) or (isinstance(value, str) and value.strip().replace(".", "", 1).isdigit()):
        number = float(value)
        return int(number / 1000 if number > 100_000_000_000 else number)
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=IST)
    return int(parsed.timestamp())


def normalize_candles(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: dict[int, dict[str, Any]] = {}
    for source in rows:
        try:
            timestamp = _epoch(source.get("time", source.get("timestamp", source.get("datetime"))))
        except (TypeError, ValueError, OverflowError, OSError):
            continue
        o = _finite(source.get("open")); h = _finite(source.get("high")); l = _finite(source.get("low")); c = _finite(source.get("close"))
        if None in (o, h, l, c) or min(o, h, l, c) < 0 or h < max(o, c, l) or l > min(o, c, h):
            continue
        row = {"time": timestamp, "open": o, "high": h, "low": l, "close": c,
               "volume": max(0.0, _finite(source.get("volume")) or 0.0)}
        optional_fields = ("bid", "ask", "bid_open", "ask_open", "bid_close", "ask_close",
                           "delta", "theta", "vega", "gamma", "iv", "iv_rank", "iv_percentile", "open_interest")
        for field in optional_fields + tuple(f"{name}_{suffix}" for name in ("delta", "theta", "vega", "gamma", "iv", "iv_rank", "iv_percentile") for suffix in ("open", "close", "at_fill")):
            value = _finite(source.get(field))
            if value is not None:
                row[field] = value
        local = datetime.fromtimestamp(timestamp, IST)
        minute_of_day = local.hour * 60 + local.minute
        if local.weekday() >= 5 or not (9 * 60 + 15 <= minute_of_day <= 15 * 60 + 29):
            continue
        normalized[timestamp] = row
    return [normalized[key] for key in sorted(normalized)]


def aggregate_candles(candles: list[dict[str, Any]], timeframe: int) -> list[dict[str, Any]]:
    if timeframe == 1:
        return candles
    groups: dict[tuple[str, int], list[dict[str, Any]]] = defaultdict(list)
    for bar in candles:
        local = datetime.fromtimestamp(bar["time"], IST)
        offset = local.hour * 60 + local.minute - (9 * 60 + 15)
        if offset < 0 or local.weekday() >= 5:
            continue
        groups[(local.date().isoformat(), offset // timeframe)].append(bar)
    out = []
    for group in groups.values():
        group.sort(key=lambda x: x["time"])
        if len(group) != timeframe:
            continue
        # Reject gaps and duplicate/malformed minute data instead of bridging them.
        if any(group[i]["time"] - group[i - 1]["time"] != 60 for i in range(1, len(group))):
            continue
        out.append({"time": group[0]["time"], "end_time": group[-1]["time"] + 60,
                    "open": group[0]["open"], "high": max(x["high"] for x in group),
                    "low": min(x["low"] for x in group), "close": group[-1]["close"],
                    "volume": sum(x["volume"] for x in group)})
    return sorted(out, key=lambda x: x["time"])


def ema(values: list[float], period: int) -> list[float | None]:
    output: list[float | None] = [None] * len(values)
    if period < 1 or len(values) < period:
        return output
    current = sum(values[:period]) / period
    output[period - 1] = current
    alpha = 2 / (period + 1)
    for i in range(period, len(values)):
        current = values[i] * alpha + current * (1 - alpha)
        output[i] = current
    return output


def sma(values: list[float], period: int) -> list[float | None]:
    output: list[float | None] = [None] * len(values)
    if period < 1:
        return output
    running = 0.0
    for i, value in enumerate(values):
        running += value
        if i >= period:
            running -= values[i - period]
        if i >= period - 1:
            output[i] = running / period
    return output


def atr(bars: list[dict[str, Any]], period: int = 14) -> list[float | None]:
    tr = []
    for i, bar in enumerate(bars):
        prev_close = bars[i - 1]["close"] if i else bar["close"]
        tr.append(max(bar["high"] - bar["low"], abs(bar["high"] - prev_close), abs(bar["low"] - prev_close)))
    return sma(tr, period)


def rsi(values: list[float], period: int) -> list[float | None]:
    output: list[float | None] = [None] * len(values)
    if len(values) <= period:
        return output
    gains = [max(0.0, values[i] - values[i - 1]) for i in range(1, len(values))]
    losses = [max(0.0, values[i - 1] - values[i]) for i in range(1, len(values))]
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    output[period] = 100.0 if avg_loss == 0 and avg_gain > 0 else (50.0 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss))
    for i in range(period + 1, len(values)):
        avg_gain = (avg_gain * (period - 1) + gains[i - 1]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i - 1]) / period
        output[i] = 100.0 if avg_loss == 0 and avg_gain > 0 else (50.0 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss))
    return output


def adx_components(bars: list[dict[str, Any]], period: int) -> tuple[list[float | None], list[float | None], list[float | None]]:
    plus_dm = [0.0]; minus_dm = [0.0]; true_range = []
    for i in range(1, len(bars)):
        up = bars[i]["high"] - bars[i - 1]["high"]
        down = bars[i - 1]["low"] - bars[i]["low"]
        plus_dm.append(up if up > down and up > 0 else 0.0)
        minus_dm.append(down if down > up and down > 0 else 0.0)
    for i, bar in enumerate(bars):
        prev = bars[i - 1]["close"] if i else bar["close"]
        true_range.append(max(bar["high"] - bar["low"], abs(bar["high"] - prev), abs(bar["low"] - prev)))
    tr_avg = sma(true_range, period); plus_avg = sma(plus_dm, period); minus_avg = sma(minus_dm, period)
    plus_di: list[float | None] = [None] * len(bars); minus_di: list[float | None] = [None] * len(bars); dx: list[float] = []
    for i in range(len(bars)):
        if tr_avg[i] is None or tr_avg[i] == 0:
            dx.append(0.0); continue
        plus_di[i] = 100 * float(plus_avg[i] or 0.0) / tr_avg[i]
        minus_di[i] = 100 * float(minus_avg[i] or 0.0) / tr_avg[i]
        denominator = float(plus_di[i] or 0.0) + float(minus_di[i] or 0.0)
        dx.append(100 * abs(float(plus_di[i] or 0.0) - float(minus_di[i] or 0.0)) / denominator if denominator else 0.0)
    adx_values = sma(dx, period)
    return adx_values, plus_di, minus_di


def _session_vwap(bars: list[dict[str, Any]]) -> list[float | None]:
    output: list[float | None] = [None] * len(bars)
    current_day = None; numerator = denominator = 0.0
    for i, bar in enumerate(bars):
        day = datetime.fromtimestamp(bar["time"], IST).date()
        if day != current_day:
            current_day = day; numerator = denominator = 0.0
        typical = (bar["high"] + bar["low"] + bar["close"]) / 3
        numerator += typical * bar["volume"]; denominator += bar["volume"]
        if denominator > 0:
            output[i] = numerator / denominator
    return output


def _bollinger(values: list[float], period: int, multiplier: float = 2.0) -> tuple[list[float | None], list[float | None], list[float | None]]:
    mid: list[float | None] = [None] * len(values); upper = mid.copy(); lower = mid.copy()
    for i in range(period - 1, len(values)):
        sample = values[i - period + 1:i + 1]
        mean = sum(sample) / period
        deviation = math.sqrt(sum((x - mean) ** 2 for x in sample) / period)
        mid[i] = mean; upper[i] = mean + multiplier * deviation; lower[i] = mean - multiplier * deviation
    return mid, upper, lower


def _supertrend(bars: list[dict[str, Any]], period: int, multiplier: float) -> list[int | None]:
    atr_values = atr(bars, period)
    direction: list[int | None] = [None] * len(bars)
    upper_final: float | None = None; lower_final: float | None = None
    for i, bar in enumerate(bars):
        if atr_values[i] is None:
            continue
        midpoint = (bar["high"] + bar["low"]) / 2
        upper_basic = midpoint + multiplier * float(atr_values[i])
        lower_basic = midpoint - multiplier * float(atr_values[i])
        if upper_final is None or lower_final is None or i == 0:
            upper_final, lower_final = upper_basic, lower_basic
            direction[i] = 1 if bar["close"] >= midpoint else -1
            continue
        prev_close = bars[i - 1]["close"]
        upper_final = upper_basic if upper_basic < upper_final or prev_close > upper_final else upper_final
        lower_final = lower_basic if lower_basic > lower_final or prev_close < lower_final else lower_final
        previous_direction = direction[i - 1] or 1
        if previous_direction < 0 and bar["close"] > upper_final:
            direction[i] = 1
        elif previous_direction > 0 and bar["close"] < lower_final:
            direction[i] = -1
        else:
            direction[i] = previous_direction
    return direction


def _day_minute(bar: dict[str, Any]) -> tuple[str, int]:
    dt = datetime.fromtimestamp(int(bar["time"]), IST)
    return dt.date().isoformat(), dt.hour * 60 + dt.minute


def generate_signals(bars: list[dict[str, Any]], strategy_id: str, settings: dict[str, Any]) -> list[dict[str, Any]]:
    """Return closed-bar signal rows. Each row can only use values through that bar."""
    if strategy_id not in STRATEGIES:
        raise ValueError(f"Unknown strategy: {strategy_id}")
    closes = [x["close"] for x in bars]; highs = [x["high"] for x in bars]; lows = [x["low"] for x in bars]
    volumes = [x["volume"] for x in bars]
    signals: list[dict[str, Any]] = []
    if strategy_id == "orb":
        opening_minutes = max(5, int(settings.get("opening_range_minutes", 15)))
        volume_average = sma(volumes, max(2, int(settings.get("volume_period", 20))))
        day_ranges: dict[str, tuple[float, float]] = {}
        by_day: dict[str, list[int]] = defaultdict(list)
        for i, bar in enumerate(bars):
            day, minute = _day_minute(bar)
            if 9 * 60 + 15 <= minute < 9 * 60 + 15 + opening_minutes:
                old = day_ranges.get(day)
                day_ranges[day] = (min(old[0], bar["low"]), max(old[1], bar["high"])) if old else (bar["low"], bar["high"])
            by_day[day].append(i)
        for day, indices in by_day.items():
            levels = day_ranges.get(day)
            if not levels: continue
            range_low, range_high = levels
            for i in indices:
                _, minute = _day_minute(bars[i])
                if minute < 9 * 60 + 15 + opening_minutes or i == 0 or volume_average[i] is None:
                    continue
                vol_ok = volumes[i] >= float(volume_average[i]) * float(settings.get("volume_multiple", 1.0))
                if vol_ok and closes[i] > range_high and closes[i - 1] <= range_high:
                    signals.append({"index": i, "direction": "BULL"})
                elif vol_ok and closes[i] < range_low and closes[i - 1] >= range_low:
                    signals.append({"index": i, "direction": "BEAR"})
    elif strategy_id == "ema_vwap":
        fast_n = max(2, int(settings.get("fast_ema", 9))); slow_n = max(fast_n + 1, int(settings.get("slow_ema", 21)))
        fast = ema(closes, fast_n); slow = ema(closes, slow_n); vwap = _session_vwap(bars)
        for i in range(1, len(bars)):
            if None in (fast[i - 1], fast[i], slow[i - 1], slow[i], vwap[i]): continue
            if fast[i - 1] <= slow[i - 1] and fast[i] > slow[i] and closes[i] > float(vwap[i]):
                signals.append({"index": i, "direction": "BULL"})
            elif fast[i - 1] >= slow[i - 1] and fast[i] < slow[i] and closes[i] < float(vwap[i]):
                signals.append({"index": i, "direction": "BEAR"})
    elif strategy_id == "supertrend_rsi":
        period = max(2, int(settings.get("supertrend_period", 10)))
        st = _supertrend(bars, period, max(0.5, float(settings.get("supertrend_multiplier", 3.0))))
        momentum = rsi(closes, max(2, int(settings.get("rsi_period", 14))))
        for i in range(1, len(bars)):
            if st[i - 1] is None or st[i] is None or momentum[i] is None: continue
            if st[i - 1] < 0 and st[i] > 0 and momentum[i] >= 50:
                signals.append({"index": i, "direction": "BULL"})
            elif st[i - 1] > 0 and st[i] < 0 and momentum[i] <= 50:
                signals.append({"index": i, "direction": "BEAR"})
    elif strategy_id == "adx_breakout":
        period = max(2, int(settings.get("adx_period", 14)))
        lookback = max(2, int(settings.get("breakout_lookback", 20)))
        adx_values, plus_di, minus_di = adx_components(bars, period)
        for i in range(max(period * 2, lookback), len(bars)):
            prior_high = max(highs[i - lookback:i]); prior_low = min(lows[i - lookback:i])
            if adx_values[i] is None or float(adx_values[i]) < float(settings.get("adx_threshold", 20.0)): continue
            if closes[i] > prior_high and float(plus_di[i] or 0.0) > float(minus_di[i] or 0.0):
                signals.append({"index": i, "direction": "BULL"})
            elif closes[i] < prior_low and float(minus_di[i] or 0.0) > float(plus_di[i] or 0.0):
                signals.append({"index": i, "direction": "BEAR"})
    else:  # volatility expansion
        period = max(5, int(settings.get("bollinger_period", 20)))
        squeeze_lookback = max(3, int(settings.get("squeeze_lookback", 20)))
        mid, upper, lower = _bollinger(closes, period)
        atr_values = atr(bars, max(2, int(settings.get("atr_period", 14))))
        atr_average = sma([x or 0.0 for x in atr_values], max(2, int(settings.get("atr_average_period", 10))))
        widths = [((upper[i] - lower[i]) / mid[i]) if upper[i] is not None and mid[i] else None for i in range(len(bars))]
        for i in range(max(period + squeeze_lookback, 2), len(bars)):
            if widths[i] is None or atr_values[i] is None or atr_average[i] is None or upper[i - 1] is None or lower[i - 1] is None: continue
            prior_widths = [x for x in widths[i - squeeze_lookback:i] if x is not None]
            if not prior_widths or widths[i - 1] > min(prior_widths) * 1.15: continue
            if float(atr_values[i]) < float(atr_average[i]) * float(settings.get("atr_expansion_multiple", 1.1)): continue
            if closes[i] > float(upper[i - 1]): signals.append({"index": i, "direction": "BULL"})
            elif closes[i] < float(lower[i - 1]): signals.append({"index": i, "direction": "BEAR"})
    return sorted(signals, key=lambda x: int(x["index"]))


def normalize_option_contracts(rows: Iterable[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    contracts: dict[str, dict[str, Any]] = {}
    for source in rows:
        try:
            time_value = source.get("time", source.get("timestamp", source.get("datetime")))
            key = str(source.get("instrument_key") or source.get("contract_id") or source.get("trading_symbol") or source.get("symbol") or "").strip()
            option_type = str(source.get("option_type") or source.get("type") or "").upper()
            expiry = str(source.get("expiry") or "")[:10]
            strike = _finite(source.get("strike", source.get("strike_price")))
            lot_size = int(_finite(source.get("lot_size")) or 0)
            if not key or option_type not in {"CE", "PE"} or not expiry or strike is None or lot_size <= 0:
                continue
            contract = contracts.setdefault(key, {
                "instrument_key": key, "symbol": str(source.get("trading_symbol") or source.get("symbol") or key),
                "option_type": option_type, "expiry": expiry, "strike": strike, "lot_size": lot_size,
                "exchange_segment": str(source.get("exchange_segment") or "nse_fo").lower(),
                "underlying": _canonical_underlying(source.get("underlying_symbol") or source.get("underlying")), "candles": []})
            candle_source = dict(source); candle_source["time"] = time_value
            candle = normalize_candles([candle_source])
            if candle:
                contract["candles"].append(candle[0])
        except (ValueError, TypeError, OverflowError):
            continue
    for contract in contracts.values():
        by_time = {x["time"]: x for x in contract["candles"]}
        contract["candles"] = [by_time[x] for x in sorted(by_time)]
        contract["times"] = [x["time"] for x in contract["candles"]]
        contract["atr"] = atr(contract["candles"], 14)
    return contracts


def _fees(segment: str, side: str, quantity: int, price: float) -> float:
    if quantity <= 0 or price <= 0: return 0.0
    try:
        data = calculate_statutory_charges(segment, side, quantity, Decimal(str(price)))
        return float(data.get("total", 0.0) or 0.0)
    except Exception:
        return 0.0


def _candle_session(bar: dict[str, Any]) -> str:
    return datetime.fromtimestamp(int(bar["time"]), IST).date().isoformat()


def _minute_setting(value: Any, default: str) -> int:
    try:
        parsed = dt_time.fromisoformat(str(value or default))
        return parsed.hour * 60 + parsed.minute
    except (TypeError, ValueError):
        parsed = dt_time.fromisoformat(default)
        return parsed.hour * 60 + parsed.minute


def _metric_value(value: Any, definition: dict[str, Any], reason: str | None = None,
                  benchmark_overrides: dict[str, Any] | None = None) -> dict[str, Any]:
    threshold = (benchmark_overrides or {}).get(definition["id"], definition.get("benchmark"))
    if threshold is not None:
        threshold = _finite(threshold)
    if value is None:
        status = "unavailable"
    elif value == "unbounded":
        status = "unbounded: no losing trades in sample"
    elif definition["id"] in {"consecutive_losses", "max_drawdown"} and threshold is not None:
        status = "within benchmark" if value <= threshold else "above benchmark"
    elif definition["id"] == "trade_count" and threshold is not None:
        status = "adequate sample" if value >= threshold else "small sample"
    elif threshold is None:
        status = "unrated"
    else:
        status = "meets benchmark" if (value >= threshold if threshold is not None else False) else ("below benchmark" if threshold is not None else "unrated")
    return {"id": definition["id"], "name": definition["name"], "value": value,
            "unit": definition["unit"], "definition": definition["definition"],
            "formula": definition["formula"], "interpretation": definition.get("interpretation"), "benchmark": threshold,
            "required_fields": definition.get("required_fields", []),
            "calculation_function": definition.get("calculation_function"),
            "data_quality_status": "available" if value is not None else "unavailable",
            "status": status, "unavailable_reason": reason}


def _streaks(trades: list[dict[str, Any]]) -> tuple[int, int, list[dict[str, Any]], list[dict[str, Any]]]:
    best_loss = best_win = run_loss = run_win = 0
    losing_runs: list[dict[str, Any]] = []
    winning_runs: list[dict[str, Any]] = []
    current_loss_pnls: list[float] = []; current_win_pnls: list[float] = []
    for trade in trades:
        pnl = float(trade["net_pnl"])
        if pnl < 0:
            if current_win_pnls:
                winning_runs.append({"length": len(current_win_pnls), "capital_gained": round(sum(current_win_pnls), 2)})
                current_win_pnls = []
            run_loss += 1; run_win = 0; current_loss_pnls.append(pnl)
        elif pnl > 0:
            run_win += 1; best_win = max(best_win, run_win)
            if current_loss_pnls:
                losing_runs.append({"length": len(current_loss_pnls), "capital_lost": round(abs(sum(current_loss_pnls)), 2)})
            current_loss_pnls = []; current_win_pnls.append(pnl); run_loss = 0
        else:
            if current_loss_pnls:
                losing_runs.append({"length": len(current_loss_pnls), "capital_lost": round(abs(sum(current_loss_pnls)), 2)})
            if current_win_pnls:
                winning_runs.append({"length": len(current_win_pnls), "capital_gained": round(sum(current_win_pnls), 2)})
            current_loss_pnls = []; current_win_pnls = []; run_loss = run_win = 0
        best_loss = max(best_loss, run_loss)
    if current_loss_pnls:
        losing_runs.append({"length": len(current_loss_pnls), "capital_lost": round(abs(sum(current_loss_pnls)), 2)})
    if current_win_pnls:
        winning_runs.append({"length": len(current_win_pnls), "capital_gained": round(sum(current_win_pnls), 2)})
    return best_loss, best_win, losing_runs, winning_runs


def _max_drawdown(curve: list[dict[str, Any]], initial_capital: float) -> dict[str, Any]:
    equity = float(initial_capital); peak = equity; peak_time = None
    max_abs = 0.0; max_pct = 0.0; max_duration = 0; underwater_start = None
    current_dd = 0.0; current_dd_pct = 0.0; average_dds = []; recoveries = []
    for point in curve:
        equity = float(point["equity"])
        if equity >= peak:
            if underwater_start is not None:
                try: recoveries.append(max(0, int(point["time"]) - underwater_start))
                except (TypeError, ValueError): pass
                underwater_start = None
            peak = equity; peak_time = point.get("time")
        dd = max(0.0, peak - equity); pct = dd / peak * 100 if peak > 0 else 0.0
        if dd > 0:
            if underwater_start is None:
                try: underwater_start = int(peak_time or point["time"])
                except (TypeError, ValueError): underwater_start = int(point["time"])
            try: duration = int(point["time"]) - underwater_start
            except (TypeError, ValueError): duration = 0
            max_duration = max(max_duration, duration); average_dds.append(dd)
        max_abs = max(max_abs, dd); max_pct = max(max_pct, pct)
        current_dd, current_dd_pct = dd, pct
    return {"max_drawdown_inr": round(max_abs, 2), "max_drawdown_pct": round(max_pct, 3),
            "current_drawdown_inr": round(current_dd, 2), "current_drawdown_pct": round(current_dd_pct, 3),
            "average_drawdown_inr": round(statistics.mean(average_dds), 2) if average_dds else 0.0,
            "longest_underwater_seconds": max_duration,
            "time_to_recovery_seconds": max(recoveries) if recoveries else None,
            "drawdown_curve": [{"time": x["time"], "equity": x["equity"]} for x in curve]}


def _tail_risk(pnls: list[float], initial_capital: float, seed: int = 4307) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for pct in (95, 99):
        if len(pnls) < (20 if pct == 95 else 100):
            out[f"var_{pct}_inr"] = None; out[f"expected_shortfall_{pct}_inr"] = None
            out[f"{pct}_reason"] = f"At least {20 if pct == 95 else 100} trades are required for this historical tail estimate."
            continue
        losses = sorted(max(0.0, -x) for x in pnls)
        tail_count = max(1, math.ceil(len(losses) * (100 - pct) / 100))
        tail = losses[-tail_count:]
        var = tail[0]
        out[f"var_{pct}_inr"] = round(var, 2)
        out[f"expected_shortfall_{pct}_inr"] = round(statistics.mean(tail), 2) if tail else None
    if len(pnls) < 20:
        out["monte_carlo"] = {"available": False, "reason": "At least 20 closed trades are required for a historical resampling estimate."}
    else:
        rng = random.Random(seed); paths = []
        for _ in range(500):
            sample = [pnls[rng.randrange(len(pnls))] for _ in pnls]
            equity = peak = float(initial_capital); dd = 0.0
            for pnl in sample:
                equity += pnl; peak = max(peak, equity); dd = max(dd, (peak - equity) / peak if peak else 0.0)
            paths.append(dd * 100)
        paths.sort()
        out["monte_carlo"] = {"available": True, "method": "500 bootstrap trade order resamples with replacement; assumes future trades resemble this sample.",
                              "median_max_drawdown_pct": round(statistics.median(paths), 2),
                              "p95_max_drawdown_pct": round(paths[int(0.95 * (len(paths) - 1))], 2),
                              "p99_max_drawdown_pct": round(paths[int(0.99 * (len(paths) - 1))], 2)}
    out["risk_of_ruin"] = {"value": None, "reason": "A calibrated losing probability and independent risk distribution are not established for this sample."}
    out["gap_and_liquidity_stress"] = {"value": None, "reason": "Historical candle data lacks executable bid and ask depth for gap and liquidity stress estimates."}
    return out


def _group_metrics(trades: list[dict[str, Any]], key_fn) -> dict[str, Any]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for trade in trades:
        groups[str(key_fn(trade))].append(trade)
    result = {}
    for key, items in sorted(groups.items()):
        wins = [x for x in items if float(x["net_pnl"]) > 0]
        losses = [x for x in items if float(x["net_pnl"]) < 0]
        net_wins = sum(float(x["net_pnl"]) for x in wins); net_losses = abs(sum(float(x["net_pnl"]) for x in losses))
        average_win = statistics.mean(float(x["net_pnl"]) for x in wins) if wins else None
        average_loss = abs(statistics.mean(float(x["net_pnl"]) for x in losses)) if losses else None
        result[key] = {"trades": len(items), "net_pnl": round(sum(float(x["net_pnl"]) for x in items), 2),
                       "win_rate_pct": round(len(wins) / len(items) * 100, 2) if items else None,
                       "profit_factor": round(net_wins / net_losses, 3) if net_losses else ("unbounded" if net_wins else None),
                       "expectancy": round(sum(float(x["net_pnl"]) for x in items) / len(items), 2) if items else None,
                       "average_winner": round(average_win, 2) if average_win is not None else None,
                       "average_loser": round(average_loss, 2) if average_loss is not None else None,
                       "risk_reward": round(average_win / average_loss, 3) if average_win is not None and average_loss else None,
                       "expectancy_r": round(statistics.mean(float(x["r_multiple"]) for x in items if x.get("r_multiple") is not None), 4)
                           if any(x.get("r_multiple") is not None for x in items) else None}
    return result


def _group_average(trades: list[dict[str, Any]], key_fn, field: str) -> dict[str, Any]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for trade in trades:
        groups[str(key_fn(trade))].append(trade)
    return {key: {"trades": len(items), "average": round(statistics.mean(float(x[field]) for x in items), 2),
                  "net_pnl": round(sum(float(x["net_pnl"]) for x in items), 2)}
            for key, items in sorted(groups.items())}


def _expiry_metrics(trades: list[dict[str, Any]], initial_capital: float) -> dict[str, Any]:
    groups = _group_metrics(trades, lambda x: x["expiry"])
    for expiry, result in groups.items():
        equity = peak = float(initial_capital); max_abs = max_pct = 0.0
        for trade in sorted((x for x in trades if str(x["expiry"]) == expiry), key=lambda x: x["exit_time"]):
            equity += float(trade["net_pnl"]); peak = max(peak, equity)
            drawdown = max(0.0, peak - equity)
            max_abs = max(max_abs, drawdown); max_pct = max(max_pct, drawdown / peak * 100 if peak > 0 else 0.0)
        result["max_drawdown_inr"] = round(max_abs, 2)
        result["max_drawdown_pct"] = round(max_pct, 3)
    return groups


def calculate_metrics(trades: list[dict[str, Any]], equity_curve: list[dict[str, Any]],
                      initial_capital: float, session_dates: list[str], settings: dict[str, Any],
                      signal_count: int, skipped_signals: int) -> dict[str, Any]:
    ordered = sorted(trades, key=lambda x: (x["exit_time"], x["entry_time"]))
    pnls = [float(x["net_pnl"]) for x in ordered]
    wins = [x for x in ordered if float(x["net_pnl"]) > 0]
    losses = [x for x in ordered if float(x["net_pnl"]) < 0]
    breakeven = [x for x in ordered if float(x["net_pnl"]) == 0]
    net_profit = sum(pnls); win_total = sum(float(x["net_pnl"]) for x in wins); loss_total = abs(sum(float(x["net_pnl"]) for x in losses))
    gross_profit = sum(max(0.0, float(x["gross_pnl"])) for x in ordered)
    gross_loss = abs(sum(min(0.0, float(x["gross_pnl"])) for x in ordered))
    charges = sum(float(x["charges"]) for x in ordered)
    avg_win = statistics.mean(float(x["net_pnl"]) for x in wins) if wins else None
    avg_loss = abs(statistics.mean(float(x["net_pnl"]) for x in losses)) if losses else None
    expectancy = net_profit / len(ordered) if ordered else None
    reward_risk = avg_win / avg_loss if avg_win is not None and avg_loss else None
    streak_loss, streak_win, losing_streaks, winning_streaks = _streaks(ordered)
    dd = _max_drawdown(sorted(equity_curve, key=lambda x: x["time"]), initial_capital)
    daily_pnl: dict[str, float] = defaultdict(float)
    for trade in ordered:
        daily_pnl[_candle_session({"time": trade["exit_time"]})] += float(trade["net_pnl"])
    daily_returns = []; daily_equity = float(initial_capital)
    daily_rows = []
    for day in sorted(set(session_dates)):
        pnl = daily_pnl.get(day, 0.0); ret = pnl / daily_equity if daily_equity > 0 else 0.0
        daily_returns.append(ret); daily_equity += pnl
        daily_rows.append({"date": day, "trades": sum(1 for x in ordered if _candle_session({"time": x["exit_time"]}) == day),
                           "net_pnl": round(pnl, 2), "return_pct": round(ret * 100, 4), "equity": round(daily_equity, 2)})
    annual_rf = float(settings.get("risk_free_rate_pct", 0.0)) / 100
    daily_rf = (1 + annual_rf) ** (1 / 252) - 1 if annual_rf > -1 else 0.0
    excess_returns = [ret - daily_rf for ret in daily_returns]
    sharpe = None
    if len(excess_returns) >= 2 and statistics.stdev(excess_returns) > 0:
        sharpe = statistics.mean(excess_returns) / statistics.stdev(excess_returns) * math.sqrt(252)
    mar_annual = float(settings.get("minimum_acceptable_return_pct", 0.0)) / 100
    daily_mar = (1 + mar_annual) ** (1 / 252) - 1 if mar_annual > -1 else 0.0
    downside = [min(0.0, ret - daily_mar) for ret in daily_returns]
    downside_dev = math.sqrt(sum(x * x for x in downside) / len(downside)) if downside else 0.0
    sortino = statistics.mean(ret - daily_mar for ret in daily_returns) if daily_returns and downside_dev > 0 else None
    if sortino is not None: sortino = sortino / downside_dev * math.sqrt(252)
    max_dd = float(dd["max_drawdown_inr"])
    session_count = len(set(session_dates)); months = len({x[:7] for x in session_dates})
    days_to_annualize = session_count >= 252
    annualized_return = ((daily_equity / initial_capital) ** (252 / session_count) - 1) * 100 if days_to_annualize and daily_equity > 0 and initial_capital > 0 else None
    core_values: dict[str, tuple[Any, str | None]] = {
        "win_rate": (len(wins) / len(ordered) * 100 if ordered else None, "No closed trades." if not ordered else None),
        "profit_factor": (win_total / loss_total if loss_total else ("unbounded" if win_total else None), "Requires at least one losing trade." if not loss_total else None),
        "expectancy": (expectancy, "No closed trades." if not ordered else None),
        "max_drawdown": (dd["max_drawdown_pct"], "Requires an equity curve." if not equity_curve else None),
        "risk_reward": (reward_risk, "Requires both winning and losing trades." if reward_risk is None else None),
        "sharpe": (round(sharpe, 3) if sharpe is not None else None, "At least two variable daily returns are required." if sharpe is None else None),
        "sortino": (round(sortino, 3) if sortino is not None else None, "Downside deviation is zero or daily return history is too short." if sortino is None else None),
        "recovery_factor": (net_profit / max_dd if max_dd > 0 else None, "Maximum drawdown is zero." if max_dd == 0 else None),
        "average_pnl": (expectancy, "No closed trades." if not ordered else None),
        "consecutive_losses": (streak_loss if ordered else None, "No closed trades." if not ordered else None),
        "return_on_capital": (net_profit / initial_capital * 100 if initial_capital > 0 else None, "Starting capital is unavailable." if initial_capital <= 0 else None),
        "trade_count": (len(ordered), None),
    }
    benchmark_overrides = settings.get("benchmark_overrides", {})
    if not isinstance(benchmark_overrides, dict):
        benchmark_overrides = {}
    metrics = []
    for definition in METRIC_REGISTRY["core"]:
        value, reason = core_values[definition["id"]]
        item = _metric_value(value, definition, reason, benchmark_overrides)
        if definition["id"] == "max_drawdown":
            item["value_inr"] = dd["max_drawdown_inr"]
        metrics.append(item)
    median_pnl = statistics.median(pnls) if pnls else None
    exposure_values = [float(x.get("premium_deployed", 0.0)) for x in ordered]
    option_fields = {}
    for field in OPTION_METRIC_DEFINITIONS:
        entries = [float(x[f"{field}_entry"]) for x in ordered if x.get(f"{field}_entry") is not None]
        exits = [float(x[f"{field}_exit"]) for x in ordered if x.get(f"{field}_exit") is not None]
        observations = entries
        option_fields[field] = {"value": round(statistics.mean(observations), 4) if observations else None,
                                "entry_mean": round(statistics.mean(entries), 4) if entries else None,
                                "exit_mean": round(statistics.mean(exits), 4) if exits else None,
                                "unit": "contract specific", "definition": OPTION_METRIC_DEFINITIONS[field],
                                "status": "available" if observations else "unavailable",
                                "unavailable_reason": None if observations else "The candle source did not provide this contract observation."}
    by_delta = _group_metrics([x for x in ordered if x.get("delta") is not None], lambda x: _delta_bucket(abs(float(x["delta"]))))
    option_fields["pnl_by_delta_bucket"] = by_delta or {"value": None, "status": "unavailable", "unavailable_reason": "Contract delta observations are missing."}
    option_fields["pnl_by_iv_regime"] = _group_metrics([x for x in ordered if x.get("iv_rank") is not None], lambda x: "low IV" if float(x["iv_rank"]) < 30 else ("medium IV" if float(x["iv_rank"]) < 70 else "high IV")) or {"value": None, "status": "unavailable", "unavailable_reason": "Contract specific IV rank observations are missing."}
    iv_change_trades = [x for x in ordered if x.get("iv_entry") is not None and x.get("iv_exit") is not None]
    option_fields["pnl_by_iv_change"] = _group_metrics(iv_change_trades, lambda x: "IV expanded" if float(x["iv_exit"]) - float(x["iv_entry"]) > 0.001 else ("IV contracted" if float(x["iv_exit"]) - float(x["iv_entry"]) < -0.001 else "IV stable")) or {"value": None, "status": "unavailable", "unavailable_reason": "Entry and exit contract IV observations are required."}
    option_fields["pnl_by_iv_percentile_bucket"] = _group_metrics([x for x in ordered if x.get("iv_percentile") is not None], lambda x: "low IV percentile" if float(x["iv_percentile"]) < 30 else ("medium IV percentile" if float(x["iv_percentile"]) < 70 else "high IV percentile")) or {"value": None, "status": "unavailable", "unavailable_reason": "Contract specific IV percentile observations are missing."}
    option_fields["pnl_by_dte"] = _group_metrics([x for x in ordered if x.get("dte_sessions") is not None], lambda x: f"{x['dte_sessions']} sessions")
    option_fields["holding_duration_theta"] = _group_metrics([x for x in ordered if x.get("theta_entry") is not None], lambda x: "under 5 min" if x["holding_minutes"] < 5 else ("5 to 15 min" if x["holding_minutes"] < 15 else "15 min or more"))
    # Contract IV rank is based solely on supplied IV observations; the index VIX is never substituted.
    option_fields["iv_rank_history"] = []
    for trade in ordered:
        if trade.get("iv_rank") is not None:
            option_fields["iv_rank_history"].append({"time": trade["entry_time"], "iv_rank": trade["iv_rank"], "net_pnl": trade["net_pnl"]})
    if not option_fields["iv_rank_history"]:
        option_fields["iv_rank_status"] = {"value": None, "status": "unavailable", "unavailable_reason": "Contract specific historical IV is unavailable."}
    option_fields["iv_lookback_requirement"] = {"sessions": int(settings.get("iv_lookback_sessions", 252)),
                                                  "status": "available" if any(x.get("iv_rank") is not None for x in ordered) else "unavailable",
                                                  "reason": None if any(x.get("iv_rank") is not None for x in ordered) else "A complete contract specific IV lookback was not supplied."}
    session_months = sorted({x[:7] for x in session_dates})
    total_signals = max(0, int(signal_count))
    average_entry_slippage = [float(x["entry_slippage_cost"]) for x in ordered if x.get("entry_slippage_cost") is not None]
    average_exit_slippage = [float(x["exit_slippage_cost"]) for x in ordered if x.get("exit_slippage_cost") is not None]
    execution = {
        "signal_count": total_signals, "filled_trades": len(ordered),
        "simulated_fill_rate_pct": round(len(ordered) / total_signals * 100, 2) if total_signals else None,
        "fill_rate_status": "modelled from supplied OHLC candles; not broker order fills",
        "rejected_orders": {"value": None, "reason": "Historical candle data contains no broker order reports."},
        "partial_fills": {"value": None, "reason": "Historical candle data contains no broker execution reports."},
        "average_signal_to_fill_seconds": round(statistics.mean(float(x.get("signal_to_fill_seconds", 0.0)) for x in ordered), 2) if ordered else None,
        "latency_status": "modelled next available option candle, not measured network latency",
        "average_entry_spread": None if not any(x.get("entry_spread") is not None for x in ordered) else round(statistics.mean(x["entry_spread"] for x in ordered if x.get("entry_spread") is not None), 4),
        "average_exit_spread": None if not any(x.get("exit_spread") is not None for x in ordered) else round(statistics.mean(x["exit_spread"] for x in ordered if x.get("exit_spread") is not None), 4),
        "slippage_cost_inr": round(sum(float(x.get("slippage_cost") or 0.0) for x in ordered), 2) if any(x.get("slippage_cost") is not None for x in ordered) else None,
        "entry_slippage_adverse_cost_inr": round(sum(average_entry_slippage), 2) if average_entry_slippage else None,
        "exit_slippage_adverse_cost_inr": round(sum(average_exit_slippage), 2) if average_exit_slippage else None,
        "average_entry_slippage_inr": round(statistics.mean(average_entry_slippage), 2) if average_entry_slippage else None,
        "average_exit_slippage_inr": round(statistics.mean(average_exit_slippage), 2) if average_exit_slippage else None,
        "slippage_as_pct_of_gross_profit": round(sum(float(x.get("slippage_cost") or 0.0) for x in ordered) / gross_profit * 100, 3) if gross_profit and any(x.get("slippage_cost") is not None for x in ordered) else None,
        "slippage_status": "quote observations used" if any(x.get("slippage_cost") is not None for x in ordered) else "unavailable: bid and ask observations were not supplied",
        "slippage_by_time_of_day": _group_average([x for x in ordered if x.get("slippage_cost") is not None], lambda x: datetime.fromtimestamp(x["entry_time"], IST).strftime("%H") + ":00", "slippage_cost"),
        "slippage_by_liquidity": _group_average([x for x in ordered if x.get("slippage_cost") is not None], lambda x: "high volume" if float(x.get("entry_volume") or 0) >= float(settings.get("liquidity_volume_threshold", 1000)) else "lower volume", "slippage_cost"),
        "average_holding_minutes": round(statistics.mean(float(x.get("holding_minutes", 0.0)) for x in ordered), 2) if ordered else None,
        "average_mfe_inr": round(statistics.mean(float(x.get("mfe_inr", 0.0)) for x in ordered), 2) if ordered else None,
        "average_mae_inr": round(statistics.mean(float(x.get("mae_inr", 0.0)) for x in ordered), 2) if ordered else None,
        "profit_capture_ratio_pct": round(sum(float(x["gross_pnl"]) for x in ordered) / sum(float(x.get("mfe_inr", 0.0)) for x in ordered) * 100, 2) if sum(float(x.get("mfe_inr", 0.0)) for x in ordered) > 0 else None,
        "exit_reason_counts": dict(Counter(x.get("exit_reason", "UNKNOWN") for x in ordered)),
        "mfe_mae_scatter": [{"mfe_inr": x.get("mfe_inr"), "mae_inr": x.get("mae_inr"), "realized_net_pnl": x.get("net_pnl")} for x in ordered],
        "transaction_cost_per_trade": round(charges / len(ordered), 2) if ordered else None,
        "total_transaction_cost": round(charges, 2),
        "net_to_gross_profit_ratio": round(net_profit / gross_profit, 4) if gross_profit else None,
        "skipped_signals": int(skipped_signals),
    }
    monthly_groups = _group_metrics(ordered, lambda x: datetime.fromtimestamp(x["exit_time"], IST).strftime("%Y-%m"))
    daily_by_month: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in daily_rows:
        daily_by_month[row["date"][:7]].append(row)
    for month, row in monthly_groups.items():
        rows = daily_by_month.get(month, [])
        month_start_equity = rows[0]["equity"] - rows[0]["net_pnl"] if rows else None
        row["return_on_allocated_capital_pct"] = round(row["net_pnl"] / initial_capital * 100, 4) if initial_capital else None
        row["monthly_return_pct"] = round(row["net_pnl"] / month_start_equity * 100, 4) if month_start_equity else None
        row["sessions"] = len(rows)
    rolling_window = min(20, len(ordered))
    rolling_expectancy = []
    rolling_profit_factor = []
    rolling_sharpe = []; rolling_sortino = []
    if rolling_window:
        for i in range(rolling_window - 1, len(ordered)):
            sample = ordered[i - rolling_window + 1:i + 1]
            rolling_expectancy.append({"time": sample[-1]["exit_time"], "trades": rolling_window,
                                       "expectancy": round(statistics.mean(float(x["net_pnl"]) for x in sample), 2)})
            rolling_wins = sum(float(x["net_pnl"]) for x in sample if float(x["net_pnl"]) > 0)
            rolling_losses = abs(sum(float(x["net_pnl"]) for x in sample if float(x["net_pnl"]) < 0))
            rolling_profit_factor.append({"time": sample[-1]["exit_time"], "trades": rolling_window,
                                          "profit_factor": round(rolling_wins / rolling_losses, 3) if rolling_losses else ("unbounded" if rolling_wins else None)})
    daily_window = min(20, len(daily_returns))
    if daily_window >= 2:
        for i in range(daily_window - 1, len(daily_returns)):
            sample = daily_returns[i - daily_window + 1:i + 1]
            excess = [x - daily_rf for x in sample]
            std = statistics.stdev(excess)
            if std > 0:
                rolling_sharpe.append({"date": daily_rows[i]["date"], "sessions": daily_window,
                                       "value": round(statistics.mean(excess) / std * math.sqrt(252), 3)})
            downside_sample = [min(0.0, x - daily_mar) for x in sample]
            downside_std = math.sqrt(sum(x * x for x in downside_sample) / len(downside_sample))
            if downside_std > 0:
                rolling_sortino.append({"date": daily_rows[i]["date"], "sessions": daily_window,
                                        "value": round(statistics.mean(x - daily_mar for x in sample) / downside_std * math.sqrt(252), 3)})
    losing_streak_frequency = len(losing_streaks) / session_count if session_count else None
    worst_month = min((float(x["net_pnl"]) for x in monthly_groups.values()), default=0.0)
    worst_trade = min(pnls, default=0.0)
    extreme_threshold = max(0.0, initial_capital * float(settings.get("extreme_loss_threshold_pct", 1.0)) / 100)
    extreme_loss_count = sum(1 for pnl in pnls if pnl <= -extreme_threshold) if extreme_threshold else 0
    slippage_stress = {}
    for bps in (0, 5, 10, 25):
        extra_cost = sum(float(x.get("premium_deployed", 0.0)) * 2 * bps / 10000 for x in ordered)
        stressed_net = net_profit - extra_cost
        slippage_stress[f"{bps}_bps"] = {"net_pnl": round(stressed_net, 2),
                                          "return_on_allocated_capital_pct": round(stressed_net / initial_capital * 100, 3) if initial_capital else None,
                                          "assumption": "Additional round-turn cost applied to premium notional; scenario only, not observed execution."}
    transaction_cost_stress = {}
    for multiplier in (0.5, 1.0, 1.5, 2.0):
        stressed_net = net_profit - charges * (multiplier - 1.0)
        transaction_cost_stress[f"{multiplier:.1f}x"] = {"net_pnl": round(stressed_net, 2),
                                                         "return_on_allocated_capital_pct": round(stressed_net / initial_capital * 100, 3) if initial_capital else None,
                                                         "assumption": "Current modeled statutory charges scaled as a sensitivity scenario."}
    greeks_by_dte = {}
    for field in ("delta", "theta", "vega", "gamma"):
        groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for trade in ordered:
            if trade.get(f"{field}_entry") is not None and trade.get("dte_sessions") is not None:
                groups[f"{trade['dte_sessions']} sessions"].append(trade)
        greeks_by_dte[field] = {key: {"trades": len(items), "entry_mean": round(statistics.mean(float(x[f"{field}_entry"]) for x in items), 4),
                                           "exit_mean": round(statistics.mean([float(x[f"{field}_exit"]) for x in items if x.get(f"{field}_exit") is not None]), 4)
                                               if any(x.get(f"{field}_exit") is not None for x in items) else None,
                                           "net_pnl": round(sum(float(x["net_pnl"]) for x in items), 2)}
                                  for key, items in sorted(groups.items())}
    greeks_by_option_type = {}
    for kind in ("CE", "PE"):
        items = [x for x in ordered if x["option_type"] == kind]
        greeks_by_option_type[kind] = {field: {"entry_mean": round(statistics.mean(float(x[f"{field}_entry"]) for x in items if x.get(f"{field}_entry") is not None), 4)
                                                            if any(x.get(f"{field}_entry") is not None for x in items) else None,
                                              "exit_mean": round(statistics.mean(float(x[f"{field}_exit"]) for x in items if x.get(f"{field}_exit") is not None), 4)
                                                            if any(x.get(f"{field}_exit") is not None for x in items) else None}
                                           for field in ("delta", "theta", "vega", "gamma")}
    return {
        "summary": {"net_pnl": round(net_profit, 2), "gross_profit": round(gross_profit, 2), "gross_loss": round(gross_loss, 2),
                    "charges": round(charges, 2), "allocated_capital": round(initial_capital, 2),
                    "return_on_capital_pct": round(net_profit / initial_capital * 100, 3) if initial_capital else None,
                    "expectancy_pct_of_allocated_capital": round(expectancy / initial_capital * 100, 5) if expectancy is not None and initial_capital else None,
                    "expectancy_r": round(statistics.mean(float(x["r_multiple"]) for x in ordered if x.get("r_multiple") is not None), 4)
                        if any(x.get("r_multiple") is not None for x in ordered) else None,
                    "total_trades": len(ordered), "winning_trades": len(wins), "losing_trades": len(losses),
                    "breakeven_trades": len(breakeven), "average_winner": round(avg_win, 2) if avg_win is not None else None,
                    "average_loser": round(avg_loss, 2) if avg_loss is not None else None,
                    "median_trade_pnl": round(median_pnl, 2) if median_pnl is not None else None,
                    "average_pnl_per_lot": round(expectancy / statistics.mean([x["lots"] for x in ordered]), 2) if ordered and statistics.mean([x["lots"] for x in ordered]) else None,
                    "average_daily_pnl": round(net_profit / session_count, 2) if session_count else None,
                    "average_monthly_pnl": round(net_profit / months, 2) if months else None,
                    "annualized_return_pct": round(annualized_return, 2) if annualized_return is not None else None,
                    "annualized_return_reason": None if annualized_return is not None else "At least 252 observed trading sessions are required.",
                    "maximum_consecutive_losses": streak_loss, "maximum_consecutive_wins": streak_win,
                    "average_losing_streak": round(statistics.mean(x["length"] for x in losing_streaks), 2) if losing_streaks else 0.0,
                    "average_winning_streak": round(statistics.mean(x["length"] for x in winning_streaks), 2) if winning_streaks else 0.0,
                    "losing_streak_frequency_per_session": round(losing_streak_frequency, 4) if losing_streak_frequency is not None else None,
                    "worst_streak_capital_lost": max((x["capital_lost"] for x in losing_streaks), default=0.0),
                    "trade_count_by_option_type": {kind: sum(x["option_type"] == kind for x in ordered) for kind in ("CE", "PE")},
                    "trade_count_by_day_type": {kind: sum(x["day_type"] == kind for x in ordered) for kind in ("1DTE", "EXPIRY", "OTHER")},
                    "capital_required_peak_premium": round(max(exposure_values, default=0.0), 2),
                    "capital_required_average_premium": round(statistics.mean(exposure_values), 2) if exposure_values else None,
                    "total_premium_paid": round(sum(
                        float(x.get("entry_price", 0.0)) * int(x.get("quantity", 0))
                        for x in ordered
                    ), 2),
                    "capital_utilization_pct": round(max(exposure_values, default=0.0) / initial_capital * 100, 3) if initial_capital else None,
                    "average_capital_utilization_pct": round(statistics.mean(exposure_values) / initial_capital * 100, 3) if exposure_values and initial_capital else None,
                    "available_capital_at_end": round(initial_capital + net_profit, 2),
                    "planned_risk_reward": round(float(settings.get("target_r", 2.25)), 3),
                    "return_to_drawdown": round(net_profit / max_dd, 3) if max_dd else None,
                    "return_on_peak_premium_deployed_pct": round(net_profit / max(exposure_values) * 100, 3) if exposure_values and max(exposure_values) else None,
                    "data_quality": {"sessions": session_count, "closed_trades": len(ordered), "small_sample_warning": len(ordered) < 100}},
        "metrics": metrics,
        "drawdown": dd,
        "daily": daily_rows,
        "monthly": monthly_groups,
        "by_option_type": _group_metrics(ordered, lambda x: x["option_type"]),
        "by_option_type_risk": {kind: {"trades": len(items), "net_pnl": round(sum(float(x["net_pnl"]) for x in items), 2),
                                        "win_rate_pct": round(sum(float(x["net_pnl"]) > 0 for x in items) / len(items) * 100, 2),
                                        "risk_reward": (statistics.mean(float(x["net_pnl"]) for x in items if float(x["net_pnl"]) > 0) /
                                                        abs(statistics.mean(float(x["net_pnl"]) for x in items if float(x["net_pnl"]) < 0)))
                                            if any(float(x["net_pnl"]) > 0 for x in items) and any(float(x["net_pnl"]) < 0 for x in items) else None}
                                 for kind in ("CE", "PE") if (items := [x for x in ordered if x["option_type"] == kind])},
        "by_day_type": _group_metrics(ordered, lambda x: x["day_type"]),
        "by_expiry": _expiry_metrics(ordered, initial_capital),
        "by_time_of_day": _group_metrics(ordered, lambda x: datetime.fromtimestamp(x["entry_time"], IST).strftime("%H") + ":00"),
        "by_dte": _group_metrics(ordered, lambda x: str(x.get("dte_calendar")) if x.get("dte_calendar") is not None else "N/A"),
        "greeks_by_dte": greeks_by_dte,
        "greeks_by_option_type": greeks_by_option_type,
        "options_metrics": option_fields,
        "execution_metrics": execution,
        "tail_risk": {**_tail_risk(pnls, initial_capital),
                      "worst_trade_loss_inr": round(worst_trade, 2), "worst_month_loss_inr": round(worst_month, 2),
                      "extreme_loss_threshold_inr": round(extreme_threshold, 2), "extreme_loss_count": extreme_loss_count,
                      "extreme_loss_frequency_pct": round(extreme_loss_count / len(ordered) * 100, 2) if ordered else None},
        "slippage_stress": slippage_stress,
        "transaction_cost_stress": transaction_cost_stress,
        "rolling_expectancy": rolling_expectancy,
        "rolling_profit_factor": rolling_profit_factor,
        "rolling_sharpe": rolling_sharpe,
        "rolling_sortino": rolling_sortino,
        "losing_streaks": losing_streaks,
        "winning_streaks": winning_streaks,
        "r_multiples": [round(float(x["r_multiple"]), 4) for x in ordered],
        "trades": ordered,
        "equity_curve": sorted(equity_curve, key=lambda x: x["time"]),
    }


def _delta_bucket(delta: float) -> str:
    for low, high in ((0.2, 0.3), (0.3, 0.4), (0.4, 0.5), (0.5, 0.6)):
        if low <= delta < high: return f"{low:.1f}–{high:.1f}"
    return "outside requested buckets"


def _select_expiry_for_day(expiries: list[str], day: str, session_days: list[str], mode: str) -> tuple[str | None, str | None]:
    if mode not in {"both", "expiry", "1dte"}:
        mode = "both"
    ordered = sorted(set(expiries))
    if day in ordered:
        return (day, "EXPIRY") if mode in {"both", "expiry"} else (None, None)
    if mode == "expiry": return None, None
    for expiry in ordered:
        prior = [x for x in session_days if x < expiry]
        if prior and prior[-1] == day:
            return expiry, "1DTE"
    return (None, None) if mode in {"both", "1dte"} else (None, "OTHER")


def _entry_observation(contract: dict[str, Any], index: int, field: str) -> float | None:
    current = contract["candles"][index]
    opening_value = current.get(f"{field}_open")
    if opening_value is not None:
        return float(opening_value)
    if index <= 0:
        return None
    # Candle level indicators and Greeks are close observations. Use the prior
    # completed bar at an opening fill to avoid within-bar information leakage.
    return _finite(contract["candles"][index - 1].get(field))


def _contract_iv_rank(contract: dict[str, Any], cutoff: int, lookback_sessions: int) -> tuple[float | None, float | None, int]:
    daily: dict[str, float] = {}
    for bar in contract["candles"]:
        if int(bar["time"]) >= cutoff:
            break
        iv_value = _finite(bar.get("iv_close", bar.get("iv")))
        if iv_value is not None:
            daily[_candle_session(bar)] = iv_value
    series = [daily[key] for key in sorted(daily)][-lookback_sessions:]
    if len(series) < lookback_sessions or len(series) < 2:
        return None, None, len(series)
    current = series[-1]
    history = series[:-1]
    low = min(history); high = max(history)
    rank = (current - low) / (high - low) * 100 if high > low else None
    percentile = sum(value < current for value in history) / len(history) * 100 if history else None
    return (round(rank, 2) if rank is not None else None,
            round(percentile, 2) if percentile is not None else None, len(series))


def _select_option_contract(candidates: list[dict[str, Any]], spot: float, option_type: str,
                            signal_time: int, settings: dict[str, Any]) -> dict[str, Any] | None:
    if not candidates:
        return None
    mode = str(settings.get("strike_selection", "atm")).strip().lower()
    strikes = sorted({float(x["strike"]) for x in candidates})
    atm = min(strikes, key=lambda x: abs(x - spot))
    if mode == "delta":
        target = max(0.01, min(0.99, float(settings.get("target_delta", 0.5))))
        observed = []
        for contract in candidates:
            prior_index = bisect.bisect_left(contract["times"], signal_time) - 1
            if prior_index < 0: continue
            candle = contract["candles"][prior_index]
            delta = _finite(candle.get("delta_close", candle.get("delta")))
            if delta is not None:
                observed.append((abs(abs(delta) - target), contract))
        return min(observed, key=lambda item: item[0])[1] if observed else None
    offset_map = {"atm": 0, "itm1": -1 if option_type == "CE" else 1,
                  "itm2": -2 if option_type == "CE" else 2,
                  "otm1": 1 if option_type == "CE" else -1,
                  "otm2": 2 if option_type == "CE" else -2}
    offset = offset_map.get(mode, 0)
    atm_index = min(range(len(strikes)), key=lambda index: abs(strikes[index] - atm))
    selected_index = max(0, min(len(strikes) - 1, atm_index + offset))
    selected_strike = strikes[selected_index]
    exact = [x for x in candidates if float(x["strike"]) == selected_strike]
    return min(exact, key=lambda x: abs(float(x["strike"]) - spot)) if exact else None


def run_strategy_backtest(
    strategy_id: str,
    underlying_rows: list[dict[str, Any]],
    option_rows: list[dict[str, Any]],
    settings: dict[str, Any] | None = None,
    allowed_dates: set[str] | None = None,
) -> dict[str, Any]:
    """Simulate long CE/PE trades on actual option OHLC candles for one strategy."""
    if strategy_id not in STRATEGIES: raise ValueError(f"Unknown strategy: {strategy_id}")
    config = dict(settings or {})
    timeframe = int(config.get("timeframe_minutes", 5))
    if timeframe not in {1, 5}: raise ValueError("Timeframe must be 1 or 5 minutes.")
    underlying = aggregate_candles(normalize_candles(underlying_rows), timeframe)
    contracts = normalize_option_contracts(option_rows)
    if len(underlying) < 30: raise ValueError("At least 30 valid underlying bars are required after timeframe aggregation.")
    if not contracts: raise ValueError("No valid exact option contract candles were supplied.")
    signals = generate_signals(underlying, strategy_id, config)
    session_days = sorted({_candle_session(x) for x in underlying})
    expiries = sorted({x["expiry"] for x in contracts.values()})
    option_index = {key: contract["times"] for key, contract in contracts.items()}
    initial_capital = max(1.0, float(config.get("initial_capital", 1_000_000)))
    risk_pct = max(0.01, min(10.0, float(config.get("risk_pct_per_trade", 0.5))))
    max_lots = max(1, min(1000, int(config.get("max_lots", 2))))
    rr_target = max(0.25, min(20.0, float(config.get("target_r", 2.25))))
    stop_multiple = max(0.1, min(10.0, float(config.get("stop_atr_multiple", 1.0))))
    trail_at_r = max(0.0, min(10.0, float(config.get("trail_after_r", 1.0))))
    dte_mode = str(config.get("expiry_mode", "both")).lower()
    max_daily_loss = initial_capital * max(0.1, min(50.0, float(config.get("max_daily_loss_pct", 10)))) / 100
    max_drawdown_pct = max(0.1, min(90.0, float(config.get("max_drawdown_pct", 30))))
    max_consecutive_losses = max(1, min(20, int(config.get("max_consecutive_losses", 3))))
    loss_window = max(60, min(86400, int(config.get("loss_streak_window_seconds", 1800))))
    entry_start_minute = _minute_setting(config.get("entry_start_time"), "09:20")
    entry_end_minute = _minute_setting(config.get("entry_end_time"), "15:25")
    square_off_minute = _minute_setting(config.get("square_off_time"), "15:29")
    underlying_filter = _canonical_underlying(config.get("underlying_symbol"))
    capital = initial_capital; peak_equity = capital; trades = []; curve = []; signal_count = 0; skipped = 0
    daily_net: dict[str, float] = defaultdict(float); daily_halts: dict[str, str] = {}
    last_exit_timestamp = -1; halt = None
    underlying_close = [x["close"] for x in underlying]
    all_session_dates = sorted({_candle_session(x) for x in underlying})
    session_dates = sorted(day for day in all_session_dates if allowed_dates is None or day in allowed_dates)
    for signal in signals:
        signal_bar = underlying[int(signal["index"])]
        signal_time = int(signal_bar.get("end_time", signal_bar["time"] + timeframe * 60))
        signal_day = _candle_session(signal_bar)
        if allowed_dates is not None and signal_day not in allowed_dates: continue
        local_signal = datetime.fromtimestamp(signal_time, IST)
        signal_minute = local_signal.hour * 60 + local_signal.minute
        if signal_minute < entry_start_minute or signal_minute > entry_end_minute:
            continue
        signal_count += 1
        if halt: skipped += 1; continue
        if signal_day in daily_halts: skipped += 1; continue
        if signal_time <= last_exit_timestamp: skipped += 1; continue
        expiry, day_type = _select_expiry_for_day(expiries, signal_day, all_session_dates, dte_mode)
        if not expiry: skipped += 1; continue
        direction = signal["direction"]; option_type = "CE" if direction == "BULL" else "PE"
        candidates = [x for x in contracts.values() if x["expiry"] == expiry and x["option_type"] == option_type
                      and (not underlying_filter or not x.get("underlying") or x.get("underlying") == underlying_filter)]
        if not candidates: skipped += 1; continue
        spot = float(signal_bar["close"])
        candidate = _select_option_contract(candidates, spot, option_type, signal_time, config)
        if candidate is None: skipped += 1; continue
        timestamps = option_index[candidate["instrument_key"]]
        fill_threshold = signal_time
        entry_idx = bisect.bisect_left(timestamps, fill_threshold)
        if entry_idx >= len(timestamps): skipped += 1; continue
        entry_bar = candidate["candles"][entry_idx]
        if _candle_session(entry_bar) != signal_day: skipped += 1; continue
        # Current minute open quote fields are used when available; otherwise candle open is the explicit fill proxy.
        entry_reference = float(entry_bar["open"])
        entry = float(entry_bar.get("ask_open", entry_reference))
        premium_atr = candidate["atr"][entry_idx - 1] if entry_idx > 0 else None
        if premium_atr is None or premium_atr <= 0 or entry <= 0: skipped += 1; continue
        risk = float(premium_atr) * stop_multiple
        initial_stop = entry - risk
        if initial_stop <= 0 or initial_stop >= entry: skipped += 1; continue
        lot_size = int(candidate["lot_size"])
        segment = candidate.get("exchange_segment", "bse_fo" if candidate["instrument_key"].startswith("BSE_FO|") else "nse_fo")
        risk_budget = capital * risk_pct / 100
        premium_and_fee_per_lot = entry * lot_size + _fees(segment, "BUY", lot_size, entry)
        affordable_lots = int(max(0.0, capital) // premium_and_fee_per_lot) if premium_and_fee_per_lot > 0 else 0
        lots = min(max_lots, affordable_lots, int(risk_budget // (risk * lot_size)))
        if lots < 1: skipped += 1; continue
        quantity = lots * lot_size
        entry_charges = _fees(segment, "BUY", quantity, entry)
        stop = initial_stop; target = entry + risk * rr_target; trail_stop = stop
        partial_exit = None; exit_bar = entry_bar; exit_price = None; reason = "EOD_EXIT"
        mfe = 0.0; mae = 0.0; highwater = entry; exit_idx = entry_idx
        signal_timestamp = signal_time
        for j in range(entry_idx, len(timestamps)):
            bar = candidate["candles"][j]; bar_day = _candle_session(bar)
            if bar_day != signal_day: break
            exit_idx = j; exit_bar = bar
            if bar["time"] < signal_time: continue
            high = float(bar["high"]); low = float(bar["low"])
            mfe = max(mfe, high - entry); mae = max(mae, entry - low)
            local_bar = datetime.fromtimestamp(bar["time"], IST)
            if local_bar.hour * 60 + local_bar.minute >= square_off_minute:
                exit_price = float(bar.get("bid_close", bar["close"]))
                reason = "EOD_EXIT"; break
            # If both levels occur inside one candle, the stop is conservatively first.
            if low <= stop:
                base_exit = min(float(bar["open"]), stop) if float(bar["open"]) < stop else stop
                exit_price = max(0.0, base_exit); reason = "TRAILING_STOP" if stop > initial_stop else "STOP_LOSS"; break
            if high >= target:
                exit_price = target; reason = "TARGET"; break
            mark = float(bar["close"])
            mark_equity = capital + (mark - entry) * quantity - entry_charges
            high_equity = capital + (high - entry) * quantity - entry_charges
            low_equity = capital + (low - entry) * quantity - entry_charges
            # OHLC does not reveal the order of the high and low. Applying the
            # high before the low gives a conservative intrabar drawdown path.
            curve.append({"time": int(bar["time"]) + 10, "equity": round(high_equity, 2), "type": "mark_high"})
            curve.append({"time": int(bar["time"]) + 20, "equity": round(low_equity, 2), "type": "mark_low"})
            curve.append({"time": int(bar["time"]) + 30, "equity": round(mark_equity, 2), "type": "mark_close"})
            peak_equity = max(peak_equity, high_equity)
            if peak_equity > 0 and (peak_equity - low_equity) / peak_equity >= max_drawdown_pct / 100:
                halt = "MAX_DRAWDOWN"
                exit_price = mark; reason = "MAX_DRAWDOWN"; break
            floating_day_pnl = daily_net.get(signal_day, 0.0) + (mark - entry) * quantity - entry_charges
            if floating_day_pnl <= -max_daily_loss:
                daily_halts[signal_day] = "MAX_DAILY_LOSS"
                exit_price = mark; reason = "MAX_DAILY_LOSS"; break
            if mfe >= risk * trail_at_r and trail_at_r > 0:
                highwater = max(highwater, high)
                trail_stop = max(trail_stop, highwater - risk)
            stop = max(stop, trail_stop)
        if exit_price is None:
            exit_price = float(exit_bar.get("bid_close", exit_bar["close"]))
            reason = "EOD_EXIT"
        exit_charges = _fees(segment, "SELL", quantity, exit_price)
        gross = (exit_price - entry) * quantity
        fees = entry_charges + exit_charges
        net = gross - fees
        exit_time = int(exit_bar.get("time", 0)) + 60
        capital += net; peak_equity = max(peak_equity, capital)
        curve.append({"time": exit_time, "equity": round(capital, 2), "type": "realized"})
        daily_net[signal_day] += net
        try: dte_calendar = (date.fromisoformat(expiry) - date.fromisoformat(signal_day)).days
        except ValueError: dte_calendar = None
        try:
            dte_sessions = all_session_dates.index(expiry) - all_session_dates.index(signal_day) if expiry in all_session_dates and signal_day in all_session_dates else None
        except ValueError:
            dte_sessions = None
        entry_mid = None
        if entry_bar.get("ask_open") is not None and entry_bar.get("bid_open") is not None:
            entry_mid = (float(entry_bar["ask_open"]) + float(entry_bar["bid_open"])) / 2
        exit_mid = None
        if exit_bar.get("ask_close") is not None and exit_bar.get("bid_close") is not None:
            exit_mid = (float(exit_bar["ask_close"]) + float(exit_bar["bid_close"])) / 2
        slippage = None
        entry_slippage_signed = None; exit_slippage_signed = None
        entry_slippage_cost = None; exit_slippage_cost = None
        if entry_mid is not None:
            entry_slippage_signed = entry - entry_mid
            entry_slippage_cost = max(0.0, entry_slippage_signed * quantity)
        if exit_mid is not None:
            exit_slippage_signed = exit_mid - exit_price
            exit_slippage_cost = max(0.0, exit_slippage_signed * quantity)
        if entry_slippage_cost is not None or exit_slippage_cost is not None:
            slippage = (entry_slippage_cost or 0.0) + (exit_slippage_cost or 0.0)
        def optional(field: str, source: dict[str, Any]) -> float | None:
            return _finite(source.get(field))
        entry_observation = {field: _entry_observation(candidate, entry_idx, field) for field in ("delta", "theta", "vega", "gamma", "iv", "iv_rank", "iv_percentile")}
        iv_lookback = max(2, min(2520, int(config.get("iv_lookback_sessions", 252))))
        if entry_observation["iv_rank"] is None or entry_observation["iv_percentile"] is None:
            calculated_rank, calculated_percentile, iv_sample = _contract_iv_rank(candidate, int(entry_bar["time"]), iv_lookback)
            if entry_observation["iv_rank"] is None: entry_observation["iv_rank"] = calculated_rank
            if entry_observation["iv_percentile"] is None: entry_observation["iv_percentile"] = calculated_percentile
        else:
            iv_sample = iv_lookback
        exit_observation = {}
        for field in ("delta", "theta", "vega", "gamma", "iv", "iv_rank", "iv_percentile"):
            explicit = exit_bar.get(f"{field}_at_fill")
            if explicit is not None:
                exit_observation[field] = float(explicit)
            elif reason == "EOD_EXIT":
                exit_observation[field] = _finite(exit_bar.get(f"{field}_close", exit_bar.get(field)))
            else:
                exit_observation[field] = None
        trade = {
            "strategy_id": strategy_id, "direction": direction, "option_type": option_type,
            "symbol": candidate["symbol"], "instrument_key": candidate["instrument_key"],
            "strike": float(candidate["strike"]), "expiry": expiry, "day_type": day_type,
            "dte_calendar": dte_calendar, "dte_sessions": dte_sessions, "entry_time": int(entry_bar["time"]), "exit_time": exit_time,
            "signal_time": signal_timestamp, "entry_price": round(entry, 4), "exit_price": round(exit_price, 4),
            "initial_stop": round(initial_stop, 4), "final_stop": round(stop, 4), "target": round(target, 4),
            "lots": lots, "lot_size": lot_size, "quantity": quantity,
            "risk_cash": round(risk * quantity, 2), "gross_pnl": round(gross, 2), "charges": round(fees, 2),
            "net_pnl": round(net, 2), "r_multiple": round(net / (risk * quantity), 4) if risk * quantity else None,
            "exit_reason": reason, "holding_minutes": max(1, round((exit_time - int(entry_bar["time"])) / 60, 2)),
            "mfe_inr": round(mfe * quantity, 2), "mae_inr": round(mae * quantity, 2),
            "profit_capture_ratio": round(gross / (mfe * quantity), 4) if mfe > 0 else None,
            "premium_deployed": round(entry * quantity + entry_charges, 2),
            "entry_volume": float(entry_bar.get("volume", 0.0)),
            "entry_open_interest": _finite(entry_bar.get("open_interest")),
            "signal_to_fill_seconds": max(0, int(entry_bar["time"]) - signal_timestamp),
            "entry_spread": round(float(entry_bar["ask_open"]) - float(entry_bar["bid_open"]), 4) if entry_bar.get("ask_open") is not None and entry_bar.get("bid_open") is not None else None,
            "exit_spread": round(float(exit_bar["ask_close"]) - float(exit_bar["bid_close"]), 4) if exit_bar.get("ask_close") is not None and exit_bar.get("bid_close") is not None else None,
            "entry_slippage_signed_per_unit": round(entry_slippage_signed, 4) if entry_slippage_signed is not None else None,
            "exit_slippage_signed_per_unit": round(exit_slippage_signed, 4) if exit_slippage_signed is not None else None,
            "entry_slippage_cost": round(entry_slippage_cost, 2) if entry_slippage_cost is not None else None,
            "exit_slippage_cost": round(exit_slippage_cost, 2) if exit_slippage_cost is not None else None,
            "slippage_cost": round(slippage, 2) if slippage is not None else None,
            "delta": entry_observation["delta"], "theta": entry_observation["theta"],
            "vega": entry_observation["vega"], "gamma": entry_observation["gamma"],
            "iv": entry_observation["iv"], "iv_rank": entry_observation["iv_rank"],
            "iv_percentile": entry_observation["iv_percentile"], "iv_lookback_observations": iv_sample,
            **{f"{field}_entry": entry_observation[field] for field in entry_observation},
            **{f"{field}_exit": exit_observation[field] for field in exit_observation},
        }
        trades.append(trade); last_exit_timestamp = exit_time
        if daily_net.get(signal_day, 0.0) <= -max_daily_loss:
            daily_halts[signal_day] = "MAX_DAILY_LOSS"
        day_trades = [x for x in trades if _candle_session({"time": x["entry_time"]}) == signal_day]
        if len(day_trades) >= max_consecutive_losses:
            last_streak = day_trades[-max_consecutive_losses:]
            if all(float(x["net_pnl"]) < 0 for x in last_streak) and last_streak[-1]["exit_time"] - last_streak[0]["exit_time"] <= loss_window:
                daily_halts[signal_day] = "LOSS_STREAK"
        if halt: break
    selected_date_set = set(session_dates)
    metrics = calculate_metrics(trades, curve, initial_capital, session_dates, config, signal_count, skipped)
    return {"strategy_id": strategy_id, "strategy": STRATEGIES[strategy_id], "settings": config,
            "data_quality": {"underlying_rows": len(underlying_rows), "valid_underlying_bars": len(underlying),
                             "option_contracts": len(contracts), "option_rows": sum(len(x["candles"]) for x in contracts.values()),
                             "session_count": len(session_dates), "session_count_available": len(all_session_dates), "contract_count": len(contracts),
                             "missing_option_signals": skipped,
                             "data_range_start": datetime.fromtimestamp(next((x["time"] for x in underlying if _candle_session(x) in selected_date_set), underlying[0]["time"]), IST).isoformat(),
                             "data_range_end": datetime.fromtimestamp(next((x["time"] for x in reversed(underlying) if _candle_session(x) in selected_date_set), underlying[-1]["time"]), IST).isoformat(),
                             "source": str(config.get("data_source", "user supplied; verify against broker source")),
                             "fill_assumption": "next available option candle open after confirmed underlying signal; no invented premium"},
            "risk_halt_reason": halt, **metrics}


def run_comparison(underlying_rows: list[dict[str, Any]], option_rows: list[dict[str, Any]],
                   settings: dict[str, Any] | None = None, strategy_ids: list[str] | None = None) -> dict[str, Any]:
    config = dict(settings or {})
    requested = strategy_ids or list(STRATEGIES)
    unknown = [key for key in requested if key not in STRATEGIES]
    if unknown: raise ValueError(f"Unknown strategy ids: {', '.join(unknown)}")
    normalized_underlying = aggregate_candles(normalize_candles(underlying_rows), int(config.get("timeframe_minutes", 5)))
    dates = sorted({_candle_session(x) for x in normalized_underlying})
    split = max(1, min(len(dates) - 1, int(len(dates) * 0.7))) if len(dates) >= 2 else 0
    train_dates = set(dates[:split]); test_dates = set(dates[split:])
    results = []
    for strategy_id in requested:
        full = run_strategy_backtest(strategy_id, underlying_rows, option_rows, config)
        if split > 0:
            full["validation"] = {
                "method": "chronological 70/30 session split; indicators warm up on full history, orders restricted to each split",
                "in_sample": run_strategy_backtest(strategy_id, underlying_rows, option_rows, config, train_dates),
                "out_of_sample": run_strategy_backtest(strategy_id, underlying_rows, option_rows, config, test_dates),
                "train_sessions": len(train_dates), "test_sessions": len(test_dates),
                "status": "screening only; not an untouched final holdout",
            }
        else:
            full["validation"] = {"status": "unavailable", "reason": "At least two distinct sessions are required for a chronological split."}
        results.append(full)
    ranking = []
    for result in results:
        oos = result.get("validation", {}).get("out_of_sample", {})
        summary = oos.get("summary", {})
        pf_metric = next((x.get("value") for x in oos.get("metrics", []) if x["id"] == "profit_factor"), None)
        expectancy = next((x.get("value") for x in oos.get("metrics", []) if x["id"] == "expectancy"), None)
        dd = oos.get("drawdown", {}).get("max_drawdown_pct")
        score = None
        if expectancy is not None and isinstance(pf_metric, (int, float)) and dd is not None and oos.get("summary", {}).get("total_trades", 0) >= 20:
            # Screening score is explicit and bounded; it is not a forecast or investment recommendation.
            score = round((math.tanh(float(expectancy) / max(1.0, float(result["summary"].get("allocated_capital", 1)) * 0.001))
                           + math.tanh((float(pf_metric) - 1) / 0.5) - min(1.0, float(dd) / 30.0)), 4)
        ranking.append({"strategy_id": result["strategy_id"], "name": result["strategy"]["name"],
                        "out_of_sample_expectancy": expectancy, "out_of_sample_profit_factor": pf_metric,
                        "out_of_sample_max_drawdown_pct": dd, "sample_trades": summary.get("total_trades"),
                        "score": score, "status": "ranked" if score is not None else "insufficient out of sample sample"})
    return {"version": "1.0", "data_source": config.get("data_source", "user supplied; verify against broker source"),
            "settings": config, "strategy_count": len(results), "strategies": results,
            "comparison": sorted(ranking, key=lambda x: x["score"] if x["score"] is not None else -999, reverse=True),
            "metric_registry": METRIC_REGISTRY,
            "assumptions": ["Signals are based on completed underlying bars.",
                            "Option P&L uses supplied listed-contract OHLC premiums and never underlying-index returns.",
                            "When stop and target occur in the same candle, the stop is assumed first.",
                            "Daily return risk metrics use closed trade equity; intratrade drawdown uses supplied option OHLC marks.",
                            "No broker latency, order book queue, rejected orders, or partial execution is inferred from OHLC data."]}


DEFAULT_PARAMETER_SPACES: dict[str, dict[str, list[Any]]] = {
    "orb": {"opening_range_minutes": [10, 15, 20], "volume_multiple": [0.8, 1.0, 1.2], "target_r": [1.5, 2.25, 3.0]},
    "ema_vwap": {"fast_ema": [7, 9, 12], "slow_ema": [18, 21, 26], "target_r": [1.5, 2.25, 3.0]},
    "supertrend_rsi": {"supertrend_period": [7, 10, 14], "supertrend_multiplier": [2.0, 3.0, 4.0], "rsi_period": [10, 14, 20]},
    "adx_breakout": {"adx_period": [10, 14, 20], "adx_threshold": [18, 20, 25], "breakout_lookback": [10, 20, 30]},
    "volatility_expansion": {"bollinger_period": [15, 20, 25], "squeeze_lookback": [10, 20, 30], "atr_expansion_multiple": [1.0, 1.1, 1.25]},
}


def _optimization_score(report: dict[str, Any], capital: float, minimum_trades: int) -> tuple[float | None, dict[str, Any]]:
    summary = report.get("summary", {})
    metrics = {x.get("id"): x.get("value") for x in report.get("metrics", [])}
    trades = int(summary.get("total_trades", 0))
    expectancy = metrics.get("expectancy")
    profit_factor = metrics.get("profit_factor")
    drawdown = report.get("drawdown", {}).get("max_drawdown_pct")
    measured = {"trades": trades, "expectancy": expectancy, "profit_factor": profit_factor, "max_drawdown_pct": drawdown}
    if trades < minimum_trades or expectancy is None or profit_factor is None or drawdown is None:
        return None, measured
    pf = 3.0 if profit_factor == "unbounded" else float(profit_factor)
    score = math.tanh(float(expectancy) / max(1.0, capital * 0.001)) + math.tanh((pf - 1) / 0.5) - min(1.0, float(drawdown) / 30.0)
    return round(score, 5), measured


def optimize_strategy(
    strategy_id: str,
    underlying_rows: list[dict[str, Any]],
    option_rows: list[dict[str, Any]],
    settings: dict[str, Any] | None = None,
    method: str = "grid",
    parameter_space: dict[str, list[Any]] | None = None,
    budget: int = 60,
    seed: int = 4307,
    minimum_trades: int = 20,
) -> dict[str, Any]:
    """Train-only parameter screening followed by validation and untouched holdout reports."""
    if strategy_id not in STRATEGIES:
        raise ValueError(f"Unknown strategy: {strategy_id}")
    mode = str(method).lower().strip()
    if mode == "bayesian":
        try:
            import skopt  # type: ignore[import-not-found] # noqa: F401
        except ImportError:
            return {"status": "unavailable", "method": mode,
                    "reason": "Bayesian optimization is unavailable because scikit-optimize is not installed; grid and random search are supported."}
        return {"status": "unavailable", "method": mode,
                "reason": "The installed Bayesian optimizer is not yet wired to this research engine; use grid or random search."}
    if mode not in {"grid", "random"}:
        raise ValueError("Optimization method must be grid, random, or bayesian.")
    config = dict(settings or {})
    normalized = aggregate_candles(normalize_candles(underlying_rows), int(config.get("timeframe_minutes", 5)))
    dates = sorted({_candle_session(x) for x in normalized})
    if len(dates) < 8:
        return {"status": "unavailable", "method": mode,
                "reason": "Optimization requires at least eight distinct sessions to keep development, validation, and holdout periods separate.",
                "session_count": len(dates)}
    space = parameter_space or DEFAULT_PARAMETER_SPACES[strategy_id]
    if not isinstance(space, dict) or not space:
        raise ValueError("Provide at least one parameter with a list of candidate values.")
    allowed = {param for params in DEFAULT_PARAMETER_SPACES.values() for param in params}
    allowed.update({"stop_atr_multiple", "trail_after_r", "strike_selection", "target_delta", "expiry_mode"})
    clean_space: dict[str, list[Any]] = {}
    for key, values in space.items():
        if (key not in allowed or not isinstance(values, list) or not values or len(values) > 50
                or any(not isinstance(value, (int, float, str)) or (isinstance(value, float) and not math.isfinite(value)) for value in values)):
            raise ValueError(f"Invalid parameter grid for {key}.")
        clean_space[key] = list(dict.fromkeys(values))
    cap = max(1, min(200, int(budget)))
    value_lists = [clean_space[key] for key in clean_space]
    total_combinations = math.prod(len(values) for values in value_lists)
    rng = random.Random(seed)
    if mode == "random" or total_combinations > cap:
        target = min(cap, total_combinations)
        sampled: set[tuple[Any, ...]] = set()
        while len(sampled) < target:
            sampled.add(tuple(rng.choice(values) for values in value_lists))
        combinations = list(sampled)
    else:
        combinations = list(itertools.product(*value_lists))
    dev_end = max(5, int(len(dates) * 0.8))
    dev_end = min(len(dates) - 2, dev_end)
    development = dates[:dev_end]
    holdout = dates[dev_end:]
    train_end = max(3, int(len(development) * 0.7))
    train = development[:train_end]
    validation = development[train_end:]
    capital = max(1.0, float(config.get("initial_capital", 1_000_000)))
    candidates: list[dict[str, Any]] = []
    for values in combinations:
        trial = dict(config); parameters = dict(zip(clean_space, values)); trial.update(parameters)
        report = run_strategy_backtest(strategy_id, underlying_rows, option_rows, trial, set(train))
        score, measured = _optimization_score(report, capital, minimum_trades)
        candidates.append({"parameters": parameters, "training_score": score, "training": measured})
    ranked = sorted((x for x in candidates if x["training_score"] is not None), key=lambda x: float(x["training_score"]), reverse=True)
    if not ranked:
        return {"status": "insufficient_sample", "method": mode, "candidate_count": len(candidates),
                "minimum_training_trades": minimum_trades, "train_sessions": len(train),
                "validation_sessions": len(validation), "holdout_sessions": len(holdout),
                "reason": "No parameter combination met the minimum training sample and metric requirements.",
                "candidates": candidates}
    winner = ranked[0]
    chosen = dict(config); chosen.update(winner["parameters"])
    validation_report = run_strategy_backtest(strategy_id, underlying_rows, option_rows, chosen, set(validation))
    holdout_report = run_strategy_backtest(strategy_id, underlying_rows, option_rows, chosen, set(holdout))
    validation_score, validation_metrics = _optimization_score(validation_report, capital, minimum_trades)
    holdout_score, holdout_metrics = _optimization_score(holdout_report, capital, minimum_trades)
    sensitivity: dict[str, list[dict[str, Any]]] = {}
    for parameter in clean_space:
        grouped: dict[str, list[float]] = defaultdict(list)
        for candidate in candidates:
            if candidate["training_score"] is not None:
                grouped[str(candidate["parameters"][parameter])].append(float(candidate["training_score"]))
        sensitivity[parameter] = [{"value": value, "mean_training_score": round(statistics.mean(scores), 5), "combinations": len(scores)}
                                  for value, scores in sorted(grouped.items())]
    fold_reports = []
    fold_size = max(1, len(development) // 4)
    for fold_no, fold_start in enumerate(range(max(3, len(development) // 2), len(development), fold_size), 1):
        fold_end = min(len(development), fold_start + fold_size)
        prior_dates = development[:fold_start]; test_dates = development[fold_start:fold_end]
        if len(prior_dates) < 3 or not test_dates: continue
        fold_train_reports = []
        for values in combinations:
            trial = dict(config); trial.update(dict(zip(clean_space, values)))
            report = run_strategy_backtest(strategy_id, underlying_rows, option_rows, trial, set(prior_dates))
            score, measured = _optimization_score(report, capital, minimum_trades)
            if score is not None:
                fold_train_reports.append((score, dict(zip(clean_space, values)), measured))
        if not fold_train_reports:
            fold_reports.append({"fold": fold_no, "status": "insufficient_sample", "train_sessions": len(prior_dates), "test_sessions": len(test_dates)})
            continue
        fold_train_reports.sort(key=lambda x: x[0], reverse=True)
        fold_settings = dict(config); fold_settings.update(fold_train_reports[0][1])
        fold_test = run_strategy_backtest(strategy_id, underlying_rows, option_rows, fold_settings, set(test_dates))
        _, test_metrics = _optimization_score(fold_test, capital, 1)
        fold_reports.append({"fold": fold_no, "status": "evaluated", "train_sessions": len(prior_dates), "test_sessions": len(test_dates),
                            "parameters": fold_train_reports[0][1], "test": test_metrics})
    return {"status": "evaluated", "method": mode, "seed": seed, "candidate_count": len(candidates),
            "selected_parameters": winner["parameters"], "selected_training_metrics": winner["training"],
            "validation": validation_metrics, "validation_score": validation_score,
            "holdout": holdout_metrics, "holdout_score": holdout_score,
            "sample_periods": {"training_sessions": len(train), "validation_sessions": len(validation),
                               "untouched_holdout_sessions": len(holdout), "method": "chronological 56/24/20 split; candidate ranking uses training only"},
            "walk_forward": {"method": "expanding training window, up to three subsequent development folds", "folds": fold_reports},
            "parameter_sensitivity": sensitivity, "top_candidates": ranked[:20],
            "all_candidates": candidates, "warnings": ["A one-time holdout is no longer untouched after repeated review and parameter changes.",
                                                            "Search results are sample-dependent; a positive holdout is not a forecast."]}
