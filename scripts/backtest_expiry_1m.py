"""Run a one-minute Upstox backtest for the last 19 expiry sessions per index.

The simulator deliberately uses only the OHLCV bars returned by Upstox. It does
not treat expanded/interpolated five-second chart bars as historical market data.
The result report is written to reports/ and the raw request cache to ignored data/.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import math
import os
import statistics
import sys
import time
from collections import defaultdict
from datetime import date, datetime, time as dt_time, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode
from zoneinfo import ZoneInfo

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.accounting import calculate_statutory_charges  # noqa: E402

IST = ZoneInfo("Asia/Kolkata")
TODAY = date(2026, 11, 14)
INITIAL_CAPITAL = 1_000_000.0
MAX_LOTS_PER_ORDER = 1
RISK_PCT_PER_TRADE = 0.5
MAX_DAILY_LOSS_PCT = 10.0
MAX_DRAWDOWN_PCT = 30.0
RR_RATIO = 2.25
ATR_MIN = 14.0
LOSS_STREAK_COUNT = 3
LOSS_STREAK_WINDOW_SEC = 1800
LOOKBACK_EXPIRIES = 19
REPORT_DIR = ROOT / "reports"
CACHE_DIR = ROOT / "data" / "expiry_1m_cache"

UNDERLYINGS: dict[str, dict[str, str]] = {
    "NIFTY": {"key": "NSE_INDEX|Nifty 50", "exchange": "NSE", "annual_events": "weekly"},
    "BANKNIFTY": {"key": "NSE_INDEX|Nifty Bank", "exchange": "NSE", "annual_events": "monthly"},
    "SENSEX": {"key": "BSE_INDEX|SENSEX", "exchange": "BSE", "annual_events": "weekly"},
}


def load_token() -> str:
    token = os.getenv("UPSTOX_ACCESS_TOKEN", "").strip()
    if token:
        return token
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.strip().startswith("UPSTOX_ACCESS_TOKEN="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise RuntimeError("UPSTOX_ACCESS_TOKEN is not configured in the process environment or project .env.")


class UpstoxData:
    def __init__(self, token: str) -> None:
        self.client = httpx.Client(
            timeout=35.0,
            headers={"Accept": "application/json", "Authorization": f"Bearer {token}", "User-Agent": "NeoPIP-expiry-backtest/1.0"},
        )
        CACHE_DIR.mkdir(parents=True, exist_ok=True)

    def get_json(self, url: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        cache_key = url + ("?" + urlencode(params or {}, doseq=True) if params else "")
        cache_path = CACHE_DIR / (hashlib.sha256(cache_key.encode()).hexdigest() + ".json")
        if cache_path.exists():
            try:
                return json.loads(cache_path.read_text())
            except (json.JSONDecodeError, OSError):
                cache_path.unlink(missing_ok=True)
        last_status = None
        for attempt in range(5):
            response = self.client.get(url, params=params)
            last_status = response.status_code
            if response.status_code == 429:
                time.sleep(min(2 ** attempt, 12))
                continue
            if response.status_code >= 500:
                time.sleep(min(attempt + 1, 5))
                continue
            if response.status_code >= 400:
                try:
                    body = response.json()
                    errors = body.get("errors") or []
                    code = errors[0].get("errorCode") if errors else body.get("code")
                except Exception:
                    code = None
                raise RuntimeError(f"Upstox HTTP {response.status_code} for {url.split('?')[0]} (code={code})")
            body = response.json()
            cache_path.write_text(json.dumps(body, separators=(",", ":")))
            time.sleep(0.04)
            return body
        raise RuntimeError(f"Upstox request failed after retries (HTTP {last_status}) for {url.split('?')[0]}")

    def get_expiries(self, underlying_key: str) -> list[str]:
        body = self.get_json("https://api.upstox.com/v2/expired-instruments/expiries", {"instrument_key": underlying_key})
        return sorted(x for x in (body.get("data") or []) if isinstance(x, str) and x <= TODAY.isoformat())

    def get_options(self, underlying_key: str, expiry: str) -> list[dict[str, Any]]:
        body = self.get_json(
            "https://api.upstox.com/v2/expired-instruments/option/contract",
            {"instrument_key": underlying_key, "expiry_date": expiry},
        )
        return body.get("data") or []

    def get_expired_future(self, underlying_key: str, expiry: str) -> dict[str, Any] | None:
        body = self.get_json(
            "https://api.upstox.com/v2/expired-instruments/future/contract",
            {"instrument_key": underlying_key, "expiry_date": expiry},
        )
        rows = body.get("data") or []
        return rows[0] if rows else None

    def get_expired_candles(self, instrument_key: str, session_date: str) -> list[list[Any]]:
        url = (
            "https://api.upstox.com/v2/expired-instruments/historical-candle/"
            f"{quote(instrument_key, safe='')}/1minute/{session_date}/{session_date}"
        )
        return (self.get_json(url).get("data") or {}).get("candles") or []

    def get_active_candles(self, instrument_key: str, session_date: str) -> list[list[Any]]:
        url = (
            "https://api.upstox.com/v3/historical-candle/"
            f"{quote(instrument_key, safe='')}/minutes/1/{session_date}/{session_date}"
        )
        return (self.get_json(url).get("data") or {}).get("candles") or []

    def close(self) -> None:
        self.client.close()


def load_current_futures(data: UpstoxData) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for exchange in ("NSE", "BSE"):
        url = f"https://assets.upstox.com/market-quote/instruments/exchange/{exchange}.json.gz"
        response = data.client.get(url)
        if response.status_code != 200:
            raise RuntimeError(f"Could not load Upstox {exchange} instrument master (HTTP {response.status_code}).")
        rows = json.loads(gzip.decompress(response.content))
        for row in rows:
            underlying = str(row.get("underlying_symbol") or "").upper()
            if row.get("instrument_type") != "FUT" or underlying not in UNDERLYINGS:
                continue
            expiry_ms = int(row.get("expiry") or 0)
            expiry_date = datetime.fromtimestamp(expiry_ms / 1000, tz=ZoneInfo("UTC")).date()
            result[underlying].append({**row, "expiry_date": expiry_date.isoformat()})
    for rows in result.values():
        rows.sort(key=lambda r: r["expiry_date"])
    return result


def to_ist(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=IST)
    return parsed.astimezone(IST)


def session_bars(raw: list[list[Any]], day: str) -> list[dict[str, Any]]:
    result = []
    for row in raw:
        try:
            dt = to_ist(str(row[0]))
            minute = dt.hour * 60 + dt.minute
            if dt.date().isoformat() != day or not (9 * 60 + 15 <= minute <= 15 * 60 + 29):
                continue
            result.append({
                "dt": dt,
                "time": int(dt.timestamp()),
                "open": float(row[1]),
                "high": float(row[2]),
                "low": float(row[3]),
                "close": float(row[4]),
                "volume": int(float(row[5] or 0)) if len(row) > 5 else 0,
            })
        except (ValueError, TypeError, IndexError, OverflowError):
            continue
    result.sort(key=lambda x: x["time"])
    return result


def ema(values: list[float], period: int) -> list[float]:
    if not values:
        return []
    if len(values) < period:
        avg = sum(values) / len(values)
        return [avg] * len(values)
    k = 2.0 / (period + 1)
    seed = sum(values[:period]) / period
    result = [seed] * period
    current = seed
    for value in values[period:]:
        current = value * k + current * (1.0 - k)
        result.append(current)
    return result


def atr_series(bars: list[dict[str, Any]], period: int = 14) -> list[float]:
    tr = []
    for i, bar in enumerate(bars):
        if i == 0:
            tr.append(max(0.0, bar["high"] - bar["low"]))
        else:
            prev = bars[i - 1]["close"]
            tr.append(max(bar["high"] - bar["low"], abs(bar["high"] - prev), abs(bar["low"] - prev)))
    return [sum(tr[max(0, i - period + 1):i + 1]) / len(tr[max(0, i - period + 1):i + 1]) for i in range(len(tr))]


def aggregate_2m(bars: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for bar in bars:
        offset = bar["dt"].hour * 60 + bar["dt"].minute - (9 * 60 + 15)
        if offset < 0:
            continue
        groups[offset // 2].append(bar)
    result = []
    for _, group in sorted(groups.items()):
        group.sort(key=lambda x: x["time"])
        if len(group) < 2:
            continue
        result.append({
            "dt": group[0]["dt"],
            "end_time": group[1]["time"] + 60,
            "time": group[0]["time"],
            "open": group[0]["open"],
            "high": max(x["high"] for x in group),
            "low": min(x["low"] for x in group),
            "close": group[-1]["close"],
        })
    return result


def find_fib_level(bars_2m: list[dict[str, Any]], trend: str, cutoff: int) -> float | None:
    prior = [bar for bar in bars_2m if bar["end_time"] <= cutoff]
    if len(prior) < 8:
        return None
    highs: list[tuple[int, float]] = []
    lows: list[tuple[int, float]] = []
    for i in range(2, len(prior) - 2):
        window = prior[i - 2:i + 3]
        if prior[i]["high"] >= max(x["high"] for x in window):
            highs.append((i, prior[i]["high"]))
        if prior[i]["low"] <= min(x["low"] for x in window):
            lows.append((i, prior[i]["low"]))
    if trend == "BULL":
        for high_i, high in reversed(highs):
            prior_lows = [(low_i, low) for low_i, low in lows if low_i < high_i and low < high]
            if prior_lows:
                return (high + prior_lows[-1][1]) / 2.0
    else:
        for low_i, low in reversed(lows):
            prior_highs = [(high_i, high) for high_i, high in highs if high_i < low_i and high > low]
            if prior_highs:
                return (low + prior_highs[-1][1]) / 2.0
    return None


def make_tick(value: float, tick: float) -> float:
    if tick <= 0:
        return round(value, 2)
    return round(round(value / tick) * tick, 2)


def option_tick(row: dict[str, Any]) -> float:
    raw = float(row.get("tick_size") or 5.0)
    # Upstox instrument masters report option ticks in paise (e.g. 5 = ₹0.05).
    return raw / 100.0 if raw >= 1 else raw


def choose_future(
    data: UpstoxData,
    current_futures: dict[str, list[dict[str, Any]]],
    underlying: str,
    expiry: str,
    expiry_dates: list[str],
) -> tuple[dict[str, Any] | None, list[list[Any]]]:
    session_dt = date.fromisoformat(expiry)
    same_month = [x for x in expiry_dates if x[:7] == expiry[:7]]
    monthly_option_expiry = max(same_month) if same_month else expiry
    # The active instrument master is needed only for the latest, not-yet-expired future.
    active_candidates = [x for x in current_futures.get(underlying, []) if x["expiry_date"] >= expiry]
    newest_month = max((x for x in expiry_dates if x <= TODAY.isoformat()), default=expiry)[:7]
    is_recent_active_session = (TODAY - session_dt).days <= 32 and expiry[:7] >= newest_month
    if is_recent_active_session and active_candidates:
        future = min(active_candidates, key=lambda x: x["expiry_date"])
        return future, data.get_active_candles(str(future["instrument_key"]), expiry)

    future = data.get_expired_future(UNDERLYINGS[underlying]["key"], monthly_option_expiry)
    if future is None and monthly_option_expiry != expiry:
        future = data.get_expired_future(UNDERLYINGS[underlying]["key"], expiry)
    if future is None:
        return None, []
    return future, data.get_expired_candles(str(future["instrument_key"]), expiry)


def close_charges(segment: str, qty: int, entry: float, exit_price: float) -> float:
    buy = calculate_statutory_charges(segment, "BUY", qty, Decimal(str(entry))).get("total", Decimal("0"))
    sell = calculate_statutory_charges(segment, "SELL", qty, Decimal(str(exit_price))).get("total", Decimal("0"))
    return float(buy + sell)


def simulate_session(
    underlying: str,
    expiry: str,
    future_contract: dict[str, Any],
    future_raw: list[list[Any]],
    option_contract: dict[str, Any],
    option_raw: list[list[Any]],
) -> dict[str, Any]:
    future = session_bars(future_raw, expiry)
    options = session_bars(option_raw, expiry)
    future_at_1515 = next((x for x in future if x["dt"].time() == dt_time(15, 15)), None)
    option_at_1515 = next((x for x in options if x["dt"].time() == dt_time(15, 15)), None)
    if not future_at_1515 or not option_at_1515 or len(options) < 40:
        return {"underlying": underlying, "date": expiry, "status": "SKIPPED", "skip_reason": "Missing 15:15 bar or insufficient one-minute candles", "trades": [], "signals": 0}

    two_min = aggregate_2m(future)
    pre_1515 = [x for x in two_min if x["end_time"] <= int(datetime.combine(date.fromisoformat(expiry), dt_time(15, 15), IST).timestamp())]
    if len(pre_1515) < 21:
        return {"underlying": underlying, "date": expiry, "status": "SKIPPED", "skip_reason": "Insufficient 2-minute trend history", "trades": [], "signals": 0}
    trend_fast = ema([x["close"] for x in pre_1515], 9)[-1]
    trend_slow = ema([x["close"] for x in pre_1515], 21)[-1]
    if abs(trend_fast - trend_slow) < 1e-9:
        return {"underlying": underlying, "date": expiry, "status": "SKIPPED", "skip_reason": "No 2-minute EMA trend direction", "trades": [], "signals": 0}
    trend = "BULL" if trend_fast > trend_slow else "BEAR"
    fib = find_fib_level(two_min, trend, pre_1515[-1]["end_time"])
    base_ltp = option_at_1515["open"]
    limit_price = make_tick(base_ltp * 0.5, option_tick(option_contract))
    if base_ltp <= 0 or limit_price <= 0:
        return {"underlying": underlying, "date": expiry, "status": "SKIPPED", "skip_reason": "Invalid 15:15 option premium", "trades": [], "signals": 0}

    closes = [x["close"] for x in options]
    fast = ema(closes, 9)
    slow = ema(closes, 21)
    atrs = atr_series(options, 14)
    option_index_by_time = {bar["time"]: i for i, bar in enumerate(options)}
    fib_signal_times: set[int] = set()
    if fib is not None:
        for b in two_min:
            if b["dt"].time() < dt_time(15, 15):
                continue
            if trend == "BULL" and b["low"] <= fib:
                fib_signal_times.add(b["end_time"])
            elif trend == "BEAR" and b["high"] >= fib:
                fib_signal_times.add(b["end_time"])

    # Map confirmed 2-minute Fib touches to the first option-minute close at/after them.
    fib_minute_times: set[int] = set()
    for end_ts in fib_signal_times:
        next_bar = next((b for b in options if b["time"] + 60 >= end_ts), None)
        if next_bar:
            fib_minute_times.add(next_bar["time"])

    segment = "bse_fo" if underlying == "SENSEX" else "nse_fo"
    lot_size = int(option_contract.get("lot_size") or 0)
    if lot_size <= 0:
        return {"underlying": underlying, "date": expiry, "status": "SKIPPED", "skip_reason": "Invalid option lot size", "trades": [], "signals": 0}
    quantity = lot_size * MAX_LOTS_PER_ORDER
    trades: list[dict[str, Any]] = []
    signal_count = 0
    pending_order: dict[str, Any] | None = None
    active: dict[str, Any] | None = None
    exit_next_open = False
    session_halt = False
    loss_times: list[tuple[int, float]] = []
    realized_today = 0.0
    peak_intraday = INITIAL_CAPITAL
    equity = INITIAL_CAPITAL
    max_day_loss_cash = INITIAL_CAPITAL * MAX_DAILY_LOSS_PCT / 100.0
    max_daily_drawdown = 0.0

    def finish_trade(ts: int, px: float, reason: str) -> None:
        nonlocal active, equity, realized_today, peak_intraday, max_daily_drawdown, exit_next_open, session_halt
        if active is None:
            return
        entry = float(active["entry_price"])
        gross = (px - entry) * quantity
        charges = close_charges(segment, quantity, entry, px)
        net = gross - charges
        risk_cash = float(active["risk_unit"]) * quantity
        trade = {
            "underlying": underlying,
            "date": expiry,
            "symbol": option_contract.get("trading_symbol"),
            "instrument_key": option_contract.get("instrument_key"),
            "option_type": option_contract.get("instrument_type"),
            "trend": trend,
            "fib_level": round(fib, 2) if fib is not None else None,
            "entry_time": datetime.fromtimestamp(int(active["entry_time"]), IST).isoformat(),
            "exit_time": datetime.fromtimestamp(ts, IST).isoformat(),
            "entry_price": round(entry, 2),
            "exit_price": round(px, 2),
            "limit_price": round(limit_price, 2),
            "quantity": quantity,
            "lot_size": lot_size,
            "risk_per_unit": round(float(active["risk_unit"]), 2),
            "initial_stop": round(float(active["initial_stop"]), 2),
            "final_stop": round(float(active["stop"]), 2),
            "target": round(float(active["target"]), 2),
            "r_multiple": round(gross / risk_cash, 3) if risk_cash > 0 else 0.0,
            "gross_pnl": round(gross, 2),
            "charges": round(charges, 2),
            "net_pnl": round(net, 2),
            "exit_reason": reason,
            "breakeven_activated": bool(active["breakeven_activated"]),
        }
        trades.append(trade)
        equity += net
        realized_today += net
        peak_intraday = max(peak_intraday, equity)
        max_daily_drawdown = max(max_daily_drawdown, (peak_intraday - equity) / peak_intraday if peak_intraday else 0.0)
        loss_times.append((ts, net))
        if len(loss_times) >= LOSS_STREAK_COUNT:
            recent = loss_times[-LOSS_STREAK_COUNT:]
            if all(pnl < 0 for _, pnl in recent) and recent[-1][0] - recent[0][0] <= LOSS_STREAK_WINDOW_SEC:
                session_halt = True
        if realized_today <= -max_day_loss_cash:
            session_halt = True
        active = None
        exit_next_open = False

    start_ts = int(datetime.combine(date.fromisoformat(expiry), dt_time(15, 15), IST).timestamp())
    last_ts = int(datetime.combine(date.fromisoformat(expiry), dt_time(15, 29), IST).timestamp())
    for i, bar in enumerate(options):
        ts = bar["time"]
        if ts < start_ts or ts > last_ts:
            continue
        if active is not None and exit_next_open:
            open_px = max(0.0, float(bar["open"]))
            finish_trade(ts, open_px, "EMA_9_BELOW_21")
        if active is not None:
            stop = float(active["stop"])
            target = float(active["target"])
            entry_fee = float(active.get("entry_fee") or 0.0)
            high_equity = equity + (float(bar["high"]) - float(active["entry_price"])) * quantity - entry_fee
            low_equity = equity + (float(bar["low"]) - float(active["entry_price"])) * quantity - entry_fee
            peak_intraday = max(peak_intraday, high_equity)
            max_daily_drawdown = max(
                max_daily_drawdown,
                (peak_intraday - low_equity) / peak_intraday if peak_intraday > 0 else 0.0,
            )
            stop_hit = bar["low"] <= stop
            target_hit = bar["high"] >= target
            if stop_hit:
                exit_px = min(bar["open"], stop) if bar["open"] < stop else stop
                finish_trade(ts, max(0.0, exit_px), "BREAKEVEN_OR_TRAILING_STOP" if active["stop"] >= active["entry_price"] else "STOP_LOSS")
            elif target_hit:
                finish_trade(ts, target, "TAKE_PROFIT_2_25R")
            elif bar["dt"].time() == dt_time(15, 29):
                finish_trade(ts + 60, max(0.0, bar["close"]), "EOD_15_30")
            else:
                if bar["high"] >= float(active["entry_price"]) + float(active["risk_unit"]):
                    active["breakeven_activated"] = True
                    active["stop"] = max(float(active["stop"]), float(active["entry_price"]))
                if active["breakeven_activated"]:
                    active["high_water"] = max(float(active["high_water"]), float(bar["high"]))
                    trail = float(active["high_water"]) - float(active["risk_unit"])
                    active["stop"] = max(float(active["stop"]), trail)
                if fast[i] < slow[i]:
                    exit_next_open = True
        if active is None and pending_order is not None and not session_halt:
            if ts > int(pending_order["signal_bar_time"]) and bar["low"] <= limit_price and (bar["volume"] > 0 or bar["open"] <= limit_price):
                entry_price = min(float(bar["open"]), limit_price) if bar["open"] > 0 else limit_price
                risk_unit = min(float(pending_order["atr"]), entry_price * 0.8)
                if risk_unit <= 0:
                    pending_order = None
                else:
                    risk_budget = equity * RISK_PCT_PER_TRADE / 100.0
                    lots_by_risk = int(risk_budget // (risk_unit * lot_size))
                    if min(MAX_LOTS_PER_ORDER, lots_by_risk) < 1:
                        pending_order = None
                    else:
                        sl = make_tick(entry_price - risk_unit, option_tick(option_contract))
                        target = make_tick(entry_price + risk_unit * RR_RATIO, option_tick(option_contract))
                        active = {
                            "entry_time": ts,
                            "entry_price": entry_price,
                            "risk_unit": risk_unit,
                            "initial_stop": sl,
                            "stop": sl,
                            "target": target,
                            "high_water": entry_price,
                            "breakeven_activated": False,
                            "entry_fee": float(calculate_statutory_charges(segment, "BUY", quantity, Decimal(str(entry_price))).get("total", Decimal("0"))),
                        }
                        pending_order = None
                        # A minute bar can include both the fill and an adverse move; use stop-first.
                        if bar["low"] <= sl:
                            finish_trade(ts, sl, "STOP_LOSS_SAME_BAR")
                        # Do not credit a target in the fill minute: minute OHLC cannot
                        # establish whether the target was touched before the limit fill.
        if active is None and pending_order is None and not session_halt and ts < last_ts:
            if realized_today <= -max_day_loss_cash or equity <= 0:
                session_halt = True
                continue
            atr = atrs[i]
            if atr <= ATR_MIN:
                continue
            fib_touch = ts in fib_minute_times
            ema_entry = fast[i] > slow[i]
            if ema_entry or fib_touch:
                signal_count += 1
                pending_order = {"signal_bar_time": ts, "atr": atr, "signal_type": "EMA" if ema_entry else "FIB"}
        if session_halt and active is None:
            pending_order = None

    if active is not None:
        last_bar = next((b for b in reversed(options) if b["dt"].time() == dt_time(15, 29)), None)
        if last_bar:
            finish_trade(last_bar["time"] + 60, max(0.0, last_bar["close"]), "EOD_15_30")
    return {
        "underlying": underlying,
        "date": expiry,
        "status": "OK",
        "trend": trend,
        "trend_ema9": round(trend_fast, 4),
        "trend_ema21": round(trend_slow, 4),
        "future_symbol": future_contract.get("trading_symbol"),
        "future_instrument_key": future_contract.get("instrument_key"),
        "future_1515_price": round(future_at_1515["open"], 2),
        "option_symbol": option_contract.get("trading_symbol"),
        "option_instrument_key": option_contract.get("instrument_key"),
        "option_1515_price": round(base_ltp, 2),
        "limit_price": round(limit_price, 2),
        "fib_level": round(fib, 2) if fib is not None else None,
        "fib_available": fib is not None,
        "signal_count": signal_count,
        "trades": trades,
        "session_net_pnl": round(sum(x["net_pnl"] for x in trades), 2),
        "session_max_drawdown_pct": round(max_daily_drawdown * 100.0, 4),
        "session_halted": session_halt,
        "bars_option": len(options),
        "bars_future": len(future),
    }


def build_metrics(underlying: str, sessions: list[dict[str, Any]]) -> dict[str, Any]:
    good = [s for s in sessions if s.get("status") == "OK"]
    trades = [t for s in good for t in s.get("trades", [])]
    wins = [t for t in trades if t["net_pnl"] > 0]
    losses = [t for t in trades if t["net_pnl"] < 0]
    gross_profit = sum(max(0.0, t["gross_pnl"]) for t in trades)
    gross_loss = abs(sum(min(0.0, t["gross_pnl"]) for t in trades))
    charges = sum(t["charges"] for t in trades)
    pnl = sum(t["net_pnl"] for t in trades)
    daily = defaultdict(float)
    for t in trades:
        daily[t["date"]] += t["net_pnl"]
    session_returns = [daily[s["date"]] / INITIAL_CAPITAL for s in good]
    sharpe = None
    if len(session_returns) >= 2 and statistics.stdev(session_returns) > 0:
        span_days = max(1, (date.fromisoformat(max(s["date"] for s in good)) - date.fromisoformat(min(s["date"] for s in good))).days)
        annual_events = len(good) * 365.25 / span_days
        sharpe = round(statistics.mean(session_returns) / statistics.stdev(session_returns) * math.sqrt(annual_events), 2)
    equity = INITIAL_CAPITAL
    peak = equity
    max_dd = 0.0
    for session in sorted(good, key=lambda x: x["date"]):
        equity += float(session.get("session_net_pnl") or 0)
        peak = max(peak, equity)
        max_dd = max(max_dd, (peak - equity) / peak if peak > 0 else 0.0)
        max_dd = max(max_dd, float(session.get("session_max_drawdown_pct") or 0.0) / 100.0)
    return {
        "underlying": underlying,
        "expiry_sessions_requested": LOOKBACK_EXPIRIES,
        "sessions_with_data": len(good),
        "sessions_skipped": len(sessions) - len(good),
        "first_expiry": min((s["date"] for s in good), default=None),
        "last_expiry": max((s["date"] for s in good), default=None),
        "trend_bull_sessions": sum(s.get("trend") == "BULL" for s in good),
        "trend_bear_sessions": sum(s.get("trend") == "BEAR" for s in good),
        "fib_available_sessions": sum(bool(s.get("fib_available")) for s in good),
        "signals": sum(int(s.get("signal_count") or 0) for s in good),
        "unfilled_limit_orders": max(0, sum(int(s.get("signal_count") or 0) for s in good) - len(trades)),
        "limit_fill_rate_pct": round(len(trades) / sum(int(s.get("signal_count") or 0) for s in good) * 100.0, 2) if sum(int(s.get("signal_count") or 0) for s in good) else 0.0,
        "trades": len(trades),
        "filled_trades": len(trades),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate_pct": round(len(wins) / len(trades) * 100.0, 2) if trades else 0.0,
        "gross_profit": round(gross_profit, 2),
        "gross_loss": round(gross_loss, 2),
        "charges": round(charges, 2),
        "net_pnl": round(pnl, 2),
        "return_pct": round(pnl / INITIAL_CAPITAL * 100.0, 3),
        "profit_factor": round(gross_profit / gross_loss, 3) if gross_loss else (None if gross_profit == 0 else "unbounded"),
        "expectancy_per_trade": round(pnl / len(trades), 2) if trades else 0.0,
        "average_r_multiple": round(statistics.mean(t["r_multiple"] for t in trades), 3) if trades else 0.0,
        "max_drawdown_pct": round(max_dd * 100.0, 3),
        "max_session_drawdown_pct": round(max((float(s.get("session_max_drawdown_pct") or 0.0) for s in good), default=0.0), 3),
        "sample_sharpe_annualized_by_expiry_frequency": sharpe,
        "sharpe_target": 1.30,
        "max_daily_loss_limit_pct": MAX_DAILY_LOSS_PCT,
        "max_drawdown_limit_pct": MAX_DRAWDOWN_PCT,
    }


def markdown_report(report: dict[str, Any]) -> str:
    lines = [
        "# Expiry day option buying backtest (1-minute Upstox proxy)",
        "",
        f"Run date: {report['run_date']} (Asia/Kolkata)",
        "",
        "## Data and execution assumptions",
        "",
        "- Last 19 expired expiry dates returned by Upstox per underlying.",
        "- Upstox expired option/future OHLCV at 1-minute resolution; session data filtered to 09:15–15:29 IST.",
        "- ATM strike is nearest to the index future 15:15 one-minute bar open; side is CE for bullish, PE for bearish 2-minute EMA 9/21 trend.",
        "- The 15:15 option reference uses that minute bar open; the buy limit is 50% of that price, rounded to the contract tick.",
        "- EMA entry is option premium EMA 9 > EMA 21. Fib entry is a touch of the 50% retracement of the latest confirmed 2-minute swing in the trend direction. Either can trigger.",
        "- Entry signals are confirmed at a 1-minute close; fills can occur no earlier than the next minute when its low touches the resting limit. Fill price is the better of the bar open and limit; queue position and partial fills are not modeled.",
        "- Premium ATR(14) must be strictly greater than 14. Initial risk is min(ATR(14), 80% of premium); target is 2.25R. Stop moves to cost after +1R and trails one risk unit behind the high-water mark. EMA 9 below 21 exits at next minute open; otherwise exit at 15:30.",
        "- One lot per trade; charges use the project's app.accounting model (Kotak Neo free F&O plan), not Upstox brokerage; per-session capital base ₹10,00,000. The original 0.5% per-trade cap, 10% daily stop, 30% drawdown ceiling, and 3-loss/30-minute stop are applied per underlying session.",
        "- This is a minute-bar proxy. It does not represent real 5-second data or guarantee limit-order execution.",
        "",
        "## Performance",
        "",
        "| Underlying | Sessions | Signals | Fills | Fill rate | Win rate | Net P&L | Return | PF | Max DD | Sharpe* |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for name, metric in report["metrics"].items():
        sharpe = metric["sample_sharpe_annualized_by_expiry_frequency"]
        lines.append(
            f"| {name} | {metric['sessions_with_data']}/{metric['expiry_sessions_requested']} | {metric['signals']} | {metric['trades']} | {metric['limit_fill_rate_pct']:.1f}% | {metric['win_rate_pct']:.2f}% | ₹{metric['net_pnl']:,.2f} | {metric['return_pct']:.3f}% | {metric['profit_factor']} | {metric['max_drawdown_pct']:.3f}% | {sharpe if sharpe is not None else 'n/a'} |"
        )
    p = report["portfolio"]
    lines.extend([
        f"| **Combined (one lot per index)** | {p['expiry_sessions']} index-sessions | {p['signals']} | {p['trades']} | {p['limit_fill_rate_pct']:.1f}% | {p['win_rate_pct']:.2f}% | **₹{p['net_pnl']:,.2f}** | **{p['return_pct']:.3f}%** | {p['profit_factor']} | {p['max_drawdown_pct']:.3f}% | {p['sample_sharpe_annualized_by_expiry_frequency'] if p['sample_sharpe_annualized_by_expiry_frequency'] is not None else 'n/a'} |",
        "",
        "*Sharpe is annualized using the observed expiry-session frequency across each 19-session date span. The combined estimate uses unique expiry dates and remains a small-sample statistic.*",
        "",
        "## Trades",
        "",
        "| Date | Underlying | Option | Trend | Entry | Exit | Qty | Net P&L | Exit reason |",
        "|---|---|---|---|---:|---:|---:|---:|---|",
    ])
    all_trades = [t for s in report["sessions"] for t in s.get("trades", [])]
    for t in sorted(all_trades, key=lambda x: (x["date"], x["underlying"], x["entry_time"])):
        lines.append(
            f"| {t['date']} | {t['underlying']} | {t['symbol']} | {t['trend']} | {t['entry_price']:.2f} | {t['exit_price']:.2f} | {t['quantity']} | ₹{t['net_pnl']:,.2f} | {t['exit_reason']} |"
        )
    if not all_trades:
        lines.append("| — | — | — | — | — | — | — | — | No fills |")
    skipped = [s for s in report["sessions"] if s.get("status") != "OK"]
    if skipped:
        lines.extend(["", "## Skipped sessions", "", "| Date | Underlying | Reason |", "|---|---|---|"])
        for s in skipped:
            lines.append(f"| {s['date']} | {s['underlying']} | {s.get('skip_reason', 'Unknown')} |")
    lines.extend(["", "## Full report", "", f"JSON data: `{report['json_path']}`", ""])
    return "\n".join(lines)


def main() -> None:
    token = load_token()
    data = UpstoxData(token)
    try:
        expiry_lists = {name: data.get_expiries(spec["key"]) for name, spec in UNDERLYINGS.items()}
        selected = {name: values[-LOOKBACK_EXPIRIES:] for name, values in expiry_lists.items()}
        current_futures = load_current_futures(data)
        sessions: list[dict[str, Any]] = []
        expected = sum(len(x) for x in selected.values())
        count = 0
        for underlying, expiry_dates in selected.items():
            full_dates = expiry_lists[underlying]
            for expiry in expiry_dates:
                count += 1
                future_contract, future_raw = choose_future(data, current_futures, underlying, expiry, full_dates)
                if not future_contract or not future_raw:
                    sessions.append({"underlying": underlying, "date": expiry, "status": "SKIPPED", "skip_reason": "No matching historical future candles", "trades": [], "signals": 0})
                    print(f"[{count}/{expected}] {underlying} {expiry}: missing future data")
                    continue
                fut_session = session_bars(future_raw, expiry)
                future_at_1515 = next((x for x in fut_session if x["dt"].time() == dt_time(15, 15)), None)
                if not future_at_1515:
                    sessions.append({"underlying": underlying, "date": expiry, "status": "SKIPPED", "skip_reason": "Missing 15:15 future candle", "trades": [], "signals": 0})
                    print(f"[{count}/{expected}] {underlying} {expiry}: no 15:15 future candle")
                    continue
                option_contracts = data.get_options(UNDERLYINGS[underlying]["key"], expiry)
                option_type = "CE"
                future_price = future_at_1515["open"]
                candidates = [x for x in option_contracts if x.get("instrument_type") == option_type]
                if not candidates:
                    sessions.append({"underlying": underlying, "date": expiry, "status": "SKIPPED", "skip_reason": "No call contracts returned", "trades": [], "signals": 0})
                    print(f"[{count}/{expected}] {underlying} {expiry}: no option contracts")
                    continue
                strike = min((float(x.get("strike_price") or 0) for x in candidates), key=lambda x: abs(x - future_price))
                option_contract = next(x for x in candidates if float(x.get("strike_price") or 0) == strike)
                # Side selection uses the underlying trend from the full 2-minute history up to 15:15.
                # The paired PE/CE contract shares the same strike for these index chains.
                future_2m = aggregate_2m(fut_session)
                cutoff = int(datetime.combine(date.fromisoformat(expiry), dt_time(15, 15), IST).timestamp())
                pre = [x for x in future_2m if x["end_time"] <= cutoff]
                trend = "BULL" if len(pre) >= 21 and ema([x["close"] for x in pre], 9)[-1] > ema([x["close"] for x in pre], 21)[-1] else "BEAR"
                option_type = "CE" if trend == "BULL" else "PE"
                candidates = [x for x in option_contracts if x.get("instrument_type") == option_type]
                option_contract = min(candidates, key=lambda x: abs(float(x.get("strike_price") or 0) - future_price))
                option_raw = data.get_expired_candles(str(option_contract["instrument_key"]), expiry)
                session = simulate_session(underlying, expiry, future_contract, future_raw, option_contract, option_raw)
                sessions.append(session)
                print(f"[{count}/{expected}] {underlying} {expiry}: {len(session.get('trades', []))} fills, {session.get('session_net_pnl', 0.0):.2f} net")

        metrics = {name: build_metrics(name, [x for x in sessions if x["underlying"] == name]) for name in UNDERLYINGS}
        all_trades = [t for s in sessions for t in s.get("trades", [])]
        portfolio_daily = defaultdict(float)
        for trade in all_trades:
            portfolio_daily[trade["date"]] += trade["net_pnl"]
        portfolio_equity = INITIAL_CAPITAL
        peak = portfolio_equity
        max_dd = 0.0
        for day in sorted(portfolio_daily):
            portfolio_equity += portfolio_daily[day]
            peak = max(peak, portfolio_equity)
            max_dd = max(max_dd, (peak - portfolio_equity) / peak if peak else 0.0)
        portfolio_wins = [t for t in all_trades if t["net_pnl"] > 0]
        portfolio_losses = [t for t in all_trades if t["net_pnl"] < 0]
        all_expiry_days = sorted({s["date"] for s in sessions})
        combined_daily_returns = [portfolio_daily[d] / INITIAL_CAPITAL for d in all_expiry_days]
        portfolio_sharpe = None
        if len(combined_daily_returns) >= 2 and statistics.stdev(combined_daily_returns) > 0:
            span_days = max(1, (date.fromisoformat(all_expiry_days[-1]) - date.fromisoformat(all_expiry_days[0])).days)
            annual_events = len(all_expiry_days) * 365.25 / span_days
            portfolio_sharpe = round(statistics.mean(combined_daily_returns) / statistics.stdev(combined_daily_returns) * math.sqrt(annual_events), 2)
        gross_profit = sum(max(0.0, t["gross_pnl"]) for t in all_trades)
        gross_loss = abs(sum(min(0.0, t["gross_pnl"]) for t in all_trades))
        report = {
            "run_date": TODAY.isoformat(),
            "data_source": "Upstox expired option contracts, expired 1-minute option candles, and active/expired 1-minute index futures candles",
            "session_window_ist": "Entries after 15:15; only candles starting 15:15–15:29 considered; forced exit at 15:30",
            "settings": {
                "lookback_expiries_per_underlying": LOOKBACK_EXPIRIES,
                "capital_per_underlying": INITIAL_CAPITAL,
                "combined_portfolio_capital": INITIAL_CAPITAL,
                "lots_per_order_cap": MAX_LOTS_PER_ORDER,
                "risk_pct_per_trade": RISK_PCT_PER_TRADE,
                "rr_ratio": RR_RATIO,
                "atr_min": ATR_MIN,
                "max_daily_loss_pct": MAX_DAILY_LOSS_PCT,
                "max_drawdown_pct": MAX_DRAWDOWN_PCT,
                "loss_streak_count": LOSS_STREAK_COUNT,
                "loss_streak_window_seconds": LOSS_STREAK_WINDOW_SEC,
                "trend_filter": "2-minute underlying future EMA 9/21 as of 15:15; bullish=CE, bearish=PE",
                "entry_signal": "option EMA 9>21 OR 2-minute underlying Fib 50% retracement touch; both gated by option ATR(14)>14",
                "limit_rule": "buy limit rounded to contract tick at 50% of the 15:15 option bar open",
                "stop_rule": "initial risk=min(ATR14, 80% entry premium); stop moves to entry after +1R, then trails one risk unit behind high-water mark",
                "exit_rule": "2.25R target, EMA 9<21 at next minute open, trailing/breakeven stop, or 15:30 close",
                "fill_rule": "signal confirmed at minute close; fill no earlier than next minute; touched limit assumed filled at limit or better when volume exists",
            },
            "metrics": metrics,
            "portfolio": {
                "sessions": len(sessions),
                "expiry_sessions": sum(m["sessions_with_data"] for m in metrics.values()),
                "signals": sum(int(m["signals"]) for m in metrics.values()),
                "unfilled_limit_orders": sum(int(m["unfilled_limit_orders"]) for m in metrics.values()),
                "trades": len(all_trades),
                "limit_fill_rate_pct": round(len(all_trades) / sum(int(m["signals"]) for m in metrics.values()) * 100.0, 2) if sum(int(m["signals"]) for m in metrics.values()) else 0.0,
                "wins": len(portfolio_wins),
                "losses": len(portfolio_losses),
                "win_rate_pct": round(len(portfolio_wins) / len(all_trades) * 100, 2) if all_trades else 0.0,
                "gross_profit": round(gross_profit, 2),
                "gross_loss": round(gross_loss, 2),
                "charges": round(sum(t["charges"] for t in all_trades), 2),
                "net_pnl": round(sum(t["net_pnl"] for t in all_trades), 2),
                "return_pct": round(sum(t["net_pnl"] for t in all_trades) / INITIAL_CAPITAL * 100, 3),
                "profit_factor": round(gross_profit / gross_loss, 3) if gross_loss else (None if gross_profit == 0 else "unbounded"),
                "max_drawdown_pct": round(max_dd * 100, 3),
                "sample_sharpe_annualized_by_expiry_frequency": portfolio_sharpe,
                "sharpe_target": 1.30,
                "capital_assumption": "Combined P&L sums one-lot trades from all three index expiry sessions; independent index metrics each use ₹10,00,000 starting capital.",
                "charges_model": "Uses the project's app.accounting statutory-charge model (Kotak Neo free F&O plan), not a broker-specific Upstox execution fee schedule.",
            },
            "metrics_by_underlying": metrics,
            "sessions": sessions,
        }
        REPORT_DIR.mkdir(parents=True, exist_ok=True)
        stem = "expiry_day_1m_backtest_2026-11-14"
        json_path = REPORT_DIR / f"{stem}.json"
        md_path = REPORT_DIR / f"{stem}.md"
        report["json_path"] = str(json_path)
        json_path.write_text(json.dumps(report, indent=2, ensure_ascii=False))
        md_path.write_text(markdown_report(report))
        print(json.dumps({"report_markdown": str(md_path), "report_json": str(json_path), "metrics": metrics, "portfolio": report["portfolio"]}, ensure_ascii=False))
    finally:
        data.close()


if __name__ == "__main__":
    main()
