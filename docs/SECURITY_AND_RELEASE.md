# Security, Operational Safety & Release Checklist

## Before releasing the hosted site

- [ ] Keep `.env` out of Git and Docker; use mode `0600` on the VM.
- [ ] Configure unique owner `ADMIN_USERNAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `OWNER_PIN` values. Never reuse the Kotak MPIN for the owner PIN.
- [ ] Keep `LIVE_TRADING_ENABLED=false` until the live deployment has been separately reviewed.
- [ ] Set `BACKEND_DOMAIN` to a hostname or reserved public IPv4 for the Oracle VM and confirm the Caddy TLS certificate is valid. For IP mode, check its IP SAN, expiry, and renewal logs.
- [ ] Allow inbound TCP 80/443 and UDP 443 in the Oracle VCN. Remove TCP 8000 ingress.
- [ ] Set Vercel Production `NEO_PIP_BACKEND_URL` to the HTTPS origin and set the allowed frontend origins.
- [ ] Confirm external port 8000 is unreachable and the HTTPS API health route reports the expected version.
- [ ] Confirm `/`, `/chart`, `/research`, and `/api/research/local-datasets` load on the hosted deployment.
- [ ] Transfer local research data to the VM only when the hosted app should use those CSVs; do not put them in Git or the image.
- [ ] Review deployment diffs and perform the rollout outside trading hours.

## Before enabling live orders

- [ ] Run an end-to-end paper session first. Confirm real quotes, exact listed contracts, candle source, quantity, stop, target, charges, and risk state.
- [ ] Confirm the backend, network, and quote polling can stay available for the entire session. Algo stops are software monitored, not exchange-held.
- [ ] Verify current official Kotak API requirements, source IP, account/product eligibility, order types, and order limits.
- [ ] Configure Kotak credentials on the Oracle VM through its protected `.env`; never share them in chat or frontend code.
- [ ] Complete TOTP registration and test authentication when ready.
- [ ] Enable `LIVE_TRADING_ENABLED=true` only with deliberate operator intent. The setup script never enables it.
- [ ] Confirm position sizing and start with the smallest supported size.
- [ ] Check Kotak order/trade books after every submission. Reconcile ambiguous requests before retrying.
- [ ] Before restarting or deploying, stop running algos and check broker positions because a restart interrupts quote monitoring.

## Known operational risks

- Algo stop, target, trailing, and end-of-day exits depend on the backend process and market data connection. A crash, stale feed, network interruption, or slippage can leave risk open.
- The login limiter is in memory per backend process. If the service is scaled to multiple replicas, use a shared limiter.
- Session tokens are stored in SQLite. Restrict database and backup access; revoke/rotate sessions if a copy is exposed.
- Broker API integration, order status mapping, account permissions, and live market data have not been validated against this user's account in this release.
- Historical backtest metrics are limited by the supplied candles and their scope. They do not establish future profitability.

## Local development

- [ ] Keep the local backend bound to `127.0.0.1:8000` unless LAN mode is deliberately enabled on a trusted private network.
- [ ] Keep the Chrome extension limited to the browser profile used for Kotak Neo and use a high-entropy bridge token.
- [ ] Confirm exact symbol, contract, exchange segment, product, lot size, quantity, stop, and order type before any real order.

## Risk statement

Neo PIP is a trading tool, not a recommendation service or guarantee of results. The strategy's Sharpe target is not a promised or optimized outcome. Software-managed exits are not exchange-held protective orders. Always verify orders and positions in the broker's own interface.
