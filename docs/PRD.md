# Product Requirements Document — Neo PIP Trading Ticket

**Version:** 0.2.1 · **Date:** 15 November 2026 · **Status:** Source release prepared; hosted deployment and broker verification pending

## 1. Product vision

Provide a local trading terminal with a compact Kotak Neo ticket and a button controlled, paper-first Indian options strategy. A trader can start and stop the strategy, see its risk state and inspect its persistent trade ledger.

## 2. User problem

A trader working in a broker's charting interface may not want to switch context to a full-size order form for each order. They need a compact ticket, quantity controls, an obvious side choice and a safe review before an order reaches the broker.

## 3. Goals

- Keep the ticket compact and readable in a 410 × 790 px floating window.
- Let the user enter or bridge a symbol, choose exchange/product/order type, enter lots and lot size, and calculate total units.
- Make the Buy/Sell direction and simulation/live mode unmistakable.
- Require explicit confirmation for every order.
- Record order requests and audit events locally.
- Provide a well-defined path to Kotak Neo authentication and order execution without putting broker secrets in frontend code.
- Run the Indian ATM option buying strategy in paper mode by default, with explicit live-mode selection behind the existing app and broker gates.
- Enforce configured daily loss, drawdown, per-trade risk, trailing-stop and consecutive-loss rules.
- Use real listed option contracts and closed 1-minute premium candles; reject synthetic chain data for entries.
- Ship runnable documentation and repeatable local tests.

## 4. Non-goals for v0.2

- Forex strategy execution in this release; the 4% Forex daily-loss value is reserved for later.
- Exchange-hosted protective orders. Algo stops are software monitored and depend on the local server and market-data source.
- Cloud-hosted, multi-user or unattended production deployment.
- Guaranteeing a Sharpe ratio, profit, fill price, or maximum realised loss during gaps, outages or slippage.
- Guaranteeing exact symbol detection across all current/future Kotak Neo pages.

## 5. Personas and core flow

**Primary persona:** one retail trader operating a local Chrome browser and a Kotak Neo account.

1. Start the local backend; the app opens in simulation mode.
2. Load the extension and open a supported Kotak Neo web page.
3. Select an instrument. The extension attempts a high-confidence auto-sync; otherwise the user can press Capture in its bridge card.
4. Verify symbol and exchange in the terminal, and manually set/verify lot size.
5. Select BUY or SELL; set product, order type, lots and, where needed, limit/trigger price.
6. Review the order details and tick the confirmation checkbox.
7. In simulation, the app logs a simulated order. In live mode, the server requires its configuration gate plus authenticated Kotak session before it can send an order.
8. Verify live order acceptance and fill in Kotak Neo itself.
9. For the algo, keep paper selected while validating the live option data path and strategy ledger. Live mode requires the explicit selection plus the app live gate and authenticated Kotak session.

## 6. Functional requirements

| ID | Requirement | Release status |
|---|---|---|
| PRD-01 | Display the active symbol and exchange segment | Implemented; manual override supported |
| PRD-02 | Receive symbol candidates from a Chrome extension via authenticated local bridge | Implemented heuristically; broker-specific selectors require validation |
| PRD-03 | Choose BUY/SELL and display direction-specific styling | Implemented |
| PRD-04 | Choose exchange segment, product, order type and validity | Implemented; validity currently DAY |
| PRD-05 | Enter lots and units per lot, calculate total units | Implemented; unit/lot size is manual |
| PRD-06 | Validate market/limit/stop-limit/stop-market inputs | Implemented at API boundary |
| PRD-07 | Require explicit review checkbox before submitting | Implemented in UI and backend |
| PRD-08 | Default to local simulation and persist test orders | Implemented |
| PRD-09 | Authenticate to Kotak Neo via maintained Python SDK with TOTP and MPIN | Implemented behind live gate; account test pending |
| PRD-10 | Send live orders through backend only; never automatically retry mutating calls | Implemented; SDK/account verification pending |
| PRD-11 | Show the last 8 of recent orders with simulation/live state | Implemented |
| PRD-12 | Always-on-top compact PiP window on supported Chrome | Implemented through Document Picture-in-Picture; browser verification pending |
| PRD-13 | Display live market price | Implemented; indicative polled quote |
| PRD-14 | Automatically trail stop-loss | Implemented as a local software-managed stop |
| PRD-15 | Start/stop the Indian ATM option buying algo from the terminal | Implemented; local account validation pending |
| PRD-16 | Require EMA 9/15 bullish cross, volume confirmation and ATM premium ATR(14) > 14 | Implemented on closed real 1-minute option candles |
| PRD-17 | Target 1:2.25 reward/risk and trail after +1R | Implemented as a local software-managed stop |
| PRD-18 | Halt at 10% daily loss, 30% drawdown or three consecutive losses within 30 minutes | Implemented; paper behavior requires operational validation |
| PRD-19 | Keep daily trade count unlimited, subject to open-position and risk controls | Implemented; default maximum two concurrent positions |
| PRD-20 | Show measured Sharpe against 1.30 target | Implemented; target is not a performance guarantee |
| PRD-21 | Run an Upstox historical candle backtest and persist complete metrics for review | Implemented for one exact current ATM contract; rolling ATM portfolio history needs point-in-time contract data |
| PRD-22 | Restrict the Indian strategy session to 09:20–15:29 IST | Implemented; new entries stop at 15:28 so open trades can be squared off at 15:29 |

## 7. Safety and usability requirements

- Live orders are disabled unless an operator explicitly enables the backend configuration flag and restarts it.
- Authentication secrets are not stored in SQLite or written to audit events.
- The local API binds to loopback and rejects non-local Host/Origin headers.
- No order confirmation is silently inferred from a UI button click alone.
- Ambiguous live order errors must instruct the user to reconcile the broker order book before retrying.
- Paper mode is the default. Live algo execution requires an explicit mode selection, LIVE_TRADING_ENABLED, an authenticated Kotak session and Upstox option market data.
- Stop/target/trailing exits are local software orders, not exchange-held stops. The UI and docs must disclose that process, feed, network and execution failures can expose a position.
- Sharpe 1.30 is a target only. Report observed results from the trade ledger and leave the metric unavailable when there is insufficient history.
- The UI must disclose that displayed quantity is lots × the manually specified unit size.
- Symbol sync must be clearly identified as manual vs extension-linked.

## 8. Success criteria

- User can start in simulation, send a simulated BUY and SELL, and find both in local order history.
- Invalid quantity, missing limit price, missing stop trigger, invalid bridge token and unconfirmed order are rejected.
- PiP uses a separate UI instance connected to the same local service; closing the floating window leaves the main page usable.
- Live mode stays unavailable by default; live account end-to-end tests are considered unverified until performed by the user with explicit authorization and account access.
- Pressing Start launches the paper strategy loop; Forex is rejected until a separate Forex strategy is implemented.

## 9. Risks and open issues

- Kotak Neo page URL and DOM vary by version; extension matching and symbol extraction need live-page tuning.
- A visual label may not equal the broker's canonical tradingsymbol. The current detector cannot prove tradability.
- Contract lot sizes change and vary by instrument; the algo reads the selected contract metadata and skips contracts whose size cannot fit the configured risk budget.
- Kotak API permissions, static IP registration, current product restrictions and session rules can vary by account.
- Local software-managed stops cannot guarantee execution during process, feed, network, broker or exchange failures.
- Backtest results apply only to the exact option contract and supplied candle history; one contract report is not a portfolio result or a promise of live performance.

## 10. Options research workspace extension

The local project now also includes `/research` for comparing five configurable Indian option-buying strategies on user-supplied historical underlying and exact-option candles. It includes central metric definitions, private runs, optional read-only strategy shares, validation, grid/random optimization, and downloadable reports. The CSV source label is not verified and the workspace does not yet ingest multi-contract Upstox history automatically; see `docs/OPTIONS_RESEARCH.md` for this extension's behavior and limits.
