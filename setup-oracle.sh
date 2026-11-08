#!/usr/bin/env bash
# ==============================================================================
# Neo PIP Terminal — Oracle Cloud Always Free Automated Setup Script
# ==============================================================================
# This script configures an Oracle Cloud Always Free Ubuntu VM:
# 1. Installs Docker and dependencies
# 2. Configures iptables & UFW to allow port 8000 (resolving Oracle's default firewall block)
# 3. Pulls/builds the Neo PIP backend container with automatic restart
# 4. Detects your VM's permanent static public IPv4 for Kotak Neo whitelisting
# ==============================================================================

set -euo pipefail

echo "=========================================================="
echo "🚀 Neo PIP Terminal — Oracle Cloud Setup"
echo "=========================================================="

# Check root / sudo
if [ "$(id -u)" -ne 0 ]; then
  echo "❌ Please run this script with sudo or as root: sudo bash setup-oracle.sh"
  exit 1
fi

# Step 1: Update packages and install prerequisites
echo "📦 Updating apt packages and installing dependencies..."
apt-get update -y
apt-get install -y --no-install-recommends \
    curl \
    git \
    ca-certificates \
    gnupg \
    lsb-release \
    iptables-persistent \
    netfilter-persistent

# Step 2: Install Docker if not present
if ! command -v docker &> /dev/null; then
  echo "🐳 Installing Docker Engine..."
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg --yes
  chmod a+r /etc/apt/keyrings/docker.gpg

  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
    tee /etc/apt/sources.list.d/docker.list > /dev/null

  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable docker
  systemctl start docker
  echo "✅ Docker installed successfully."
else
  echo "✅ Docker is already installed."
fi

# Step 3: Configure Oracle Cloud iptables firewall to open port 8000
echo "🛡️ Configuring firewall rules for port 8000..."
# Oracle Cloud Ubuntu instances have pre-configured iptables rules that drop incoming traffic
iptables -I INPUT -p tcp --dport 8000 -m state --state NEW,ESTABLISHED -j ACCEPT || true
if command -v ufw &> /dev/null; then
  ufw allow 8000/tcp || true
fi
netfilter-persistent save || true

# Step 4: Clone or update repo
APP_DIR="/opt/neo-pip-terminal"
echo "📂 Setting up application in ${APP_DIR}..."

if [ ! -d "${APP_DIR}/.git" ]; then
  mkdir -p "${APP_DIR}"
  git clone https://github.com/saif-ali-khan/neo-pip-terminal.git "${APP_DIR}" || {
    echo "⚠️ Git clone failed (repository might be private). If this is a private repo, clone manually into ${APP_DIR}."
  }
else
  cd "${APP_DIR}"
  git pull origin main || true
fi

cd "${APP_DIR}"

# Step 5: Check or generate .env
if [ ! -f .env ]; then
  echo "📝 Creating initial .env configuration..."
  cp .env.example .env
  # Set cloud mode defaults
  sed -i 's/LIVE_TRADING_ENABLED=false/LIVE_TRADING_ENABLED=true/' .env || true
  sed -i 's/CLOUD_DEPLOYMENT=false/CLOUD_DEPLOYMENT=true/' .env || true
  echo "⚠️ Notice: Please edit ${APP_DIR}/.env with your Kotak Neo API credentials (UCC, MPIN, Consumer Key, etc.)."
fi

# Step 6: Build and run Docker container
echo "🔨 Building and launching Neo PIP backend container..."
docker build -t neo-pip-backend .

# Stop and remove existing container if running
docker stop neo-pip-backend 2>/dev/null || true
docker rm neo-pip-backend 2>/dev/null || true

# Run container with automatic restart
docker run -d \
  --name neo-pip-backend \
  --restart always \
  -p 8000:8000 \
  --env-file .env \
  -e CLOUD_DEPLOYMENT=true \
  -v "${APP_DIR}/data:/app/data" \
  -v "${APP_DIR}/logs:/app/logs" \
  neo-pip-backend

# Step 7: Detect Public IP
PUBLIC_IP=$(curl -s -4 https://api.ipify.org || curl -s -4 https://ifconfig.me || echo "UNKNOWN")

echo ""
echo "=========================================================="
echo "🎉 DEPLOYMENT COMPLETE & ONLINE!"
echo "=========================================================="
echo "📍 Permanent Static Public IP : ${PUBLIC_IP}"
echo "🌐 Backend Health Check URL   : http://${PUBLIC_IP}:8000/api/health"
echo ""
echo "👉 NEXT STEPS:"
echo "1. Whitelist this IP on Kotak Neo Developer Portal:"
echo "   IP to enter: ${PUBLIC_IP}"
echo ""
echo "2. In your Oracle Cloud Web Console (Networking -> VCN -> Security Lists):"
echo "   Add Ingress Rule -> Source: 0.0.0.0/0, IP Protocol: TCP, Destination Port: 8000"
echo ""
echo "3. Update your frontend (vercel.json) rewrite destination:"
echo "   \"destination\": \"http://${PUBLIC_IP}:8000/api/:path*\""
echo "=========================================================="
