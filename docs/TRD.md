# Technical Requirements Document — Neo PIP Trading Ticket

**Version:** 0.2.1 · **Date:** 15 November 2026

## 1. Chosen implementation

- **Runtime:** Python 3.10+.
- **HTTP backend:** FastAPI + Pydantic v2.
- **Broker client:** official/maintained `kotakneoapi` Python SDK `>=3.0,<4.0`.
- **Persistence:** SQLite using Python's standard `sqlite3` library.
- **Frontend:** semantic HTML, CSS and vanilla JavaScript; no bundler or third-party runtime.
- **Browser companion:** Chrome Manifest V3 extension with a service worker and content script.
- **Floating UI:** Chrome Document Picture-in-Picture API; fallback is an ordinary popup without an always-on-top guarantee.
- **Execution model:** local backend binds to `127.0.0.1:8000`; the Oracle backend listens on a private Docker network behind Caddy TLS on 80/443. Broker client never runs in browser code.

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
| `UPSTOX_ACCESS_TOKEN` | Algo | Live option-chain quote and one-minute premium candle source |
| `BRIDGE_TOKEN` | Extension | Shared secret for local extension bridge |
| `DATABASE_PATH` | No | SQLite file path |

## 9. Indian ATM option buying algo

1. The authenticated operator selects Paper or Live in the algo modal and presses Start. Paper is the default. Forex requests are rejected.
2. The server scans the supported Indian index option chains during the configured market window and chooses the closest listed strike to spot, for both calls and puts.
3. For each exact listed contract, it requires a fresh live quote and closed Upstox 1-minute option-premium candles. Synthetic chain/candle fallbacks are not eligible.
4. A BUY requires a recent bullish EMA 9/15 crossover, volume confirmation and ATR(14) strictly greater than 14 premium points. The default stop distance uses recent premium structure, capped by premium price and ATR; the target is 2.25 times that risk.
5. Quantity is capped by 0.5% capital risk per trade and one lot minimum. The daily trade count is uncapped; two concurrent positions are allowed by default.
6. Circuit breakers stop new entries at 10% daily loss, 30% peak-to-equity drawdown, three consecutive losses within 30 minutes, unresolved order status or unavailable open-position MTM. Forex's 4% daily limit is reserved for a later strategy.
7. The software stop begins trailing after +1R and ratchets upward by one initial risk unit. The session window is 09:20–15:29 IST; new entries stop at 15:28 and remaining strategy positions are closed at 15:29. These exits are server-side quote monitors, not exchange-held protective orders.
8. Live entries and exits are matched against Kotak's order report before the strategy ledger records fills. Partial or uncertain states remain flagged for broker-side reconciliation.

Sharpe 1.30 is a target only. The reported value is computed from closed strategy results across active days and remains unavailable with insufficient or zero-variance history. Backtest runs are saved with their candle range, configuration, complete metrics, daily results and trade ledger. Historical option tests use one exact listed contract; they are not a point-in-time rolling ATM portfolio simulation.

## 10. Multi-strategy options research

The research app extends the same FastAPI service with `app/research_engine.py`, a central metric registry, and account-scoped SQLite run/share tables. It accepts combined underlying and exact-option candle CSVs, applies causal five-strategy signals, and runs configurable 1-minute or 5-minute option premium simulations. It supports chronological screening, grid/random optimization with a per-run holdout, private strategy results, expiring strategy-scoped shares, and dependency-free CSV/Excel/PDF exports.

This research path is not the live algo loop and does not automatically request historical multi-contract option data from Upstox. Raw CSVs are not stored after a run; re-upload them to optimize a reopened run. Bayesian optimization, historical fee/lot/calendar reconstruction, executable order-book modeling, and quote-less Greeks/IV remain unsupported and are explicitly reported.
