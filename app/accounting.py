"""
Broker-independent Position Accounting & FIFO Engine for Neo PIP Terminal
Implements:
- Net position lifecycle management (OPEN, PARTIALLY_CLOSED, CLOSED)
- Persistent FIFO matching of entry lots against exit executions
- Exact Decimal financial arithmetic for Gross & Net Realised P&L
- Statutory charges calculation & proportional lot allocation (STT, Exchange, SEBI, GST, Stamp Duty)
- Position reversal handling with automatic new lifecycle generation
- Immutable Execution Ledger and Audit Trail
- Daily P&L aggregation (IST Asia/Kolkata settlement)
- Full ledger replay and reconciliation recovery
"""

import sqlite3
import uuid
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Any
import zoneinfo

IST = zoneinfo.ZoneInfo("Asia/Kolkata")


def utc_iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def to_ist_date(utc_iso_string: str) -> str:
    try:
        dt = datetime.fromisoformat(utc_iso_string)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(IST).strftime("%Y-%m-%d")
    except Exception:
        return datetime.now(IST).strftime("%Y-%m-%d")


def init_accounting_db(conn: sqlite3.Connection) -> None:
    """Initialize database tables and indexes for position accounting."""
    conn.execute("""
    CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        broker_execution_id TEXT NOT NULL,
        order_id TEXT,
        account_id TEXT NOT NULL,
        instrument_key TEXT NOT NULL,
        trading_symbol TEXT NOT NULL,
        exchange TEXT NOT NULL,
        segment TEXT NOT NULL,
        product_type TEXT NOT NULL,
        side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
        quantity INTEGER NOT NULL CHECK(quantity > 0),
        price TEXT NOT NULL,
        multiplier TEXT NOT NULL DEFAULT '1',
        execution_time TEXT NOT NULL,
        received_at TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        UNIQUE(account_id, broker_execution_id)
    )""")

    conn.execute("""
    CREATE TABLE IF NOT EXISTS positions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        instrument_key TEXT NOT NULL,
        trading_symbol TEXT NOT NULL,
        product_type TEXT NOT NULL,
        lifecycle_number INTEGER NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('LONG','SHORT')),
        open_quantity INTEGER NOT NULL,
        average_entry_price TEXT NOT NULL,
        realised_gross_pnl TEXT NOT NULL DEFAULT '0',
        realised_net_pnl TEXT NOT NULL DEFAULT '0',
        total_charges TEXT NOT NULL DEFAULT '0',
        status TEXT NOT NULL CHECK(status IN ('OPEN','PARTIALLY_CLOSED','CLOSED')),
        opened_at TEXT NOT NULL,
        closed_at TEXT,
        exit_reason TEXT,
        UNIQUE(account_id, instrument_key, product_type, lifecycle_number)
    )""")

    conn.execute("""
    CREATE TABLE IF NOT EXISTS position_lots (
        id TEXT PRIMARY KEY,
        position_id TEXT NOT NULL,
        entry_execution_id TEXT NOT NULL,
        original_quantity INTEGER NOT NULL,
        remaining_quantity INTEGER NOT NULL,
        entry_price TEXT NOT NULL,
        execution_time TEXT NOT NULL,
        FOREIGN KEY(position_id) REFERENCES positions(id),
        FOREIGN KEY(entry_execution_id) REFERENCES executions(id)
    )""")

    conn.execute("""
    CREATE TABLE IF NOT EXISTS position_matches (
        id TEXT PRIMARY KEY,
        position_id TEXT NOT NULL,
        entry_execution_id TEXT NOT NULL,
        exit_execution_id TEXT NOT NULL,
        matched_quantity INTEGER NOT NULL,
        entry_price TEXT NOT NULL,
        exit_price TEXT NOT NULL,
        gross_realised_pnl TEXT NOT NULL,
        allocated_entry_charges TEXT DEFAULT '0',
        allocated_exit_charges TEXT DEFAULT '0',
        net_realised_pnl TEXT NOT NULL,
        matched_at TEXT NOT NULL,
        FOREIGN KEY(position_id) REFERENCES positions(id),
        FOREIGN KEY(entry_execution_id) REFERENCES executions(id),
        FOREIGN KEY(exit_execution_id) REFERENCES executions(id)
    )""")

    conn.execute("""
    CREATE TABLE IF NOT EXISTS charges (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        charge_type TEXT NOT NULL,
        amount TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'INR',
        source TEXT NOT NULL,
        FOREIGN KEY(execution_id) REFERENCES executions(id)
    )""")

    conn.execute("""
    CREATE TABLE IF NOT EXISTS daily_pnl (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        gross_realised_pnl TEXT NOT NULL DEFAULT '0',
        total_charges TEXT NOT NULL DEFAULT '0',
        net_realised_pnl TEXT NOT NULL DEFAULT '0',
        winning_positions INTEGER NOT NULL DEFAULT 0,
        losing_positions INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        UNIQUE(account_id, trade_date)
    )""")

    # Performance and Integrity Indexes
    conn.execute("CREATE INDEX IF NOT EXISTS idx_executions_instrument_time ON executions(account_id, instrument_key, execution_time)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(account_id, status)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_matches_position ON position_matches(position_id, matched_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_matches_exit_execution ON position_matches(exit_execution_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_lots_fifo ON position_lots(position_id, execution_time)")
    conn.commit()


def calculate_statutory_charges(
    segment: str,
    side: str,
    quantity: int,
    price: Decimal,
    multiplier: Decimal = Decimal("1"),
) -> dict[str, Decimal]:
    """
    Calculate regulatory charges for Indian F&O:
    - Brokerage: 0 (Kotak Neo Free F&O trade plan)
    - STT: 0.1% on options sell turnover
    - Exchange turnover: 0.05% on option premium turnover
    - SEBI charges: ₹10 per crore (0.0001%)
    - Stamp duty: 0.003% on buy turnover
    - GST: 18% on (Exchange turnover + SEBI turnover)
    """
    turnover = (Decimal(quantity) * price * multiplier).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    zero = Decimal("0.00")
    two_places = Decimal("0.01")

    # Kotak Zero Brokerage
    brokerage = zero

    is_sell = side.upper() == "SELL"
    is_buy = side.upper() == "BUY"

    # STT: 0.1% on sell side for option premium
    stt = (turnover * Decimal("0.001")).quantize(two_places, rounding=ROUND_HALF_UP) if is_sell else zero

    # Exchange transaction charge ~ 0.05% (0.0005)
    exchange_charges = (turnover * Decimal("0.0005")).quantize(two_places, rounding=ROUND_HALF_UP)

    # SEBI turnover charges: 0.0001% (₹10 / Crore)
    sebi_charges = (turnover * Decimal("0.000001")).quantize(two_places, rounding=ROUND_HALF_UP)

    # Stamp Duty: 0.003% on Buy side only
    stamp_duty = (turnover * Decimal("0.00003")).quantize(two_places, rounding=ROUND_HALF_UP) if is_buy else zero

    # GST: 18% on (Exchange charges + SEBI charges)
    gst_base = exchange_charges + sebi_charges
    gst = (gst_base * Decimal("0.18")).quantize(two_places, rounding=ROUND_HALF_UP)

    total = brokerage + stt + exchange_charges + sebi_charges + stamp_duty + gst
    return {
        "brokerage": brokerage,
        "stt": stt,
        "exchange_charges": exchange_charges,
        "sebi_charges": sebi_charges,
        "stamp_duty": stamp_duty,
        "gst": gst,
        "total": total.quantize(two_places, rounding=ROUND_HALF_UP),
    }


def process_execution(
    execution_data: dict[str, Any],
    conn: sqlite3.Connection,
    is_replay: bool = False,
) -> dict[str, Any]:
    """
    Core FIFO Position Accounting Engine.
    Processes an individual execution within a database transaction.
    """
    account_id = str(execution_data.get("account_id") or "DEFAULT_ACCOUNT")
    broker_exec_id = str(execution_data.get("broker_execution_id") or str(uuid.uuid4()))
    order_id = str(execution_data.get("order_id") or "")
    instrument_key = str(execution_data.get("instrument_key") or execution_data.get("symbol") or "UNKNOWN")
    trading_symbol = str(execution_data.get("trading_symbol") or execution_data.get("symbol") or instrument_key)
    exchange = str(execution_data.get("exchange") or "NSE")
    segment = str(execution_data.get("segment") or "NSE_FO")
    product_type = str(execution_data.get("product_type") or "NRML").upper()
    side = str(execution_data.get("side") or "BUY").upper()
    quantity = int(execution_data.get("quantity") or 0)
    price = Decimal(str(execution_data.get("price") or "0")).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
    multiplier = Decimal(str(execution_data.get("multiplier") or "1"))
    execution_time = str(execution_data.get("execution_time") or utc_iso_now())
    received_at = str(execution_data.get("received_at") or utc_iso_now())
    source = str(execution_data.get("source") or "MANUAL")

    if quantity <= 0:
        raise ValueError("Execution quantity must be strictly greater than zero")
    if price <= 0:
        raise ValueError("Execution price must be strictly greater than zero")

    cursor = conn.cursor()

    # 1. Idempotency Check
    existing_exec = cursor.execute(
        "SELECT id FROM executions WHERE account_id = ? AND broker_execution_id = ?",
        (account_id, broker_exec_id)
    ).fetchone()

    if existing_exec and not is_replay:
        return {"ok": True, "duplicate": True, "execution_id": existing_exec[0], "message": "Execution already processed"}

    if is_replay and existing_exec:
        exec_id = existing_exec[0]
    else:
        exec_id = str(uuid.uuid4())
        cursor.execute("""
            INSERT INTO executions (
                id, broker_execution_id, order_id, account_id, instrument_key,
                trading_symbol, exchange, segment, product_type, side,
                quantity, price, multiplier, execution_time, received_at, source, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
        """, (
            exec_id, broker_exec_id, order_id, account_id, instrument_key,
            trading_symbol, exchange, segment, product_type, side,
            quantity, str(price), str(multiplier), execution_time, received_at, source
        ))

    # 2. Statutory charges calculation & recording (only if not replay)
    charges_dict = calculate_statutory_charges(segment, side, quantity, price, multiplier)
    total_exec_charges = charges_dict["total"]
    if not is_replay:
        for c_type, c_amount in charges_dict.items():
            if c_type != "total" and c_amount > 0:
                cursor.execute("""
                    INSERT INTO charges (id, execution_id, charge_type, amount, currency, source)
                    VALUES (?, ?, ?, ?, 'INR', ?)
                """, (str(uuid.uuid4()), exec_id, c_type, str(c_amount), "LOCAL_CALCULATOR"))

    # 3. Find current active position lifecycle
    pos_row = cursor.execute("""
        SELECT * FROM positions
        WHERE account_id = ? AND instrument_key = ? AND product_type = ?
          AND status IN ('OPEN', 'PARTIALLY_CLOSED')
        ORDER BY lifecycle_number DESC LIMIT 1
    """, (account_id, instrument_key, product_type)).fetchone()

    trade_date = to_ist_date(execution_time)

    if not pos_row:
        # Case A: Open a new position lifecycle
        max_life = cursor.execute("""
            SELECT COALESCE(MAX(lifecycle_number), 0) FROM positions
            WHERE account_id = ? AND instrument_key = ? AND product_type = ?
        """, (account_id, instrument_key, product_type)).fetchone()[0]

        new_lifecycle = max_life + 1
        pos_direction = "LONG" if side == "BUY" else "SHORT"
        pos_id = str(uuid.uuid4())

        cursor.execute("""
            INSERT INTO positions (
                id, account_id, instrument_key, trading_symbol, product_type,
                lifecycle_number, direction, open_quantity, average_entry_price,
                realised_gross_pnl, realised_net_pnl, total_charges,
                status, opened_at, closed_at, exit_reason
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '0', '0', '0', 'OPEN', ?, NULL, NULL)
        """, (
            pos_id, account_id, instrument_key, trading_symbol, product_type,
            new_lifecycle, pos_direction, quantity, str(price), execution_time
        ))

        # Insert initial entry lot
        lot_id = str(uuid.uuid4())
        cursor.execute("""
            INSERT INTO position_lots (
                id, position_id, entry_execution_id, original_quantity,
                remaining_quantity, entry_price, execution_time
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (lot_id, pos_id, exec_id, quantity, quantity, str(price), execution_time))

        return {
            "ok": True,
            "action": "POSITION_OPENED",
            "position_id": pos_id,
            "lifecycle_number": new_lifecycle,
            "direction": pos_direction,
            "open_quantity": quantity,
            "average_entry_price": str(price),
        }

    pos_id = pos_row["id"]
    pos_direction = pos_row["direction"]
    current_open_qty = int(pos_row["open_quantity"])
    current_avg_price = Decimal(str(pos_row["average_entry_price"]))
    current_gross_pnl = Decimal(str(pos_row["realised_gross_pnl"]))
    current_net_pnl = Decimal(str(pos_row["realised_net_pnl"]))
    current_charges = Decimal(str(pos_row["total_charges"]))
    lifecycle_num = int(pos_row["lifecycle_number"])

    is_same_side = (pos_direction == "LONG" and side == "BUY") or (pos_direction == "SHORT" and side == "SELL")

    if is_same_side:
        # Case B: Adding to existing open position
        new_open_qty = current_open_qty + quantity
        new_avg_price = (
            (Decimal(current_open_qty) * current_avg_price) + (Decimal(quantity) * price)
        ) / Decimal(new_open_qty)
        new_avg_str = str(new_avg_price.quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP))

        cursor.execute("""
            UPDATE positions
            SET open_quantity = ?, average_entry_price = ?, status = 'OPEN'
            WHERE id = ?
        """, (new_open_qty, new_avg_str, pos_id))

        lot_id = str(uuid.uuid4())
        cursor.execute("""
            INSERT INTO position_lots (
                id, position_id, entry_execution_id, original_quantity,
                remaining_quantity, entry_price, execution_time
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (lot_id, pos_id, exec_id, quantity, quantity, str(price), execution_time))

        return {
            "ok": True,
            "action": "POSITION_INCREASED",
            "position_id": pos_id,
            "open_quantity": new_open_qty,
            "average_entry_price": new_avg_str,
        }

    # Case C: Opposite-side fill (Consumes FIFO lots, partial/full close, or reversal)
    lots = cursor.execute("""
        SELECT pl.*, e.quantity as exec_total_qty,
               (SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) FROM charges WHERE execution_id = e.id) as exec_total_charges
        FROM position_lots pl
        JOIN executions e ON pl.entry_execution_id = e.id
        WHERE pl.position_id = ? AND pl.remaining_quantity > 0
        ORDER BY pl.execution_time ASC, pl.rowid ASC
    """, (pos_id,)).fetchall()

    remaining_exit = quantity
    gross_pnl_added = Decimal("0.00")
    net_pnl_added = Decimal("0.00")
    charges_added = Decimal("0.00")

    for lot in lots:
        if remaining_exit <= 0:
            break
        lot_id = lot["id"]
        lot_rem = int(lot["remaining_quantity"])
        matched_qty = min(remaining_exit, lot_rem)

        entry_prc = Decimal(str(lot["entry_price"]))
        exit_prc = price

        if pos_direction == "LONG":
            lot_gross = (exit_prc - entry_prc) * Decimal(matched_qty) * multiplier
        else:
            lot_gross = (entry_prc - exit_prc) * Decimal(matched_qty) * multiplier

        # Proportional charge allocation
        orig_entry_qty = Decimal(lot["exec_total_qty"]) if lot["exec_total_qty"] else Decimal(lot["original_quantity"])
        entry_tot_chg = Decimal(str(lot["exec_total_charges"] or "0"))
        alloc_entry_chg = (entry_tot_chg * (Decimal(matched_qty) / orig_entry_qty)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

        alloc_exit_chg = (total_exec_charges * (Decimal(matched_qty) / Decimal(quantity))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

        lot_net = lot_gross - alloc_entry_chg - alloc_exit_chg

        gross_pnl_added += lot_gross
        net_pnl_added += lot_net
        charges_added += (alloc_entry_chg + alloc_exit_chg)

        # Record position match
        match_id = str(uuid.uuid4())
        cursor.execute("""
            INSERT INTO position_matches (
                id, position_id, entry_execution_id, exit_execution_id,
                matched_quantity, entry_price, exit_price, gross_realised_pnl,
                allocated_entry_charges, allocated_exit_charges, net_realised_pnl, matched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            match_id, pos_id, lot["entry_execution_id"], exec_id,
            matched_qty, str(entry_prc), str(exit_prc),
            str(lot_gross.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)),
            str(alloc_entry_chg), str(alloc_exit_chg),
            str(lot_net.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)),
            execution_time
        ))

        new_lot_rem = lot_rem - matched_qty
        cursor.execute("UPDATE position_lots SET remaining_quantity = ? WHERE id = ?", (new_lot_rem, lot_id))
        remaining_exit -= matched_qty

    updated_gross = (current_gross_pnl + gross_pnl_added).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    updated_net = (current_net_pnl + net_pnl_added).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    updated_charges = (current_charges + charges_added).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

    # Check remaining lots for position
    rem_lots_agg = cursor.execute("""
        SELECT COALESCE(SUM(remaining_quantity), 0) as total_rem,
               COALESCE(SUM(remaining_quantity * CAST(entry_price AS REAL)), 0) as total_val
        FROM position_lots
        WHERE position_id = ? AND remaining_quantity > 0
    """, (pos_id,)).fetchone()

    total_rem = int(rem_lots_agg["total_rem"])
    total_val = Decimal(str(rem_lots_agg["total_val"]))

    if total_rem == 0 and remaining_exit == 0:
        # Full Close
        cursor.execute("""
            UPDATE positions
            SET open_quantity = 0, status = 'CLOSED', closed_at = ?,
                realised_gross_pnl = ?, realised_net_pnl = ?, total_charges = ?
            WHERE id = ?
        """, (execution_time, str(updated_gross), str(updated_net), str(updated_charges), pos_id))
        res_action = "POSITION_CLOSED"
    elif total_rem > 0 and remaining_exit == 0:
        # Partial Close
        new_rem_avg = (total_val / Decimal(total_rem)).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
        cursor.execute("""
            UPDATE positions
            SET open_quantity = ?, average_entry_price = ?, status = 'PARTIALLY_CLOSED',
                realised_gross_pnl = ?, realised_net_pnl = ?, total_charges = ?
            WHERE id = ?
        """, (total_rem, str(new_rem_avg), str(updated_gross), str(updated_net), str(updated_charges), pos_id))
        res_action = "POSITION_PARTIALLY_CLOSED"
    else:
        # total_rem == 0 and remaining_exit > 0 => POSITION REVERSAL
        cursor.execute("""
            UPDATE positions
            SET open_quantity = 0, status = 'CLOSED', closed_at = ?,
                realised_gross_pnl = ?, realised_net_pnl = ?, total_charges = ?
            WHERE id = ?
        """, (execution_time, str(updated_gross), str(updated_net), str(updated_charges), pos_id))

        new_rev_dir = "SHORT" if pos_direction == "LONG" else "LONG"
        new_life = lifecycle_num + 1
        new_pos_id = str(uuid.uuid4())

        cursor.execute("""
            INSERT INTO positions (
                id, account_id, instrument_key, trading_symbol, product_type,
                lifecycle_number, direction, open_quantity, average_entry_price,
                realised_gross_pnl, realised_net_pnl, total_charges,
                status, opened_at, closed_at, exit_reason
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '0', '0', '0', 'OPEN', ?, NULL, NULL)
        """, (
            new_pos_id, account_id, instrument_key, trading_symbol, product_type,
            new_life, new_rev_dir, remaining_exit, str(price), execution_time
        ))

        new_lot_id = str(uuid.uuid4())
        cursor.execute("""
            INSERT INTO position_lots (
                id, position_id, entry_execution_id, original_quantity,
                remaining_quantity, entry_price, execution_time
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (new_lot_id, new_pos_id, exec_id, remaining_exit, remaining_exit, str(price), execution_time))
        res_action = "POSITION_REVERSED"

    # 4. Update Daily P&L for trade_date
    _update_daily_pnl(account_id, trade_date, cursor)

    return {
        "ok": True,
        "action": res_action,
        "position_id": pos_id,
        "matched_quantity": quantity - remaining_exit,
        "gross_realised_pnl": str(updated_gross),
        "net_realised_pnl": str(updated_net),
        "total_charges": str(updated_charges),
    }


def _update_daily_pnl(account_id: str, trade_date: str, cursor: sqlite3.Cursor) -> None:
    """Recalculate and update daily P&L aggregates for an account and trade date."""
    agg = cursor.execute("""
        SELECT
            COALESCE(SUM(CAST(pm.gross_realised_pnl AS REAL)), 0) as gross,
            COALESCE(SUM(CAST(pm.allocated_entry_charges AS REAL) + CAST(pm.allocated_exit_charges AS REAL)), 0) as charges,
            COALESCE(SUM(CAST(pm.net_realised_pnl AS REAL)), 0) as net
        FROM position_matches pm
        JOIN positions p ON pm.position_id = p.id
        WHERE p.account_id = ? AND strftime('%Y-%m-%d', pm.matched_at) = ?
    """, (account_id, trade_date)).fetchone()

    # Winning vs losing closed positions on this date
    stats = cursor.execute("""
        SELECT
            COUNT(CASE WHEN CAST(realised_net_pnl AS REAL) > 0 THEN 1 END) as wins,
            COUNT(CASE WHEN CAST(realised_net_pnl AS REAL) < 0 THEN 1 END) as losses
        FROM positions
        WHERE account_id = ? AND status = 'CLOSED' AND strftime('%Y-%m-%d', closed_at) = ?
    """, (account_id, trade_date)).fetchone()

    gross_val = str(round(agg["gross"], 2))
    charges_val = str(round(agg["charges"], 2))
    net_val = str(round(agg["net"], 2))
    wins = int(stats["wins"] or 0)
    losses = int(stats["losses"] or 0)

    daily_row = cursor.execute("SELECT id FROM daily_pnl WHERE account_id = ? AND trade_date = ?", (account_id, trade_date)).fetchone()
    now_str = utc_iso_now()

    if daily_row:
        cursor.execute("""
            UPDATE daily_pnl
            SET gross_realised_pnl = ?, total_charges = ?, net_realised_pnl = ?,
                winning_positions = ?, losing_positions = ?, updated_at = ?
            WHERE id = ?
        """, (gross_val, charges_val, net_val, wins, losses, now_str, daily_row[0]))
    else:
        cursor.execute("""
            INSERT INTO daily_pnl (
                id, account_id, trade_date, gross_realised_pnl, total_charges,
                net_realised_pnl, winning_positions, losing_positions, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (str(uuid.uuid4()), account_id, trade_date, gross_val, charges_val, net_val, wins, losses, now_str))


def get_open_positions(account_id: str, conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """Retrieve all open and partially closed positions for an account."""
    cursor = conn.cursor()
    rows = cursor.execute("""
        SELECT * FROM positions
        WHERE account_id = ? AND status IN ('OPEN', 'PARTIALLY_CLOSED')
        ORDER BY opened_at DESC
    """, (account_id,)).fetchall()

    results = []
    for r in rows:
        results.append({
            "position_id": r["id"],
            "account_id": r["account_id"],
            "instrument_key": r["instrument_key"],
            "trading_symbol": r["trading_symbol"],
            "symbol": r["trading_symbol"],
            "product_type": r["product_type"],
            "product": r["product_type"],
            "lifecycle_number": r["lifecycle_number"],
            "direction": r["direction"],
            "side": "BUY" if r["direction"] == "LONG" else "SELL",
            "quantity": r["open_quantity"],
            "average_entry_price": r["average_entry_price"],
            "avg_price": float(r["average_entry_price"]),
            "realised_gross_pnl": r["realised_gross_pnl"],
            "realised_net_pnl": r["realised_net_pnl"],
            "total_charges": r["total_charges"],
            "status": r["status"],
            "opened_at": r["opened_at"],
        })
    return results


def get_closed_positions(
    account_id: str,
    from_date: str | None = None,
    to_date: str | None = None,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    """Retrieve closed lifecycles with daily aggregation and FIFO match details."""
    cursor = conn.cursor()
    query = """
        SELECT * FROM positions
        WHERE account_id = ? AND status = 'CLOSED'
    """
    params = [account_id]
    if from_date:
        query += " AND strftime('%Y-%m-%d', closed_at) >= ?"
        params.append(from_date)
    if to_date:
        query += " AND strftime('%Y-%m-%d', closed_at) <= ?"
        params.append(to_date)

    query += " ORDER BY closed_at DESC"
    rows = cursor.execute(query, params).fetchall()

    positions = []
    total_gross = Decimal("0.00")
    total_charges = Decimal("0.00")
    total_net = Decimal("0.00")
    winning_count = 0
    losing_count = 0

    for r in rows:
        pos_id = r["id"]
        gross = Decimal(str(r["realised_gross_pnl"]))
        net = Decimal(str(r["realised_net_pnl"]))
        charges = Decimal(str(r["total_charges"]))

        total_gross += gross
        total_charges += charges
        total_net += net

        if net > Decimal("0.00"):
            winning_count += 1
        elif net < Decimal("0.00"):
            losing_count += 1

        # Fetch FIFO matches
        matches = cursor.execute("""
            SELECT pm.*, e_entry.execution_time as entry_time, e_exit.execution_time as exit_time
            FROM position_matches pm
            JOIN executions e_entry ON pm.entry_execution_id = e_entry.id
            JOIN executions e_exit ON pm.exit_execution_id = e_exit.id
            WHERE pm.position_id = ?
            ORDER BY pm.matched_at ASC
        """, (pos_id,)).fetchall()

        match_list = [{
            "id": m["id"],
            "matched_quantity": m["matched_quantity"],
            "entry_price": m["entry_price"],
            "exit_price": m["exit_price"],
            "gross_realised_pnl": m["gross_realised_pnl"],
            "allocated_entry_charges": m["allocated_entry_charges"],
            "allocated_exit_charges": m["allocated_exit_charges"],
            "net_realised_pnl": m["net_realised_pnl"],
            "matched_at": m["matched_at"],
        } for m in matches]

        # Calculate average exit price across matches
        tot_exit_val = sum(Decimal(str(m["exit_price"])) * Decimal(m["matched_quantity"]) for m in match_list)
        tot_exit_qty = sum(m["matched_quantity"] for m in match_list)
        avg_exit_prc = (tot_exit_val / Decimal(tot_exit_qty)).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP) if tot_exit_qty else Decimal("0.00")

        positions.append({
            "position_id": pos_id,
            "account_id": r["account_id"],
            "instrument_key": r["instrument_key"],
            "trading_symbol": r["trading_symbol"],
            "symbol": r["trading_symbol"],
            "product_type": r["product_type"],
            "lifecycle_number": r["lifecycle_number"],
            "direction": r["direction"],
            "side": "BUY" if r["direction"] == "LONG" else "SELL",
            "executed_quantity": tot_exit_qty,
            "quantity": 0,
            "average_entry_price": r["average_entry_price"],
            "average_exit_price": str(avg_exit_prc),
            "gross_realised_pnl": str(gross),
            "total_charges": str(charges),
            "net_realised_pnl": str(net),
            "opened_at": r["opened_at"],
            "closed_at": r["closed_at"],
            "status": "CLOSED",
            "matches": match_list,
        })

    return {
        "account_id": account_id,
        "currency": "INR",
        "summary": {
            "gross_realised_pnl": str(total_gross.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)),
            "total_charges": str(total_charges.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)),
            "net_realised_pnl": str(total_net.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)),
            "winning_lifecycles": winning_count,
            "losing_lifecycles": losing_count,
            "total_closed_lifecycles": len(positions),
        },
        "positions": positions,
    }


def get_position_details(position_id: str, conn: sqlite3.Connection) -> dict[str, Any] | None:
    """Retrieve full details for a single position lifecycle including open lots and matches."""
    cursor = conn.cursor()
    pos = cursor.execute("SELECT * FROM positions WHERE id = ?", (position_id,)).fetchone()
    if not pos:
        return None

    lots = cursor.execute("""
        SELECT * FROM position_lots WHERE position_id = ? ORDER BY execution_time ASC
    """, (position_id,)).fetchall()

    matches = cursor.execute("""
        SELECT * FROM position_matches WHERE position_id = ? ORDER BY matched_at ASC
    """, (position_id,)).fetchall()

    return {
        "position": dict(pos),
        "open_lots": [dict(l) for l in lots],
        "matches": [dict(m) for m in matches],
    }


def get_executions(account_id: str, limit: int = 100, conn: sqlite3.Connection | None = None) -> list[dict[str, Any]]:
    """Retrieve immutable execution history (Trade History)."""
    cursor = conn.cursor()
    rows = cursor.execute("""
        SELECT * FROM executions
        WHERE account_id = ?
        ORDER BY execution_time DESC, received_at DESC
        LIMIT ?
    """, (account_id, limit)).fetchall()
    return [dict(r) for r in rows]


def get_pnl_summary(account_id: str, conn: sqlite3.Connection) -> dict[str, Any]:
    """Retrieve overall gross and net realized P&L and daily aggregates."""
    cursor = conn.cursor()
    agg = cursor.execute("""
        SELECT
            COALESCE(SUM(CAST(realised_gross_pnl AS REAL)), 0) as gross,
            COALESCE(SUM(CAST(total_charges AS REAL)), 0) as charges,
            COALESCE(SUM(CAST(realised_net_pnl AS REAL)), 0) as net
        FROM positions
        WHERE account_id = ? AND status = 'CLOSED'
    """, (account_id,)).fetchone()

    wins_losses = cursor.execute("""
        SELECT
            COUNT(CASE WHEN CAST(realised_net_pnl AS REAL) > 0 THEN 1 END) as wins,
            COUNT(CASE WHEN CAST(realised_net_pnl AS REAL) < 0 THEN 1 END) as losses,
            COUNT(*) as total
        FROM positions
        WHERE account_id = ? AND status = 'CLOSED'
    """, (account_id,)).fetchone()

    today_str = datetime.now(IST).strftime("%Y-%m-%d")
    today_row = cursor.execute("""
        SELECT * FROM daily_pnl WHERE account_id = ? AND trade_date = ?
    """, (account_id, today_str)).fetchone()

    return {
        "account_id": account_id,
        "currency": "INR",
        "all_time": {
            "gross_realised_pnl": str(round(agg["gross"], 2)),
            "total_charges": str(round(agg["charges"], 2)),
            "net_realised_pnl": str(round(agg["net"], 2)),
            "winning_lifecycles": int(wins_losses["wins"] or 0),
            "losing_lifecycles": int(wins_losses["losses"] or 0),
            "total_closed_lifecycles": int(wins_losses["total"] or 0),
        },
        "today": {
            "trade_date": today_str,
            "gross_realised_pnl": today_row["gross_realised_pnl"] if today_row else "0.00",
            "total_charges": today_row["total_charges"] if today_row else "0.00",
            "net_realised_pnl": today_row["net_realised_pnl"] if today_row else "0.00",
            "winning_positions": today_row["winning_positions"] if today_row else 0,
            "losing_positions": today_row["losing_positions"] if today_row else 0,
        }
    }


def rebuild_accounting_ledger(account_id: str, conn: sqlite3.Connection) -> dict[str, Any]:
    """
    Recovery / Reconciliation:
    Clears derived positions, lots, matches, and daily_pnl,
    and replays all executions in chronological order.
    """
    cursor = conn.cursor()
    # 1. Fetch all executions in chronological order
    all_execs = cursor.execute("""
        SELECT * FROM executions
        WHERE account_id = ? AND status = 'ACTIVE'
        ORDER BY execution_time ASC, rowid ASC
    """, (account_id,)).fetchall()

    exec_list = [dict(e) for e in all_execs]

    # 2. Clear derived tables for this account
    pos_ids = [r[0] for r in cursor.execute("SELECT id FROM positions WHERE account_id = ?", (account_id,)).fetchall()]
    if pos_ids:
        placeholders = ",".join("?" for _ in pos_ids)
        cursor.execute(f"DELETE FROM position_matches WHERE position_id IN ({placeholders})", pos_ids)
        cursor.execute(f"DELETE FROM position_lots WHERE position_id IN ({placeholders})", pos_ids)
        cursor.execute(f"DELETE FROM positions WHERE id IN ({placeholders})", pos_ids)
    cursor.execute("DELETE FROM daily_pnl WHERE account_id = ?", (account_id,))

    # 3. Replay each execution through FIFO matcher
    replayed_count = 0
    for e in exec_list:
        process_execution({
            "account_id": e["account_id"],
            "broker_execution_id": e["broker_execution_id"],
            "order_id": e["order_id"],
            "instrument_key": e["instrument_key"],
            "trading_symbol": e["trading_symbol"],
            "exchange": e["exchange"],
            "segment": e["segment"],
            "product_type": e["product_type"],
            "side": e["side"],
            "quantity": e["quantity"],
            "price": e["price"],
            "multiplier": e["multiplier"],
            "execution_time": e["execution_time"],
            "received_at": e["received_at"],
            "source": e["source"],
        }, conn, is_replay=True)
        replayed_count += 1

    conn.commit()
    return {"ok": True, "replayed_executions": replayed_count, "account_id": account_id}
