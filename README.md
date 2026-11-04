# Neo PIP — Local Kotak Neo Trading Ticket

Neo PIP is a local-first, compact trading ticket intended to sit in a Chrome Document Picture-in-Picture window while you use Kotak Neo. It is a fresh implementation and does not reuse a previous project.

**Version:** 0.1.1

**Default behaviour:** simulation only. The backend binds to `127.0.0.1`, live orders are disabled by default, all orders require a review checkbox, concurrent submissions are rejected, and the backend does not automatically retry an order submission after a transport exception.

## What is implemented

- Minimalist compact ticket with Buy/Sell selection, lots, units per lot, exchange segment, product, market/limit/stop order types, quantity calculation, review step, and activity log.
- Chrome Document Picture-in-Picture window where supported. The floating window is a separate app instance connected to the same local API. On unsupported browsers, the app opens a compact ordinary popup; ordinary popups are not guaranteed to stay on top.
- Local FastAPI backend and SQLite order/audit history.
- Optional Kotak Neo login using the maintained `kotakneoapi` SDK (TOTP + MPIN). Live orders require both an authenticated broker session and an explicit configuration gate.
- Kotak instrument-master search by exchange segment, exact contract selection, returned lot-size fill, and periodic LTP quotes through the SDK. This uses the configured consumer key; quote availability depends on Kotak API access and market conditions.
- Index option-chain panel for NIFTY, BANKNIFTY, and SENSEX, with nearest option expiry selected by default, expiry switching, ten strikes, call/put LTP and OI, and direct contract selection from any quote/OI cell. Load expiries and chains after clicking **Connect Kotak Neo** in this app; a Kotak website login is a separate session.
- Strike-aware search for index options supplements Kotak's prefix search, so entering a strike such as `73500` can find matching CE/PE contracts.
- Optional Chrome extension bridge that scans supported Kotak Neo pages and sends a likely selected symbol. It auto-syncs only high-confidence formats; manual capture is offered for less certain patterns.
- Test suite for important API validation, simulation, bridge authentication, and audit redaction cases.

## Honest limitations in this release

1. **Kotak page symbol detection is heuristic.** Kotak Neo web DOM, URLs, and symbol presentation can change, and the exact trading symbol must be verified in the ticket before every order. The extension is not an official Kotak integration.
2. **Quotes are polled snapshots, not a streaming feed.** Instrument search and LTP require a configured Kotak consumer key. The displayed LTP is indicative and is not a guaranteed market-order execution price.
3. **Lot size comes from Kotak for searched instruments and option-chain contracts.** For manually entered symbols it defaults to 1. Verify the selected contract and displayed quantity before ordering.
4. **No automatic trailing stop-loss manager is included.** This release focuses on the user-confirmed Buy/Sell ticket. Trailing-stop logic needs verified quote updates, position/order reconciliation, exchange constraints, and a robust monitor/recovery mechanism; implementing it without those is unsafe.
5. Kotak Neo credentials and API access are required for live use. This app has not been tested against your account, and no real live orders have been placed as part of this build. Tests use local API cases only.
6. Live order submission responses are not a guarantee of execution. Always check Kotak Neo order/trade books. If the backend reports an uncertain broker call, do not click again until you have reconciled the broker order book.

## Requirements

- Python 3.10 or newer.
- Desktop Google Chrome or another Chromium browser with Document Picture-in-Picture support for the floating window.
- A Kotak Neo Trade API consumer key and registered TOTP, UCC, and MPIN for optional live connectivity.

## Start on macOS / Linux

```bash
./run.sh
```

Open <http://127.0.0.1:8000>. The script creates a virtual environment, installs dependencies, and creates `.env` from `.env.example` on first run. Review `.env` before use. No credentials are needed for simulation mode.

The regular browser page now uses a full desktop workspace on wide screens and a touch-friendly stacked layout on phones. **Pop out** continues to use the compact ticket.

### Hosted Vercel preview

The Vercel deployment is intentionally a static simulation preview. It serves only the browser UI; Kotak sign-in, extension bridge, live prices, option-chain data, and broker order APIs are disabled. Simulated orders exist only in the current browser session. The local Python app remains the only build configured to access Kotak. Vercel's static output is restricted to the three browser assets, so the backend, `.env`, database, logs, and extension files are not deployed.

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
5. Start with the smallest valid quantity and supported product/order type, and check Kotak Neo order/trade books. Live orders are not paper-traded after the live gate is enabled.

**There is no promise of a broker sandbox.** This project uses simulation locally. Whether Kotak gives your account a separate test environment must be confirmed with Kotak; the SDK's `prod` environment is the default unless changed.

### Troubleshooting `Not_Ok` order responses

The app surfaces Kotak rejection messages and records rejected attempts locally. A response with `stat: Not_Ok` is a rejected attempt, but always check Kotak's order book before retrying. Kotak validates the source IP on order APIs and binds the session to the IP used at login; create a new session after changing network or whitelist settings. `NEO_FORCE_IPV4=true` binds SDK requests to IPv4 for IPv4 whitelists, and the connection footer shows the egress IP Kotak reports after login. Optionally set `NEO_WHITELISTED_IPS` to one or two comma-separated addresses from Kotak's whitelist; PIP checks that allowlist and the login-session IP before each live order. A session still cannot switch between the primary and secondary IP. See Kotak's [static IP guidance](https://github.com/Kotak-Neo/Kotak-Neo/blob/main/docs/static-ip-whitelisting.md).

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
