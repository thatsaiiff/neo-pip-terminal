# Technical Requirements Document — Neo PIP Trading Ticket

**Version:** 0.1.0 · **Date:** 29 October 2026

## 1. Chosen implementation

- **Runtime:** Python 3.10+.
- **HTTP backend:** FastAPI + Pydantic v2.
- **Broker client:** official/maintained `kotakneoapi` Python SDK `>=3.0,<4.0`.
- **Persistence:** SQLite using Python's standard `sqlite3` library.
- **Frontend:** semantic HTML, CSS and vanilla JavaScript; no bundler or third-party runtime.
- **Browser companion:** Chrome Manifest V3 extension with a service worker and content script.
- **Floating UI:** Chrome Document Picture-in-Picture API; fallback is an ordinary popup without an always-on-top guarantee.
- **Execution model:** backend bound to `127.0.0.1:8000`; broker client never runs in browser code.

## 2. Environments and modes

### Simulation

Default configuration. Order submissions are stored with `mode=simulation`, `status=simulated`, and a synthetic local row ID. No request is made to Kotak Neo.

### Live

Live mode requires all of the following:

1. `LIVE_TRADING_ENABLED=true` in `.env` and service restart.
2. Correct `NEO_CONSUMER_KEY`, `NEO_MOBILE_NUMBER`, and `NEO_UCC` environment variables.
3. Successful TOTP login and MPIN validation.
4. Explicit user review and confirmation for each order.

No SDK order call is attempted when the gate is disabled. No mutating order call is automatically retried.

## 3. Order contract

Order quantity is `lots × lot_size`; the server sends this integer as the broker quantity. The user must verify the lot size against a broker/exchange source. `symbol` is sent as the exact string shown in the ticket; there is no internal symbol-master resolution in v0.1.

Supported segment inputs: `nse_cm`, `bse_cm`, `nse_fo`, `bse_fo`, `mcx_fo`.

Supported products: `MIS`, `NRML`, `CNC`, `MTF` (exact account/segment eligibility must be checked at the broker).

Supported order types: `MKT`, `L`, `SL`, `SL-M`. `L` requires `price`; `SL` requires both `price` and `trigger_price`; `SL-M` requires `trigger_price`. The broker remains the final authority on exchange/order validity.

## 4. Runtime sequence

1. FastAPI starts, initialises SQLite tables and serves the static UI.
2. UI polls `/api/status`, `/api/selected-symbol` (via status payload), and `/api/orders`.
3. Extension detects a candidate symbol and sends an extension runtime message.
4. Service worker posts to local `/api/bridge/symbol` with the configured bridge token.
5. User reviews order; frontend posts `/api/orders` with `user_confirmed=true`.
6. Backend validates payload and mode. Simulation writes a simulated order; live mode invokes SDK once and records response or returns an uncertain-outcome error.
7. UI refreshes order history.

## 5. Reliability

- SQLite writes use context managers and a connection timeout.
- Mutating broker calls do not use retry decorators.
- A process-wide non-blocking order lock rejects a concurrent submission with HTTP 409 rather than queueing a second order.
- If the SDK throws during live submission, the app does not claim success and tells the user to reconcile the broker order book.
- Health endpoint: `GET /api/health`.
- Backend errors are surfaced as human-readable HTTP errors.

## 6. Performance targets (initial local target)

- Initial local UI response under 1 second after service startup on a typical desktop.
- UI status refresh cadence: 900 ms; recent order refresh: 5 seconds.
- Order placement latency is broker/network-dependent and has no guaranteed upper bound.
- Symbol-bridge propagation target: next poll (typically under 1.5 seconds) after the content script posts a candidate.

## 7. Quality and verification

- `pytest -q` runs local API tests without broker calls.
- No live end-to-end test is part of a default build.
- Browser-specific PiP behavior must be verified in target Chromium.
- Kotak SDK integration must be verified against a real account only after the operator configures credentials and explicitly accepts live risk.

## 8. Configuration keys

| Variable | Required | Purpose |
|---|---|---|
| `LIVE_TRADING_ENABLED` | No | Explicit live-order kill switch; default `false` |
| `NEO_ENVIRONMENT` | No | SDK environment; default `prod` |
| `NEO_CONSUMER_KEY` | Live | API consumer key |
| `NEO_MOBILE_NUMBER` | Live | Registered mobile in international form |
| `NEO_UCC` | Live | Client/UCC code |
| `BRIDGE_TOKEN` | Extension | Shared secret for local extension bridge |
| `DATABASE_PATH` | No | SQLite file path |
