# Options Research Workspace

## Open it

Start the local app with `./run.sh`, sign in, and open `http://127.0.0.1:8000/research`, or open `/research` on the configured hosted website. The workspace uses the existing FastAPI, SQLite, HTML, CSS, and JavaScript stack. A backtest is private to the signed-in account until a read-only share link is created. On the hosted site, saved CSVs must exist on the Oracle VM; workstation files are not visible to it automatically.

## Load data

The research workspace accepts two CSV files. Example headers are available at `/static/research-underlying-template.csv` and `/static/research-options-template.csv`. When the Bank Nifty export exists at `data/exports/banknifty_1m/`, the page discovers and selects its underlying and option candles automatically. Backtest and optimization calls send a saved dataset ID, so those files are read by the local server instead of being copied through browser memory.

On the hosted site, choose both files and click **Upload selected files** to stream them directly to the configured HTTPS Oracle backend. This action requires the owner account; files are limited to 200 MB each and validated before replacing the server's allowlisted CSV. The browser cannot silently open files from the user's computer, so the file picker requires explicit selection. On local runs, the same workflow writes under the local `data/exports/banknifty_1m/` directory.

- Underlying rows: timestamp, OHLC, volume.
- Option rows: timestamp, underlying symbol, exact instrument key or contract ID, trading symbol, expiry, CE/PE, strike, lot size, exchange segment, OHLC, and optional bid/ask, open interest, IV, and Greeks.
- Timestamps may be ISO 8601 or Unix seconds/milliseconds. Naive ISO timestamps are interpreted as Asia/Kolkata.
- Rows outside weekdays and 09:15–15:29 IST, malformed bars, and duplicate timestamps are removed. Five-minute bars are built only from five contiguous one-minute bars; missing minutes are not filled.
- Option candles must be actual listed-contract prices. The page shows the source label as unverified; use an auditable Upstox export and inspect the reported coverage before interpreting results.

The research page does not automatically download a multi-contract option-chain history from Upstox. The existing Upstox integration and prior exact-contract backtest are separate from this multi-strategy CSV workflow. A compatible combined underlying and options dataset is needed to run the five-strategy comparison. The token is never sent to the browser by this workspace.

## Strategy and fill model

Five independently signaled long-option rules are available: opening range breakout, EMA/VWAP momentum, Supertrend/RSI, ADX breakout, and volatility expansion. Indicator parameters, timeframe, expiry mode, strike selection, times, stop ATR multiple, target R, trailing threshold, capital, risk per trade, max lots, daily loss, drawdown, benchmark thresholds, and loss-streak halt are configurable.

Signals use closed underlying candles. The simulator selects the requested expiry class and nearest configured strike/delta, then enters at the first available option-candle open at or after the signal close. It calculates P&L from that option contract's premium and uses the supplied lot size. When quotes exist, entry is modeled at ask and exit at bid; otherwise candle open/close is the disclosed proxy. If stop and target could both occur within one candle, the stop is treated as first. Positions are square-off at the configured time; only one position per strategy is open at once.

Statutory charges use the project's current `calculate_statutory_charges` schedule. This is not a reconstructed date-specific historical tax schedule. The simulator cannot model queue position, order-book depth, broker latency, order rejection, or partial fills from OHLC candles. Spread and adverse slippage are measured only when quote fields are present. Basis-point slippage sensitivity is a separate scenario estimate, not observed fills.

## Validation and optimization

The comparison uses a chronological 70/30 session split for fixed-parameter screening. Indicator values are causal and warm up on prior candles. The screen score uses only out-of-sample expectancy, profit factor, and drawdown; it requires 20 test trades. Its exact formula is shown in the comparison table. This split is a screening result, not a final independent holdout.

For one selected strategy, grid and random parameter search rank candidates on the first segment, report a validation segment, and reserve a later 20% period as an untouched per-run holdout. The report also shows expanding walk-forward folds and parameter sensitivity. The candidate budget is capped at 200. Bayesian mode currently returns `N/A` with an explanation; it is not implemented. Repeated tuning and review consumes the holdout in practice, so it should not be treated as permanently untouched.

## Metrics and exports

The response and dashboard include the 12 core metrics in the central registry, net-of-modeled-cost P&L groups, monthly/daily series, expiry and DTE groups, Greeks/IV where supplied, capital usage, risk streaks, tail estimates, execution measurements, and explicit unavailable reasons. Daily Sharpe/Sortino use 252-session annualization, configurable risk-free/MAR inputs, and the observed session series. VaR/expected shortfall require minimum samples; Monte Carlo is a 500-path trade-order bootstrap; risk of ruin and gap/liquidity stress remain unavailable because the assumptions and executable depth data are not supported.

Trades export to CSV. Excel includes Summary, Trades, Metrics, Validation, Risk Options, Optimization, and Metric Registry sheets; PDF includes metric definitions, formulas, unavailable explanations, assumptions, validation, and optimization summary. Each share link is tokenized, read-only, expires within the configured period, and can be scoped to one strategy. Shared strategy pages also allow CSV, Excel, and PDF downloads. A share link grants access to the run's displayed data, so create one only when appropriate.

## Existing Upstox historical runs

Two separate historical artifacts are included in `reports/`; they were produced by the existing Upstox expired-contract pipeline, not by the five-strategy CSV workspace:

- [5-minute EMA 9/15 trend, 1DTE and expiry sessions](../reports/trend_1dte_expiry_1m_2026-11-14.md): actual 1-minute Upstox option and future candles aggregated to 5-minute bars; 114 of 114 requested instrument sessions from 2025-04-23 through 2026-11-12, 269 trades, 32.34% win rate, ₹3,817.64 net P&L on ₹10 lakh allocated capital (0.382%), net profit factor 1.012, and 6.211% realized drawdown. NIFTY and SENSEX were net negative; BANKNIFTY was net positive. This aggregate result is marginal and is not evidence of a robust edge.
- [19 expiry-session limit-entry test](../reports/expiry_day_1m_backtest_2026-11-14.md): 57 instrument sessions across the three indices and 25 simulated fills; combined net P&L −₹6,319.01, 24.00% win rate, and net profit factor 0.379. It uses the earlier 15:15 premium reference and half-price limit-entry rule, so it is a different strategy from the EMA trend run.

Both reports use minute bars, not five-second data or broker order-book fills. Their fee assumption is the project's Kotak charge schedule rather than historical Upstox charges. The 1DTE/expiry report is a separate strategy-specific result; the five-strategy comparison still requires a combined underlying and exact option-candle dataset in the upload format described above.

## API routes

These endpoints use the app's existing owner-session authentication unless the URL contains a share token.

- `GET /api/research/registry`
- `GET /api/research/local-datasets`
- `POST /api/research/local-datasets/{dataset_id}/validate`
- `POST /api/research/backtests/run`
- `GET /api/research/backtests?limit=20`
- `GET /api/research/backtests/{run_id}`
- `POST /api/research/backtests/{run_id}/optimize`
- `POST /api/research/backtests/{run_id}/share`
- `GET /api/research/backtests/{run_id}/trades.csv?strategy_id=orb`
- `GET /api/research/backtests/{run_id}/report.xlsx?strategy_id=orb`
- `GET /api/research/backtests/{run_id}/report.pdf?strategy_id=orb`
- `GET /api/research/shared/{token}` and `/trades.csv`, `/report.xlsx`, `/report.pdf`
- Pages: `/research`, `/research/results/{run_id}`, and `/results/{token}/{strategy_id}`

Manual CSV selection supports files up to 200 MB, with limits of 1,000,000 underlying rows and 2,000,000 option rows. Saved local Bank Nifty files bypass browser and JSON payload limits through the allowlisted local dataset endpoint. Optimization can reuse that saved dataset ID; arbitrary filesystem paths are not accepted.

## Current boundaries

- The workspace reuses this repository's FastAPI and static HTML/CSS/JavaScript stack. It does not introduce the separately specified Next.js/React/TypeScript/Tailwind/shadcn frontend.
- Multi-contract Upstox history is not fetched automatically by the five-strategy workspace; load a compatible underlying/options CSV export. The separate Upstox strategy reports above do not contain a reusable complete option-chain dataset.
- Bayesian optimization is exposed as unavailable; grid and random search are implemented.
- The app does not verify that the user's source label or candle rows came from Upstox.
- Option Greeks, IV, bid/ask, and open interest stay `N/A` without exact-contract observations. Index VIX is not substituted for option IV.
- Historical fee schedules, contract calendars, historical exchange lot sizes, and corporate/exchange specification changes are not reconstructed automatically.
- This is a research backtester, not the live algo controller. A good backtest does not imply paper or live profitability.
- The UI returns the first 500 matching trades on screen for responsiveness; CSV/Excel exports contain the full tradebook.
