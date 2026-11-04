# API Specification — Neo PIP Local Service

Base URL: `http://127.0.0.1:8000`

All routes are local-only and return JSON except `GET /` and `/static/*`. The bridge route requires `X-Bridge-Token`. Extension-origin requests are allowed only for the bridge route; UI routes accept only the local app origins on port 8000. No endpoint exposes API keys or SDK session tokens.

## `GET /api/health`

Returns `{ "ok": true, "service": "neo-pip-terminal", "time": "..." }`.

## `GET /api/status`

Returns current operation mode, whether live trading is enabled, whether the broker SDK is authenticated, whether minimum broker configuration exists, the currently selected symbol and whether the bridge token is configured. It never returns secret values.

## `POST /api/auth/login`

Request:

```json
{ "totp": "123456", "mpin": "123456" }
```

Requires `LIVE_TRADING_ENABLED=true` and the consumer key, mobile number and UCC from local `.env`. Performs `NeoAPI.totp_login()` followed by `NeoAPI.totp_validate()`. TOTP is six digits; MPIN is 4–8 digits. Credentials are not written to audit logs. Response indicates a successful local session; this is not an order execution.

## `POST /api/auth/logout`

Calls the SDK logout best-effort, clears the in-memory SDK session, and returns to simulation mode.

## `GET /api/selected-symbol`

Returns current in-memory symbol, segment, source, confidence, and update timestamp.

## `POST /api/bridge/symbol`

Requires header `X-Bridge-Token: <same value as BRIDGE_TOKEN>`.

Request:

```json
{
  "symbol": "RELIANCE-EQ",
  "exchange_segment": "nse_cm",
  "source": "chrome extension",
  "confidence": 0.95
}
```

Symbol accepts upper-case alphanumeric characters plus spaces and `.&_/-`, maximum 64 characters. Supported segments: `nse_cm`, `bse_cm`, `nse_fo`, `bse_fo`, `mcx_fo`. Confidence must be at least 0.55. This endpoint validates structure, not broker instrument validity.

## `POST /api/orders`

Request example (simulation-safe):

```json
{
  "symbol": "NIFTY26NOV2625000CE",
  "side": "BUY",
  "lots": 1,
  "lot_size": 1,
  "exchange_segment": "nse_fo",
  "product": "MIS",
  "order_type": "MKT",
  "price": null,
  "trigger_price": null,
  "validity": "DAY",
  "user_confirmed": true
}
```

- `side`: `BUY` or `SELL`.
- `lots`: integer from 1 to 1000.
- `lot_size`: integer from 1 to 100000; explicit user confirmation required in UI.
- `quantity`: calculated server-side as `lots * lot_size`.
- `order_type`: `MKT`, `L`, `SL`, or `SL-M`.
- `L` requires a positive `price`; `SL` requires positive `price` and `trigger_price`; `SL-M` requires positive `trigger_price`.
- `product`: `MIS`, `NRML`, `CNC`, `MTF`.
- `validity`: `DAY` or `IOC`.
- `user_confirmed`: must be `true`; otherwise HTTP 400.

Simulation response includes `mode=simulation`, `status=simulated`, a local row ID, and an explicit warning that no broker order was sent. Live response requires both a successful authenticated session and enabled live gate. The broker SDK call maps `BUY`/`SELL` to `B`/`S` and sends exact quantity in the SDK's `quantity` field. Mutating calls are not retried automatically.

## `GET /api/orders?limit=20`

Returns newest-first order history. `limit` is bounded to 1–100. Secret/session data is not part of the response.

## `GET /api/audit?limit=30`

Returns newest-first audit events. Sensitive field names are removed before saving.

## Common errors

| Status | Meaning |
|---|---|
| 400 | Missing explicit order confirmation or order-level policy error |
| 409 | Another order submission is already in progress |
| 401 | Invalid bridge token or broker session/authentication failure |
| 403 | Live mode disabled or prohibited request origin/host |
| 422 | Invalid request field, symbol format, exchange segment or price requirement |
| 502 | Broker call failed/uncertain or did not confirm successful order acceptance |
| 503 | Missing bridge config or SDK dependency |

When a live call returns an uncertain error, check Kotak Neo's order book before retrying. The API is intentionally not idempotency-guaranteed by the broker; the client cannot safely assume the failed HTTP request means no order was placed.
