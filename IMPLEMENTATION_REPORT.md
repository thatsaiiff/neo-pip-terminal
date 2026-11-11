# Implementation Report: Production Audit & Hardening
**Project:** Kotak Neo PIP Trading Terminal  
**Date:** November 11, 2026  
**Status:** Completed & Verified

---

## 1. Summary of Implemented Changes

### 1.1 Database Concurrency, Foreign Keys & Indexes
- **WAL Mode & Foreign Keys:** Configured `PRAGMA journal_mode = WAL;` and `PRAGMA foreign_keys = ON;` in `db()` connection factory to prevent reader-writer locking bottlenecks and enforce referential integrity.
- **Index Migration Added:**
  - `idx_orders_account`: `orders(account_id, id DESC)`
  - `idx_orders_broker_id`: `orders(broker_order_id)` for high-speed reconciliation lookup.
  - `idx_orders_status`: `orders(status)` for quick status querying.
  - `idx_sltp_account_status`: `sltp_rules(account_id, status)`
  - `idx_users_username`: `users(username)`
  - `idx_executions_acc_inst`: `executions(account_id, instrument_key)`
  - `idx_position_matches_pos`: `position_matches(position_id)`
  - `idx_charges_exec`: `charges(execution_id)`

### 1.2 Security & Rate Limiting Hardening
- **Sliding-Window Rate Limiter:** Implemented `check_rate_limit(key, max_calls, window_seconds)` in `app/main.py`. Attached protection to:
  - `/api/auth/signin`: 12 calls/minute per IP
  - `/api/auth/login`: 6 Kotak TOTP/MPIN attempts/minute per IP
- **CORS Allowlist:** Eliminated unsafe wildcard reflection (`origin or "*"`). Replaced with strict allowlist (`neo-pip-terminal.vercel.app`, `localhost:8000`, `127.0.0.1:8000`, `localhost:3000`, and `ALLOWED_ORIGINS`).
- **Defensive Headers:** Attached `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: SAMEORIGIN` (allowing Document PiP windows while preventing foreign clickjacking), and `X-Request-ID` correlation IDs on all responses.

### 1.3 Order State Machine & Failure Safeguards
- **Ambiguous Timeout Persistence:** In `sdk_order()`, when network transport exceptions occur during mutating order placement, the order is now recorded immediately in SQLite with status `UNKNOWN` and message `"Broker call failed or outcome is uncertain..."`.
- **Zero Automatic Retries:** Enforced rule prohibiting automatic retries on ambiguous live orders. Reconcile via `/api/reconciliation/sync`.

### 1.4 Observability & Diagnostics
- **Endpoint Added:** `/api/admin/diagnostics` exposing live system uptime, Python runtime, Upstox V3 WebSocket subscriptions, stale subscription count, Kotak session IP verification, and SQLite database record counts.
- **Quote Staleness Detection:** Enforced a 15-second freshness check on `/api/chart/live-quote` during active Indian market hours, annotating quote responses with `"is_stale": true|false`.

---

## 2. Test Verification Evidence
- **Automated Pytest Suite:** 76/76 unit and integration tests passing (`tests/test_api.py`).
- **JavaScript Syntax Check:** Node v23 `-c` passed with 0 syntax errors across `chart.js`, `app.js`, `chart-indicators.js`, and `chart-drawings.js`.
