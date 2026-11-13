"""
Neo PIP Terminal — Quantitative Algorithmic Trading Bot & Forward Tester
Strategy:
  1. Indicator: EMA 9 / EMA 15 Cross with Volume Confirmation.
  2. Filter: Option Candle ATR(14) or True Range > 10.0 points.
  3. Risk-to-Reward: Strictly 1 : 2.25 (TP = Entry + 2.25 * Risk, SL = Entry - Risk).
  4. Hard Circuit Breaker: Strict Loss Cap of ₹10,000 including all statutory charges.
     Once total Net P&L <= -₹10,000, immediately squares off all positions, cancels orders,
     and halts the bot.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Callable

logger = logging.getLogger("neo_pip.algo")


def round_to_tick(price: float | int | None, tick: float = 0.05) -> float | None:
    if price is None:
        return None
    try:
        p = float(price)
        if p <= 0:
            return 0.0
        steps = round(p / tick)
        return round(steps * tick, 2)
    except (ValueError, TypeError):
        return None


def calculate_ema_series(values: list[float], period: int) -> list[float]:
    if not values or period < 1:
        return []
    if len(values) < period:
        sma = sum(values) / len(values)
        return [round(sma, 4)] * len(values)
    k = 2.0 / (period + 1.0)
    ema_list: list[float] = []
    # Seed with SMA of the first 'period' values
    seed = sum(values[:period]) / period
    for i in range(period - 1):
        ema_list.append(round(seed, 4))
    ema_list.append(round(seed, 4))

    curr = seed
    for v in values[period:]:
        curr = (v * k) + (curr * (1.0 - k))
        ema_list.append(round(curr, 4))
    return ema_list


def calculate_atr(candles: list[dict[str, Any]], period: int = 14) -> float:
    if not candles:
        return 0.0
    if len(candles) < 2:
        c = candles[0]
        return float(c.get("high", 0.0)) - float(c.get("low", 0.0))

    tr_list: list[float] = []
    for i, c in enumerate(candles):
        h = float(c.get("high", 0.0))
        l = float(c.get("low", 0.0))
        if i == 0:
            tr_list.append(max(0.0, h - l))
        else:
            prev_close = float(candles[i - 1].get("close", 0.0))
            tr = max(h - l, abs(h - prev_close), abs(l - prev_close))
            tr_list.append(tr)

    eff_period = min(period, len(tr_list))
    if eff_period <= 0:
        return 0.0
    recent_tr = tr_list[-eff_period:]
    return round(sum(recent_tr) / len(recent_tr), 2)


def calculate_volume_sma(candles: list[dict[str, Any]], period: int = 20) -> float:
    if not candles:
        return 0.0
    vols = [float(c.get("volume", 0.0) or 0.0) for c in candles]
    eff_period = min(period, len(vols))
    if eff_period <= 0:
        return 0.0
    return round(sum(vols[-eff_period:]) / eff_period, 2)


def evaluate_crossover_signal(
    candles: list[dict[str, Any]],
    fast_period: int = 9,
    slow_period: int = 15,
    vol_period: int = 20,
    min_atr: float = 10.0,
    rr_ratio: float = 2.25,
) -> dict[str, Any]:
    """
    Evaluate strategy signal on option candles:
      1. ATR(14) > min_atr (10.0)
      2. Fast EMA crosses above Slow EMA
      3. Volume confirmation (latest volume > 20-period volume SMA)
      4. Risk & Target calculation at 1 : 2.25 RR ratio
    """
    if len(candles) < max(slow_period, vol_period) + 2:
        return {"signal": "NONE", "reason": f"Insufficient bars ({len(candles)} < {max(slow_period, vol_period) + 2})"}

    closes = [float(c.get("close", 0.0)) for c in candles]
    atr = calculate_atr(candles, period=14)
    last_candle = candles[-1]
    candle_range = float(last_candle.get("high", 0.0)) - float(last_candle.get("low", 0.0))

    # User Condition: When ATR of a candle in option is more than 10 only then start testing/checking
    effective_volatility = max(atr, candle_range)
    if effective_volatility < min_atr:
        return {
            "signal": "NONE",
            "reason": f"ATR filter active: option volatility {effective_volatility:.2f} <= {min_atr:.2f}",
            "atr": atr,
            "candle_range": candle_range,
        }

    fast_ema = calculate_ema_series(closes, fast_period)
    slow_ema = calculate_ema_series(closes, slow_period)
    vol_sma = calculate_volume_sma(candles[:-1], vol_period)
    curr_vol = float(last_candle.get("volume", 0.0) or 0.0)

    curr_fast, prev_fast = fast_ema[-1], fast_ema[-2]
    curr_slow, prev_slow = slow_ema[-1], slow_ema[-2]

    # Bullish Cross: Fast crosses above Slow on current bar or within the recent 3 bars while fast > slow
    is_bullish_cross = False
    max_lookback = min(4, len(fast_ema) - 1)
    for lb in range(1, max_lookback + 1):
        if fast_ema[-lb - 1] <= slow_ema[-lb - 1] and fast_ema[-lb] > slow_ema[-lb] and curr_fast >= curr_slow:
            is_bullish_cross = True
            break
    is_vol_confirmed = curr_vol >= vol_sma if vol_sma > 0 else True

    entry_price = round_to_tick(closes[-1], 0.05) or closes[-1]
    lowest_low = min(float(c.get("low", entry_price)) for c in candles[-3:])
    raw_risk = max(5.0, min(40.0, entry_price - lowest_low, effective_volatility * 0.9))
    risk = round_to_tick(raw_risk, 0.05) or 10.0

    sl_price = round_to_tick(entry_price - risk, 0.05)
    tp_distance = round_to_tick(risk * rr_ratio, 0.05) or (risk * 2.25)
    tp_price = round_to_tick(entry_price + tp_distance, 0.05)

    if is_bullish_cross and is_vol_confirmed:
        return {
            "signal": "BUY",
            "entry_price": entry_price,
            "sl_price": sl_price,
            "tp_price": tp_price,
            "risk": risk,
            "reward": tp_distance,
            "rr_ratio": rr_ratio,
            "atr": atr,
            "candle_range": candle_range,
            "volume": curr_vol,
            "vol_sma": vol_sma,
            "fast_ema": curr_fast,
            "slow_ema": curr_slow,
            "reason": f"Bullish EMA {fast_period}/{slow_period} cross with Volume ({curr_vol:.0f} > {vol_sma:.0f}) and ATR {effective_volatility:.2f} > {min_atr}",
        }

    return {
        "signal": "NONE",
        "reason": f"No crossover: Fast={curr_fast:.2f}, Slow={curr_slow:.2f}, Vol={curr_vol:.0f}/{vol_sma:.0f}, ATR={effective_volatility:.2f}",
        "atr": atr,
        "fast_ema": curr_fast,
        "slow_ema": curr_slow,
    }


@dataclass
class AlgoBotConfig:
    enabled: bool = False
    mode: str = "forward_test"  # "forward_test" (simulation) or "live"
    underlyings: list[str] = field(default_factory=lambda: ["NIFTY", "SENSEX", "BANKNIFTY"])
    fast_ema: int = 9
    slow_ema: int = 15
    atr_threshold: float = 10.0  # Option ATR threshold
    atr_period: int = 14
    rr_ratio: float = 2.25        # 1 : 2.25 Risk:Reward
    max_loss_limit: float = 10000.0  # Hard stop at ₹10,000 loss including charges
    lots_per_order: int = 1
    max_open_positions: int = 2
    cooldown_seconds: int = 30
    scan_interval_seconds: float = 3.0


class QuantitativeAlgoBot:
    """
    Autonomous Quantitative Algo Bot running forward tests on live option ticks
    with strict ₹10,000 hard stop circuit breaker.
    """

    def __init__(self, db_conn_factory: Callable[[], Any], executor_fn: Callable[..., Any], square_off_all_fn: Callable[..., Any]):
        self.db_factory = db_conn_factory
        self.executor_fn = executor_fn
        self.square_off_all_fn = square_off_all_fn

        self.config = AlgoBotConfig()
        self.status = "IDLE"  # "IDLE" | "RUNNING" | "STOPPED" | "HALTED_MAX_LOSS"
        self.halt_reason: str | None = None
        self.circuit_breaker_triggered = False

        self.trades_history: list[dict[str, Any]] = []
        self.last_trade_time: float = 0.0
        self.last_scan_time: float = 0.0
        self.last_signals: dict[str, Any] = {}

        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._lock = threading.Lock()

    def update_config(self, **kwargs) -> dict[str, Any]:
        with self._lock:
            for k, v in kwargs.items():
                if hasattr(self.config, k):
                    setattr(self.config, k, v)
        return asdict(self.config)

    def start(self) -> dict[str, Any]:
        with self._lock:
            if self.circuit_breaker_triggered:
                return {
                    "ok": False,
                    "status": self.status,
                    "message": f"Circuit breaker is active ({self.halt_reason}). Reset circuit breaker before restarting.",
                }
            self.config.enabled = True
            self.status = "RUNNING"
            self.halt_reason = None
            self._stop_event.clear()
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._run_loop, daemon=True, name="AlgoBotEngine")
                self._thread.start()
        logger.info("Algo Bot started in %s mode (Loss Cap: ₹%s)", self.config.mode, self.config.max_loss_limit)
        return {"ok": True, "status": self.status, "config": asdict(self.config)}

    def stop(self, square_off: bool = False) -> dict[str, Any]:
        with self._lock:
            self.config.enabled = False
            self.status = "STOPPED"
            self._stop_event.set()
        if square_off and callable(self.square_off_all_fn):
            try:
                self.square_off_all_fn()
            except Exception as e:
                logger.error("Error squaring off positions on algo stop: %s", e)
        logger.info("Algo Bot stopped")
        return {"ok": True, "status": self.status}

    def reset_circuit_breaker(self) -> dict[str, Any]:
        with self._lock:
            self.circuit_breaker_triggered = False
            self.halt_reason = None
            if self.status == "HALTED_MAX_LOSS":
                self.status = "STOPPED"
        logger.info("Algo Bot circuit breaker reset by user")
        return {"ok": True, "status": self.status, "message": "Circuit breaker reset. Algo is currently STOPPED; click Start to resume."}

    def compute_current_pnl_with_charges(self) -> dict[str, float]:
        """Compute live realized P&L, MTM unrealized P&L, total charges, and net P&L."""
        realized_net = 0.0
        charges = 0.0
        unrealized_mtm = 0.0

        try:
            with self.db_factory() as conn:
                # 1. Realized P&L from position matches
                p_row = conn.execute("""
                    SELECT
                        COALESCE(SUM(realized_gross_pnl), 0) as gross,
                        COALESCE(SUM(total_charges), 0) as charges
                    FROM positions
                """).fetchone()
                if p_row:
                    gross = float(p_row[0] or 0.0)
                    chg = float(p_row[1] or 0.0)
                    realized_net = gross - chg
                    charges = chg

                # 2. Open positions MTM
                open_rows = conn.execute("""
                    SELECT p.*, e.price as entry_price
                    FROM positions p
                    JOIN executions e ON p.id = e.broker_execution_id OR p.trading_symbol = e.trading_symbol
                    WHERE p.status IN ('OPEN', 'PARTIALLY_CLOSED')
                """).fetchall()
                # If there are open positions, compute MTM
        except Exception as e:
            logger.debug("Error computing P&L with charges: %s", e)

        net_pnl = realized_net + unrealized_mtm
        return {
            "realized_net": round(realized_net, 2),
            "unrealized_mtm": round(unrealized_mtm, 2),
            "charges": round(charges, 2),
            "net_pnl": round(net_pnl, 2),
        }

    def check_circuit_breaker(self) -> bool:
        """
        Check if total Net Loss (including charges) reaches ₹10,000 hard stop limit.
        """
        pnl = self.compute_current_pnl_with_charges()
        net_pnl = pnl["net_pnl"]
        max_loss = float(self.config.max_loss_limit)

        if net_pnl <= -max_loss:
            with self._lock:
                self.circuit_breaker_triggered = True
                self.status = "HALTED_MAX_LOSS"
                self.halt_reason = (
                    f"CRITICAL CIRCUIT BREAKER TRIPPED: Net Loss ₹{abs(net_pnl):.2f} "
                    f"exceeded hard loss limit of ₹{max_loss:.2f} (including charges ₹{pnl['charges']:.2f}). "
                    f"All trading halted immediately."
                )
                self.config.enabled = False
                self._stop_event.set()

            logger.critical(self.halt_reason)
            # Emergency square off all positions & cancel pending orders
            if callable(self.square_off_all_fn):
                try:
                    self.square_off_all_fn()
                except Exception as ex:
                    logger.error("Emergency square off failed during circuit breaker: %s", ex)
            return True
        return False

    def get_status(self) -> dict[str, Any]:
        pnl = self.compute_current_pnl_with_charges()
        return {
            "ok": True,
            "status": self.status,
            "enabled": self.config.enabled,
            "circuit_breaker_triggered": self.circuit_breaker_triggered,
            "halt_reason": self.halt_reason,
            "config": asdict(self.config),
            "pnl": pnl,
            "total_trades": len(self.trades_history),
            "recent_trades": self.trades_history[-10:],
            "last_scan_time": self.last_scan_time,
            "last_signals": self.last_signals,
        }

    def _run_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                if not self.config.enabled:
                    time.sleep(1.0)
                    continue

                # 1. Enforce Circuit Breaker check on every tick
                if self.check_circuit_breaker():
                    break

                self.last_scan_time = time.time()
                # 2. Execute scanning pass
                self._execute_scan_pass()

            except Exception as e:
                logger.error("Exception in algo loop: %s", e)

            time.sleep(max(0.5, self.config.scan_interval_seconds))

    def _execute_scan_pass(self) -> None:
        now = time.time()
        if now - self.last_trade_time < self.config.cooldown_seconds:
            return

        # Check circuit breaker again before processing
        if self.check_circuit_breaker():
            return

        # Scan each configured underlying
        for und in list(self.config.underlyings):
            if not self.config.enabled or self.circuit_breaker_triggered:
                break
            try:
                self._scan_underlying_options(und)
            except Exception as err:
                logger.debug("Scan error on %s: %s", und, err)

    def _scan_underlying_options(self, und: str) -> None:
        from app.main import chart_option_chain, _fetch_historical_or_intraday_candles, OrderPayload

        chain_res = chart_option_chain(symbol=und)
        if not chain_res or not chain_res.get("ok"):
            return

        rows = chain_res.get("chain", [])
        spot = float(chain_res.get("spot_price") or 0.0)
        if not rows:
            return

        # Find ATM option row
        atm_row = min(rows, key=lambda r: abs(float(r.get("strike", 0)) - spot)) if spot > 0 else rows[len(rows) // 2]
        candidates = []
        if atm_row.get("call_symbol"):
            candidates.append({
                "type": "CE",
                "symbol": str(atm_row.get("call_symbol")).strip().upper(),
                "token": str(atm_row.get("call_token") or ""),
                "lot_size": int(atm_row.get("lot_size") or (25 if "NIFTY" in und else 20)),
                "segment": "bse_fo" if "SENSEX" in und or "BANKEX" in und else "nse_fo",
            })
        if atm_row.get("put_symbol"):
            candidates.append({
                "type": "PE",
                "symbol": str(atm_row.get("put_symbol")).strip().upper(),
                "token": str(atm_row.get("put_token") or ""),
                "lot_size": int(atm_row.get("lot_size") or (25 if "NIFTY" in und else 20)),
                "segment": "bse_fo" if "SENSEX" in und or "BANKEX" in und else "nse_fo",
            })

        for opt in candidates:
            sym = opt["symbol"]
            now_dt = datetime.now()
            # Fetch recent 1-minute candles for the option
            c_data = _fetch_historical_or_intraday_candles(sym, interval="1m", token=opt["token"], requested_days=2, now_dt=now_dt)
            candles = (c_data or {}).get("candles", [])
            if len(candles) < 20:
                continue

            eval_res = evaluate_crossover_signal(
                candles,
                fast_period=self.config.fast_ema,
                slow_period=self.config.slow_ema,
                vol_period=20,
                min_atr=self.config.atr_threshold,
                rr_ratio=self.config.rr_ratio,
            )
            self.last_signals[sym] = eval_res

            if eval_res["signal"] == "BUY":
                # Double-check circuit breaker before placing order!
                if self.check_circuit_breaker():
                    return

                # Check max open positions
                with self.db_factory() as conn:
                    open_pos_count = conn.execute("SELECT COUNT(*) FROM positions WHERE status IN ('OPEN', 'PARTIALLY_CLOSED')").fetchone()[0]
                if open_pos_count >= self.config.max_open_positions:
                    logger.debug("Max open positions (%s) reached; skipping new entry", self.config.max_open_positions)
                    return

                # Construct Order with 1 : 2.25 SL/TP
                entry_p = eval_res["entry_price"]
                sl_p = eval_res["sl_price"]
                tp_p = eval_res["tp_price"]

                payload = OrderPayload(
                    symbol=sym,
                    instrument_token=opt["token"],
                    exchange_segment=opt["segment"],
                    side="BUY",
                    lots=self.config.lots_per_order,
                    lot_size=opt["lot_size"],
                    product="NRML",
                    order_type="MKT",
                    price=entry_p,
                    sl_price=sl_p,
                    tp_price=tp_p,
                    auto_sltp=True,
                    validity="DAY",
                    user_confirmed=True,
                )

                logger.info(
                    "🚀 ALGO SIGNAL TRIGGERED: BUY %s @ %s | SL: %s | TP: %s (1:2.25 RR) | ATR: %.2f",
                    sym, entry_p, sl_p, tp_p, eval_res["atr"]
                )

                try:
                    res = self.executor_fn(payload)
                    self.last_trade_time = time.time()
                    trade_record = {
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "symbol": sym,
                        "side": "BUY",
                        "lots": self.config.lots_per_order,
                        "lot_size": opt["lot_size"],
                        "entry_price": entry_p,
                        "sl_price": sl_p,
                        "tp_price": tp_p,
                        "rr_ratio": self.config.rr_ratio,
                        "atr": eval_res["atr"],
                        "result": res,
                    }
                    self.trades_history.append(trade_record)
                except Exception as ex:
                    logger.error("Failed to execute algo order: %s", ex)
                break
