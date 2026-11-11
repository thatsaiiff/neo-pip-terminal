# Production Deployment & Operations Guide
**Project:** Kotak Neo PIP Trading Terminal  
**Target Environments:** Local Workstation (macOS / Linux / Windows) & Cloud Host (Oracle Cloud VM / Docker)

---

## 1. Local Development & Production Run

### Prerequisites
- Python 3.11+
- Chrome or Brave browser (supporting Document Picture-in-Picture)
- Kotak Neo API Developer Account (Consumer Key, Mobile, UCC)
- Upstox API Account (for real-time market data feed)

### Local Launch Steps
```bash
# 1. Clone repository & install dependencies
git clone https://github.com/thatsaiiff/neo-pip-terminal.git
cd neo-pip-terminal
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 2. Configure environment
cp .env.example .env
# Edit .env with your credentials

# 3. Launch terminal server
./run.sh
# Server starts on http://127.0.0.1:8000
```

---

## 2. Cloud VM & Docker Deployment (Oracle VM / Ubuntu)

### Docker Deployment
```bash
# Build production container
docker build -t neo-pip-backend .

# Run container with persistent data volume
docker run -d \
  --name neo-pip-backend \
  --restart always \
  -p 8000:8000 \
  --env-file .env \
  -v /opt/neo-pip-terminal/data:/app/data \
  -v /opt/neo-pip-terminal/logs:/app/logs \
  neo-pip-backend
```

### Static Frontend (Vercel)
The static frontend is configured via `vercel.json` and proxies `/api/*` to the cloud backend.
- Production URL: `https://neo-pip-terminal.vercel.app`
- Allowed Origins configured on backend: `https://neo-pip-terminal.vercel.app`

---

## 3. Operations & Runbook

### IP Whitelisting on Kotak Neo
1. Navigate to `http://127.0.0.1:8000/api/egress-ip` or the Terminal Account screen.
2. Copy the displayed egress IP.
3. Whitelist the exact IP in the Kotak Neo Developer Portal.
4. If your ISP assigns a dynamic IP, re-authenticate after network reconnection.

### Live Trading Activation Checklist
- [ ] Confirm `LIVE_TRADING_ENABLED=true` in `.env`.
- [ ] Re-authenticate Kotak Neo via TOTP and MPIN.
- [ ] Ensure terminal shows badge `[LIVE]`.
- [ ] Double-check lot sizes before confirming orders.
