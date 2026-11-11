# Automated Test Report
**Project:** Kotak Neo PIP Trading Terminal  
**Date:** November 11, 2026  
**Test Suite:** Pytest 8.4.2 with Python 3.14.2 & AnyIO  
**Status:** 100% Passed (76/76 Tests)

---

## 1. Test Execution Summary

```
============================= test session starts ==============================
platform darwin -- Python 3.14.2, pytest-8.4.2, pluggy-1.7.0
rootdir: /Users/saif/Downloads/PropDesk/neo-pip-terminal
plugins: anyio-4.15.1
collected 76 items

tests/test_api.py ...................................................... [ 71%]
......................                                                   [100%]
======================== 76 passed, 1 warning in 9.16s =========================
```

---

## 2. Test Coverage Categories

1. **Broker Connectivity & Health:**
   - `test_health`: API status and health check.
   - `test_egress_ip_endpoint`: Egress IP detection for whitelisting.
   - `test_owner_auth_and_session_status`: Admin authentication and session timeout validation.

2. **Order Lifecycle & Validation:**
   - `test_simulation_order_is_logged_and_qty_calculated`: Correct lot-to-quantity conversion.
   - `test_rejects_unconfirmed_order`: Enforces `user_confirmed: true`.
   - `test_limit_requires_price`: Rejects limit order with missing price.
   - `test_stop_market_requires_trigger`: Rejects stop market without trigger price.
   - `test_rejects_bad_side_and_invalid_lots`: Input validation bounds.
   - `test_rejects_concurrent_order_submission`: Thread-safe concurrency lock.
   - `test_order_with_ioc_validity`: IOC orders supported.
   - `test_live_broker_rejection_shows_errmsg_and_is_logged_locally`: Rejection parsing and logging.

3. **Position Accounting & Realized P&L:**
   - `test_accounting_fifo_lifecycle_and_closed_pnl`: Multi-lot FIFO matching and closed trade P&L.
   - `test_accounting_position_reversal`: Long-to-short and short-to-long position reversal.
   - `test_positions_calculates_closed_trade_pnl`: Closed trade matching.
   - `test_estimated_charges_with_outside_orders`: Statutory charges calculation.
   - `test_executions_and_pnl_summary_endpoints`: Execution history and trade metrics.

4. **Security, Headers & Rate Limiting:**
   - `test_audit_never_contains_sensitive_fields`: Sanitization of TOTP/MPIN/Passwords.
   - `test_extension_origin_can_only_use_symbol_bridge`: Chrome extension CORS restriction.
   - `test_untrusted_local_origin_is_rejected`: Origin validation.
   - `test_audit_hardening_rate_limiter_and_diagnostics`: Sliding-window rate limiter, security headers, and diagnostics telemetry.

5. **Market Data & Streaming:**
   - `test_upstox_v3_feed_decoder_and_realtime_sensex_quotes`: Binary protobuf V3 feed decoding.
   - `test_live_quotes_batch_dictionary_mapping`: Batch LTP mapping.
   - `test_sensex_option_candles_not_index_price`: Option contract candle isolation.
