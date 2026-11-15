"""Allowlisted local research datasets and large CSV inspection helpers."""

from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
EXPORT_ROOT = ROOT / "data" / "exports"

LOCAL_DATASETS: dict[str, dict[str, str]] = {
    "banknifty_1m": {
        "label": "Bank Nifty 1 minute from Upstox",
        "directory": "banknifty_1m",
        "underlying_file": "banknifty_index_1m.csv",
        "options_file": "banknifty_options_1m.csv",
        "metadata_file": "metadata.json",
        "underlying": "BANKNIFTY",
    },
}


def local_dataset_manifest() -> dict[str, Any]:
    datasets = []
    for dataset_id, config in LOCAL_DATASETS.items():
        directory = EXPORT_ROOT / config["directory"]
        underlying_path = directory / config["underlying_file"]
        options_path = directory / config["options_file"]
        metadata_path = directory / config["metadata_file"]
        if not (underlying_path.is_file() and options_path.is_file() and metadata_path.is_file()):
            continue
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            metadata = {}
        datasets.append({
            "id": dataset_id,
            "label": config["label"],
            "underlying": config["underlying"],
            "underlying_file": config["underlying_file"],
            "options_file": config["options_file"],
            "underlying_rows": int(metadata.get("index_bar_count") or 0),
            "option_rows": int(metadata.get("option_bar_count") or 0),
            "option_contracts": int(metadata.get("option_contracts_with_candles") or 0),
            "contract_master_rows": int(metadata.get("contract_master_row_count") or 0),
            "index_range": metadata.get("index_range"),
            "option_range": metadata.get("option_candle_range"),
            "underlying_bytes": underlying_path.stat().st_size,
            "options_bytes": options_path.stat().st_size,
            "directory": config["directory"],
        })
    return {"ok": True, "datasets": datasets}


def local_dataset_paths(dataset_id: str) -> tuple[Path, Path]:
    config = LOCAL_DATASETS.get(dataset_id)
    if not config:
        raise KeyError("Local research dataset was not found.")
    directory = EXPORT_ROOT / config["directory"]
    underlying_path = directory / config["underlying_file"]
    options_path = directory / config["options_file"]
    if not underlying_path.is_file() or not options_path.is_file():
        raise FileNotFoundError("The saved Bank Nifty CSV exports are not available on this computer.")
    return underlying_path, options_path


def load_local_dataset(dataset_id: str) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    underlying_path, options_path = local_dataset_paths(dataset_id)
    return _read_csv(underlying_path), _read_csv(options_path)


def inspect_local_dataset(dataset_id: str) -> dict[str, Any]:
    underlying_path, options_path = local_dataset_paths(dataset_id)
    underlying, engine = inspect_csv_file(underlying_path, "underlying")
    options, _ = inspect_csv_file(options_path, "options")
    return {
        "ok": True,
        "dataset_id": dataset_id,
        "validation_engine": engine,
        "underlying": underlying,
        "options": options,
    }


def inspect_csv_file(path: str | Path, kind: str) -> tuple[dict[str, Any], str]:
    from app.execution import inspect_market_csv, is_rust_execution_available

    if is_rust_execution_available():
        return inspect_market_csv(path, kind), "rust-pyo3"
    return _inspect_python(Path(path), kind), "python-fallback"


def summarize_csv_pair(underlying_path: str | Path, options_path: str | Path) -> dict[str, Any]:
    """Build compact counts and coverage metadata using a streaming CSV pass."""

    def read_summary(path: str | Path, kind: str) -> dict[str, Any]:
        count = 0
        first_time: str | None = None
        last_time: str | None = None
        contracts: set[str] = set()
        expiries: list[str] = []
        with Path(path).open("r", newline="", encoding="utf-8-sig") as handle:
            reader = csv.DictReader(handle)
            headers = [str(field or "").strip().lower().replace(" ", "_").replace("-", "_") for field in reader.fieldnames or []]
            reader.fieldnames = headers
            time_field = next((name for name in ("time", "timestamp", "datetime") if name in headers), None)
            if not time_field:
                raise ValueError("CSV must contain a time, timestamp, or datetime column.")
            contract_field = next((name for name in ("instrument_key", "contract_id", "trading_symbol", "symbol") if name in headers), None)
            expiry_field = next((name for name in ("expiry",) if name in headers), None)
            for row in reader:
                count += 1
                timestamp = str(row.get(time_field) or "").strip()
                if timestamp:
                    first_time = timestamp if first_time is None else min(first_time, timestamp)
                    last_time = timestamp if last_time is None else max(last_time, timestamp)
                if kind == "options":
                    contract = str(row.get(contract_field) or "").strip() if contract_field else ""
                    if contract:
                        contracts.add(contract)
                    expiry = str(row.get(expiry_field) or "").strip() if expiry_field else ""
                    if expiry:
                        expiries.append(expiry)
        return {"rows": count, "first_time": first_time, "last_time": last_time, "contracts": contracts, "expiries": expiries}

    underlying = read_summary(underlying_path, "underlying")
    options = read_summary(options_path, "options")
    expiry_range = [min(options["expiries"]), max(options["expiries"])] if options["expiries"] else None
    return {
        "index_bar_count": underlying["rows"],
        "option_bar_count": options["rows"],
        "option_contracts_with_candles": len(options["contracts"]),
        "contract_master_row_count": 0,
        "index_range": [underlying["first_time"], underlying["last_time"]],
        "option_candle_range": expiry_range,
    }


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", newline="", encoding="utf-8-sig") as handle:
        return [row for row in csv.DictReader(handle) if any(str(value or "").strip() for value in row.values())]


def _inspect_python(path: Path, kind: str) -> dict[str, Any]:
    if kind not in {"underlying", "options"}:
        raise ValueError("CSV kind must be underlying or options.")
    seen: set[tuple[str, str]] = set()
    row_count = invalid = duplicates = 0
    first_time: str | None = None
    last_time: str | None = None
    with path.open("r", newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        headers = [str(field or "").strip().lower().replace(" ", "_").replace("-", "_") for field in reader.fieldnames or []]
        reader.fieldnames = headers
        time_field = next((name for name in ("time", "timestamp", "datetime") if name in headers), None)
        if not time_field:
            raise ValueError("CSV must contain time, timestamp, or datetime.")
        required = {"open", "high", "low", "close"}
        missing = required - set(headers)
        if missing:
            raise ValueError(f"CSV is missing required columns: {', '.join(sorted(missing))}.")
        key_field = next((name for name in ("instrument_key", "contract_id", "trading_symbol", "symbol") if name in headers), "")
        if kind == "options":
            aliases = (
                ("instrument key", {"instrument_key", "contract_id", "trading_symbol", "symbol"}),
                ("expiry", {"expiry"}),
                ("option type", {"option_type", "type"}),
                ("strike", {"strike", "strike_price"}),
                ("lot size", {"lot_size"}),
            )
            missing_options = [label for label, names in aliases if not names.intersection(headers)]
            if missing_options:
                raise ValueError(f"Option CSV is missing {', '.join(missing_options)}.")
        for row in reader:
            if not any(str(value or "").strip() for value in row.values()):
                continue
            row_count += 1
            timestamp = str(row.get(time_field) or "").strip()
            key = str(row.get(key_field) or "").strip()
            marker = (key, timestamp)
            if marker in seen:
                duplicates += 1
            else:
                seen.add(marker)
            if timestamp and (first_time is None or timestamp < first_time):
                first_time = timestamp
            if timestamp and (last_time is None or timestamp > last_time):
                last_time = timestamp
            try:
                open_, high, low, close = (float(row[field]) for field in ("open", "high", "low", "close"))
                if not all(map(lambda number: number == number and abs(number) != float("inf"), (open_, high, low, close))):
                    raise ValueError
                if high < max(open_, low, close) or low > min(open_, high, close):
                    raise ValueError
            except (KeyError, TypeError, ValueError):
                invalid += 1
    return {
        "kind": kind,
        "path_name": path.name,
        "file_bytes": path.stat().st_size,
        "headers": headers,
        "rows": row_count,
        "valid_rows": max(0, row_count - invalid - duplicates),
        "invalid_ohlc": invalid,
        "duplicate_bars": duplicates,
        "first_time": first_time,
        "last_time": last_time,
    }
