# Product Requirements Document — Neo PIP Trading Ticket

**Version:** 0.1.0 · **Date:** 29 October 2026 · **Status:** Build draft / local verification required

## 1. Product vision

Provide a compact, lightweight trading ticket that can remain visible in a separate Chrome Document Picture-in-Picture window while a trader uses Kotak Neo. The first release optimises for a verified symbol, simple Buy/Sell order entry, explicit review and clear local order history—not for charting or automated strategy execution.

## 2. User problem

A trader working in a broker's charting interface may not want to switch context to a full-size order form for each order. They need a compact ticket, quantity controls, an obvious side choice and a safe review before an order reaches the broker.

## 3. Goals

- Keep the ticket compact and readable in a 410 × 790 px floating window.
- Let the user enter or bridge a symbol, choose exchange/product/order type, enter lots and lot size, and calculate total units.
- Make the Buy/Sell direction and simulation/live mode unmistakable.
- Require explicit confirmation for every order.
- Record order requests and audit events locally.
- Provide a well-defined path to Kotak Neo authentication and order execution without putting broker secrets in frontend code.
- Ship runnable documentation and repeatable local tests.

## 4. Non-goals for v0.1

- Full broker workstation replacement, advanced charting, depth/market-by-price or options chain.
- Real-time LTP display or a live quote feed.
- Automatic trailing stop-loss, bracket/OCO manager or strategy automation.
- Automatic position netting, auto-square-off, risk sizing, margin estimation or P&L calculation.
- Multi-user, cloud-hosted or remote-access deployment.
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
| PRD-13 | Display live market price | Not in v0.1 |
| PRD-14 | Automatically trail stop-loss | Not in v0.1 |

## 7. Safety and usability requirements

- Live orders are disabled unless an operator explicitly enables the backend configuration flag and restarts it.
- Authentication secrets are not stored in SQLite or written to audit events.
- The local API binds to loopback and rejects non-local Host/Origin headers.
- No order confirmation is silently inferred from a UI button click alone.
- Ambiguous live order errors must instruct the user to reconcile the broker order book before retrying.
- The UI must disclose that displayed quantity is lots × the manually specified unit size.
- Symbol sync must be clearly identified as manual vs extension-linked.

## 8. Success criteria

- User can start in simulation, send a simulated BUY and SELL, and find both in local order history.
- Invalid quantity, missing limit price, missing stop trigger, invalid bridge token and unconfirmed order are rejected.
- PiP uses a separate UI instance connected to the same local service; closing the floating window leaves the main page usable.
- Live mode stays unavailable by default; live account end-to-end tests are considered unverified until performed by the user with explicit authorization and account access.

## 9. Risks and open issues

- Kotak Neo page URL and DOM vary by version; extension matching and symbol extraction need live-page tuning.
- A visual label may not equal the broker's canonical tradingsymbol. The current detector cannot prove tradability.
- Contract lot sizes change and vary by instrument; they are intentionally user-entered.
- Kotak API permissions, static IP registration, current product restrictions and session rules can vary by account.
- No automatic LTP feed means no reliable trailing stop, price estimate or quote freshness control yet.
