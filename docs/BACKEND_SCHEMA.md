# Backend Data Schema — Neo PIP Trading Ticket

Storage is SQLite; all timestamps are ISO 8601 UTC strings. Foreign keys are not required in v0.1 because order and audit records are independently append-oriented.

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

## 4. Future schema candidates (not implemented)

For a later live price/trailing-stop release: instrument master cache with canonical tokens and lot sizes; streaming quote snapshots with timestamps; persisted positions/fills; bracket/guard orders and OCO groups; trailing stop state machine; idempotency/reconciliation records; durable session state design. These require separate validation before use with real funds.
