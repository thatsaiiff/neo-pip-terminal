# Neo PIP — Local Trading Terminal and Indian Options Algo

Neo PIP is a local-first, compact trading ticket intended to sit in a Chrome Document Picture-in-Picture window while you use Kotak Neo. It is a fresh implementation and does not reuse a previous project.

**Version:** 0.2.1

**Default behaviour:** manual orders use simulation, and the options algo defaults to paper execution. The backend binds to `127.0.0.1`; live orders are disabled unless the operator enables the backend gate and authenticates with Kotak Neo. Manual orders require a review checkbox; live algo mode requires an explicit mode selection and Start confirmation. Concurrent manual submissions are rejected, and the backend does not automatically retry an order submission after a transport exception.

## What is implemented

- Minimalist compact ticket with Buy/Sell selection, lots, units per lot, exchange segment, product, market/limit/stop order types, quantity calculation, review step, and activity log.
- Chrome Document Picture-in-Picture window where supported. The floating window is a separate app instance connected to the same local API. On unsupported browsers, the app opens a compact ordinary popup; ordinary popups are not guaranteed to stay on top.
- Local FastAPI backend and SQLite order/audit history.
- Optional Kotak Neo login using the maintained `kotakneoapi` SDK (TOTP + MPIN). Live orders require both an authenticated broker session and an explicit configuration gate.
- Kotak instrument-master search by exchange segment, exact contract selection, returned lot-size fill, and periodic LTP quotes through the SDK. This uses the configured consumer key; quote availability depends on Kotak API access and market conditions.
- Index option-chain panel for NIFTY, BANKNIFTY, and SENSEX, with nearest option expiry selected by default, expiry switching, ten strikes, call/put LTP and OI, and direct contract selection from any quote/OI cell. Load expiries and chains after clicking **Connect Kotak Neo** in this app; a Kotak website login is a separate session.
- Strike-aware search for index options supplements Kotak's prefix search, so entering a strike such as `73500` can find matching CE/PE contracts.
- Indian ATM options algo with a Start/Stop control and 09:20–15:29 IST session. It scans NIFTY, BANKNIFTY and SENSEX call/put contracts, requires a bullish EMA 9/15 crossover with volume confirmation and closed 1-minute premium ATR(14) strictly above 14, sizes entries to at most 0.5% of configured capital, targets 1:2.25 reward/risk, trails the stop after +1R, and enforces a 10% daily loss limit, 30% drawdown halt and three losses within 30 minutes. There is no daily trade-count cap; the default concurrent-position cap is two.
- Persistent algo trade ledger and Upstox V3 exact-contract option candle backtests. Backtest runs save the candle range, settings, daily results, full trade ledger and review metrics. The UI labels this as a single current contract test, not a rolling ATM portfolio result.
- Central Kotak order mutation gateway implemented in Rust and exposed to Python through PyO3. Live order placement, cancellation, algo risk halts, and option risk sizing pass through the native boundary; ambiguous broker calls are never retried. Python retains Kotak session management and the research/backtest layer.
- Options Research workspace at `/research`: five configurable option-buying strategies, exact-contract premium P&L, 12 registered core metrics, option/execution analytics, in/out-of-sample screening, grid/random optimization, private saved runs, strategy-scoped shares, and CSV/Excel/PDF exports.
- Research data page automatically detects the saved Bank Nifty export under `data/exports/banknifty_1m/`, validates its large CSV files through a Rust streaming inspector when built, and sends a dataset ID instead of copying 188,000 candle rows through the browser. Manual CSV limits are now 1,000,000 underlying rows and 2,000,000 option rows.
- Optional Chrome extension bridge that scans supported Kotak Neo pages and sends a likely selected symbol. It auto-syncs only high-confidence formats; manual capture is offered for less certain patterns.
- Test suite for important API validation, simulation, bridge authentication, and audit redaction cases.

## Honest limitations in this release

1. **Kotak page symbol detection is heuristic.** Kotak Neo web DOM, URLs, and symbol presentation can change, and the exact trading symbol must be verified in the ticket before every order. The extension is not an official Kotak integration.
2. **Quotes are polled snapshots, not a streaming feed.** Instrument search and LTP require a configured Kotak consumer key. The displayed LTP is indicative and is not a guaranteed market-order execution price.
3. **Lot size comes from Kotak for searched instruments and option-chain contracts.** For manually entered symbols it defaults to 1. Verify the selected contract and displayed quantity before ordering.
4. **Algo exits are software-managed.** The stop, target, trailing stop and end-of-day exit are monitored by this local server using polled quotes. They are not exchange-held protective orders; they depend on this process, the quote source, the network and successful broker execution. A server shutdown, stale feed, gap or slippage can leave a position exposed. Check the broker position and order book.
5. **The strategy is Indian-options-only.** It uses actual listed ATM option contracts and Upstox V3 1-minute premium candles. Forex is not enabled; its 4% daily-loss setting is reserved for a later strategy. The Sharpe ratio of 1.30 is a target, not a promised or optimized outcome. The displayed Sharpe is calculated from observed closed-day results and remains unavailable until enough data exists.
6. Kotak Neo credentials and API access are required for live use. This app has not been tested against your account, and no real live algo orders have been placed as part of this build.
7. Live order submission responses are not a guarantee of execution. The app reconciles algo order statuses, but always check Kotak Neo order/trade books. If an order status becomes uncertain, reconcile it with the broker before resetting the halt or taking another action.
8. The multi-strategy research workspace accepts actual candle CSVs but does not yet fetch multi-contract Upstox history itself. Source labels are user-supplied and unverified. Historical fees, option calendars, Greeks, and quote/execution quality are only available to the extent they are present in the supplied data; see [Options Research](docs/OPTIONS_RESEARCH.md).

## Requirements

- Python 3.10 or newer.
- Desktop Google Chrome or another Chromium browser with Document Picture-in-Picture support for the floating window.
- A Kotak Neo Trade API consumer key and registered TOTP, UCC, and MPIN for optional live connectivity.
- Rust and Cargo for the native execution module. Without them, paper and research remain available while live Kotak order mutations fail closed.

## Start on macOS / Linux

```bash
./run.sh
```

Open <http://127.0.0.1:8000>. The script creates a virtual environment, installs dependencies, and creates `.env` from `.env.example` on first run. Review `.env` before use. Manual simulation needs no broker credentials; the options algo's paper mode still needs an Upstox token for real market data.

The regular browser page now uses a full desktop workspace on wide screens and a touch-friendly stacked layout on phones. **Pop out** continues to use the compact ticket.

### Hosted Vercel app and Oracle backend

The hosted app serves the ticket, chart, and `/research` pages from Vercel. Its `/api/*` calls go through the Vercel `api/proxy.js` function to the Oracle backend using HTTPS. The backend is not published on host port 8000; Caddy terminates TLS on ports 80/443 and forwards traffic over a private Docker network. The Vercel project needs `NEO_PIP_BACKEND_URL=https://<backend-host-or-ip>` and `NEO_PIP_FRONTEND_ORIGINS=https://neo-pip-terminal.vercel.app` in its Production environment before the proxy can connect. A reserved Oracle IPv4 can be used directly without buying a domain; Caddy requests a 160-hour Let's Encrypt IP certificate and renews it automatically. Keep Caddy and ports 80/443 available for renewal. On `/research`, the signed-in owner can select and stream large CSVs directly to the backend; the browser still requires a manual file selection.

The cloud `/terminal` web shell is disabled because the legacy PTY accepted unauthenticated websocket connections. Use private SSH-key access for VM administration; never expose the backend container port or re-enable the web shell.

Cloud `.env` files must set unique `ADMIN_USERNAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `OWNER_PIN`, and `BACKEND_DOMAIN` values. `BACKEND_DOMAIN` accepts a hostname or the VM's reserved public IPv4. The setup script never enables live trading. The local Upstox exports under `data/exports/banknifty_1m/` are excluded from the Docker build context; import them from `/research` or copy them to the VM's `/opt/neo-pip-terminal/data/exports/banknifty_1m/` if the hosted Research page should use that dataset. See [Deployment Guide](DEPLOYMENT_GUIDE.md) and [Deployment Audit](docs/DEPLOYMENT_AUDIT.md) before rollout.

### Optional phone access on the same Wi-Fi

The service stays loopback-only unless you explicitly enable LAN access. To use it from a phone connected to the same trusted Wi-Fi:

1. Add `LAN_ACCESS_ENABLED=true` and a long random `LAN_ACCESS_TOKEN` to `.env` (for example, generate one with `python -c "import secrets; print(secrets.token_urlsafe(32))"`).
2. Restart Neo PIP with `./run.sh`. The script will show your computer's Wi-Fi address when available and bind the server to the local network.
3. On your phone, open `http://<computer-wifi-ip>:8000`. Enter the token when prompted. The browser keeps an HttpOnly access cookie for 12 hours.
4. Keep the phone and computer on the same private Wi-Fi. Disable `LAN_ACCESS_ENABLED` and restart when finished.

LAN mode accepts requests only from private network addresses, requires the access token for API use, and remains plain HTTP on the local network. Do not enable it on public Wi-Fi or configure router port forwarding. Phone access requires the computer and its local service to remain on; it does not create remote/cloud access.

## Start on Windows PowerShell

```powershell
.\run.ps1
```

If script execution policy blocks activation, create/activate `.venv` manually and run `python -m pip install -r requirements.txt` followed by `python -m uvicorn app.main:app --host 127.0.0.1 --port 8000`.

## Load the Chrome extension

1. Start Neo PIP locally and keep it running.
2. Open `.env`, generate a strong random `BRIDGE_TOKEN`, and save the file.
3. Open `extension/bridge-config.js` and replace its placeholder with the **same** token. This extension config is local; never commit the token.
4. Open `chrome://extensions`, enable Developer mode, click **Load unpacked**, and choose this project's `extension` folder.
5. Open/reload the Kotak Neo trading tab. The extension adds a small “NEO PIP BRIDGE” card at the lower-right of supported pages. It auto-syncs recognised high-confidence formats and offers manual capture otherwise.
6. In Neo PIP, click **Pop out**. If the broker page's domain is not covered by `extension/manifest.json`, add the exact domain to `matches` and `host_permissions`, reload the extension and reload the broker tab.

The symbol detector is intentionally conservative; the bridge may not detect symbols when the page uses an unsupported DOM structure. Do not treat a successful sync as proof that the symbol is orderable. Manually verify the exact trading symbol and exchange segment.

## Kotak Neo setup (live trading)

1. Create the `.env` file by copying `.env.example` if it does not exist.
2. Set `NEO_CONSUMER_KEY`, `NEO_MOBILE_NUMBER`, and `NEO_UCC` locally.
3. Keep `LIVE_TRADING_ENABLED=false` while learning and running tests. Click **Connect Kotak Neo** while the gate is disabled to see that the backend blocks authentication.
4. To enable live order capability, first follow the security checklist below; only then set `LIVE_TRADING_ENABLED=true` and restart the server. Confirm the consumer key/TOTP/MPIN requirements and static-IP rules directly with Kotak Neo. Use a current authenticator TOTP and your MPIN in the connect dialog.
5. Configure UPSTOX_ACCESS_TOKEN for both algo modes; paper mode simulates fills but still needs live option quotes and candles. In the algo panel, paper mode is selected by default; live algo mode also requires the enabled Kotak live gate and an authenticated Kotak Neo session. Start with paper mode first, then verify orders and exits in the broker order/trade books before considering live use.

**There is no promise of a broker sandbox.** This project uses simulation locally. Whether Kotak gives your account a separate test environment must be confirmed with Kotak; the SDK's `prod` environment is the default unless changed.

### Troubleshooting `Not_Ok` order responses

The app surfaces Kotak rejection messages and records rejected attempts locally. A response with `stat: Not_Ok` is a rejected attempt, but always check Kotak's order book before retrying. Kotak validates the source IP on order APIs and binds the session to the IP used at login; create a new session after changing network or whitelist settings. `NEO_FORCE_IPV4=true` binds SDK requests to IPv4 for IPv4 whitelists, and the connection footer shows the egress IP Kotak reports after login. The app does not compare against a separate locally configured IP allowlist; Kotak performs the whitelist validation. Before sending a live order, the app still checks that the current egress IP matches the IP used to create this API session. A session still cannot switch between the primary and secondary IP. See Kotak's [static IP guidance](https://github.com/Kotak-Neo/Kotak-Neo/blob/main/docs/static-ip-whitelisting.md).

Manual symbol entry only applies format validation. The exact `trading_symbol` must be the actual tradable contract name from Kotak's current instrument master, not an index label such as `NIFTY`; the exchange segment, product, expiry/strike/option type and quantity must match the contract.

## Run tests

```bash
. .venv/bin/activate        # Windows: .\.venv\Scripts\Activate.ps1
pytest -q
```

Tests do not submit live orders. They cover local API behaviour only.

## Security principles

- Do not commit `.env` or share bridge tokens/API credentials.
- The server binds to loopback only and rejects non-local host/origin traffic.
- TOTP and MPIN are not stored in the database or audit events; the MPIN field is cleared from the UI after authentication attempt.
- Keep `LIVE_TRADING_ENABLED=false` unless you deliberately intend to send real orders.
- Never blindly retry a timed-out live order; reconcile first with Kotak's order book.

## Docs

See `docs/` for PRD, TRD, UI/UX, system architecture, backend schema, API specification, security/release checklist, and test report.
For research data format, modeling rules, optimization, metrics, and API examples, see [docs/OPTIONS_RESEARCH.md](docs/OPTIONS_RESEARCH.md).
For the Python/Rust execution and local research data boundaries, see [docs/EXECUTION_ARCHITECTURE.md](docs/EXECUTION_ARCHITECTURE.md).
