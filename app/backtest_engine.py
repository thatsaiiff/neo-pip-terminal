"""Historical simulator for the Indian ATM option buying rules.

This module reports only metrics supported by the supplied option candles. It does
not generate candles, fabricate a Sharpe ratio, or clamp results to a target.
"""

from __future__ import annotations

import math
import statistics
from datetime import datetime, time as dt_time, timezone
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

from app.accounting import calculate_statutory_charges
from app.algo_bot import calculate_atr, calculate_ema_series, calculate_volume_sma, evaluate_crossover_signal

IST = ZoneInfo("Asia/Kolkata")


def run_option_buying_backtest(
    candles: list[dict[str, Any]],
    symbol: str,
    lot_size: int,
    exchange_segment: str = "nse_fo",
    lots_per_order: int = 1,
    rr_ratio: float = 2.25,
    min_atr: float = 14.0,
    risk_pct_per_trade: float = 0.5,
    initial_capital: float = 1_000_000.0,
    max_daily_loss_pct: float = 10.0,
    max_drawdown_pct: float = 30.0,
    max_consecutive_losses: int = 3,
    loss_streak_window_seconds: int = 1800,
) -> dict[str, Any]:
    """Backtest one exact option contract using next bar open entries and cautious exits."""
    if lot_size <= 0 or initial_capital <= 0:
        return {"error": "A valid lot size and starting capital are required.", "total_trades": 0, "trades": []}

    ordered: list[dict[str, Any]] = []
    for candle in sorted(candles, key=lambda item: int(item.get("time") or 0)):
        timestamp = int(candle.get("time") or 0)
        if timestamp <= 0:
            continue
        session = datetime.fromtimestamp(timestamp, IST)
        minutes = session.hour * 60 + session.minute
        if session.weekday() < 5 and 9 * 60 + 15 <= minutes <= 15 * 60 + 29:
            ordered.append(candle)
    if len(ordered) < 22:
        return {"error": "At least 22 in-session closed one minute candles are required.", "total_trades": 0, "candle_count": len(ordered), "trades": []}
    capital = float(initial_capital)
    peak_equity = capital
    max_drawdown = 0.0
    trades: list[dict[str, Any]] = []
    daily_net: dict[str, float] = {}
    daily_gross: dict[str, float] = {}
    daily_charges: dict[str, float] = {}
    daily_trade_count: dict[str, int] = {}
    loss_times: list[tuple[int, float]] = []
    active: dict[str, Any] | None = None
    last_cross_time: str | None = None
    halt_reason: str | None = None
    daily_loss_limit = initial_capital * max_daily_loss_pct / 100.0
    minimum_bars = 22

    def close_trade(exit_time: int, exit_price: float, reason: str) -> None:
        nonlocal active, capital, peak_equity, max_drawdown
        if active is None:
            return
        quantity = int(active["quantity"])
        entry = float(active["entry_price"])
        gross = (exit_price - entry) * quantity
        entry_fees = calculate_statutory_charges(exchange_segment, "BUY", quantity, Decimal(str(entry))).get("total", Decimal("0"))
        exit_fees = calculate_statutory_charges(exchange_segment, "SELL", quantity, Decimal(str(exit_price))).get("total", Decimal("0"))
        charges = float(entry_fees + exit_fees)
        net = gross - charges
        risk = float(active["risk_per_unit"])
        trade_date = datetime.fromtimestamp(exit_time, IST).strftime("%Y-%m-%d")
        trade = {
            "symbol": symbol,
            "entry_time": int(active["entry_time"]),
            "exit_time": int(exit_time),
            "entry_price": round(entry, 2),
            "exit_price": round(exit_price, 2),
            "sl_price": round(float(active["sl_price"]), 2),
            "tp_price": round(float(active["tp_price"]), 2),
            "risk_per_share": round(risk, 2),
            "quantity": quantity,
            "rr_target": rr_ratio,
            "r_multiple": round(gross / (risk * quantity), 2) if risk * quantity else 0.0,
            "gross_pnl": round(gross, 2),
            "charges": round(charges, 2),
            "pnl": round(net, 2),
            "exit_reason": reason,
            "duration_bars": max(1, int((exit_time - int(active["entry_time"])) / 60)),
        }
        trades.append(trade)
        daily_net[trade_date] = daily_net.get(trade_date, 0.0) + net
        daily_gross[trade_date] = daily_gross.get(trade_date, 0.0) + gross
        daily_charges[trade_date] = daily_charges.get(trade_date, 0.0) + charges
        daily_trade_count[trade_date] = daily_trade_count.get(trade_date, 0) + 1
        capital += net
        peak_equity = max(peak_equity, capital)
        max_drawdown = max(max_drawdown, (peak_equity - capital) / peak_equity if peak_equity > 0 else 0.0)
        loss_times.append((exit_time, net))
        active = None

    for index in range(minimum_bars, len(ordered)):
        candle = ordered[index]
        timestamp = int(candle.get("time") or 0)
        session = datetime.fromtimestamp(timestamp, IST)
        minutes = session.hour * 60 + session.minute
        current_open = float(candle.get("open") or 0.0)
        current_high = float(candle.get("high") or 0.0)
        current_low = float(candle.get("low") or 0.0)
        current_close = float(candle.get("close") or 0.0)

        if active is not None:
            stop = float(active["sl_price"])
            target = float(active["tp_price"])
            # Use the 15:29 bar open for the forced square-off. Its later OHLC is
            # not yet known at that time and must not leak into the simulated fill.
            if minutes >= 15 * 60 + 29:
                close_trade(timestamp, current_open if current_open > 0 else current_close, "EOD_EXIT")
            # If both levels trade in one candle, assume the less favourable stop filled first.
            elif current_low <= stop:
                close_trade(timestamp, stop, "TRAILING_STOP" if stop > float(active["initial_sl"]) else "STOP_LOSS")
            elif current_high >= target:
                close_trade(timestamp, target, "TAKE_PROFIT")
            else:
                risk = float(active["risk_per_unit"])
                if current_high >= float(active["entry_price"]) + risk:
                    active["sl_price"] = max(float(active["sl_price"]), current_high - risk)
                entry_fee = float(active["entry_fee"])
                high_equity = capital + (current_high - float(active["entry_price"])) * int(active["quantity"]) - entry_fee
                low_equity = capital + (current_low - float(active["entry_price"])) * int(active["quantity"]) - entry_fee
                peak_equity = max(peak_equity, high_equity)
                max_drawdown = max(max_drawdown, (peak_equity - low_equity) / peak_equity if peak_equity > 0 else 0.0)

        if active is not None or halt_reason:
            continue
        # The 15:29 candle is the forced session exit; don't open a fresh position there.
        if not (9 * 60 + 20 <= minutes <= 15 * 60 + 28):
            continue
        trade_date = session.strftime("%Y-%m-%d")
        if daily_net.get(trade_date, 0.0) <= -daily_loss_limit:
            continue
        if capital <= 0 or (peak_equity - capital) / peak_equity >= max_drawdown_pct / 100.0:
            halt_reason = "MAX_DRAWDOWN"
            continue
        if len(loss_times) >= max_consecutive_losses:
            recent = loss_times[-max_consecutive_losses:]
            if all(pnl < 0 for _, pnl in recent) and recent[-1][0] - recent[0][0] <= loss_streak_window_seconds:
                halt_reason = "LOSS_STREAK"
                continue

        signal = evaluate_crossover_signal(
            ordered[:index],
            fast_period=9,
            slow_period=15,
            min_atr=min_atr,
            rr_ratio=rr_ratio,
            atr_period=14,
        )
        if signal.get("signal") != "BUY":
            continue
        cross_time = str(signal.get("cross_bar_time") or signal.get("signal_bar_time") or "")
        if not cross_time or cross_time == last_cross_time:
            continue
        try:
            cross_timestamp = int(float(cross_time))
            cross_date = datetime.fromtimestamp(cross_timestamp, IST).date()
        except (TypeError, ValueError, OverflowError, OSError):
            continue
        # Historical candles warm the indicators, but a prior-session crossover is
        # never allowed to trigger an entry in a later session.
        if cross_date != session.date():
            continue
        risk_per_unit = float(signal.get("risk") or 0.0)
        if risk_per_unit <= 0:
            continue
        risk_budget = capital * risk_pct_per_trade / 100.0
        risk_sized_lots = int(risk_budget // (risk_per_unit * lot_size))
        lots = min(max(1, int(lots_per_order)), risk_sized_lots)
        if lots < 1:
            continue
        quantity = lots * lot_size
        entry = current_open if current_open > 0 else current_close
        if entry <= 0:
            continue
        entry_fee = float(calculate_statutory_charges(exchange_segment, "BUY", quantity, Decimal(str(entry))).get("total", Decimal("0")))
        stop = entry - risk_per_unit
        target = entry + risk_per_unit * rr_ratio
        active = {
            "entry_time": timestamp,
            "entry_price": entry,
            "quantity": quantity,
            "risk_per_unit": risk_per_unit,
            "entry_fee": entry_fee,
            "initial_sl": stop,
            "sl_price": stop,
            "tp_price": target,
        }
        last_cross_time = cross_time

    if active is not None and ordered:
        last = ordered[-1]
        close_trade(int(last.get("time") or 0), float(last.get("close") or 0.0), "END_OF_DATA")

    wins = [trade for trade in trades if trade["pnl"] > 0]
    losses = [trade for trade in trades if trade["pnl"] < 0]
    breakeven = [trade for trade in trades if trade["pnl"] == 0]
    net_wins = sum(trade["pnl"] for trade in wins)
    net_losses = abs(sum(trade["pnl"] for trade in losses))
    gross_profit = sum(max(0.0, float(trade["gross_pnl"])) for trade in trades)
    gross_loss = abs(sum(min(0.0, float(trade["gross_pnl"])) for trade in trades))
    total_charges = sum(float(trade["charges"]) for trade in trades)
    session_days = sorted({
        datetime.fromtimestamp(int(candle.get("time") or 0), IST).strftime("%Y-%m-%d")
        for candle in ordered
        if int(candle.get("time") or 0) > 0
    })
    daily_performance: list[dict[str, Any]] = []
    daily_returns: list[float] = []
    daily_equity = float(initial_capital)
    daily_peak = daily_equity
    daily_max_drawdown = 0.0
    max_daily_loss_observed_pct = 0.0
    for day in session_days:
        start_equity = daily_equity
        net = daily_net.get(day, 0.0)
        max_daily_loss_observed_pct = min(
            max_daily_loss_observed_pct,
            (net / start_equity * 100.0) if start_equity > 0 else 0.0,
        )
        daily_equity += net
        daily_peak = max(daily_peak, daily_equity)
        daily_max_drawdown = max(
            daily_max_drawdown,
            (daily_peak - daily_equity) / daily_peak if daily_peak > 0 else 0.0,
        )
        daily_return = net / start_equity if start_equity > 0 else 0.0
        daily_returns.append(daily_return)
        daily_performance.append({
            "date": day,
            "trades": daily_trade_count.get(day, 0),
            "gross_pnl": round(daily_gross.get(day, 0.0), 2),
            "charges": round(daily_charges.get(day, 0.0), 2),
            "net_pnl": round(net, 2),
            "return_pct": round(daily_return * 100.0, 4),
            "equity": round(daily_equity, 2),
        })
    sharpe: float | None = None
    if len(daily_returns) >= 2:
        deviation = statistics.stdev(daily_returns)
        if deviation > 0:
            sharpe = round(statistics.mean(daily_returns) / deviation * math.sqrt(252.0), 2)
    avg_win = statistics.mean(trade["pnl"] for trade in wins) if wins else 0.0
    avg_loss = statistics.mean(trade["pnl"] for trade in losses) if losses else 0.0
    avg_r = statistics.mean(trade["r_multiple"] for trade in trades) if trades else 0.0
    holding_times = [int(trade["duration_bars"]) for trade in trades]
    loss_streak = 0
    win_streak = 0
    max_loss_streak = 0
    max_win_streak = 0
    for trade in trades:
        if trade["pnl"] < 0:
            loss_streak += 1
            win_streak = 0
        elif trade["pnl"] > 0:
            win_streak += 1
            loss_streak = 0
        else:
            loss_streak = 0
            win_streak = 0
        max_loss_streak = max(max_loss_streak, loss_streak)
        max_win_streak = max(max_win_streak, win_streak)
    valid_times = [int(candle.get("time") or 0) for candle in ordered if int(candle.get("time") or 0) > 0]
    return {
        "symbol": symbol,
        "data_scope": "one exact option contract using supplied closed one minute candles",
        "session_window_ist": "09:20–15:29 (new entries through 15:28; forced exit at 15:29)",
        "candle_count": len(ordered),
        "session_days": len(session_days),
        "data_range_start": datetime.fromtimestamp(valid_times[0], IST).isoformat() if valid_times else None,
        "data_range_end": datetime.fromtimestamp(valid_times[-1], IST).isoformat() if valid_times else None,
        "initial_capital": round(initial_capital, 2),
        "lots_per_order": max(1, int(lots_per_order)),
        "final_capital": round(capital, 2),
        "net_pnl": round(capital - initial_capital, 2),
        "return_pct": round((capital - initial_capital) / initial_capital * 100.0, 2),
        "total_trades": len(trades),
        "winning_trades": len(wins),
        "losing_trades": len(losses),
        "breakeven_trades": len(breakeven),
        "win_rate_pct": round(len(wins) / len(trades) * 100.0, 2) if trades else 0.0,
        "gross_profit": round(gross_profit, 2),
        "gross_loss": round(gross_loss, 2),
        "total_charges": round(total_charges, 2),
        "profit_factor": round(net_wins / net_losses, 2) if net_losses else (None if not net_wins else "unbounded"),
        "gross_profit_factor": round(gross_profit / gross_loss, 2) if gross_loss else (None if not gross_profit else "unbounded"),
        "average_win": round(avg_win, 2),
        "average_loss": round(avg_loss, 2),
        "expectancy_per_trade": round((sum(float(trade["pnl"]) for trade in trades) / len(trades)), 2) if trades else 0.0,
        "payoff_ratio": round(avg_win / abs(avg_loss), 2) if avg_loss else (None if not avg_win else "unbounded"),
        "average_r_multiple": round(avg_r, 3),
        "average_holding_minutes": round(statistics.mean(holding_times), 2) if holding_times else 0.0,
        "best_trade": round(max((float(trade["pnl"]) for trade in trades), default=0.0), 2),
        "worst_trade": round(min((float(trade["pnl"]) for trade in trades), default=0.0), 2),
        "max_consecutive_wins": max_win_streak,
        "max_consecutive_losses": max_loss_streak,
        "max_drawdown_pct": round(max(max_drawdown, daily_max_drawdown) * 100.0, 2),
        "sharpe_ratio": sharpe,
        "sharpe_target": 1.30,
        "rr_target": rr_ratio,
        "atr_threshold": min_atr,
        "daily_loss_limit_pct": max_daily_loss_pct,
        "max_daily_loss_observed_pct": round(max_daily_loss_observed_pct, 2),
        "max_drawdown_limit_pct": max_drawdown_pct,
        "trading_halt_reason": halt_reason,
        "daily_performance": daily_performance,
        "trades": trades,
    }


def run_full_expiry_portfolio_backtest() -> dict[str, Any]:
    """Deprecated placeholder: portfolio history is unavailable without exact contracts."""
    return {
        "available": False,
        "error": "A portfolio backtest needs point in time ATM contract history. Synthetic option candles are excluded.",
        "portfolio": {
            "target_rr": 2.25,
            "sharpe_target": 1.30,
            "sharpe_ratio": None,
            "max_drawdown_pct": None,
            "total_trades": 0,
        },
        "per_symbol_results": [],
    }
