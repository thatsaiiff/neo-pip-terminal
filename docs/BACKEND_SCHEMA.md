# Backend Data Schema — Neo PIP Trading Ticket

Storage is SQLite; all timestamps are ISO 8601 UTC strings. Foreign keys are not required in v0.2 because order, audit and strategy records are independently append-oriented.

## 1. `orders`

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | INTEGER PK AUTOINCREMENT | No | Local record ID |
| `created_at` | TEXT | No | UTC submission timestamp |
| `mode` | TEXT | No | `simulation` or `live` |
| `symbol` | TEXT | No | Exact symbol string sent/used |
| `exchange_segment` | TEXT | No | Normalised segment code |
| `side` | TEXT | No | `BUY` or `SELL` |
| `lots` | INTEGER | No | User-entered contract lots |
| `lot_size` | INTEGER | No | User-entered units per lot |
| `quantity` | INTEGER | No | `lots × lot_size` |
| `product` | TEXT | No | `MIS`, `NRML`, `CNC`, `MTF` |
| `order_type` | TEXT | No | `MKT`, `L`, `SL`, `SL-M` |
| `price` | REAL | Yes | Limit price when applicable |
| `trigger_price` | REAL | Yes | Trigger price when applicable |
| `status` | TEXT | No | `simulated` or `submitted` in current code path |
| `broker_order_id` | TEXT | Yes | Kotak order number if returned |
| `message` | TEXT | Yes | Non-secret status/error message |
| `request_json` | TEXT | No | Normalised order request, excludes confirmation flag |
| `response_json` | TEXT | Yes | SDK response for accepted live orders or simulation marker |

The current implementation records a simulated record on simulation submissions and a live record once the SDK confirms acceptance. A live submission that fails before an order ID is confirmed produces an audit event and HTTP error rather than a normal order row; operator reconciliation is required.

## 2. `audit_events`

| Column | Type | Null | Meaning |
|---|---|---:|---|
| `id` | INTEGER PK AUTOINCREMENT | No | Event ID |
| `created_at` | TEXT | No | UTC timestamp |
| `event_type` | TEXT | No | Event identifier, e.g. `symbol_updated` |
| `detail` | TEXT JSON | No | Sanitised event fields |

Sensitive field names such as `totp`, `mpin`, `consumer_key`, `auth`, `token`, and `password` are filtered before writes.

## 3. Transient backend state

- `neo_client`: SDK object retained in memory after authentication.
- `neo_authenticated`: boolean for session state.
- `selected_symbol`: symbol, segment, source, confidence and timestamp. It is transient in memory and resets at backend restart in v0.1.

## 4. Algo tables and stop rules

### algo_trades

One row per strategy entry, scoped by strategy and account. Statuses include SUBMITTING, SUBMITTED, OPEN, EXIT_SUBMITTED, CLOSED, FAILED, UNKNOWN and EXIT_UNKNOWN. The instrument key pins each row to the exact option contract.

| Column group | Meaning |
|---|---|
| strategy_id, account_id, trade_date | Strategy/account scope and India-local trading date |
| symbol, option_type, instrument_key, exchange_segment, product | Exact listed option and broker/data identifiers |
| entry_time, signal_bar_time, entry_price, quantity, lot_size | Entry request/fill, consumed signal and contract sizing |
| sl_price, tp_price, trailing_dist | Initial and ratcheting software stop state plus fixed target |
| status, order_id, exit_order_id, exit_submitted_at | Entry/exit lifecycle and reconciliation identifiers |
| exit_time, exit_price, gross_pnl, charges, net_pnl, exit_reason | Closed trade result, recorded after broker fill reconciliation in live mode |

### algo_risk_state and algo_session_days

- algo_risk_state stores the persistent equity high-water mark per strategy/account for maximum drawdown checks.
- algo_session_days records days on which the strategy ran; daily net returns from the trade ledger are used for the measured Sharpe ratio.

### algo_backtest_runs

One durable row per requested historical run, scoped to the authenticated account and strategy. `settings_json` stores the thresholds and risk settings used; `report_json` stores the complete metrics, daily performance and trade ledger so results can be reopened later. The report records the exact instrument key and data range used.

### sltp_rules additions

The existing stop table has account_id, market_mode, trailing_dist, strategy_id and instrument_token fields. Algo rules are scoped to their strategy and exact option token. Live exits remain software monitored and are matched to broker order reports before an algo trade is marked closed.

## 5. Remaining schema candidates

Exchange-hosted protective orders, durable per-instance strategy configuration, canonical instrument-master snapshots, and stronger broker idempotency/recovery records remain future work. Any live order lifecycle changes require validation against a real Kotak account before use with funds.

## 6. Multi-strategy research tables

### `research_backtest_runs`

One private row per multi-strategy CSV backtest. `account_id` scopes access; `data_source_label` is supplied by the user and is not verified; `settings_json` stores the strategy and fill assumptions; `report_json` stores all strategy results, validation splits, metric registry values, tradebooks, and optional optimization reports. Raw CSV candle arrays are not persisted.

### `research_shares`

Maps only a SHA-256 hash of an unguessable URL token to a run, account, optional strategy ID, creation time, and expiry. Raw share tokens are returned once to the creator and are not stored. Share APIs expose read-only report/CSV/Excel/PDF output until expiry.
