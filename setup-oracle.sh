#!/usr/bin/env bash
# Secure Oracle VM deployment for Neo PIP.
# Publishes HTTPS through Caddy on 80/443; the FastAPI container stays private.

set -euo pipefail

APP_DIR="/opt/neo-pip-terminal"
BACKEND_CONTAINER="neo-pip-backend"
PROXY_CONTAINER="neo-pip-caddy"
DOCKER_NETWORK="neo-pip-network"

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

if [ "$(id -u)" -ne 0 ]; then
  fail "Run with sudo: sudo bash setup-oracle.sh"
fi

printf '%s\n' 'Neo PIP Oracle deployment (HTTPS reverse proxy; backend port stays private)'

apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl git gnupg lsb-release iptables-persistent netfilter-persistent

if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg --yes
  chmod a+r /etc/apt/keyrings/docker.gpg
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu %s stable\n' \
    "$(dpkg --print-architecture)" "$(. /etc/os-release && printf '%s' "$VERSION_CODENAME")" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
fi

if [ ! -d "$APP_DIR/.git" ]; then
  mkdir -p "$APP_DIR"
  git clone https://github.com/thatsaiiff/neo-pip-terminal.git "$APP_DIR"
else
  git -C "$APP_DIR" pull --ff-only origin main
fi

if [ -f /home/ubuntu/.env ] && [ ! -f "$APP_DIR/.env" ]; then
  install -m 0600 /home/ubuntu/.env "$APP_DIR/.env"
fi
if [ ! -f "$APP_DIR/.env" ]; then
  install -m 0600 "$APP_DIR/.env.example" "$APP_DIR/.env"
  fail "Created $APP_DIR/.env with safe defaults. Configure ADMIN_USERNAME, ADMIN_EMAIL, ADMIN_PASSWORD, OWNER_PIN and BACKEND_DOMAIN, then rerun. Live trading remains disabled."
fi
chmod 0600 "$APP_DIR/.env"

# Parse keys as data; never source or print credential values from .env.
MISSING_KEYS="$(python3 - "$APP_DIR/.env" <<'PY'
import sys
from pathlib import Path

required = ("ADMIN_USERNAME", "ADMIN_EMAIL", "ADMIN_PASSWORD", "OWNER_PIN", "BACKEND_DOMAIN")
values = {}
for line in Path(sys.argv[1]).read_text().splitlines():
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in stripped:
        continue
    key, value = stripped.split("=", 1)
    values[key.strip()] = value.strip().strip("\"'")
print("\n".join(key for key in required if not values.get(key)))
PY
)"
if [ -n "$MISSING_KEYS" ]; then
  fail "Set these empty deployment values in $APP_DIR/.env, then rerun: $(printf '%s' "$MISSING_KEYS" | paste -sd ', ' -)"
fi

BACKEND_DOMAIN="$(python3 - "$APP_DIR/.env" <<'PY'
import sys
from pathlib import Path
for line in Path(sys.argv[1]).read_text().splitlines():
    if line.strip().startswith("BACKEND_DOMAIN="):
        print(line.split("=", 1)[1].strip().strip("\"'"))
        break
PY
)"
PUBLIC_IP="$(curl --fail --silent --show-error --ipv4 https://api.ipify.org || true)"
if [[ ! "$PUBLIC_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  fail "Could not determine the VM public IPv4. Check outbound internet access and the Oracle public IP assignment."
fi

if ! BACKEND_KIND="$(python3 - "$BACKEND_DOMAIN" <<'PY'
import ipaddress
import re
import sys

value = sys.argv[1]
try:
    ipaddress.IPv4Address(value)
except ipaddress.AddressValueError:
    labels = value.split(".")
    numeric_dotted_quad = re.fullmatch(r"[0-9.]+", value)
    valid = not numeric_dotted_quad and len(value) <= 253 and len(labels) >= 2 and all(
        re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label)
        for label in labels
    ) and re.fullmatch(r"[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{2,59}", labels[-1], re.IGNORECASE)
    if not valid or ":" in value or "/" in value or "@" in value:
        raise SystemExit(1)
    print("hostname")
else:
    print("ipv4")
PY
)"; then
  fail "BACKEND_DOMAIN must be a public DNS hostname or IPv4 address; do not include a scheme or path."
fi

if [ "$BACKEND_KIND" = "ipv4" ]; then
  if [ "$BACKEND_DOMAIN" != "$PUBLIC_IP" ]; then
    fail "For an IP certificate, BACKEND_DOMAIN ($BACKEND_DOMAIN) must exactly match this VM's public IPv4 ($PUBLIC_IP). Reserve the IP in Oracle so it does not change."
  fi
  CADDYFILE="$APP_DIR/deploy/Caddyfile.ipv4"
else
  DNS_IPS="$(getent ahostsv4 "$BACKEND_DOMAIN" | awk '{print $1}' | sort -u || true)"
  if ! printf '%s\n' "$DNS_IPS" | grep -Fxq "$PUBLIC_IP"; then
    fail "BACKEND_DOMAIN must resolve to this VM's public IPv4 ($PUBLIC_IP) before deployment."
  fi
  CADDYFILE="$APP_DIR/deploy/Caddyfile"
fi

LIVE_VALUE="$(python3 - "$APP_DIR/.env" <<'PY'
import sys
from pathlib import Path
value = "false"
for line in Path(sys.argv[1]).read_text().splitlines():
    if line.strip().startswith("LIVE_TRADING_ENABLED="):
        value = line.split("=", 1)[1].strip().lower()
print(value)
PY
)"
if [ "$LIVE_VALUE" = "true" ] && [ "${ALLOW_LIVE_RESTART:-}" != "yes" ]; then
  fail "LIVE_TRADING_ENABLED is already true. This deployment restarts the backend. Confirm there are no active positions/algos, then rerun with ALLOW_LIVE_RESTART=yes. This script never enables live trading."
fi

# Keep 8000 closed and permit only the TLS reverse proxy ports at the VM firewall.
while iptables -C INPUT -p tcp --dport 8000 -m state --state NEW,ESTABLISHED -j ACCEPT 2>/dev/null; do
  iptables -D INPUT -p tcp --dport 8000 -m state --state NEW,ESTABLISHED -j ACCEPT
done
iptables -C INPUT -p tcp -m multiport --dports 80,443 -m state --state NEW,ESTABLISHED -j ACCEPT 2>/dev/null \
  || iptables -I INPUT -p tcp -m multiport --dports 80,443 -m state --state NEW,ESTABLISHED -j ACCEPT
iptables -C INPUT -p udp --dport 443 -m state --state NEW,ESTABLISHED -j ACCEPT 2>/dev/null \
  || iptables -I INPUT -p udp --dport 443 -m state --state NEW,ESTABLISHED -j ACCEPT
if command -v ufw >/dev/null 2>&1; then
  ufw delete allow 8000/tcp >/dev/null 2>&1 || true
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null
fi
netfilter-persistent save >/dev/null 2>&1 || true

cd "$APP_DIR"
if [ -L "$APP_DIR/data" ] || [ -L "$APP_DIR/logs" ]; then
  fail "Refusing to change ownership through a symlinked data or logs directory. Inspect those paths manually."
fi
install -d -o 10001 -g 10001 -m 0750 "$APP_DIR/data" "$APP_DIR/logs"
chown -R 10001:10001 "$APP_DIR/data" "$APP_DIR/logs"
docker build --pull -t neo-pip-backend:latest .
docker network inspect "$DOCKER_NETWORK" >/dev/null 2>&1 || docker network create "$DOCKER_NETWORK" >/dev/null

docker rm -f "$BACKEND_CONTAINER" >/dev/null 2>&1 || true
docker run -d \
  --name "$BACKEND_CONTAINER" \
  --restart unless-stopped \
  --network "$DOCKER_NETWORK" \
  --env-file "$APP_DIR/.env" \
  -e CLOUD_DEPLOYMENT=true \
  -e LIVE_TRADING_ENABLED="$LIVE_VALUE" \
  -v "$APP_DIR/data:/app/data" \
  -v "$APP_DIR/logs:/app/logs" \
  neo-pip-backend:latest >/dev/null

docker rm -f "$PROXY_CONTAINER" >/dev/null 2>&1 || true
docker run -d \
  --name "$PROXY_CONTAINER" \
  --restart unless-stopped \
  --network "$DOCKER_NETWORK" \
  -p 80:80 \
  -p 443:443 \
  -p 443:443/udp \
  -e BACKEND_DOMAIN="$BACKEND_DOMAIN" \
  -v "$CADDYFILE:/etc/caddy/Caddyfile:ro" \
  -v neo-pip-caddy-data:/data \
  -v neo-pip-caddy-config:/config \
  caddy:2.11.9-alpine >/dev/null

printf '\nDeployment launched. The backend container has no published host port.\n'
printf 'HTTPS backend: https://%s/api/health\n' "$BACKEND_DOMAIN"
printf 'Local container status: docker ps --filter name=neo-pip-\n'
printf 'Check logs: docker logs --tail 100 %s\n' "$BACKEND_CONTAINER"
printf '\nOracle VCN security rules must allow TCP 80/443 and UDP 443, and remove any TCP 8000 ingress rule.\n'
printf 'Set Vercel Production variables: NEO_PIP_BACKEND_URL=https://%s and NEO_PIP_FRONTEND_ORIGINS=https://neo-pip-terminal.vercel.app\n' "$BACKEND_DOMAIN"
printf 'Live trading was not enabled or changed by this script.\n'
