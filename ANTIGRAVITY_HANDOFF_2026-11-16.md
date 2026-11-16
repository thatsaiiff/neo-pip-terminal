# Antigravity handoff — chart, mobile navigation, admin login

Date: 2026-11-16
Repository: `/Users/saif/Downloads/PropDesk/neo-pip-terminal`

## Why the deployed navigation did not change

The navigation work was edited and built in this local checkout only. It was **not committed, pushed, or deployed to Vercel**, so `neo-pip-terminal.vercel.app` continues to serve the previous version. At the time of handoff, `gh auth status` reports the GitHub CLI session as invalid and the Vercel CLI is not installed. Do not report these UI changes as live until a deployment is completed and checked in a browser.

## User request

1. Fix delayed/non-realtime Indian market candles and verify Upstox data in the chart.
2. Remove floating Buy/Sell chart buttons.
3. Make mobile lot count tap-to-edit/typable.
4. Fix admin sign-in using VM `.env` credentials.
5. Add main-page mobile bottom tabs: Home, Watchlist, Orders, Positions, More.

## Local changes in this checkout

- `app/static/chart.js`
  - Added a reconnecting browser WebSocket consumer for `/api/ws/quotes` and live tick to candle aggregation.
  - Vercel frontends connect directly to the Oracle TLS endpoint `wss://92.4.87.82/api/ws/quotes`; local development uses same-origin WebSocket.
  - Removed the chart floating dock's one-tap order JS and removed the external TradingView hosted widget switch. The chart always uses local TradingView Lightweight Charts, which can render this app's Upstox data.
  - Removed fabricated volume values; zero volume remains zero.
  - Made `/chart` mobile navigation labels Home / Watchlist / Orders / Positions / More and wired Orders/Positions views.
  - Made mobile lots input editable and synchronized with the main lot input.
- `app/main.py`
  - The `/api/ws/quotes` server handler now uses `asyncio.to_thread` around synchronous quote fetch helpers so blocking REST fallback work does not block the ASGI event loop.
- `app/static/chart.html`, `app/static/chart.css`
  - Removed the floating chart Buy/Sell controls and external TradingView widget containers/scripts; added editable mobile lots; feed footer status now starts at Connecting.
- `app/static/index.html`, `app/static/styles.css`, `app/static/app.js`
  - Added fixed mobile bottom nav with Home, Watchlist, Orders, Positions, More.
  - Added a mobile index watchlist (NIFTY, BANK NIFTY, SENSEX) with quote display and symbol selection; More links to chart, strategy research, connect, and sign-in.
- `vercel.json`
  - CSP permits the direct Oracle WSS endpoint and removes now-unused TradingView widget/frame hosts.

There were pre-existing modifications to `SECURITY_AUDIT.md`, `deploy/Caddyfile.ipv4`, and `docs/DEPLOYMENT_AUDIT.md` before this task. Preserve and review them; do not discard them as part of this handoff.

## Verification performed

- `python3 -m py_compile app/main.py` — passed.
- `node --check app/static/chart.js` — passed.
- `node --check app/static/app.js` — passed.
- `node scripts/build_vercel.js` — passed (`Prepared 18 allowlisted Vercel assets`).
- `git diff --check` — passed.
- Parsed both HTML files and found no duplicate IDs.
- Local browser preview was not completed: binding a local HTTP server was denied by the environment.

## Production observations (read-only)

- `https://92.4.87.82/api/health` responds with backend version `0.1.1`; repo source has version `0.2.1`. This confirms the VM is on older backend code.
- Public `/api/chart/upstox-status` and `/api/settings/keys-status` report Upstox configured. A read-only query confirmed an Upstox token exists in the VM app-settings database (token value was not read or printed).
- A read-only POST to `/api/chart/live-quotes` returned a current NIFTY quote.
- A WebSocket handshake to `/api/ws/quotes` returned `101 Switching Protocols`, but a NIFTY subscription returned no quote within 12 seconds on the currently deployed `0.1.1` backend. Retest after deploying the event-loop fix. If still no tick, investigate `_get_upstox_ws_or_v3_batch`, subscription token resolution, Upstox connection/cache status, and add safe diagnostics (never log tokens).
- VM `/opt/neo-pip-terminal/.env` and running container lack `ADMIN_USERNAME`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD`. Admin sign-in reads these at process start in `app/main.py`; there is no database fallback. This is the confirmed reason the supplied admin credentials do not work on this VM.
- Current VM DB aggregate counts: 5 positions with status `OPEN`; 31 live orders with status `submitted`; other live orders are rejected. Earlier user confirmation said no active algo/position, but this read-only database snapshot contradicts that. **Do not restart/redeploy the backend until the user/broker reconciles these records and safe deployment is confirmed.** `LIVE_TRADING_ENABLED=true` has previously been confirmed; leave it unchanged.
- GitHub CLI auth is invalid; no Vercel CLI available. Nothing from this task is published yet.

## Next actions for Antigravity

1. Review the diff, especially the `/chart` mobile navigation wiring and CSP. Test both desktop and phone widths in a browser.
2. Confirm the account state with the user/broker before any backend restart. Do not stop containers, reset orders, alter live-trading state, or change credentials while the submitted/open records are unresolved.
3. Restore authorized GitHub/Vercel deployment access using the user's local browser/session. Deploy the frontend, then verify the production page actually shows the five tabs and that the new static asset hashes are served.
4. In a safe backend maintenance window, update the Oracle app from this repo so the WebSocket event-loop fix is active, then subscribe to a liquid Indian instrument and verify actual incoming tick timestamps and candle updates.
5. Have the owner securely add the correct `ADMIN_USERNAME`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` to the actual VM `.env` at `/opt/neo-pip-terminal/.env`. Do not ask them to paste secrets into chat or print them in logs. Restart only after the open positions/orders are reconciled; then verify admin login and environment presence using boolean-only checks.
6. Re-run syntax/build checks and production smoke checks. Do not claim realtime is solved solely because an HTTP quote or WebSocket handshake succeeds; confirm a subscribed WebSocket tick arrives and updates the visible candle.

## Secret handling

This note contains no passwords, PINs, SSH private key material, or Upstox access tokens. The user's previously rotated/revoked Upstox token must remain private.

## Follow-up: admin environment restart attempt

- The owner explicitly asked the agent to restart/reload Oracle after adding the admin variables.
- Recreated only `neo-pip-backend` from the same immutable image, preserving `/opt/neo-pip-terminal/data`, `/opt/neo-pip-terminal/logs`, host port 8000, and `LIVE_TRADING_ENABLED=true`. Kept the old stopped container as `neo-pip-backend-before-admin-env-20261116` as rollback.
- The first recreation did not preserve Caddy reachability because the prior backend was on Docker's default `bridge` network while Caddy uses `neo-pip-network`. Restored the Caddy upstream without restarting either container using `docker network connect --alias neo-pip-backend neo-pip-network neo-pip-backend`.
- Public HTTPS health and Upstox status both now return HTTP 200; service reports backend version `0.1.1`. Database still has 5 OPEN positions and 31 submitted live orders; counts and `LIVE_TRADING_ENABLED=true` were preserved.
- After recreation, a fresh boolean-only check found `ADMIN_USERNAME`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` absent from both the host `/opt/neo-pip-terminal/.env` and container. Therefore admin sign-in still cannot work. Do not print/collect secret values. Ask owner to verify exact unindented `KEY=value` lines are saved in that exact host file, then recreate only the backend again from the same image and repeat the safe health/admin-login checks.
- The local source changes are still not deployed to Vercel; GitHub CLI authentication remains invalid and Vercel CLI is unavailable. The running backend image is still 0.1.1 and does not include the local WebSocket event-loop change.
