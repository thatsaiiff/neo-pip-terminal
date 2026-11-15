"""Export Bank Nifty 1-minute Upstox candles and related expired contracts.

The index series is downloaded in one-month V3 windows. Expired future candles,
expiry option masters, and backtest-selected option candles are read through the
existing Upstox response cache (and fetched if a requested response is absent).
The access token is read from the process environment or .env and is never written
to the export.
"""

from __future__ import annotations

import csv
import json
import sys
from datetime import date, time as dt_time, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import backtest_expiry_1m as base  # noqa: E402

REPORT_PATH = ROOT / "reports" / "trend_1dte_expiry_1m_2026-11-14.json"
EXPORT_DIR = ROOT / "data" / "exports" / "banknifty_1m"
INDEX_KEY = base.UNDERLYINGS["BANKNIFTY"]["key"]
MARKET_OPEN = dt_time(9, 15)
MARKET_CLOSE = dt_time(15, 29)

INDEX_FIELDS = [
    "time", "underlying", "instrument_key", "open", "high", "low", "close",
    "volume", "open_interest",
]
FUTURE_FIELDS = [
    "time", "underlying", "instrument_key", "trading_symbol", "expiry",
    "open", "high", "low", "close", "volume", "open_interest",
]
OPTION_FIELDS = [
    "time", "underlying", "instrument_key", "trading_symbol", "expiry",
    "option_type", "strike", "lot_size", "exchange_segment", "open", "high",
    "low", "close", "volume", "open_interest",
]
CONTRACT_FIELDS = [
    "underlying", "underlying_key", "underlying_symbol", "instrument_key",
    "trading_symbol", "expiry", "option_type", "strike", "lot_size",
    "tick_size", "exchange", "exchange_segment", "weekly", "freeze_quantity",
    "minimum_lot",
]


def in_regular_session(timestamp: str) -> bool:
    try:
        dt = base.to_ist(timestamp)
    except (TypeError, ValueError, OverflowError):
        return False
    return dt.weekday() < 5 and MARKET_OPEN <= dt.time() <= MARKET_CLOSE


def candle_fields(row: list[Any]) -> tuple[str, Any, Any, Any, Any, Any, Any] | None:
    if len(row) < 5 or not in_regular_session(str(row[0])):
        return None
    try:
        return (
            str(row[0]), float(row[1]), float(row[2]), float(row[3]), float(row[4]),
            int(float(row[5] or 0)) if len(row) > 5 else 0,
            float(row[6]) if len(row) > 6 and row[6] is not None else "",
        )
    except (TypeError, ValueError, OverflowError):
        return None


def write_csv(path: Path, fields: list[str], rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field, "") for field in fields})


def chunk_dates(start: date, end: date) -> list[tuple[date, date]]:
    chunks = []
    chunk_start = start
    while chunk_start <= end:
        year = chunk_start.year + (1 if chunk_start.month == 12 else 0)
        month = 1 if chunk_start.month == 12 else chunk_start.month + 1
        # Cap requests at one calendar month (inclusive), matching Upstox V3's
        # documented 1-month retrieval window even around February.
        try:
            next_month_same_day = date(year, month, chunk_start.day)
        except ValueError:
            import calendar
            next_month_same_day = date(year, month, calendar.monthrange(year, month)[1])
        chunk_end = min(end, next_month_same_day - timedelta(days=1))
        chunks.append((chunk_start, chunk_end))
        chunk_start = chunk_end + timedelta(days=1)
    return chunks


def request_candles(data: base.UpstoxData, instrument_key: str, to_day: str, from_day: str) -> list[list[Any]]:
    url = (
        "https://api.upstox.com/v2/expired-instruments/historical-candle/"
        f"{quote(instrument_key, safe='')}/1minute/{to_day}/{from_day}"
    )
    return (data.get_json(url).get("data") or {}).get("candles") or []


def request_index_candles(data: base.UpstoxData, to_day: date, from_day: date) -> list[list[Any]]:
    url = (
        "https://api.upstox.com/v3/historical-candle/"
        f"{quote(INDEX_KEY, safe='')}/minutes/1/{to_day.isoformat()}/{from_day.isoformat()}"
    )
    return (data.get_json(url).get("data") or {}).get("candles") or []


def main() -> None:
    report = json.loads(REPORT_PATH.read_text(encoding="utf-8"))
    sessions = [
        session for session in report["sessions"]
        if session.get("underlying") == "BANKNIFTY" and session.get("expiry")
    ]
    expiries = sorted({session["expiry"] for session in sessions})
    if not expiries:
        raise RuntimeError("The backtest report has no Bank Nifty expiry sessions.")

    data = base.UpstoxData(base.load_token())
    try:
        # Load expired monthly future candles and contract masters for each expiry.
        expiry_listing = data.get_expiries(INDEX_KEY)
        futures_by_bar: dict[tuple[str, str], dict[str, Any]] = {}
        contracts_by_key: dict[str, dict[str, Any]] = {}
        contracts_by_expiry: dict[str, list[dict[str, Any]]] = {}

        for expiry in expiries:
            month_expiries = [item for item in expiry_listing if item[:7] == expiry[:7]]
            monthly_expiry = max(month_expiries) if month_expiries else expiry
            future = data.get_expired_future(INDEX_KEY, monthly_expiry)
            if not future:
                raise RuntimeError(f"No expired Bank Nifty future contract was returned for {monthly_expiry}.")
            future_key = str(future["instrument_key"])
            future_start = (date.fromisoformat(monthly_expiry) - timedelta(days=10)).isoformat()
            for raw in request_candles(data, future_key, monthly_expiry, future_start):
                candle = candle_fields(raw)
                if candle is None:
                    continue
                timestamp, open_, high, low, close, volume, oi = candle
                futures_by_bar[(future_key, timestamp)] = {
                    "time": timestamp, "underlying": "BANKNIFTY", "instrument_key": future_key,
                    "trading_symbol": future.get("trading_symbol", ""), "expiry": future.get("expiry", monthly_expiry),
                    "open": open_, "high": high, "low": low, "close": close,
                    "volume": volume, "open_interest": oi,
                }

            contracts = data.get_options(INDEX_KEY, expiry)
            contracts_by_expiry[expiry] = contracts
            for contract in contracts:
                key = str(contract.get("instrument_key") or "")
                if key:
                    contracts_by_key[key] = contract

        if not futures_by_bar:
            raise RuntimeError("No regular-session Bank Nifty futures candles were returned.")

        # Use the exact futures data coverage as the index export date window.
        future_days = [date.fromisoformat(row["time"][:10]) for row in futures_by_bar.values()]
        index_start, index_end = min(future_days), max(future_days)
        index_by_bar: dict[str, dict[str, Any]] = {}
        date_chunks = chunk_dates(index_start, index_end)
        for number, (from_day, to_day) in enumerate(date_chunks, start=1):
            raw_rows = request_index_candles(data, to_day, from_day)
            for raw in raw_rows:
                candle = candle_fields(raw)
                if candle is None:
                    continue
                timestamp, open_, high, low, close, volume, oi = candle
                index_by_bar[timestamp] = {
                    "time": timestamp, "underlying": "BANKNIFTY", "instrument_key": INDEX_KEY,
                    "open": open_, "high": high, "low": low, "close": close,
                    "volume": volume, "open_interest": oi,
                }
            print(f"Index window {number}/{len(date_chunks)}: {from_day} to {to_day}, {len(raw_rows)} candles")

        if not index_by_bar:
            raise RuntimeError("No Bank Nifty index candles were returned.")

        # Export full contract metadata, and candle history for contracts exercised
        # by the 1-DTE/expiry trend backtest sessions.
        option_by_bar: dict[tuple[str, str], dict[str, Any]] = {}
        option_pairs: set[tuple[str, str, str]] = set()
        for session in sessions:
            session_day = str(session["date"] or "")
            if not session_day:
                continue
            prior_day = (date.fromisoformat(session_day) - timedelta(days=1)).isoformat()
            for trade in session.get("trades") or []:
                instrument_key = str(trade.get("instrument_key") or "")
                if not instrument_key:
                    continue
                pair = (instrument_key, session_day, prior_day)
                if pair in option_pairs:
                    continue
                option_pairs.add(pair)
                contract = contracts_by_key.get(instrument_key, {})
                if not contract:
                    contract = {
                        "instrument_key": instrument_key,
                        "trading_symbol": trade.get("symbol", ""),
                        "expiry": trade.get("expiry", session["expiry"]),
                        "instrument_type": trade.get("option_type", ""),
                        "strike_price": trade.get("strike", ""),
                        "lot_size": trade.get("lot_size", ""),
                        "segment": "NSE_FO",
                    }
                for raw in request_candles(data, instrument_key, session_day, prior_day):
                    candle = candle_fields(raw)
                    if candle is None:
                        continue
                    timestamp, open_, high, low, close, volume, oi = candle
                    option_by_bar[(instrument_key, timestamp)] = {
                        "time": timestamp, "underlying": "BANKNIFTY", "instrument_key": instrument_key,
                        "trading_symbol": contract.get("trading_symbol") or trade.get("symbol", ""),
                        "expiry": contract.get("expiry") or trade.get("expiry") or session["expiry"],
                        "option_type": contract.get("instrument_type") or trade.get("option_type", ""),
                        "strike": contract.get("strike_price", trade.get("strike", "")),
                        "lot_size": contract.get("lot_size", trade.get("lot_size", "")),
                        "exchange_segment": str(contract.get("segment") or "NSE_FO").lower(),
                        "open": open_, "high": high, "low": low, "close": close,
                        "volume": volume, "open_interest": oi,
                    }

        EXPORT_DIR.mkdir(parents=True, exist_ok=True)
        index_rows = sorted(index_by_bar.values(), key=lambda row: row["time"])
        future_rows = sorted(futures_by_bar.values(), key=lambda row: (row["time"], row["instrument_key"]))
        option_rows = sorted(option_by_bar.values(), key=lambda row: (row["time"], row["instrument_key"]))
        master_rows: list[dict[str, Any]] = []
        for expiry in expiries:
            for contract in contracts_by_expiry[expiry]:
                master_rows.append({
                    "underlying": "BANKNIFTY",
                    "underlying_key": contract.get("underlying_key", INDEX_KEY),
                    "underlying_symbol": contract.get("underlying_symbol", "BANKNIFTY"),
                    "instrument_key": contract.get("instrument_key", ""),
                    "trading_symbol": contract.get("trading_symbol", ""),
                    "expiry": contract.get("expiry", expiry),
                    "option_type": contract.get("instrument_type", ""),
                    "strike": contract.get("strike_price", ""),
                    "lot_size": contract.get("lot_size", ""),
                    "tick_size": contract.get("tick_size", ""),
                    "exchange": contract.get("exchange", "NSE"),
                    "exchange_segment": str(contract.get("segment", "NSE_FO")).lower(),
                    "weekly": contract.get("weekly", ""),
                    "freeze_quantity": contract.get("freeze_quantity", ""),
                    "minimum_lot": contract.get("minimum_lot", ""),
                })

        write_csv(EXPORT_DIR / "banknifty_index_1m.csv", INDEX_FIELDS, index_rows)
        write_csv(EXPORT_DIR / "banknifty_futures_1m.csv", FUTURE_FIELDS, future_rows)
        write_csv(EXPORT_DIR / "banknifty_options_1m.csv", OPTION_FIELDS, option_rows)
        write_csv(EXPORT_DIR / "banknifty_option_contracts.csv", CONTRACT_FIELDS, master_rows)

        option_days = [date.fromisoformat(row["time"][:10]) for row in option_rows]
        metadata = {
            "data_source": "Upstox historical candle and expired-instruments APIs",
            "timezone": "Asia/Kolkata (timestamps retain the +05:30 offset)",
            "session_filter": "Weekdays, 09:15 through 15:29 IST",
            "index_instrument_key": INDEX_KEY,
            "index_range": [index_rows[0]["time"], index_rows[-1]["time"]],
            "index_bar_count": len(index_rows),
            "futures_range": [future_rows[0]["time"], future_rows[-1]["time"]],
            "futures_bar_count": len(future_rows),
            "futures_contract_count": len({row["instrument_key"] for row in future_rows}),
            "option_candle_range": [min(option_days).isoformat(), max(option_days).isoformat()] if option_days else None,
            "option_bar_count": len(option_rows),
            "option_contracts_with_candles": len({row["instrument_key"] for row in option_rows}),
            "option_contract_session_requests": len(option_pairs),
            "contract_master_expiries": expiries,
            "contract_master_row_count": len(master_rows),
            "option_candle_scope": "Only exact option contracts with trades in the included BANKNIFTY 1-DTE/expiry backtest report; contract master contains all listed options for the 19 expiries.",
            "option_candle_history_is_full_chain": False,
            "backtest_report": REPORT_PATH.name,
            "files": [
                "banknifty_index_1m.csv",
                "banknifty_futures_1m.csv",
                "banknifty_options_1m.csv",
                "banknifty_option_contracts.csv",
            ],
        }
        (EXPORT_DIR / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
        (EXPORT_DIR / "README.md").write_text(
            "# Bank Nifty 1-minute historical data\n\n"
            "Source: Upstox historical candle and expired-instruments APIs. Timestamps are in Asia/Kolkata (+05:30). All candle files are filtered to weekdays, 09:15–15:29 IST.\n\n"
            "- `banknifty_index_1m.csv`: Bank Nifty index candles, spanning "
            f"{index_rows[0]['time']} through {index_rows[-1]['time']} ({len(index_rows):,} bars).\n"
            "- `banknifty_futures_1m.csv`: expired monthly futures candles used as the backtest's underlying price series.\n"
            "- `banknifty_options_1m.csv`: actual 1-minute candles for option contracts selected/traded by the saved 1-DTE/expiry backtest; it does not contain every strike's history.\n"
            "- `banknifty_option_contracts.csv`: contract metadata for all option instruments returned for the included expiries.\n\n"
            f"The option candle file contains {len(option_rows):,} bars across {metadata['option_contracts_with_candles']} distinct contracts and {len(option_pairs)} contract/session requests. The master contains {len(master_rows):,} contracts across {len(expiries)} expiries. See `metadata.json` for exact coverage and counts.\n",
            encoding="utf-8",
        )

        print(f"Saved exports to {EXPORT_DIR}")
        print(f"Index: {len(index_rows):,} bars; futures: {len(future_rows):,} bars; options: {len(option_rows):,} bars")
        print(f"Option contracts with candles: {metadata['option_contracts_with_candles']}; contract master: {len(master_rows):,}")
    finally:
        data.close()


if __name__ == "__main__":
    main()
