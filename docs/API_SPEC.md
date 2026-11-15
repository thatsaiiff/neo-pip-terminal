# API Specification — Neo PIP Service

Local base URL: `http://127.0.0.1:8000`; hosted browser base URL: `https://neo-pip-terminal.vercel.app`.

The hosted Vercel frontend routes `/api/*` through `api/proxy.js` to the HTTPS Oracle backend. Direct local runs bind to loopback; the Oracle API is available only through Caddy TLS on ports 80/443, with FastAPI on a private Docker network. API routes return JSON except the HTML and static-file routes. The bridge route requires `X-Bridge-Token`. Cloud CORS uses the configured frontend origin allowlist. No endpoint should return API keys or Kotak SDK session credentials.

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

## Algo backtests and review history

These admin-only endpoints use Upstox option data. Historical premium candles are fetched through the V3 1-minute candle API. The UI runner chooses the nearest current ATM call or put and tests that exact listed contract for up to 30 calendar days; it does not reconstruct historical ATM contract changes.

### `POST /api/algo/backtests/run`

Request:

```json
{ "underlying": "NIFTY", "option_type": "CE", "days": 30 }
```

Supported underlyings are `NIFTY`, `BANKNIFTY`, and `SENSEX`; `option_type` is `CE` or `PE`; `days` is 1–30. A successful contract selection creates a saved run, including no-trade or insufficient-candle results.

### `GET /api/algo/backtests?limit=20`

Returns saved run summaries for the signed-in admin account. `limit` is bounded to 1–100.

### `GET /api/algo/backtests/{run_id}`

Returns the saved settings, full metrics, daily performance, and completed trade ledger for one run.

## Multi-strategy options research

The CSV research workspace is served at `/research`. Detailed fields, fill assumptions, metric definitions, and limitations are in [OPTIONS_RESEARCH.md](OPTIONS_RESEARCH.md). All private API routes use the existing signed-in owner session and account scoping.

### `GET /api/research/registry`

Returns five strategy definitions and the central core, options, and execution metric registries. Each core metric includes its formula, unit, interpretation, benchmark, calculation identifier, required fields, and per-run data-quality state.

### `POST /api/research/local-datasets/{dataset_id}/upload?kind=underlying|options`

Owner only raw CSV upload. The request body is the file bytes (`Content-Type: text/csv`), streamed directly to the HTTPS Oracle origin by the hosted browser. The current allowlist accepts `banknifty_1m`; the server writes only canonical filenames, caps each upload at 200 MB, validates required columns, OHLC values, and duplicate candles, then regenerates compact metadata after both files exist.

### `POST /api/research/backtests/run`

Accepts `underlying_candles`, `option_candles`, `strategies`, `settings`, and a user-supplied `data_source` label, or the `banknifty_1m` dataset ID. Inline history is limited to 1,000,000 underlying rows and 2,000,000 option rows. Options rows require instrument/contract ID, expiry, CE/PE, strike, lot size, time, and OHLC. Successful results are persisted privately to SQLite.

### `POST /api/research/backtests/{run_id}/optimize`

Accepts `strategy_id`, method (`grid`, `random`, or `bayesian`), budget (maximum 200), minimum training trades, and the same candle arrays. Grid and random searches rank training candidates, then report validation, an untouched per-run holdout, walk-forward folds, and sensitivity. Bayesian mode is currently unavailable and returns an explanation.

### Saved results and sharing

- `GET /api/research/backtests?limit=20` lists private runs; `GET /api/research/backtests/{run_id}` loads a private run.
- `POST /api/research/backtests/{run_id}/share` accepts `expires_days` (1–365) and optional `strategy_id`; tokens are stored as hashes and links are read-only.
- `GET /api/research/shared/{token}` returns the unexpired run or the single strategy scoped to that share.
- Private tradebook/Excel/PDF exports are available at `/api/research/backtests/{run_id}/trades.csv`, `/report.xlsx`, and `/report.pdf`; `strategy_id` scopes an export.
- Read-only token URLs also support `/api/research/shared/{token}/trades.csv`, `/report.xlsx`, and `/report.pdf`.
- Pages: `/research/results/{run_id}` for private results and `/results/{token}/{strategy_id}` for strategy shares.
