# Rust and Python execution architecture

## Separation of responsibilities

| Area | Owner | Responsibility |
| --- | --- | --- |
| Broker login and session | Python FastAPI and Kotak Neo SDK | TOTP and MPIN flow, session cookies, egress IP checks, account limits, positions, order reports, and broker reconciliation. |
| Order mutation gateway | Rust through PyO3 | Validates Kotak place and cancel requests, creates a unique broker correlation tag, tracks in flight dispatches, and invokes each SDK mutation once. |
| Algo risk gate | Rust through PyO3 | Evaluates daily loss, maximum drawdown, recent losing streak, unresolved broker orders, and missing live marks. |
| Option position sizing | Rust through PyO3 | Calculates the permitted lot count and quantity from equity, configured risk percent, actual rounded stop, and exchange lot size. |
| Strategy and metrics research | Python | Owns strategy configuration, indicators, event driven backtests, analytics, optimization, saved reports, and exports. |
| Large CSV inspection | Rust through PyO3 | Streams saved CSV files to validate required columns, OHLC ranges, duplicate candles, row counts, and coverage without loading the file into the browser. |
| Research data selection | Python FastAPI | Resolves a small allowlist of saved local dataset IDs to files under `data/exports`; arbitrary filesystem paths are never accepted from the browser. |

The Rust layer does not create a second Kotak login or duplicate the broker's authentication protocol. It calls the already authenticated official Kotak Python SDK through PyO3. This keeps the IP bound session and existing account controls intact while centralizing broker mutations in one Rust boundary. Kotak documents its REST API and actively maintained Python SDK in the [official Neo API repository](https://github.com/Kotak-Neo/Kotak-Neo) and the [official `place_order` reference](https://github.com/Kotak-Neo/kotak-neo-python/blob/main/docs/functions/orders/place_order.md).

## Order path

1. The Python application authenticates the owner and checks the live trading gate, broker session, account state, and session IP.
2. Algo risk checks and option lot sizing use the Rust module when it is available.
3. Manual orders, algo entries, exits, square offs, and order cancellations call `dispatch_kotak_mutation`.
4. The Rust gateway validates the SDK request, attaches a unique 22 character correlation tag, marks the request in flight, and invokes `place_order` or `cancel_order` exactly once.
5. A broker response is recorded in the existing Python and SQLite order ledger. A transport error remains ambiguous; the gateway never retries it. Existing order reconciliation remains the source of truth for accepted, filled, rejected, and unresolved broker orders.

The gateway's recent dispatch list is diagnostic and in memory. The existing SQLite order and algo ledgers remain the persistent audit records. A tag is for correlation; Kotak does not document it as an idempotency guarantee.

If the Rust module is missing, the app can still run paper orders and research. Every live Kotak mutation fails closed, and live algo startup returns an explicit unavailable response. The engine is built by `run.sh` or `run.ps1` when Rust and Cargo are installed. The local development command is:

```bash
python -m pip install 'maturin>=1.8,<2.0'
maturin develop --manifest-path rust/neo_execution/Cargo.toml --locked
```

The native extension is configured for the stable CPython ABI from Python 3.10 upward. Maturin's mixed Python and Rust project workflow is documented in its [official project layout guide](https://www.maturin.rs/project_layout).

## Research data path

The `/research` page asks the local server for an allowlisted dataset manifest. When `data/exports/banknifty_1m/` exists, it automatically selects `banknifty_index_1m.csv` and `banknifty_options_1m.csv`. The browser displays file names, coverage, and row counts but does not read or resend those large files. Backtest and optimization requests send the dataset ID; Python reads the CSVs on the server and passes the actual rows to the Python research engine.

The page also offers a Rust streaming validation action. It checks the saved file headers, candle OHLC shape, duplicate key and timestamp pairs, and time coverage. When the native extension is absent, the same validation uses a Python streaming fallback; the page labels which engine performed the check.

In the hosted deployment, the same allowlisted path is resolved on the Oracle VM, not the trader's workstation. The owner can choose both CSVs in the Research page; the browser streams each file directly to the HTTPS API, which validates it and writes only the allowlisted Bank Nifty filenames into persistent `data/exports/banknifty_1m/`. The Docker image intentionally excludes local CSVs.

Manually selected CSVs are still supported. The browser limit is 200 MB per file and 1,000,000 underlying rows or 2,000,000 option rows. The local dataset route avoids those browser memory and JSON payload costs for files already saved by this app.

The option price file contains historical bars for the 73 contracts selected by the saved backtest, not a full historical option chain. Its companion contract master lists all contracts returned for the included expiries. This scope appears in the dataset coverage and backtest report.

## Safety and verification boundary

- No broker orders were sent while implementing or verifying the Rust module.
- Rust dispatch uses the existing Python SDK session and does not retry a broker mutation after any response or transport exception.
- Live execution remains gated by `LIVE_TRADING_ENABLED`, a Kotak authenticated session, the existing IP checks, and the compiled Rust module.
- Paper and research workflows do not require the Rust compiler at runtime; research uses Python for strategy execution and metrics.
- Rust unit tests cover risk halt precedence, loss and drawdown thresholds, consecutive loss thresholds, and position sizing. Python tests cover the PyO3 dispatch boundary and local dataset endpoints.
