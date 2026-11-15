"""Fail-closed Python bridge for the Rust execution engine.

Python continues to own Kotak authentication and calls the official Neo SDK.
All broker order mutations pass through the Rust/PyO3 gateway, which validates
the request, adds a unique correlation tag, records dispatch state, and never
retries an ambiguous broker call.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

try:
    from app.execution import _neo_exec
except ImportError as exc:  # Keep research and paper workflows usable without Rust.
    _neo_exec = None
    _IMPORT_ERROR = type(exc).__name__
else:
    _IMPORT_ERROR = None


class RustExecutionUnavailable(RuntimeError):
    """Raised when a broker mutation is attempted without the native engine."""


_ENGINE = _neo_exec.ExecutionEngine() if _neo_exec is not None else None


def is_rust_execution_available() -> bool:
    return _ENGINE is not None


def dispatch_kotak_mutation(client: Any, operation: str, **request: Any) -> Any:
    if _ENGINE is None:
        raise RustExecutionUnavailable(
            "Rust execution module is not built. Install Rust and run `maturin develop`; "
            "live Kotak order mutations are disabled until it is available."
        )
    return _ENGINE.dispatch(client, operation, request)


def risk_halt_code(
    *,
    daily_net_pnl: float,
    daily_loss_limit: float,
    drawdown_pct: float,
    max_drawdown_pct: float,
    loss_streak: int,
    max_consecutive_losses: int,
    unresolved_orders: int,
    unmarked_positions: int,
) -> str | None:
    if _neo_exec is None:
        return None
    return _neo_exec.risk_halt_code(
        daily_net_pnl,
        daily_loss_limit,
        drawdown_pct,
        max_drawdown_pct,
        loss_streak,
        max_consecutive_losses,
        unresolved_orders,
        unmarked_positions,
    )


def calculate_option_position_size(
    *,
    initial_capital: float,
    risk_pct_per_trade: float,
    entry_price: float,
    stop_price: float,
    lot_size: int,
    max_lots: int,
) -> dict[str, Any]:
    if _neo_exec is not None:
        return _neo_exec.size_option_position(
            initial_capital,
            risk_pct_per_trade,
            entry_price,
            stop_price,
            lot_size,
            max_lots,
        )
    risk_budget = float(initial_capital) * float(risk_pct_per_trade) / 100.0
    risk_per_unit = float(entry_price) - float(stop_price)
    risk_per_lot = risk_per_unit * int(lot_size)
    lots = min(int(max_lots), int(risk_budget // risk_per_lot)) if risk_per_lot > 0 else 0
    quantity = lots * int(lot_size)
    return {
        "risk_budget": risk_budget,
        "risk_per_unit": risk_per_unit,
        "risk_per_lot": risk_per_lot,
        "lots": lots,
        "quantity": quantity,
        "risk_cash": risk_per_unit * quantity,
        "allowed": lots > 0,
    }


def inspect_market_csv(path: str | Path, kind: str) -> dict[str, Any]:
    if _neo_exec is None:
        raise RustExecutionUnavailable("Rust CSV inspector is not built.")
    return _neo_exec.inspect_market_csv(str(path), kind)


def rust_execution_status() -> dict[str, Any]:
    if _ENGINE is None:
        return {
            "available": False,
            "runtime": "unavailable",
            "reason": f"Native Rust module is not built ({_IMPORT_ERROR or 'import failure'}).",
            "order_dispatch_enabled": False,
            "build_command": "maturin develop --manifest-path rust/neo_execution/Cargo.toml",
        }
    result = _ENGINE.status()
    # The native bridge being present does not mean the app's live-trading
    # gate or authenticated broker session is active. Those are reported by
    # the FastAPI layer, which owns that configuration.
    result["order_dispatch_enabled"] = True
    result["engine_version"] = getattr(_neo_exec, "RUST_ENGINE_VERSION", "unknown")
    return result
