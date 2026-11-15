"""Indian index option buying strategy and risk controller.

Entries use the existing EMA 9/15 crossover with volume confirmation. A signal is
eligible only when the ATM option's closed 1 minute premium candles have ATR(14)
strictly above the configured threshold. The default paper mode is deliberate;
live orders require the separate app and broker gates plus an explicit UI choice.
"""

from __future__ import annotations

import logging
import math
import inspect
import statistics
import threading
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable
from zoneinfo import ZoneInfo

logger = logging.getLogger("neo_pip.algo")
IST = ZoneInfo("Asia/Kolkata")
STRATEGY_ID = "INDIAN_ATM_OPTION_BUYING"


def round_to_tick(price: float | int | None, tick: float = 0.05) -> float | None:
    if price is None:
        return None
    try:
        p = float(price)
        if p <= 0:
            return 0.0
        return round(round(p / tick) * tick, 2)
    except (ValueError, TypeError):
        return None


def calculate_ema_series(values: list[float], period: int) -> list[float]:
    if not values or period < 1:
        return []
    if len(values) < period:
        sma = sum(values) / len(values)
        return [round(sma, 4)] * len(values)
    k = 2.0 / (period + 1.0)
    seed = sum(values[:period]) / period
    result = [round(seed, 4)] * period
    current = seed
    for value in values[period:]:
        current = (value * k) + (current * (1.0 - k))
        result.append(round(current, 4))
    return result


def calculate_atr(candles: list[dict[str, Any]], period: int = 14) -> float:
    """Simple average of the most recent true ranges, in option premium points."""
    if not candles or period < 1:
        return 0.0
    true_ranges: list[float] = []
    for index, candle in enumerate(candles):
        high = float(candle.get("high", 0.0) or 0.0)
        low = float(candle.get("low", 0.0) or 0.0)
        if index == 0:
            true_ranges.append(max(0.0, high - low))
        else:
            previous_close = float(candles[index - 1].get("close", 0.0) or 0.0)
            true_ranges.append(max(high - low, abs(high - previous_close), abs(low - previous_close)))
    recent = true_ranges[-period:]
    return round(sum(recent) / len(recent), 4) if recent else 0.0


def calculate_volume_sma(candles: list[dict[str, Any]], period: int = 20) -> float:
    if not candles or period < 1:
        return 0.0
    volumes = [float(c.get("volume", 0.0) or 0.0) for c in candles[-period:]]
    return round(sum(volumes) / len(volumes), 2) if volumes else 0.0


def evaluate_crossover_signal(
    candles: list[dict[str, Any]],
    fast_period: int = 9,
    slow_period: int = 15,
    vol_period: int = 20,
    min_atr: float = 14.0,
    rr_ratio: float = 2.25,
    atr_period: int = 14,
) -> dict[str, Any]:
    """Evaluate a bullish option premium signal using closed candles only."""
    min_bars = max(slow_period, vol_period, atr_period) + 2
    if len(candles) < min_bars:
        return {"signal": "NONE", "reason": f"Insufficient closed bars ({len(candles)} < {min_bars})"}

    closes = [float(c.get("close", 0.0) or 0.0) for c in candles]
    last_candle = candles[-1]
    atr = calculate_atr(candles, atr_period)
    candle_range = float(last_candle.get("high", 0.0) or 0.0) - float(last_candle.get("low", 0.0) or 0.0)
    if atr <= min_atr:
        return {
            "signal": "NONE",
            "reason": f"ATM premium ATR({atr_period}) {atr:.2f} is not greater than {min_atr:.2f}; ATR filter active",
            "atr": atr,
            "candle_range": candle_range,
        }

    fast = calculate_ema_series(closes, fast_period)
    slow = calculate_ema_series(closes, slow_period)
    previous_volume_sma = calculate_volume_sma(candles[:-1], vol_period)
    current_volume = float(last_candle.get("volume", 0.0) or 0.0)
    cross_index = next((
        index for index in range(len(fast) - 1, max(0, len(fast) - 4), -1)
        if fast[index - 1] <= slow[index - 1] and fast[index] > slow[index]
    ), None)
    crossed_up_recently = cross_index is not None and fast[-1] >= slow[-1]
    volume_confirmed = current_volume >= previous_volume_sma if previous_volume_sma > 0 else False
    bar_range = max(0.0, float(last_candle.get("high", 0.0) or 0.0) - float(last_candle.get("low", 0.0) or 0.0))
    bullish_close = (
        float(last_candle.get("close", 0.0) or 0.0) >= float(last_candle.get("open", 0.0) or 0.0)
        and (bar_range == 0 or (float(last_candle.get("close", 0.0) or 0.0) - float(last_candle.get("low", 0.0) or 0.0)) >= bar_range * 0.5)
    )

    entry_price = round_to_tick(closes[-1]) or closes[-1]
    recent_low = min(float(c.get("low", entry_price) or entry_price) for c in candles[-3:])
    risk = min(entry_price * 0.8, entry_price - recent_low, atr)
    risk = round_to_tick(risk)
    if risk is None or risk <= 0:
        return {"signal": "NONE", "reason": "Could not form a positive premium stop distance", "atr": atr}

    sl_price = round_to_tick(entry_price - risk)
    target_distance = round_to_tick(risk * rr_ratio)
    tp_price = round_to_tick(entry_price + (target_distance or risk * rr_ratio))
    signal = "BUY" if crossed_up_recently and volume_confirmed and bullish_close else "NONE"
    reason = (
        f"EMA {fast_period}/{slow_period} bullish cross, volume confirmed, and ATM premium ATR {atr:.2f} > {min_atr:.2f}"
        if signal == "BUY"
        else f"No entry: EMA cross={crossed_up_recently}, volume={current_volume:.0f}/{previous_volume_sma:.0f}, bullish close={bullish_close}"
    )
    return {
        "signal": signal,
        "reason": reason,
        "entry_price": entry_price,
        "sl_price": sl_price,
        "tp_price": tp_price,
        "risk": risk,
        "reward": target_distance,
        "rr_ratio": rr_ratio,
        "atr": atr,
        "atr_period": atr_period,
        "candle_range": candle_range,
        "volume": current_volume,
        "vol_sma": previous_volume_sma,
        "fast_ema": fast[-1],
        "slow_ema": slow[-1],
        "signal_bar_time": last_candle.get("time"),
        "cross_bar_time": candles[cross_index].get("time") if cross_index is not None else None,
    }


@dataclass
class AlgoBotConfig:
    enabled: bool = False
    mode: str = "paper"  # "paper" or "live"
    market_mode: str = "indian"
    underlyings: list[str] = field(default_factory=lambda: ["NIFTY", "BANKNIFTY", "SENSEX"])
    fast_ema: int = 9
    slow_ema: int = 15
    atr_threshold: float = 14.0
    atr_period: int = 14
    rr_ratio: float = 2.25
    max_daily_loss_pct: float = 10.0
    forex_max_daily_loss_pct: float = 4.0
    max_drawdown_pct: float = 30.0
    max_consecutive_losses: int = 3
    loss_streak_window_seconds: int = 1800
    risk_pct_per_trade: float = 0.5
    initial_capital: float = 1_000_000.0
    max_loss_limit: float = 0.0  # Optional fixed-currency override; zero uses percentage.
    lots_per_order: int = 1
    max_open_positions: int = 2
    scan_interval_seconds: float = 15.0


class QuantitativeAlgoBot:
    """Background strategy runner with account scoped risk checks and paper first execution."""

    def __init__(
        self,
        db_conn_factory: Callable[[], Any],
        executor_fn: Callable[..., Any],
        square_off_all_fn: Callable[..., Any],
        paper_executor_fn: Callable[..., Any] | None = None,
    ):
        self.db_factory = db_conn_factory
        self.executor_fn = executor_fn
        self.paper_executor_fn = paper_executor_fn
        self.square_off_all_fn = square_off_all_fn
        self.config = AlgoBotConfig()
        self.status = "IDLE"
        self.halt_reason: str | None = None
        self.halt_code: str | None = None
        self.circuit_breaker_triggered = False
        self.trades_history: list[dict[str, Any]] = []
        self.last_scan_time: float = 0.0
        self.last_signals: dict[str, Any] = {}
        self.execution_context: dict[str, Any] = {}
        self.account_id = "ALGO:KOTAK_OWNER"
        self._last_entry_bar: dict[str, str] = {}
        self._peak_equity = 0.0
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._lock = threading.RLock()

    def update_config(self, **kwargs) -> dict[str, Any]:
        with self._lock:
            for key, value in kwargs.items():
                if hasattr(self.config, key):
                    setattr(self.config, key, value)
        return asdict(self.config)

    def start(self, execution_context: dict[str, Any] | None = None, mode: str = "paper") -> dict[str, Any]:
        if mode not in {"paper", "live"}:
            return {"ok": False, "status": self.status, "message": "Execution mode must be paper or live."}
        with self._lock:
            if self.config.enabled:
                return {"ok": False, "status": self.status, "message": "The algo is already running."}
            if self.circuit_breaker_triggered:
                return {"ok": False, "status": self.status, "message": f"Risk halt is active ({self.halt_reason}). Reset it before restarting."}
            self.execution_context = dict(execution_context or {})
            self.config.mode = mode
            self.config.market_mode = "indian"
            self.config.initial_capital = max(1.0, float(self.execution_context.get("base_balance") or self.config.initial_capital))
            raw_account_id = str(self.execution_context.get("account_id") or "KOTAK_OWNER")
            self.account_id = raw_account_id if mode == "live" else f"ALGO:{raw_account_id}"
            self.execution_context["account_id"] = self.account_id
            self.execution_context["market_mode"] = "indian"
            self._peak_equity = self._load_peak_equity()
            self._mark_session_day()
            self.config.enabled = True
            self.status = "RUNNING"
            self.halt_reason = None
            self.halt_code = None
            self._last_entry_bar.clear()
            self._stop_event.clear()
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._run_loop, daemon=True, name="AlgoBotEngine")
                self._thread.start()
        logger.info("Indian option algo started in %s mode", mode)
        return {"ok": True, "status": self.status, "config": asdict(self.config), "account_id": self.account_id}

    def stop(self, square_off: bool = False) -> dict[str, Any]:
        with self._lock:
            self.config.enabled = False
            self.status = "STOPPED"
            self._stop_event.set()
        if square_off and callable(self.square_off_all_fn):
            try:
                self.square_off_all_fn(STRATEGY_ID)
            except Exception as exc:
                logger.error("Error closing algo positions on stop: %s", exc)
        return {"ok": True, "status": self.status}

    def reset_circuit_breaker(self) -> dict[str, Any]:
        risk = self._risk_snapshot()
        if risk["unresolved_orders"] > 0:
            return {
                "ok": False,
                "status": self.status,
                "message": "An algo broker order is still unresolved. Reconcile its status in Kotak Neo before resetting the risk halt.",
            }
        with self._lock:
            self.circuit_breaker_triggered = False
            self.halt_reason = None
            self.halt_code = None
            if self.status.startswith("HALTED"):
                self.status = "STOPPED"
        return {"ok": True, "status": self.status, "message": "Risk halt reset. Press Start to resume."}

    def _load_peak_equity(self) -> float:
        capital = max(1.0, float(self.config.initial_capital))
        try:
            with self.db_factory() as conn:
                row = conn.execute(
                    "SELECT peak_equity FROM algo_risk_state WHERE state_key = ?",
                    (f"{STRATEGY_ID}:{self.account_id}",),
                ).fetchone()
            return max(capital, float(row[0])) if row else capital
        except Exception:
            return capital

    def _persist_peak_equity(self, peak: float) -> None:
        try:
            with self.db_factory() as conn:
                conn.execute(
                    "INSERT INTO algo_risk_state(state_key, peak_equity, updated_at) VALUES(?,?,?) "
                    "ON CONFLICT(state_key) DO UPDATE SET peak_equity = MAX(peak_equity, excluded.peak_equity), updated_at = excluded.updated_at",
                    (f"{STRATEGY_ID}:{self.account_id}", peak, datetime.now(timezone.utc).isoformat()),
                )
                conn.commit()
        except Exception as exc:
            logger.warning("Could not persist algo equity high watermark: %s", exc)

    def _open_trade_rows(self) -> list[dict[str, Any]]:
        with self.db_factory() as conn:
            rows = conn.execute(
                "SELECT * FROM algo_trades WHERE strategy_id = ? AND account_id = ? AND status IN ('OPEN','EXIT_SUBMITTED','EXIT_UNKNOWN') ORDER BY id",
                (STRATEGY_ID, self.account_id),
            ).fetchall()
        return [dict(row) for row in rows]

    def _closed_trade_rows(self) -> list[dict[str, Any]]:
        with self.db_factory() as conn:
            rows = conn.execute(
                "SELECT * FROM algo_trades WHERE strategy_id = ? AND account_id = ? AND status = 'CLOSED' ORDER BY exit_time DESC",
                (STRATEGY_ID, self.account_id),
            ).fetchall()
        return [dict(row) for row in rows]

    def _mark_session_day(self) -> None:
        try:
            now = datetime.now(IST)
            minutes = now.hour * 60 + now.minute
            if now.weekday() >= 5 or not (9 * 60 + 20 <= minutes <= 15 * 60 + 29):
                return
            with self.db_factory() as conn:
                conn.execute(
                    "INSERT OR IGNORE INTO algo_session_days(strategy_id, account_id, trade_date, started_at) VALUES(?,?,?,?)",
                    (STRATEGY_ID, self.account_id, now.strftime("%Y-%m-%d"), datetime.now(timezone.utc).isoformat()),
                )
                conn.commit()
        except Exception as exc:
            logger.warning("Could not record algo session day: %s", exc)

    def compute_current_pnl_with_charges(self) -> dict[str, float]:
        """Mark this strategy's trades to market; ignore unrelated account activity."""
        today = datetime.now(IST).strftime("%Y-%m-%d")
        realized_today = 0.0
        charges_today = 0.0
        realized_all = 0.0
        unrealized = 0.0
        open_charges = 0.0
        unmarked_positions = 0
        open_trades = self._open_trade_rows()
        try:
            with self.db_factory() as conn:
                rows = conn.execute(
                    "SELECT trade_date, COALESCE(SUM(net_pnl),0), COALESCE(SUM(charges),0) "
                    "FROM algo_trades WHERE strategy_id = ? AND account_id = ? AND status = 'CLOSED' GROUP BY trade_date",
                    (STRATEGY_ID, self.account_id),
                ).fetchall()
            for row in rows:
                trade_date, net, charges = str(row[0]), float(row[1] or 0.0), float(row[2] or 0.0)
                realized_all += net
                if trade_date == today:
                    realized_today += net
                    charges_today += charges
        except Exception as exc:
            logger.warning("Could not read algo trade ledger: %s", exc)

        try:
            from app.main import _get_live_quote_data, calculate_statutory_charges
            from decimal import Decimal

            for trade in open_trades:
                quote = _get_live_quote_data(str(trade["symbol"]), token=str(trade.get("instrument_key") or ""))
                quote_age = time.time() - float(quote.get("time") or 0.0)
                if quote.get("is_fallback") or quote_age > 30:
                    unmarked_positions += 1
                    continue
                ltp = float(quote.get("ltp") or 0.0)
                if ltp > 0:
                    entry_price = float(trade["entry_price"])
                    quantity = int(trade["quantity"])
                    entry_fee = calculate_statutory_charges(
                        str(trade.get("exchange_segment") or "nse_fo"), "BUY", quantity, Decimal(str(entry_price))
                    ).get("total", Decimal("0"))
                    exit_fee = calculate_statutory_charges(
                        str(trade.get("exchange_segment") or "nse_fo"), "SELL", quantity, Decimal(str(ltp))
                    ).get("total", Decimal("0"))
                    open_charges += float(entry_fee + exit_fee)
                    unrealized += (ltp - entry_price) * quantity - float(entry_fee + exit_fee)
        except Exception as exc:
            logger.debug("Could not mark algo positions to market: %s", exc)

        return {
            "realized_net": round(realized_today, 2),
            "realized_all": round(realized_all, 2),
            "unrealized_mtm": round(unrealized, 2),
            "charges": round(charges_today + open_charges, 2),
            "net_pnl": round(realized_today + unrealized, 2),
            "equity_pnl": round(realized_all + unrealized, 2),
            "unmarked_positions": float(unmarked_positions),
        }

    def _recent_loss_streak(self) -> int:
        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(seconds=self.config.loss_streak_window_seconds)
        count = 0
        for trade in self._closed_trade_rows():
            try:
                exit_time = datetime.fromisoformat(str(trade.get("exit_time")))
                if exit_time.tzinfo is None:
                    exit_time = exit_time.replace(tzinfo=timezone.utc)
                if exit_time < cutoff or float(trade.get("net_pnl") or 0.0) >= 0:
                    break
                count += 1
                if count >= self.config.max_consecutive_losses:
                    break
            except (TypeError, ValueError):
                break
        return count

    def _risk_snapshot(self) -> dict[str, Any]:
        pnl = self.compute_current_pnl_with_charges()
        cutoff = (datetime.now(timezone.utc) - timedelta(seconds=45)).isoformat()
        try:
            with self.db_factory() as conn:
                unresolved_orders = int(conn.execute(
                    "SELECT COUNT(*) FROM algo_trades WHERE strategy_id=? AND account_id=? AND "
                    "(status IN ('UNKNOWN','EXIT_UNKNOWN') "
                    "OR (status IN ('SUBMITTING','SUBMITTED') AND entry_time < ?) "
                    "OR (status='EXIT_SUBMITTED' AND COALESCE(exit_submitted_at, entry_time) < ?))",
                    (STRATEGY_ID, self.account_id, cutoff, cutoff),
                ).fetchone()[0] or 0)
        except Exception:
            unresolved_orders = 0
        initial_capital = max(1.0, float(self.config.initial_capital))
        # Keep the risk path tolerant of older adapters and lightweight test
        # providers that only return the public `net_pnl` field.
        raw_net_pnl = pnl.get("net_pnl")
        net_pnl = (float(raw_net_pnl) if raw_net_pnl is not None else
                   float(pnl.get("realized_net") or 0.0) + float(pnl.get("unrealized_mtm") or 0.0))
        raw_equity_pnl = pnl.get("equity_pnl")
        equity_pnl = float(raw_equity_pnl if raw_equity_pnl is not None else net_pnl)
        equity = initial_capital + equity_pnl
        self._peak_equity = max(self._peak_equity, equity)
        self._persist_peak_equity(self._peak_equity)
        drawdown_pct = max(0.0, (self._peak_equity - equity) / max(1.0, self._peak_equity) * 100.0)
        pct_limit = initial_capital * self.config.max_daily_loss_pct / 100.0
        daily_limit = min(pct_limit, float(self.config.max_loss_limit)) if self.config.max_loss_limit > 0 else pct_limit
        return {
            **pnl,
            "equity_pnl": round(equity_pnl, 2),
            "net_pnl": round(net_pnl, 2),
            "equity": round(equity, 2),
            "peak_equity": round(self._peak_equity, 2),
            "drawdown_pct": round(drawdown_pct, 2),
            "daily_loss_limit": round(daily_limit, 2),
            "daily_loss_pct": round(max(0.0, -net_pnl) / initial_capital * 100.0, 2),
            "unmarked_positions": int(pnl.get("unmarked_positions", 0) or 0),
            "loss_streak": self._recent_loss_streak(),
            "unresolved_orders": unresolved_orders,
            "pending_exits": self._count_pending_exits(),
        }

    def _count_pending_exits(self) -> int:
        try:
            with self.db_factory() as conn:
                return int(conn.execute(
                    "SELECT COUNT(*) FROM algo_trades WHERE strategy_id=? AND account_id=? AND status='EXIT_SUBMITTED'",
                    (STRATEGY_ID, self.account_id),
                ).fetchone()[0] or 0)
        except Exception:
            return 0

    def check_circuit_breaker(self) -> bool:
        risk = self._risk_snapshot()
        from app.execution import is_rust_execution_available, risk_halt_code

        if is_rust_execution_available():
            try:
                code = risk_halt_code(
                    daily_net_pnl=float(risk["net_pnl"]),
                    daily_loss_limit=float(risk["daily_loss_limit"]),
                    drawdown_pct=float(risk["drawdown_pct"]),
                    max_drawdown_pct=float(self.config.max_drawdown_pct),
                    loss_streak=int(risk["loss_streak"]),
                    max_consecutive_losses=int(self.config.max_consecutive_losses),
                    unresolved_orders=int(risk["unresolved_orders"]),
                    unmarked_positions=int(risk["unmarked_positions"]),
                )
                reason = None
            except Exception:
                logger.exception("Rust risk check failed; stopping algo entries")
                code = "RISK_ENGINE_FAILURE"
                reason = "Rust risk validation failed. New entries are halted until the engine is reviewed."
        else:
            code = None
            if risk["unresolved_orders"] > 0:
                code = "ORDER_UNCERTAIN"
            elif risk["unmarked_positions"] > 0:
                code = "MARKET_DATA"
            elif risk["net_pnl"] <= -risk["daily_loss_limit"]:
                code = "DAILY_LOSS"
            elif risk["drawdown_pct"] >= self.config.max_drawdown_pct:
                code = "MAX_DRAWDOWN"
            elif risk["loss_streak"] >= self.config.max_consecutive_losses:
                code = "LOSS_STREAK"
            reason = None

        if code and not reason:
            reason = {
                "ORDER_UNCERTAIN": "Kotak order status could not be reconciled. New entries are halted; check the broker order book before restarting.",
                "MARKET_DATA": "Live MTM is unavailable for an open algo position. New entries are halted until the risk halt is reset.",
                "DAILY_LOSS": f"Daily loss limit reached: {abs(risk['net_pnl']):.2f} of {risk['daily_loss_limit']:.2f} INR. New entries are halted.",
                "MAX_DRAWDOWN": f"Maximum drawdown reached: {risk['drawdown_pct']:.2f}% against {self.config.max_drawdown_pct:.2f}%. New entries are halted.",
                "LOSS_STREAK": f"{self.config.max_consecutive_losses} consecutive losing trades closed within {self.config.loss_streak_window_seconds // 60} minutes. New entries are halted.",
            }.get(code, "Risk control requested a halt. New entries are halted until reviewed.")
        if not code:
            return False
        reason = f"CRITICAL CIRCUIT BREAKER TRIPPED: {reason}"

        with self._lock:
            if self.circuit_breaker_triggered:
                return True
            self.circuit_breaker_triggered = True
            self.status = f"HALTED_{code}"
            self.halt_code = code
            self.halt_reason = reason
            self.config.enabled = False
            self._stop_event.set()
        logger.critical(reason)
        if code != "ORDER_UNCERTAIN" and callable(self.square_off_all_fn):
            try:
                try:
                    parameters = inspect.signature(self.square_off_all_fn).parameters.values()
                    accepts_argument = any(parameter.kind in (parameter.POSITIONAL_ONLY, parameter.POSITIONAL_OR_KEYWORD, parameter.VAR_POSITIONAL) for parameter in parameters)
                except (TypeError, ValueError):
                    accepts_argument = True
                self.square_off_all_fn(STRATEGY_ID) if accepts_argument else self.square_off_all_fn()
            except Exception as exc:
                logger.error("Could not close algo positions during risk halt: %s", exc)
        return True

    def _performance_summary(self) -> dict[str, Any]:
        daily_rows: list[tuple[str, float, float, float, int, int, int]] = []
        closed_rows: list[dict[str, Any]] = []
        try:
            with self.db_factory() as conn:
                closed_rows = [dict(row) for row in conn.execute(
                    "SELECT trade_date, entry_time, exit_time, quantity, trailing_dist, gross_pnl, charges, net_pnl "
                    "FROM algo_trades WHERE strategy_id = ? AND account_id = ? AND status = 'CLOSED' ORDER BY exit_time, id",
                    (STRATEGY_ID, self.account_id),
                ).fetchall()]
                rows = conn.execute(
                    "SELECT d.trade_date, COALESCE(SUM(t.gross_pnl),0), COALESCE(SUM(t.charges),0), "
                    "COALESCE(SUM(t.net_pnl),0), COUNT(t.id), "
                    "SUM(CASE WHEN t.net_pnl > 0 THEN 1 ELSE 0 END), "
                    "SUM(CASE WHEN t.net_pnl < 0 THEN 1 ELSE 0 END) FROM algo_session_days d "
                    "LEFT JOIN algo_trades t ON t.strategy_id=d.strategy_id AND t.account_id=d.account_id "
                    "AND t.trade_date=d.trade_date AND t.status='CLOSED' "
                    "WHERE d.strategy_id=? AND d.account_id=? GROUP BY d.trade_date ORDER BY d.trade_date",
                    (STRATEGY_ID, self.account_id),
                ).fetchall()
                daily_rows = [(
                    str(row[0]), float(row[1] or 0.0), float(row[2] or 0.0), float(row[3] or 0.0),
                    int(row[4] or 0), int(row[5] or 0), int(row[6] or 0),
                ) for row in rows]
        except Exception:
            pass
        total_trades = len(closed_rows)
        wins = [row for row in closed_rows if float(row.get("net_pnl") or 0.0) > 0]
        losses = [row for row in closed_rows if float(row.get("net_pnl") or 0.0) < 0]
        breakeven = [row for row in closed_rows if float(row.get("net_pnl") or 0.0) == 0]
        gross_profit = sum(max(0.0, float(row.get("gross_pnl") or 0.0)) for row in closed_rows)
        gross_loss = abs(sum(min(0.0, float(row.get("gross_pnl") or 0.0)) for row in closed_rows))
        total_charges = sum(float(row.get("charges") or 0.0) for row in closed_rows)
        net_profit = sum(float(row.get("net_pnl") or 0.0) for row in closed_rows)
        daily_performance: list[dict[str, Any]] = []
        returns: list[float] = []
        equity = max(1.0, float(self.config.initial_capital))
        peak = equity
        max_drawdown = 0.0
        for day, gross, charges, pnl, count, daily_wins, daily_losses in daily_rows:
            daily_return = pnl / equity if equity > 0 else 0.0
            returns.append(daily_return)
            equity += pnl
            peak = max(peak, equity)
            max_drawdown = max(max_drawdown, (peak - equity) / peak if peak > 0 else 0.0)
            daily_performance.append({
                "date": day,
                "trades": count,
                "wins": daily_wins,
                "losses": daily_losses,
                "gross_pnl": round(gross, 2),
                "charges": round(charges, 2),
                "net_pnl": round(pnl, 2),
                "return_pct": round(daily_return * 100.0, 4),
                "equity": round(equity, 2),
            })
        sharpe = None
        if len(returns) >= 2:
            stddev = statistics.stdev(returns)
            if stddev > 0:
                sharpe = round(statistics.mean(returns) / stddev * math.sqrt(252.0), 2)
        avg_win = statistics.mean(float(row.get("net_pnl") or 0.0) for row in wins) if wins else 0.0
        avg_loss = statistics.mean(float(row.get("net_pnl") or 0.0) for row in losses) if losses else 0.0
        trade_r_values = []
        holding_minutes = []
        for row in closed_rows:
            risk_cash = float(row.get("trailing_dist") or 0.0) * int(row.get("quantity") or 0)
            if risk_cash > 0:
                trade_r_values.append(float(row.get("net_pnl") or 0.0) / risk_cash)
            try:
                entry_dt = datetime.fromisoformat(str(row.get("entry_time") or "").replace("Z", "+00:00"))
                exit_dt = datetime.fromisoformat(str(row.get("exit_time") or "").replace("Z", "+00:00"))
                holding_minutes.append(max(0.0, (exit_dt - entry_dt).total_seconds() / 60.0))
            except (TypeError, ValueError, OverflowError):
                pass
        loss_streak = win_streak = max_loss_streak = max_win_streak = 0
        for row in closed_rows:
            net = float(row.get("net_pnl") or 0.0)
            if net < 0:
                loss_streak += 1
                win_streak = 0
            elif net > 0:
                win_streak += 1
                loss_streak = 0
            else:
                loss_streak = win_streak = 0
            max_loss_streak = max(max_loss_streak, loss_streak)
            max_win_streak = max(max_win_streak, win_streak)
        return {
            "closed_trades": total_trades,
            "winning_trades": len(wins),
            "losing_trades": len(losses),
            "breakeven_trades": len(breakeven),
            "win_rate_pct": round(len(wins) / total_trades * 100.0, 2) if total_trades else 0.0,
            "gross_profit": round(gross_profit, 2),
            "gross_loss": round(gross_loss, 2),
            "total_charges": round(total_charges, 2),
            "net_pnl": round(net_profit, 2),
            "return_pct": round(net_profit / max(1.0, self.config.initial_capital) * 100.0, 2),
            "profit_factor": round(sum(float(row.get("net_pnl") or 0.0) for row in wins) / abs(sum(float(row.get("net_pnl") or 0.0) for row in losses)), 2) if losses else (None if not wins else "unbounded"),
            "gross_profit_factor": round(gross_profit / gross_loss, 2) if gross_loss else (None if not gross_profit else "unbounded"),
            "average_win": round(avg_win, 2),
            "average_loss": round(avg_loss, 2),
            "expectancy_per_trade": round(net_profit / total_trades, 2) if total_trades else 0.0,
            "payoff_ratio": round(avg_win / abs(avg_loss), 2) if avg_loss else (None if not avg_win else "unbounded"),
            "average_r_multiple": round(statistics.mean(trade_r_values), 3) if trade_r_values else 0.0,
            "average_holding_minutes": round(statistics.mean(holding_minutes), 2) if holding_minutes else 0.0,
            "best_trade": round(max((float(row.get("net_pnl") or 0.0) for row in closed_rows), default=0.0), 2),
            "worst_trade": round(min((float(row.get("net_pnl") or 0.0) for row in closed_rows), default=0.0), 2),
            "max_consecutive_wins": max_win_streak,
            "max_consecutive_losses": max_loss_streak,
            "max_drawdown_pct": round(max_drawdown * 100.0, 2),
            "session_days": len(daily_rows),
            "daily_performance": daily_performance,
            "sharpe_ratio": sharpe,
            "sharpe_target": 1.30,
            "max_drawdown_target_pct": self.config.max_drawdown_pct,
        }

    def get_status(self) -> dict[str, Any]:
        risk = self._risk_snapshot()
        return {
            "ok": True,
            "status": self.status,
            "running": self.config.enabled,
            "enabled": self.config.enabled,
            "circuit_breaker_triggered": self.circuit_breaker_triggered,
            "circuit_breaker_halted": self.circuit_breaker_triggered,
            "halt_code": self.halt_code,
            "halt_reason": self.halt_reason,
            "last_reason": self.halt_reason,
            "config": asdict(self.config),
            "pnl": risk,
            "realized_pnl": risk["realized_net"],
            "unrealized_pnl": risk["unrealized_mtm"],
            "statutory_charges": risk["charges"],
            "net_pnl": risk["net_pnl"],
            "daily_loss_limit": risk["daily_loss_limit"],
            "daily_loss_pct": risk["daily_loss_pct"],
            "drawdown_pct": risk["drawdown_pct"],
            "loss_streak": risk["loss_streak"],
            "account_id": self.account_id,
            "performance": self._performance_summary(),
            "total_trades": len(self.trades_history),
            "recent_trades": self.trades_history[-25:],
            "last_scan_time": self.last_scan_time,
            "last_signals": self.last_signals,
        }

    def _run_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                if self.config.mode == "live":
                    from app.main import LIVE_TRADING_ENABLED, _reconcile_algo_orders, neo_authenticated, neo_client
                    if not (LIVE_TRADING_ENABLED and neo_authenticated and neo_client is not None):
                        with self._lock:
                            self.config.enabled = False
                            self.circuit_breaker_triggered = True
                            self.status = "HALTED_BROKER_SESSION"
                            self.halt_code = "BROKER_SESSION"
                            self.halt_reason = "Kotak live session is no longer available. New entries are halted."
                            self._stop_event.set()
                        break
                    _reconcile_algo_orders(STRATEGY_ID, self.account_id)
                self._mark_session_day()
                if not self.config.enabled or self.check_circuit_breaker():
                    break
                self.last_scan_time = time.time()
                self._execute_scan_pass()
            except Exception as exc:
                logger.exception("Algo scan failed: %s", exc)
            time.sleep(max(0.5, self.config.scan_interval_seconds))

    def _execute_scan_pass(self) -> None:
        from app.main import _is_indian_market_open

        now = datetime.now(IST)
        if not _is_indian_market_open(now):
            return
        if (now.hour * 60 + now.minute) < (9 * 60 + 20) or (now.hour * 60 + now.minute) > (15 * 60 + 28):
            return
        if self.check_circuit_breaker():
            return
        if self._count_pending_exits():
            return
        for underlying in list(self.config.underlyings):
            if not self.config.enabled or self.circuit_breaker_triggered:
                break
            try:
                self._scan_underlying_options(underlying)
            except Exception as exc:
                logger.warning("Scan error on %s: %s", underlying, exc)

    def _scan_underlying_options(self, underlying: str) -> None:
        from app.main import (
            OrderPayload,
            _fetch_historical_or_intraday_candles,
            _get_live_quote_data,
            chart_option_chain,
        )

        chain = chart_option_chain(symbol=underlying)
        if not chain or not chain.get("ok") or chain.get("market_data_source") != "live":
            self.last_signals[f"{underlying}:status"] = {"signal": "NONE", "reason": "Live option chain unavailable; synthetic chain data is never traded."}
            return
        rows = chain.get("chain") or []
        spot = float(chain.get("spot_price") or 0.0)
        if not rows or spot <= 0:
            return
        atm = min(rows, key=lambda row: abs(float(row.get("strike") or 0.0) - spot))
        candidates = []
        for side, prefix in (("CE", "call"), ("PE", "put")):
            token = str(atm.get(f"{prefix}_token") or "")
            symbol = str(atm.get(f"{prefix}_trading_symbol") or "").strip().upper()
            if not token or not symbol or float(atm.get(f"{prefix}_ltp") or 0.0) <= 0:
                continue
            candidates.append({
                "option_type": side,
                "symbol": symbol,
                "token": token,
                "lot_size": int(atm.get("lot_size") or 1),
                "segment": "bse_fo" if underlying.upper() == "SENSEX" else "nse_fo",
            })

        for option in candidates:
            symbol = option["symbol"]
            market = _get_live_quote_data(symbol, token=option["token"])
            quote_age = time.time() - float(market.get("time") or 0.0)
            if market.get("is_fallback") or float(market.get("ltp") or 0.0) <= 0 or quote_age > 15:
                self.last_signals[symbol] = {"signal": "NONE", "reason": "Live ATM premium quote unavailable."}
                continue
            candle_data = _fetch_historical_or_intraday_candles(
                symbol, token=option["token"], requested_days=2, now_dt=datetime.now(IST),
                require_current_session=False,
            )
            candles = (candle_data or {}).get("candles") or []
            scan_now = datetime.now(IST)
            latest_bar = datetime.fromtimestamp(int(candles[-1]["time"]), IST) if candles else None
            if (
                (candle_data or {}).get("source") != "upstox_live"
                or len(candles) < 22
                or latest_bar is None
                or latest_bar.date() != scan_now.date()
                or scan_now.timestamp() - latest_bar.timestamp() > 150
            ):
                self.last_signals[symbol] = {"signal": "NONE", "reason": "Insufficient live, closed option premium candles."}
                continue
            result = evaluate_crossover_signal(
                candles,
                fast_period=self.config.fast_ema,
                slow_period=self.config.slow_ema,
                min_atr=self.config.atr_threshold,
                rr_ratio=self.config.rr_ratio,
                atr_period=self.config.atr_period,
            )
            self.last_signals[symbol] = result
            if result["signal"] != "BUY":
                continue

            signal_bar = str(result.get("cross_bar_time") or result.get("signal_bar_time") or "")
            try:
                if datetime.fromtimestamp(int(float(signal_bar)), IST).date() != scan_now.date():
                    self.last_signals[symbol]["signal"] = "NONE"
                    self.last_signals[symbol]["reason"] = "The latest crossover came from an earlier session."
                    continue
            except (TypeError, ValueError, OverflowError, OSError):
                self.last_signals[symbol]["signal"] = "NONE"
                self.last_signals[symbol]["reason"] = "The signal candle time could not be validated."
                continue
            if self._last_entry_bar.get(symbol) == signal_bar:
                continue
            if self.check_circuit_breaker():
                return

            with self.db_factory() as conn:
                open_rows = conn.execute(
                    "SELECT symbol FROM algo_trades WHERE strategy_id = ? AND account_id = ? AND status IN ('OPEN','SUBMITTING','SUBMITTED','UNKNOWN','EXIT_SUBMITTED','EXIT_UNKNOWN')",
                    (STRATEGY_ID, self.account_id),
                ).fetchall()
                prior_signal = conn.execute(
                    "SELECT id FROM algo_trades WHERE strategy_id=? AND account_id=? AND UPPER(symbol)=UPPER(?) AND signal_bar_time=? LIMIT 1",
                    (STRATEGY_ID, self.account_id, symbol, signal_bar),
                ).fetchone()
            if prior_signal:
                self._last_entry_bar[symbol] = signal_bar
                continue
            if any(str(row[0]).upper() == symbol for row in open_rows):
                continue
            if self.config.max_open_positions > 0 and len(open_rows) >= self.config.max_open_positions:
                self.last_signals[symbol]["reason"] = f"Open position limit reached ({self.config.max_open_positions})."
                continue

            entry_price = float(market["ltp"])
            initial_risk_distance = float(result["risk"])
            sl_price = round_to_tick(entry_price - initial_risk_distance)
            if not sl_price or sl_price >= entry_price:
                self.last_signals[symbol]["reason"] = "The rounded stop price is invalid."
                continue
            risk_distance = entry_price - sl_price
            tp_price = round_to_tick(entry_price + risk_distance * self.config.rr_ratio)
            if not tp_price or tp_price <= entry_price:
                self.last_signals[symbol]["reason"] = "The rounded target price is invalid."
                continue
            lot_size = option["lot_size"]
            from app.execution import calculate_option_position_size
            sizing = calculate_option_position_size(
                initial_capital=self.config.initial_capital,
                risk_pct_per_trade=self.config.risk_pct_per_trade,
                entry_price=entry_price,
                stop_price=sl_price,
                lot_size=lot_size,
                max_lots=self.config.lots_per_order,
            )
            lots = int(sizing["lots"])
            if lots < 1:
                self.last_signals[symbol]["reason"] = "One lot exceeds the configured per trade risk budget."
                continue

            quantity = int(sizing["quantity"])
            timestamp = datetime.now(timezone.utc).isoformat()
            trade_date = datetime.now(IST).strftime("%Y-%m-%d")
            with self.db_factory() as conn:
                cur = conn.execute(
                    """INSERT INTO algo_trades(
                        strategy_id, account_id, trade_date, symbol, option_type, instrument_key,
                        exchange_segment, product, entry_time, signal_bar_time, entry_price, quantity, lot_size,
                        sl_price, tp_price, trailing_dist, status
                    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        STRATEGY_ID, self.account_id, trade_date, symbol, option["option_type"],
                        option["token"], option["segment"], "MIS", timestamp, signal_bar, entry_price,
                        quantity, lot_size, sl_price, tp_price, risk_distance, "SUBMITTING",
                    ),
                )
                trade_id = int(cur.lastrowid)
                conn.commit()
            self._last_entry_bar[symbol] = signal_bar
            payload = OrderPayload(
                symbol=symbol,
                instrument_token=option["token"],
                side="BUY",
                lots=lots,
                lot_size=lot_size,
                exchange_segment=option["segment"],
                product="MIS",
                order_type="MKT",
                price=entry_price,
                sl_price=sl_price,
                tp_price=tp_price,
                trailing_dist=risk_distance,
                strategy_id=STRATEGY_ID,
                auto_sltp=True,
                validity="DAY",
                user_confirmed=True,
            )
            try:
                if self.config.mode == "live":
                    response = self.executor_fn(payload)
                elif self.paper_executor_fn:
                    response = self.paper_executor_fn(payload, self.execution_context)
                else:
                    raise RuntimeError("Paper order executor is unavailable.")
                if not response or not response.get("ok"):
                    raise RuntimeError(str((response or {}).get("message") or "Order was not accepted"))
                filled_entry = float(response.get("price") or entry_price)
                quantity = int(response.get("quantity") or quantity)
                sl_price = float(response.get("sl_price") or sl_price)
                tp_price = float(response.get("tp_price") or tp_price)
                order_id = str(response.get("broker_order_id") or response.get("id") or "")
                trade_status = "SUBMITTED" if self.config.mode == "live" else "OPEN"
                with self.db_factory() as conn:
                    conn.execute(
                        "UPDATE algo_trades SET status=?, entry_price=?, quantity=?, sl_price=?, tp_price=?, order_id=? WHERE id=?",
                        (
                            trade_status, filled_entry, quantity, sl_price, tp_price, order_id, trade_id,
                        ),
                    )
                    conn.commit()
                trade_record = {
                    "timestamp": timestamp,
                    "symbol": symbol,
                    "signal": "BUY",
                    "option_type": option["option_type"],
                    "lots": lots,
                    "quantity": quantity,
                    "entry_price": filled_entry,
                    "sl_price": sl_price,
                    "tp_price": tp_price,
                    "rr_ratio": self.config.rr_ratio,
                    "atr": result["atr"],
                    "status": trade_status,
                    "result": response,
                }
                self.trades_history.append(trade_record)
                self.last_signals[symbol] = {**result, "entry_status": trade_record["status"]}
                logger.info(
                    "Algo BUY %s @ %.2f | SL %.2f | TP %.2f | RR 1:%.2f | ATR %.2f",
                    symbol, filled_entry, sl_price, tp_price, self.config.rr_ratio, result["atr"],
                )
                return
            except Exception as exc:
                error_text = str(exc)
                unresolved = self.config.mode == "live" and "uncertain" in error_text.lower()
                with self.db_factory() as conn:
                    conn.execute(
                        "UPDATE algo_trades SET status=?, exit_reason=? WHERE id=?",
                        ("UNKNOWN" if unresolved else "FAILED", error_text[:240], trade_id),
                    )
                    conn.commit()
                logger.error("Algo order failed for %s: %s", symbol, exc)
                return
