# Security and Production Audit

**Reviewed:** 15 November 2026 · **Scope:** repository deployment path and publicly reachable Vercel/Oracle endpoints
**Trading activity:** none performed

## Findings

| Severity | Finding | State |
|---|---|---|
| Critical | The deployed `/terminal` page is publicly reachable and the `/api/terminal/ws` handler from the deployed 0.1.1 source accepts a websocket and starts `/bin/bash` without authentication or role checks. | Fixed in working source: cloud HTTP and websocket routes now refuse to start a PTY. Production is still exposed until the updated backend is deployed. |
| Critical | The pushed Antigravity handoff documents contained a plaintext VM SSH password and reusable admin login token. GitHub `main` currently points to the commit containing those files. | Working copies are sanitized. Rotate the SSH credential, revoke/reset the leaked owner session, and scrub repository history before publishing the next revision. The history rewrite is not performed here. |
| High | The deployed chart client accepted `auth_token`, `session`, or `key` URL parameters as owner credentials and saved them in local storage. | Fixed in working source: those query parameters are stripped without being accepted. The deployed client remains vulnerable until redeployment. |
| Critical | The public Vercel API rewrite previously sent traffic to the Oracle public IP over plain HTTP. Session cookies, owner tokens, bridge headers, and request bodies were therefore exposed in transit. | Fixed in source: a Vercel Node proxy now accepts only an HTTPS backend origin. Production still needs a trusted certificate for the reserved IP or hostname, Vercel environment variables, and redeployment. |
| High | The deployed API reported version `0.1.1`; `/research` returned Vercel 404 and `/api/research/local-datasets` returned `Not Found`. | Fixed in source: research pages/assets and research API code are included in the Vercel config and current backend. Not yet deployed. |
| High | The previous Oracle setup script opened public port 8000 and told operators to add an internet-wide ingress rule. | Fixed in source: the new setup uses Caddy TLS on 80/443 and a private Docker network; it removes the script's known legacy 8000 firewall rules. Oracle VCN ingress must also be changed manually. |
| High | The previous setup script changed a fresh `.env` to `LIVE_TRADING_ENABLED=true`. | Fixed in source: new deployments inherit the safe false default. The script preserves an existing value, refuses a live-enabled restart unless the operator explicitly acknowledges it, and never flips the gate on. |
| High | The previous Docker build did not compile/install the Rust/PyO3 extension and could include `.env` and local historical CSVs in `COPY . .`. | Fixed in source: multi-stage Rust wheel build and `.dockerignore` exclusions. Docker is not installed on this workstation, so the image has not been built here. |
| High | The application source contained default owner/admin credentials, and the owner PIN could fall back to the Kotak MPIN. | Fixed in source: credential defaults were removed; owner/admin sign-in fails closed when not configured; owner PIN is separate from Kotak MPIN. Existing deployments need explicit `ADMIN_*` and `OWNER_PIN` settings. |
| Medium | The previous README and deployment guide described Vercel as static-only and still documented public port 8000, contradicting the deployed proxy/API behavior. | Fixed in source: README and deployment runbook now describe the TLS proxy and Research page. |
| Medium | The Bank Nifty CSV exports are present only on this workstation; the Oracle backend will not see them automatically. | Source now has an owner-only streaming upload from `/research`; still needs deployment before use. Files remain excluded from the Docker build context and Git. |

## Live deployment observations

The public checks found:

- Vercel `https://neo-pip-terminal.vercel.app/api/health` returned `ok=true`, service `neo-pip-terminal`, version `0.1.1`.
- Direct Oracle `http://92.4.87.82:8000/api/health` returned the same old version over cleartext HTTP.
- Oracle `http://92.4.87.82/terminal` returned HTTP 200; the deployed source connects that page to an unauthenticated bash PTY.
- Oracle `http://92.4.87.82:8000/api/health` returned HTTP 200; HTTPS to the IP timed out and no reverse-DNS hostname was found. Source now supports direct IP HTTPS with a short-lived Let's Encrypt certificate; that configuration has not yet been deployed or validated against the VM.
- The GitHub repository page is publicly reachable, and its `main` branch includes the handoff commit containing the credential-bearing documents.
- `https://neo-pip-terminal.vercel.app/research` returned Vercel 404.
- `https://neo-pip-terminal.vercel.app/api/research/local-datasets` returned `{"detail":"Not Found"}`.

These observations identify the currently deployed state at the time of review. The source changes in this checkout do not update production until they are pushed/deployed and the Oracle VM is rebuilt.

### Mitigation applied on 15 November 2026

- Rotated the Ubuntu account password and stored the replacement in the workstation's login Keychain.
- Deleted four persisted admin sessions from `/opt/neo-pip-terminal/data/neo_pip.sqlite3`.
- Copied the replacement Upstox token from the user's clipboard into the VM's `.env` without displaying it; verified the file remains mode `0600`. The user separately replaced the Vercel secret.
- Stopped the legacy `neo-pip-backend` container. Subsequent requests to the public health endpoint and `/terminal` failed. The backend remains stopped until the patched build is deployed.
- Began rewriting local `main` history to remove both credential-bearing handoff files. The cleaned history and source fixes are not pushed yet.

## Remaining risk and rollout requirements

- The current backend uses software-managed algo exits. A backend restart can stop quote monitoring. Check the broker order book, stop algos, and protect any open position before a production restart.
- Owner credentials and `OWNER_PIN` must be set privately on the VM. They are deliberately empty in `.env.example`; local sign-in will stay unavailable until the operator configures them.
- Vercel needs `NEO_PIP_BACKEND_URL=https://<backend-domain>` and the trusted frontend origin. DNS must point that hostname to the Oracle VM, and Caddy must obtain a valid certificate.
- Oracle VCN Security Lists must allow 80/443 and remove port 8000. Host firewall changes do not update the VCN rules.
- `setup-oracle.sh` and the Docker image have not been executed on Oracle. The current machine has no Vercel CLI/authentication or Oracle SSH key; remote rollout remains pending.
- The login limiter is process-local. Multiple backend replicas would need shared rate-limit storage.
- Session tokens are persisted in the SQLite database. Protect the VM and backups with OS permissions and encrypted storage; rotate sessions if a database backup is exposed.
- Authentication and market/broker integrations have not been validated against the user's live accounts. No live orders or fills were tested.

## Source-level controls now present

- Live order capability is disabled by default and the deployment script cannot enable it.
- Owner sign-in requires explicit environment credentials; the owner PIN no longer falls back to a broker MPIN.
- Cloud remote terminal access is disabled. URL query parameters no longer authenticate users; sign in through the normal flow.
- Owner email login is rate-limited per address and client IP; regular sign-in is rate-limited. OTP verification has a per-code attempt limit.
- Cloud CORS responses use a configured origin allowlist rather than reflecting arbitrary origins.
- Vercel forwards only the configured HTTPS backend origin and an explicit request-header allowlist.
- `.env`, `data`, `logs`, and `reports` are excluded from the Docker context.

This is an operational review of the source and observed endpoints, not a penetration test or a compliance certification.
