# Deployed Website Audit

**Checked:** 15 November 2026
**Target:** `neo-pip-terminal.vercel.app` and the configured Oracle VM
**Source version prepared:** `0.2.1`

## What the current public deployment returned

| Request | Observed result | Issue |
|---|---|---|
| `GET /api/health` through Vercel | Healthy, version `0.1.1` | Oracle is serving an older backend. |
| `GET /api/health` at `http://92.4.87.82:8000` | Healthy, version `0.1.1` | Backend is exposed directly over unencrypted HTTP. |
| `GET /research` | Vercel 404 | Research page was not part of the deployed static build. |
| `GET /api/research/local-datasets` | `{"detail":"Not Found"}` | Deployed API does not have the research routes. |
| `GET http://92.4.87.82/terminal` | HTTP 200 | The legacy remote-shell page is publicly reachable. |
| `GET http://92.4.87.82:8000/api/health` | HTTP 200 over plain HTTP | The backend port remains internet reachable and does not use TLS. |
| `GET https://92.4.87.82/terminal` | Connection timeout | No usable HTTPS endpoint is configured at the public IP. |

The current 0.1.1 backend source on GitHub exposes `/api/terminal/ws` without checking a session or role, then starts `/bin/bash` in a PTY. Together with the public `/terminal` page, this gives unauthenticated visitors a path to an interactive VM shell. Treat this as a critical remote-shell exposure. The 0.2.1 working copy returns 404 for the cloud `/terminal` page and rejects the cloud websocket before opening a PTY; this fix is not deployed.

The deployed 0.1.1 chart client also accepts `auth_token`, `session`, or `key` URL parameters as owner credentials and stores them in browser local storage. The checked-in handoff included one such reusable token. The working copy now strips these parameters without authenticating; invalidate existing owner sessions and deploy the new client.

Both Antigravity handoff copies in the pushed `main` history contained a plaintext VM SSH password and a reusable admin login token. The GitHub repository page responds publicly without authentication, and `main` still points to the commit containing those files. The current working copies have been sanitized. Treat both credentials as compromised, rotate them, and scrub the Git history before publishing another revision. History rewriting needs coordination because it changes the shared branch.

The pushed Dockerfile uses `COPY . .`, while its `.dockerignore` does not exclude `.env` or `data`. If the VM's `.env` existed in the build context, that image can contain broker, owner, bridge, or mail credentials. The current `.dockerignore` blocks those paths; rotate secrets that were present on the VM and remove the old image after a successful replacement.

The workstation's CSVs are in `data/exports/banknifty_1m/`. The Oracle VM has an independent filesystem and does not see these local files by default. Version 0.2.1 adds an owner-only direct-to-Oracle upload flow to `/research`; it still needs the Vercel frontend and updated Oracle API deployed before it can be used.

No reverse-DNS hostname was found for `92.4.87.82`; the current service is reachable by IP over HTTP only. A domain is optional: Let's Encrypt now issues IP-address certificates using the `shortlived` ACME profile. The updated source has a separate Caddy configuration for a reserved public IPv4, which requests a certificate valid for 160 hours and relies on Caddy for renewal. Keep Oracle ingress for TCP 80/443 open, preserve Caddy's certificate volumes, and remove TCP 8000. A domain remains an alternative if you prefer regular certificates. The existing `neo-pip-terminal.vercel.app` name belongs to the frontend and cannot be repurposed as the Oracle hostname.

## Fixes prepared in this checkout

- Added `/research` routes/assets and CSV templates to the Vercel build output.
- Replaced the hard-coded HTTP IP rewrite with a Vercel Node proxy at `api/proxy.js` that requires `NEO_PIP_BACKEND_URL` to be an HTTPS origin and allowlists forwarded headers/origins.
- Rebuilt the Docker definition as a multi-stage Python/Rust/PyO3 image.
- Excluded `.env`, CSV data, logs, reports, and build artifacts from the Docker context.
- Replaced the Oracle setup script's public port 8000 design with Caddy TLS termination on 80/443 and private backend networking.
- Removed code-level admin/password/PIN fallbacks and stopped owner PIN from borrowing the Kotak MPIN.
- Changed new cloud setup to keep `LIVE_TRADING_ENABLED=false` and require explicit acknowledgment before restarting an existing live-enabled deployment.
- Disabled the cloud PTY terminal entirely; cloud HTTP and websocket requests cannot start a shell. Local loopback development still supports the terminal.
- Sanitized the checked-in Antigravity handoff note. The original values remain in Git history until they are rotated and history is scrubbed.
- Updated deployment instructions and the root security audit to describe the actual Vercel + Oracle topology.

## Steps needed before production is current

1. Reserve `92.4.87.82` in Oracle and set `BACKEND_DOMAIN=92.4.87.82` in the VM's private `.env`; alternatively, configure a DNS hostname pointing to the VM.
2. Configure Oracle VCN ingress for TCP 80/443 and UDP 443; remove TCP 8000.
3. Publish the cleaned source version `0.2.1` to GitHub `main` and deploy it to Oracle. In IP mode, verify the public certificate contains the IP SAN, has an expected six-day lifetime, and renews; inspect Caddy logs.
4. Redeploy Vercel. Its Production backend origin and frontend-origin variables have already been configured.
5. Verify `/api/health`, `/research`, the research API, TLS, and external port 8000 closure.
6. Sign into the deployed Research page as owner and upload both Bank Nifty CSV files (or transfer them over SSH) if the hosted page should auto-discover the dataset.

## Deployment access and live-session constraint

The user authorized local GitHub and Vercel sign-in. GitHub CLI authentication succeeds for `thatsaiiff`; the remote `main` still points to the old credential-bearing commit pending the history rewrite. The Vercel Production environment has `NEO_PIP_BACKEND_URL=https://92.4.87.82` and `NEO_PIP_FRONTEND_ORIGINS=https://neo-pip-terminal.vercel.app`; changes need a new deployment to take effect. The user replaced the Upstox token in Vercel. SSH access to Oracle now works using the user's supplied key. The replacement Upstox token was copied from the clipboard into the VM's private `.env` without being displayed; the file remains mode `0600`.

The Ubuntu password was rotated and saved to the Mac login Keychain. Four persisted admin sessions were revoked from SQLite. The legacy `neo-pip-backend` container was stopped; public health and `/terminal` requests then became unreachable. The container remains stopped until the patched image can be deployed. Git history rewriting is now in progress under the user's prior approval.

The owner confirmed there are no active algos or positions, so a planned backend restart is acceptable. The setup script still checks the server's live-trading flag and requires an explicit `ALLOW_LIVE_RESTART=yes` if that flag is true; it never enables live trading.

## Validation status

The cleaned history and source rollout are not yet pushed. The Docker image has not been built on this workstation because Docker is unavailable. The local Rust extension has built successfully for this Mac, but that is not a substitute for a Linux container build. No order submission was made; the legacy backend remains stopped.
