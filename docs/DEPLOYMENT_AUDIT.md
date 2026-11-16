# Deployed Website Audit

**Checked:** 16 November 2026
**Target:** `neo-pip-terminal.vercel.app` and Oracle VM `92.4.87.82`
**Prepared source version:** `0.2.1`
**Live trading gate:** `LIVE_TRADING_ENABLED=true` (preserved)

## Current public checks

| Request | Result | Status |
|---|---|---|
| Vercel `/` | HTTP 200 | Frontend is serving |
| Vercel `/research` | HTTP 200 | Research page is included in the deployed frontend |
| Vercel `/api/health` | HTTP 200, backend version `0.1.1` | HTTPS proxy reaches Oracle; backend itself is still old |
| Oracle `https://92.4.87.82/api/health` | HTTP 200 | Caddy has a trusted IP certificate and proxies to the backend |
| Vercel `/api/research/local-datasets` | HTTP 404 | Oracle backend has not been upgraded to source version `0.2.1` |
| Vercel `/api/terminal/ws` | HTTP 404 | Blocked by Caddy |
| Vercel `/terminal` | Vercel 404 | No terminal page is published |
| Direct `http://92.4.87.82:8000/api/health` | Connection timeout | Public VCN ingress and host firewall allows for TCP 8000 were removed |

The 0.1.1 backend container remains running and still publishes port 8000 on its Docker host interface. Oracle's VCN security list no longer permits inbound 8000, and the matching host `INPUT` allow rules were removed. Do not restore public ingress to 8000.

The backend's old `/api/terminal/ws` handler can start an unauthenticated PTY. Caddy now returns 404 for that route before proxying other API traffic. The proxy config uses `default_sni` for the IP because clients such as Node omit SNI for IP-address URLs; without it Vercel returned 502 even though the IP certificate was valid. Caddy's IP certificate was issued and the Vercel API health check returned 200 after this setting was loaded.

## Oracle state and rollout constraint

- The Ubuntu `ubuntu` password is locked, so the old password no longer authenticates. The supplied SSH key still works. No replacement password was created or sent.
- The app database contains 5 `OPEN` position records and 31 live orders with status `submitted`. The algo status endpoint reports `enabled=false` and `IDLE`; these database records still need reconciliation against Kotak's current positions and order book before replacing the backend.
- Nine persisted user-session rows remain; none are marked admin. No session token values were read or printed.
- The backend's `.env` contains `BACKEND_DOMAIN=92.4.87.82` and `LIVE_TRADING_ENABLED=true`. The live gate was not changed.
- The backend was not restarted. Replacing it would briefly disconnect the Kotak session and could affect open positions or submitted orders.

## Remaining deployment gaps

1. Reconcile the 5 open position records and 31 submitted live-order records with the Kotak order book and positions.
2. After the records are understood and any open exposure is protected, deploy source version `0.2.1` to Oracle while preserving `LIVE_TRADING_ENABLED=true`; expect Kotak TOTP/MPIN reauthentication after a restart.
3. Verify the new backend health version, Research API, terminal route block, Vercel proxy, and Rust/PyO3 extension on the Linux VM.
4. Upload the local Bank Nifty CSVs to the hosted Research workspace after the new backend is deployed.

## Fixes in the prepared source

- Added `/research` routes/assets and CSV templates to the Vercel build.
- Added a Vercel HTTPS-only API proxy with an explicit request-header and origin allowlist.
- Added a multi-stage Rust/PyO3 Docker build and excluded `.env`, CSV data, logs, reports, and build artifacts from the Docker context.
- Reworked Oracle deployment around Caddy TLS and a private backend Docker network.
- Added the IP-certificate Caddy configuration, including `default_sni` for IP clients and a block for `/api/terminal/ws`.
- Removed code-level admin/password/PIN fallbacks and prevented owner PIN from borrowing Kotak MPIN.
- Kept new deployments disabled for live trading by default; the rollout script preserves an existing live setting and requires an explicit restart acknowledgment.
- Disabled the cloud PTY terminal and removed URL query parameters as an authentication mechanism.
