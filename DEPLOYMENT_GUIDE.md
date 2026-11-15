# Production Deployment & Operations Guide

This guide deploys the FastAPI + Rust/PyO3 backend to an Oracle Ubuntu VM and serves the frontend through Vercel. The app starts with live trading disabled. The Oracle backend is exposed through HTTPS only.

## Oracle VM

### Prerequisites

- Ubuntu VM with a reserved public IPv4 address.
- Either a DNS hostname (for example `api.example.com`) with an A record pointing to the VM, or its reserved public IPv4 address. The IP option does not require buying a domain.
- Oracle VCN ingress for TCP 80/443 and UDP 443. Remove any TCP 8000 ingress rule.
- Docker access and private owner credentials configured in `/opt/neo-pip-terminal/.env`.

For an IP address, set `BACKEND_DOMAIN` to the exact reserved public IPv4 address. The deployment uses a publicly trusted Let's Encrypt certificate with the `shortlived` ACME profile, valid for 160 hours; Caddy renews it automatically. Keep the VM, Caddy container, persistent Caddy volumes, and inbound TCP 80/443 available so renewal can complete. Caddy documents ACME profile support as experimental, so verify the issued certificate and renewal logs after deployment. If you prefer standard 90-day certificates, use a DNS hostname instead.

The cloud `/terminal` web shell is intentionally disabled. The legacy version exposed an unauthenticated bash PTY; use SSH keys through a private administration path instead. Do not publish the backend container port or re-add the web PTY route.

### Initial setup

1. Check out the current `main` branch on the VM at `/opt/neo-pip-terminal`.
2. Copy `.env.example` to `.env`, set `ADMIN_USERNAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `OWNER_PIN`, and `BACKEND_DOMAIN` to either the reserved public IPv4 or a hostname resolving to the VM, then restrict it with `chmod 600 .env`. Keep broker credentials separate from the admin password and owner PIN. Do not send secrets through chat or commit them.
3. Set `LIVE_TRADING_ENABLED=false` while installing and validating. Add broker credentials only through the VM's protected environment file.
4. Run `sudo bash setup-oracle.sh` from the repository. The script builds the Rust extension into the Docker image, starts the API container on a private Docker network, and launches Caddy for HTTPS. It does not publish port 8000 or turn on live trading.
5. Visit `https://<BACKEND_DOMAIN>/api/health`. The reported version should match this checkout (`0.2.1` at this release).

If `LIVE_TRADING_ENABLED=true` is already configured, the script stops before replacing the backend. First confirm there are no open positions or running algos, then deliberately rerun with `ALLOW_LIVE_RESTART=yes`. The script preserves the current live gate and never enables it.

### Oracle VCN and host firewall

Allow inbound TCP ports 80 and 443, plus UDP 443 for HTTP/3, to obtain and renew the TLS certificate. Remove inbound TCP 8000. `setup-oracle.sh` also removes its legacy `iptables`/UFW port 8000 rules and adds 80/443 rules. The backend container has no `-p` host mapping; only Caddy publishes ports.

### Database and market data

SQLite state and application logs persist in `/opt/neo-pip-terminal/data` and `/opt/neo-pip-terminal/logs`. The Docker build excludes `.env`, local datasets, logs, reports, and `.git`.

The workstation's Upstox Bank Nifty exports are not automatically present on the VM. To make the hosted Research page discover them, use the owner-only CSV upload in `/research` or transfer the files through a private SSH connection to:

```text
/opt/neo-pip-terminal/data/exports/banknifty_1m/
```

The folder must contain `banknifty_index_1m.csv`, `banknifty_options_1m.csv`, and `metadata.json`. Keep the transfer private and preserve the CSV files; do not commit them to Git.

## Vercel

The project serves the ticket, chart, and `/research` views. The Node serverless function at `api/proxy.js` proxies `/api/*` to the Oracle origin over HTTPS. Configure these Production environment variables in the linked Vercel project:

```text
NEO_PIP_BACKEND_URL=https://<BACKEND_DOMAIN>
NEO_PIP_FRONTEND_ORIGINS=https://neo-pip-terminal.vercel.app
```

Add the Vercel project domain and any custom production frontend domain to `NEO_PIP_FRONTEND_ORIGINS`, comma-separated. Add custom frontend origins to the Oracle `.env` `ALLOWED_ORIGINS` list as well so direct uploads pass the backend CORS check. After saving the variables, redeploy the frontend. The proxy fails closed with HTTP 503 if the backend URL is missing or is not an HTTPS origin.

The build also writes the public backend origin into `runtime-config.js` for direct CSV uploads. Only the signed-in owner can upload; files stream to Oracle over HTTPS and are limited to 200 MB each. This bypasses Vercel request-body handling and stores the files in the persistent research-data directory.

Check:

- `https://neo-pip-terminal.vercel.app/` loads the terminal.
- `https://neo-pip-terminal.vercel.app/research` loads the research workspace.
- `https://neo-pip-terminal.vercel.app/api/health` reports the deployed API version.
- `https://neo-pip-terminal.vercel.app/api/research/local-datasets` returns the VM's dataset manifest after the CSV files have been uploaded.
- The public API hostname or IPv4 redirects HTTP to HTTPS and presents a publicly trusted certificate. For IP mode, confirm the IP SAN and expiry, and inspect Caddy logs to confirm it keeps renewing.
- `http://<VM_PUBLIC_IP>:8000/api/health` is unreachable from outside the VM.
- `http://<VM_PUBLIC_IP>/terminal` is not available in cloud deployment.

## Safe operational updates

Build and deploy outside trading hours. Algo trailing stops are software managed by the backend process. Restarting the VM service can stop quote monitoring and disrupt an open position. Before any restart, check the broker order book and positions, stop running algos, and verify whether a live position needs manual protection.

Check backend status and logs on the VM:

```bash
docker ps --filter name=neo-pip-
docker logs --tail 100 neo-pip-backend
docker logs --tail 100 neo-pip-caddy
```

Keep `LIVE_TRADING_ENABLED=false` until paper trading and API behavior have been reviewed. A working health check confirms availability only; it does not prove that Kotak authentication, market data, fills, or algo exits work against the account.

## Kotak Neo network allowlist

Use `/api/egress-ip` from the Oracle backend or the terminal account panel to view the backend's egress IP. Configure the IP in the Kotak developer portal and reconnect after changing network or whitelist settings. The server uses IPv4 by default where the account is IPv4-whitelisted. Do not publish the VM API on port 8000.
