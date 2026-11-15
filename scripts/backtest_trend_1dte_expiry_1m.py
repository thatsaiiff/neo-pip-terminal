"""Backtest the 5-minute EMA trend strategy on 1-DTE and expiry sessions.

Historical Upstox bars are 1-minute. They are aggregated into 5-minute bars;
the simulator never treats interpolated sub-minute chart data as observed ticks.
"""

from __future__ import annotations

import json
import math
import statistics
import sys
from collections import defaultdict
from datetime import date, datetime, time as dt_time, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import backtest_expiry_1m as base  # noqa: E402
from app.accounting import calculate_statutory_charges  # noqa: E402

IST = base.IST
TODAY = base.TODAY
INITIAL_CAPITAL = 1_000_000.0
RISK_PCT_PER_TRADE = 0.5
MAX_DAILY_LOSS_PCT = 10.0
MAX_DRAWDOWN_PCT = 30.0
MAX_CONSECUTIVE_LOSSES = 3
LOSS_STREAK_SECONDS = 1800
EXPIRY_SAMPLES = 19
LOTS_PER_TRADE = 2  # One lot can be closed at 2R while one lot remains open.
PARTIAL_R = 2.0
FINAL_R = 8.0
REPORT_DIR = ROOT / "reports"


def get_candles_range(data: base.UpstoxData, instrument_key: str, to_date: str, from_date: str, active: bool) -> list[list[Any]]:
    if active:
        url = (
            "https://api.upstox.com/v3/historical-candle/"
            f"{quote(instrument_key, safe='')}/minutes/1/{to_date}/{from_date}"
        )
    else:
        url = (
            "https://api.upstox.com/v2/expired-instruments/historical-candle/"
            f"{quote(instrument_key, safe='')}/1minute/{to_date}/{from_date}"
        )
    return (data.get_json(url).get("data") or {}).get("candles") or []


def aggregate_5m(bars: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for bar in bars:
        offset = bar["dt"].hour * 60 + bar["dt"].minute - (9 * 60 + 15)
        if offset >= 0:
            groups[offset // 5].append(bar)
    result = []
    for _, group in sorted(groups.items()):
        group.sort(key=lambda x: x["time"])
        if len(group) != 5:
            continue
        result.append({
            "dt": group[0]["dt"],
            "time": group[0]["time"],
            "end_time": group[-1]["time"] + 60,
            "open": group[0]["open"],
            "high": max(x["high"] for x in group),
            "low": min(x["low"] for x in group),
            "close": group[-1]["close"],
            "volume": sum(x["volume"] for x in group),
        })
    return result


def historical_future_for_expiry(
    data: base.UpstoxData,
    underlying: str,
    expiry: str,
    expiry_dates: list[str],
    current_futures: dict[str, list[dict[str, Any]]],
) -> tuple[dict[str, Any] | None, list[list[Any]], bool]:
    underlying_key = base.UNDERLYINGS[underlying]["key"]
    month_dates = [x for x in expiry_dates if x[:7] == expiry[:7]]
    monthly_expiry = max(month_dates) if month_dates else expiry
    # Prefer the matching expired monthly future, which is the correct point-in-time contract.
    future = data.get_expired_future(underlying_key, monthly_expiry)
    active = False
    if future is None:
        candidates = [x for x in current_futures.get(underlying, []) if x["expiry_date"] >= expiry]
        if not candidates:
            return None, [], False
        future = min(candidates, key=lambda x: x["expiry_date"])
        active = True
    to_date = expiry
    from_date = (date.fromisoformat(expiry) - timedelta(days=10)).isoformat()
    raw = get_candles_range(data, str(future["instrument_key"]), to_date, from_date, active)
    return future, raw, active


def session_days(raw: list[list[Any]]) -> dict[str, list[dict[str, Any]]]:
    days = set()
    for row in raw:
        try:
            days.add(base.to_ist(str(row[0])).date().isoformat())
        except (ValueError, TypeError, IndexError):
            continue
    return {day: base.session_bars(raw, day) for day in sorted(days)}


def causal_ema(values: list[float], period: int) -> list[float | None]:
    """SMA-seeded EMA with no values before its warm-up period."""
    result: list[float | None] = [None] * len(values)
    if len(values) < period:
        return result
    current = sum(values[:period]) / period
    result[period - 1] = current
    alpha = 2.0 / (period + 1.0)
    for i in range(period, len(values)):
        current = alpha * values[i] + (1.0 - alpha) * current
        result[i] = current
    return result


def ema_crosses(future_5m: list[dict[str, Any]]) -> tuple[list[float | None], list[float | None], list[dict[str, Any]]]:
    closes = [x["close"] for x in future_5m]
    fast = causal_ema(closes, 9)
    slow = causal_ema(closes, 15)
    crosses = []
    for i in range(15, len(future_5m)):
        if future_5m[i]["dt"].time() < dt_time(9, 20) or future_5m[i]["dt"].time() > dt_time(15, 25):
            continue
        if fast[i - 1] is None or fast[i] is None or slow[i - 1] is None or slow[i] is None:
            continue
        slope = slow[i] - slow[i - 1]
        if fast[i - 1] <= slow[i - 1] and fast[i] > slow[i] and slope > 0:
            crosses.append({"index": i, "direction": "BULL", "bar": future_5m[i]})
        elif fast[i - 1] >= slow[i - 1] and fast[i] < slow[i] and slope < 0:
            crosses.append({"index": i, "direction": "BEAR", "bar": future_5m[i]})
    return fast, slow, crosses


def nearest_option(
    contracts: list[dict[str, Any]], direction: str, underlying_price: float
) -> dict[str, Any] | None:
    option_type = "CE" if direction == "BULL" else "PE"
    candidates = [x for x in contracts if x.get("instrument_type") == option_type]
    if not candidates:
        return None
    return min(candidates, key=lambda x: abs(float(x.get("strike_price") or 0.0) - underlying_price))


def calculate_exit_charges(segment: str, quantity: int, price: float) -> float:
    return float(calculate_statutory_charges(segment, "SELL", quantity, Decimal(str(price))).get("total", Decimal("0")))


def simulate_trade(
    underlying: str,
    expiry: str,
    session_day: str,
    day_kind: str,
    direction: str,
    signal: dict[str, Any],
    future_5m: list[dict[str, Any]],
    option_contract: dict[str, Any],
    option_5m: list[dict[str, Any]],
) -> tuple[dict[str, Any] | None, int]:
    signal_bar = signal["bar"]
    entry_idx = next((i for i, bar in enumerate(option_5m) if bar["time"] >= signal_bar["end_time"]), None)
    if entry_idx is None or entry_idx < 3:
        return None, int(signal["index"])
    entry_bar = option_5m[entry_idx]
    entry = float(entry_bar["open"])
    initial_stop = min(float(x["low"]) for x in option_5m[entry_idx - 3:entry_idx])
    if entry <= 0 or initial_stop <= 0 or initial_stop >= entry:
        return None, int(signal["index"])
    risk = entry - initial_stop
    lot_size = int(option_contract.get("lot_size") or 0)
    if lot_size <= 0:
        return None, int(signal["index"])
    qty = lot_size * LOTS_PER_TRADE
    risk_cash = risk * qty
    if risk_cash > INITIAL_CAPITAL * RISK_PCT_PER_TRADE / 100.0:
        return None, int(signal["index"])

    segment = "bse_fo" if underlying == "SENSEX" else "nse_fo"
    remaining_qty = qty
    partial_qty = qty // 2
    stop = initial_stop
    partial_done = False
    partial_exit: dict[str, Any] | None = None
    partial_gross = 0.0
    fees = float(calculate_statutory_charges(segment, "BUY", qty, Decimal(str(entry))).get("total", Decimal("0")))
    open_exit_pending = False
    exit_index = entry_idx
    exit_price = None
    exit_reason = "EOD_15_30"
    high_water = entry

    underlying_by_start = {bar["time"]: i for i, bar in enumerate(future_5m)}
    closes = [x["close"] for x in future_5m]
    ema_fast = causal_ema(closes, 9)
    ema_slow = causal_ema(closes, 15)

    for i in range(entry_idx, len(option_5m)):
        bar = option_5m[i]
        exit_index = i
        if open_exit_pending:
            exit_price = max(0.0, float(bar["open"]))
            exit_reason = "EMA_TREND_REVERSAL_BEFORE_2R"
            break

        stop_hit = float(bar["low"]) <= stop
        if stop_hit:
            exit_price = min(float(bar["open"]), stop) if float(bar["open"]) < stop else stop
            exit_reason = "TRAILING_STOP" if partial_done and stop > entry else ("COST_STOP" if partial_done else "INITIAL_SWING_STOP")
            break

        final_target = entry + FINAL_R * risk
        if partial_done and float(bar["high"]) >= final_target:
            exit_price = final_target
            exit_reason = "FINAL_TARGET_8R"
            break

        if not partial_done and float(bar["high"]) >= entry + PARTIAL_R * risk:
            partial_exit = {
                "time": datetime.fromtimestamp(bar["time"], IST).isoformat(),
                "price": round(entry + PARTIAL_R * risk, 2),
                "quantity": partial_qty,
                "r_multiple": PARTIAL_R,
            }
            partial_gross = (float(partial_exit["price"]) - entry) * partial_qty
            fees += calculate_exit_charges(segment, partial_qty, float(partial_exit["price"]))
            remaining_qty -= partial_qty
            partial_done = True
            stop = entry
            high_water = max(high_water, float(bar["high"]))
            # Activate breakeven/trailing from the next 5-minute candle. Intrabar ordering is unknown.
        elif partial_done:
            high_water = max(high_water, float(bar["high"]))
            # Trail below the lowest low of the last three completed 5-minute option bars.
            prior_low = min(float(x["low"]) for x in option_5m[max(entry_idx, i - 2):i + 1])
            stop = max(stop, entry, prior_low)

        if i >= len(option_5m) - 1 or bar["dt"].time() >= dt_time(15, 25):
            exit_price = max(0.0, float(bar["close"]))
            exit_reason = "EOD_15_30"
            break

        if not partial_done:
            fidx = underlying_by_start.get(bar["time"])
            prev_idx = fidx - 1 if fidx is not None else None
            if prev_idx is not None and prev_idx >= 0:
                if ema_fast[prev_idx] is None or ema_slow[prev_idx] is None:
                    continue
                prev_bull = ema_fast[prev_idx] > ema_slow[prev_idx]
                if (direction == "BULL" and not prev_bull) or (direction == "BEAR" and prev_bull):
                    open_exit_pending = True

    if exit_price is None:
        last = option_5m[min(exit_index, len(option_5m) - 1)]
        exit_price = max(0.0, float(last["close"]))
        exit_reason = "EOD_15_30"

    fees += calculate_exit_charges(segment, remaining_qty, float(exit_price))
    final_gross = (float(exit_price) - entry) * remaining_qty
    gross = partial_gross + final_gross
    net = gross - fees
    total_r = gross / risk_cash if risk_cash > 0 else 0.0
    trade = {
        "underlying": underlying,
        "date": session_day,
        "expiry": expiry,
        "day_type": day_kind,
        "direction": direction,
        "option_type": option_contract.get("instrument_type"),
        "symbol": option_contract.get("trading_symbol"),
        "instrument_key": option_contract.get("instrument_key"),
        "entry_time": datetime.fromtimestamp(entry_bar["time"], IST).isoformat(),
        "entry_price": round(entry, 2),
        "initial_stop": round(initial_stop, 2),
        "risk_per_unit": round(risk, 2),
        "risk_cash": round(risk_cash, 2),
        "lots": LOTS_PER_TRADE,
        "lot_size": lot_size,
        "quantity": qty,
        "partial_exit": partial_exit,
        "exit_time": datetime.fromtimestamp(option_5m[exit_index]["end_time"], IST).isoformat(),
        "exit_price": round(float(exit_price), 2),
        "exit_reason": exit_reason,
        "remaining_quantity": remaining_qty,
        "final_stop": round(stop, 2),
        "gross_pnl": round(gross, 2),
        "charges": round(fees, 2),
        "net_pnl": round(net, 2),
        "r_multiple": round(total_r, 3),
        "partial_booked": partial_done,
    }
    return trade, exit_index


def get_option_candles(data: base.UpstoxData, instrument_key: str, expiry: str, session_day: str) -> list[list[Any]]:
    from_date = (date.fromisoformat(session_day) - timedelta(days=1)).isoformat()
    url = (
        "https://api.upstox.com/v2/expired-instruments/historical-candle/"
        f"{quote(instrument_key, safe='')}/1minute/{session_day}/{from_date}"
    )
    return (data.get_json(url).get("data") or {}).get("candles") or []


def run_session(
    data: base.UpstoxData,
    underlying: str,
    expiry: str,
    session_day: str,
    day_kind: str,
    future_contract: dict[str, Any],
    future_raw: list[list[Any]],
    option_contracts: list[dict[str, Any]],
) -> dict[str, Any]:
    future_bars = base.session_bars(future_raw, session_day)
    future_5m = aggregate_5m(future_bars)
    if len(future_5m) < 20:
        return {"underlying": underlying, "expiry": expiry, "date": session_day, "day_type": day_kind, "status": "SKIPPED", "reason": "Not enough 5-minute futures data", "trades": [], "signals": 0}
    fast, slow, crosses = ema_crosses(future_5m)
    trades: list[dict[str, Any]] = []
    attempted = 0
    last_exit_index = -1
    recent_outcomes: list[tuple[int, float]] = []
    session_net = 0.0
    for signal in crosses:
        if signal["index"] <= last_exit_index:
            continue
        attempted += 1
        price = float(signal["bar"]["close"])
        option = nearest_option(option_contracts, signal["direction"], price)
        if not option:
            last_exit_index = int(signal["index"])
            continue
        raw_option = get_option_candles(data, str(option["instrument_key"]), expiry, session_day)
        option_5m = aggregate_5m(base.session_bars(raw_option, session_day))
        trade, exit_idx = simulate_trade(underlying, expiry, session_day, day_kind, signal["direction"], signal, future_5m, option, option_5m)
        last_exit_index = max(int(signal["index"]), exit_idx)
        if trade:
            trades.append(trade)
            session_net += float(trade["net_pnl"])
            exit_ts = int(datetime.fromisoformat(trade["exit_time"]).timestamp())
            recent_outcomes.append((exit_ts, float(trade["net_pnl"])))
            if len(recent_outcomes) >= MAX_CONSECUTIVE_LOSSES:
                last_three = recent_outcomes[-MAX_CONSECUTIVE_LOSSES:]
                if all(pnl < 0 for _, pnl in last_three) and last_three[-1][0] - last_three[0][0] <= LOSS_STREAK_SECONDS:
                    break
            if session_net <= -(INITIAL_CAPITAL * MAX_DAILY_LOSS_PCT / 100.0):
                break
    return {
        "underlying": underlying,
        "expiry": expiry,
        "date": session_day,
        "day_type": day_kind,
        "status": "OK",
        "future_symbol": future_contract.get("trading_symbol"),
        "signals": attempted,
        "trades": trades,
        "net_pnl": round(sum(x["net_pnl"] for x in trades), 2),
        "bars_future_5m": len(future_5m),
    }


def metrics(sessions: list[dict[str, Any]]) -> dict[str, Any]:
    ok = [s for s in sessions if s.get("status") == "OK"]
    trades = [t for s in ok for t in s.get("trades", [])]
    winners = [t for t in trades if t["net_pnl"] > 0]
    losers = [t for t in trades if t["net_pnl"] < 0]
    gross_profit = sum(max(0.0, t["gross_pnl"]) for t in trades)
    gross_loss = abs(sum(min(0.0, t["gross_pnl"]) for t in trades))
    total_pnl = sum(t["net_pnl"] for t in trades)
    net_profit = sum(max(0.0, t["net_pnl"]) for t in trades)
    net_loss = abs(sum(min(0.0, t["net_pnl"]) for t in trades))
    r_values = [float(t["r_multiple"]) for t in trades]
    sessions_by_day = defaultdict(float)
    for s in ok:
        sessions_by_day[s["date"]] += float(s.get("net_pnl") or 0.0)
    equity = INITIAL_CAPITAL
    peak = equity
    max_dd = 0.0
    for day in sorted(sessions_by_day):
        equity += sessions_by_day[day]
        peak = max(peak, equity)
        max_dd = max(max_dd, (peak - equity) / peak if peak > 0 else 0.0)
    return {
        "sessions_requested": len(sessions),
        "sessions_with_data": len(ok),
        "sessions_skipped": len(sessions) - len(ok),
        "signals": sum(int(x.get("signals") or 0) for x in ok),
        "trades": len(trades),
        "partials_booked": sum(bool(x.get("partial_booked")) for x in trades),
        "wins": len(winners),
        "losses": len(losers),
        "win_rate_pct": round(len(winners) / len(trades) * 100, 2) if trades else 0.0,
        "gross_profit": round(gross_profit, 2),
        "gross_loss": round(gross_loss, 2),
        "charges": round(sum(x["charges"] for x in trades), 2),
        "net_pnl": round(total_pnl, 2),
        "return_pct": round(total_pnl / INITIAL_CAPITAL * 100, 3),
        "profit_factor": round(gross_profit / gross_loss, 3) if gross_loss else (None if gross_profit == 0 else "unbounded"),
        "net_profit_factor": round(net_profit / net_loss, 3) if net_loss else (None if net_profit == 0 else "unbounded"),
        "average_net_trade": round(total_pnl / len(trades), 2) if trades else 0.0,
        "average_r_multiple": round(statistics.mean(r_values), 3) if r_values else 0.0,
        "median_r_multiple": round(statistics.median(r_values), 3) if r_values else 0.0,
        "average_win": round(statistics.mean(x["net_pnl"] for x in winners), 2) if winners else 0.0,
        "average_loss": round(statistics.mean(x["net_pnl"] for x in losers), 2) if losers else 0.0,
        "max_drawdown_pct": round(max_dd * 100, 3),
        "largest_loss": round(min((x["net_pnl"] for x in trades), default=0.0), 2),
        "largest_win": round(max((x["net_pnl"] for x in trades), default=0.0), 2),
    }


def main() -> None:
    data = base.UpstoxData(base.load_token())
    try:
        expiry_lists = {name: data.get_expiries(info["key"]) for name, info in base.UNDERLYINGS.items()}
        selected = {name: dates[-EXPIRY_SAMPLES:] for name, dates in expiry_lists.items()}
        current_futures = base.load_current_futures(data)
        sessions: list[dict[str, Any]] = []
        expected = sum(len(x) * 2 for x in selected.values())
        count = 0
        for underlying, expiries in selected.items():
            full_dates = expiry_lists[underlying]
            for expiry in expiries:
                future_contract, raw, active = historical_future_for_expiry(data, underlying, expiry, full_dates, current_futures)
                if not future_contract or not raw:
                    for kind, session_day in (("1DTE", None), ("EXPIRY", expiry)):
                        count += 1
                        sessions.append({"underlying": underlying, "expiry": expiry, "date": session_day, "day_type": kind, "status": "SKIPPED", "reason": "No historical future candles", "trades": [], "signals": 0})
                        print(f"[{count}/{expected}] {underlying} {expiry} {kind}: missing future")
                    continue
                by_day = session_days(raw)
                prior_days = [d for d, bars in by_day.items() if d < expiry and len(bars) >= 300]
                dte_day = prior_days[-1] if prior_days else None
                option_contracts = data.get_options(base.UNDERLYINGS[underlying]["key"], expiry)
                ordered_days = [("1DTE", dte_day), ("EXPIRY", expiry)]
                for day_kind, session_day in ordered_days:
                    count += 1
                    if session_day is None:
                        sessions.append({"underlying": underlying, "expiry": expiry, "date": None, "day_type": day_kind, "status": "SKIPPED", "reason": "Previous trading day data not available", "trades": [], "signals": 0})
                        print(f"[{count}/{expected}] {underlying} {expiry} {day_kind}: no prior session")
                        continue
                    session = run_session(data, underlying, expiry, session_day, day_kind, future_contract, raw, option_contracts)
                    sessions.append(session)
                    print(f"[{count}/{expected}] {underlying} {expiry} {day_kind} {session_day}: {len(session.get('trades', []))} trades, {session.get('net_pnl', 0):.2f} net")

        by_underlying = {name: metrics([s for s in sessions if s["underlying"] == name]) for name in base.UNDERLYINGS}
        by_day_type = {kind: metrics([s for s in sessions if s["day_type"] == kind]) for kind in ("1DTE", "EXPIRY")}
        all_metrics = metrics(sessions)
        report = {
            "run_date": TODAY.isoformat(),
            "strategy": "5-minute underlying EMA 9/15 trend; buy ATM options only on 1-DTE and expiry sessions",
            "data_source": "Upstox expired option and future contracts; actual 1-minute historical OHLCV aggregated into 5-minute candles",
            "settings": {
                "expiry_events_per_index": EXPIRY_SAMPLES,
                "sessions_per_expiry": ["previous trading session (1DTE)", "expiry session"],
                "entry": "Confirmed 5-minute EMA9/EMA15 cross after warm-up with EMA15 slope agreeing; CE on bullish, PE on bearish; enter at the next 5-minute bar open when flat",
                "trend_definition": "EMA9 crosses EMA15 and EMA15 slopes in the cross direction; no separate ADX filter; EMA values use closed bars only",
                "initial_stop": "Lowest low of the prior three completed 5-minute premium candles",
                "risk_reward": "Initial risk R to stop; sell 50% of two-lot position at +2R; final 50% target +8R",
                "remaining_position": "At +2R move stop to entry; then trail at the lowest low of the last three completed 5-minute option candles; exit at +8R, stop, or 15:30",
                "loss_exit": "Before +2R, close at next 5-minute open if underlying 9/15 trend reverses",
                "position_size": "Two lots per entry to permit an exact 50% partial; skip if initial risk exceeds 0.5% of ₹10,00,000 capital",
                "fees": "Project app.accounting charge model (Kotak Neo free F&O schedule)",
                "execution_assumption": "No order book/queue/slippage; entry and exits use minute-derived 5-minute OHLC levels",
                "other_risk_limits": {"max_daily_loss_pct": MAX_DAILY_LOSS_PCT, "max_drawdown_pct": MAX_DRAWDOWN_PCT, "max_consecutive_losses": MAX_CONSECUTIVE_LOSSES, "loss_streak_window_seconds": LOSS_STREAK_SECONDS},
            },
            "overall": all_metrics,
            "by_underlying": by_underlying,
            "by_day_type": by_day_type,
            "sessions": sessions,
        }
        REPORT_DIR.mkdir(parents=True, exist_ok=True)
        stem = "trend_1dte_expiry_1m_2026-11-14"
        json_path = REPORT_DIR / f"{stem}.json"
        md_path = REPORT_DIR / f"{stem}.md"
        report["json_path"] = str(json_path)
        json_path.write_text(json.dumps(report, indent=2, ensure_ascii=False))
        lines = [
            "# 5-minute EMA trend strategy: 1-DTE and expiry backtest",
            "",
            f"Run date: {TODAY.isoformat()} (Asia/Kolkata)",
            "",
            "## Overall",
            "",
            "| Sample | Sessions | Trades | 2R partials | Win rate | Gross PF | Net PF | Net P&L | Fees | Return | Avg/trade | Max realized DD |",
            "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
        ]
        def row(name: str, m: dict[str, Any]) -> str:
            return f"| {name} | {m['sessions_with_data']}/{m['sessions_requested']} | {m['trades']} | {m['partials_booked']} | {m['win_rate_pct']:.2f}% | {m['profit_factor']} | {m['net_profit_factor']} | ₹{m['net_pnl']:,.2f} | ₹{m['charges']:,.2f} | {m['return_pct']:.3f}% | ₹{m['average_net_trade']:,.2f} | {m['max_drawdown_pct']:.3f}% |"
        lines.append(row("All indices", all_metrics))
        for name, m in by_underlying.items():
            lines.append(row(name, m))
        for kind, m in by_day_type.items():
            lines.append(row(kind, m))
        lines.extend(["", "## Trade list", "", "| Date | Expiry | Day | Index | Option | Direction | Entry | Initial SL | 2R partial | Final exit | Net P&L | R | Exit reason |", "|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|"])
        all_trades = [t for s in sessions for t in s.get("trades", [])]
        for t in sorted(all_trades, key=lambda x: (x["date"], x["underlying"], x["entry_time"])):
            partial_px = t["partial_exit"]["price"] if t.get("partial_exit") else "—"
            lines.append(f"| {t['date']} | {t['expiry']} | {t['day_type']} | {t['underlying']} | {t['symbol']} | {t['direction']} | {t['entry_price']:.2f} | {t['initial_stop']:.2f} | {partial_px} | {t['exit_price']:.2f} | ₹{t['net_pnl']:,.2f} | {t['r_multiple']:.2f} | {t['exit_reason']} |")
        if not all_trades:
            lines.append("| — | — | — | — | — | — | — | — | — | — | — | — | No fills |")
        skips = [s for s in sessions if s.get("status") != "OK"]
        if skips:
            lines.extend(["", "## Skipped sessions", "", "| Expiry | Date | Type | Index | Reason |", "|---|---|---|---|---|"])
            for s in skips:
                lines.append(f"| {s.get('expiry')} | {s.get('date')} | {s.get('day_type')} | {s['underlying']} | {s.get('reason')} |")
        lines.extend(["", "## Assumptions and limits", "", "- Use of the prior 19 expiry dates per index is carried over from the previous run; each expiry contributes its prior trading session and expiry session.", "- Only actual Upstox 1-minute OHLCV is used; it is grouped into 5-minute bars. This is not tick-level replay, and touch fills/slippage are approximate.", "- 'Trending day' is operationalized as an EMA 9/15 crossover with EMA15 slope in the same direction. There is no ADX or subjective trend label.", "- Initial stop is the lowest low of the prior three completed 5-minute option bars. A fresh opposite EMA trend exits positions before partial profit; after +2R, the trailing stop governs the remaining lot.", "- Two lots are used so half can be sold. Fee calculation follows the project Kotak Neo model, not Upstox execution charges.", "- Profit factor is shown both before fees (gross) and after fees (net). Maximum drawdown is calculated from daily realized P&L across the combined index portfolio; it does not include intraday mark-to-market drawdown.", "", f"JSON: `{json_path}`", ""])
        md_path.write_text("\n".join(lines))
        print(json.dumps({"report_markdown": str(md_path), "report_json": str(json_path), "overall": all_metrics, "by_underlying": by_underlying, "by_day_type": by_day_type}, ensure_ascii=False))
    finally:
        data.close()


if __name__ == "__main__":
    main()
