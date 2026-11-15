#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v python3 >/dev/null 2>&1; then echo "Python 3 is required (3.10+)." >&2; exit 1; fi
if [ ! -d .venv ]; then python3 -m venv .venv; fi
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
if command -v rustc >/dev/null 2>&1 && command -v cargo >/dev/null 2>&1; then
  if ! command -v maturin >/dev/null 2>&1; then
    python -m pip install 'maturin>=1.8,<2.0' || true
  fi
  if command -v maturin >/dev/null 2>&1 && maturin develop --manifest-path rust/neo_execution/Cargo.toml --locked; then
    echo "Rust execution module is ready."
  else
    echo "Rust module build failed. Paper and research modes remain available; live Kotak order mutations are disabled."
  fi
else
  echo "Rust toolchain not found. Paper and research modes remain available; live Kotak order mutations are disabled. Install Rust, then run maturin develop --manifest-path rust/neo_execution/Cargo.toml."
fi
if [ ! -f .env ]; then cp .env.example .env; echo "Created .env from .env.example. Review it before connecting Kotak Neo."; fi
mkdir -p data
echo "Neo PIP local service: http://127.0.0.1:8000"
echo "Press Ctrl+C to stop. Live trading is disabled by default."
LAN_ACCESS_ENABLED_VALUE=$(python -c "from dotenv import dotenv_values; print(str(dotenv_values('.env').get('LAN_ACCESS_ENABLED', 'false')).lower())")
if [ "$LAN_ACCESS_ENABLED_VALUE" = "true" ]; then
  LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
  if [ -n "$LAN_IP" ]; then echo "Phone address on this Wi-Fi: http://$LAN_IP:8000"; fi
  echo "LAN access is enabled. Enter LAN_ACCESS_TOKEN from .env when prompted on the phone."
  echo "Keep this on a trusted private Wi-Fi network; disable LAN_ACCESS_ENABLED when finished."
  python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
else
  python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
fi
