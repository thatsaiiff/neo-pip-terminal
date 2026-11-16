# Security and Production Audit

**Reviewed:** 16 November 2026
**Scope:** Vercel frontend, Oracle VM deployment, and deployment source
**Trading activity:** none performed

## Findings and current state

| Severity | Finding | Current state |
|---|---|---|
| Critical | Backend `0.1.1` exposes an unauthenticated terminal WebSocket that can start a shell. | Caddy now blocks `/api/terminal/ws` with 404. The backend has not been replaced. |
| High | The backend previously served publicly on TCP 8000 over HTTP. | Removed TCP 8000 from the Oracle VCN ingress list and removed matching host firewall allows. Public TCP 8000 timed out during verification. The Docker port mapping remains, so do not restore the VCN rule. |
| High | API requests need HTTPS between Vercel and Oracle. | Caddy is running with a trusted Let's Encrypt IP certificate. Vercel `/api/health` now returns HTTP 200 through HTTPS. |
| High | Vercel and Oracle backend versions differ. | Vercel serves the new frontend, including `/research`; Oracle still reports `0.1.1` while the prepared source is `0.2.1`. Research API returns 404 until backend upgrade. |
| High | Live records could be affected by replacing the backend. | Database has 5 open positions and 31 live orders marked `submitted`; algo status is `enabled=false`, `IDLE`. Reconcile those records with Kotak before restarting. |
| Medium | Old VM password was exposed in a prior handoff. | Ubuntu password authentication is locked; the supplied SSH key remains usable. This invalidates the old password but does not create a replacement. |
| Medium | Persisted sessions should be reviewed after credential exposure. | Database reports nine user-session rows and zero admin sessions. No token values were accessed. |
| Medium | Old Git refs may retain credential-bearing history. | Clean commit `652bba9` was force-pushed to `main`, and Vercel reports it ready. Local stash/checkpoint refs still retain old history; cleanup was blocked by workspace permissions. |

## Verification results

- `https://neo-pip-terminal.vercel.app/`: HTTP 200.
- `https://neo-pip-terminal.vercel.app/research`: HTTP 200.
- `https://neo-pip-terminal.vercel.app/api/health`: HTTP 200, backend version `0.1.1`.
- `https://92.4.87.82/api/health`: HTTP 200 with the same backend version.
- `https://neo-pip-terminal.vercel.app/api/research/local-datasets`: HTTP 404.
- `https://neo-pip-terminal.vercel.app/api/terminal/ws`: HTTP 404.
- `https://neo-pip-terminal.vercel.app/terminal`: HTTP 404.
- `http://92.4.87.82:8000/api/health`: connection timeout after the ingress rule was removed.
- `LIVE_TRADING_ENABLED=true` remains set. No backend restart or order submission was performed.

The Caddy IP site uses a short-lived Let's Encrypt certificate and persistent Caddy storage. It sets `default_sni` for clients that omit SNI when connecting to an IP literal. Caddy documents `default_sni` as the default TLS server name for ClientHello messages without SNI: [Caddy global options](https://caddyserver.com/docs/caddyfile/options).

## Source-level controls in the prepared release

- Live order capability defaults off for new deployments; deployment preserves an existing live flag and explicitly guards live restarts.
- Owner/admin authentication fails closed when credentials are absent; owner PIN is separate from Kotak MPIN.
- Cloud terminal access is disabled in the updated backend.
- URL query parameters are stripped and never accepted as owner credentials.
- Vercel forwards an explicit header allowlist to an HTTPS-only backend origin.
- CORS uses the configured frontend origin allowlist.
- `.env`, data exports, logs, and reports are excluded from the Docker build context.
- The Dockerfile builds the Rust/PyO3 extension in a multi-stage image.

## Deployment status

The separate Caddy proxy is deployed and running alongside the existing backend. The current live backend remains version `0.1.1`; version `0.2.1` has not been deployed because stored position/order records need reconciliation first. The prepared Docker image has not yet been built on the Oracle VM. The local Rust extension build is not proof of a Linux container build. No live account login or order flow was tested.
