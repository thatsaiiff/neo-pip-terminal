# Security, Operational Safety & Release Checklist

## Before using the project

- [ ] Use a personal desktop account and keep the backend bound to loopback (`127.0.0.1`).
- [ ] Confirm `.env` is ignored by Git and file permissions are appropriate for the machine.
- [ ] Generate a high-entropy `BRIDGE_TOKEN`; copy it to `extension/bridge-config.js` and do not commit/share it.
- [ ] Check that the extension is loaded only in a browser profile used for Kotak Neo.
- [ ] Confirm the correct Kotak Neo domain is explicitly covered by the extension match list.
- [ ] Confirm the symbol shown in Neo PIP is exactly the canonical symbol the broker order API expects.
- [ ] Verify the exchange segment, product eligibility, lot size, quantity and stop/limit inputs manually.
- [ ] Run `pytest -q` and test the UI in simulation mode before attempting any live interaction.

## Before enabling live orders

- [ ] Read and verify the current official Kotak Neo API rules, allowed static IP/registration requirements, product types, market/stop orders and order rate limits for the account.
- [ ] Confirm consumer key, mobile number and UCC from Kotak Neo app/web; never share credentials in chat.
- [ ] Complete TOTP registration and test authentication only when ready.
- [ ] Decide whether live orders are actually intended, then change `LIVE_TRADING_ENABLED=false` to `true` locally and restart.
- [ ] Start with the smallest correct quantity and a supported product/order type.
- [ ] Check broker orderbook/tradebook after each submission; never infer fills from a successful HTTP response.
- [ ] If a timeout, exception or uncertain status occurs, reconcile with Kotak Neo first. Do not blindly retry.
- [ ] Keep this application off the public internet; do not expose it via port forwarding or tunnels.

## Hardening gaps before any shared or hosted release

- Add OS-level access control and a per-session CSRF defense if any remote browser access is introduced.
- Add stricter user confirmation or per-order live PIN; consider requiring typed confirmation text for live orders.
- Use a canonical instrument master lookup to validate symbol, segment, expiry, strike and lot size.
- Add order idempotency/reconciliation workflow based on broker orderbook before any retry.
- Implement price timestamps, quote-staleness guard and order-size/margin guardrails before adding trailing stop.
- Persist lifecycle statuses from broker order feed, not only order-submission responses.
- Add automated browser tests for PiP, accessibility, and target Kotak Neo pages.
- Review logging and storage lifecycle; add export/redaction/retention controls.

## Risk statement

This is a single-user local trading helper. It is not a recommendation service or a guarantee of trading outcomes. Browser DOM detection, price feed, broker acceptance, execution and exchange behaviour are independent failure points. Never rely on this UI alone to confirm an order filled or a stop-loss is active.
