# Security Audit Report
**Project:** Kotak Neo PIP Trading Terminal  
**Audit Date:** November 11, 2026  
**Security Classification:** Highly Sensitive / Financial Trading Application  
**Standard:** OWASP Top 10, ASVS Level 2, Indian Fintech Data Security Practices

---

## 1. Executive Summary
A comprehensive security review of the Kotak Neo PIP Trading Terminal codebase was performed across authentication, session management, web vulnerabilities, secrets management, and network exposure.

### Key Strengths:
1. **Paper Trading Default:** Live execution requires explicit toggle (`LIVE_TRADING_ENABLED=true`), explicit confirmation flag (`user_confirmed=True`), and valid Kotak session.
2. **Secrets Redaction:** The `audit()` event logging explicitly filters out sensitive parameters (`totp`, `mpin`, `consumer_key`, `password`, `token`).
3. **Double Submission Protection:** Order execution employs an in-process thread lock (`order_submit_lock.acquire(blocking=False)`) preventing double-click submissions.

### Critical & High Vulnerabilities Identified:
1. **[CRITICAL] Hardcoded Admin Password Fallback:** Default credentials (`ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "S@if7246")`) in source code.
2. **[HIGH] Lack of Rate Limiting / Brute-Force Protection:** No rate limiting or account lockout mechanism on sensitive authentication endpoints (`/api/auth/signin`, `/api/auth/login-admin`, `/api/auth/login`, `/api/auth/verify-otp`).
3. **[HIGH] CORS Allow-All Reflection:** When `CLOUD_DEPLOYMENT` is active, the CORS middleware reflects `request.headers.get("origin") or "*"` without strict origin validation allowlists.
4. **[HIGH] Hardcoded OWNER_PIN Fallback:** `OWNER_PIN = os.getenv("OWNER_PIN", "2026")` allows default PIN entry if environment variable is not supplied.
5. **[MEDIUM] Missing Security Headers on Dynamic Responses:** Security headers like CSP and HSTS are partially configured in Vercel, but direct backend responses from FastAPI lack complete defensive headers.

---

## 2. Vulnerability Findings & Risk Matrix

| Finding ID | Title | Severity | CVSS v3.1 | Status |
|---|---|---|---|---|
| **SEC-01** | Hardcoded Admin Password & Default PIN Fallback | **CRITICAL** | 8.8 | Remediation Required |
| **SEC-02** | Absence of Login Rate Limiting / Brute-Force Lockout | **HIGH** | 7.5 | Remediation Required |
| **SEC-03** | Overly Permissive CORS Origin Reflection | **HIGH** | 7.2 | Remediation Required |
| **SEC-04** | Security Headers & CSP Omission on Direct API Server | **MEDIUM** | 5.3 | Remediation Required |
| **SEC-05** | Storage of Raw Tokens in Browser LocalStorage | **MEDIUM** | 4.8 | Documented / Best Practice Hardening |
| **SEC-06** | Dependency Vulnerability Footprint (Python & JS) | **LOW** | 3.7 | Addressed |

---

## 3. Detailed Vulnerability Analyses

### SEC-01: Hardcoded Admin Password & Default PIN Fallback
- **File & Line:** `app/main.py:101-105`
- **Root Cause:**
  ```python
  ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "S@if7246")
  OWNER_PIN = os.getenv("OWNER_PIN", "2026").strip()
  ```
- **Risk:** Anyone inspecting the repository or de-compiling the package gains admin authentication access if env variables are omitted.
- **Remediation:** Remove hardcoded credential literals. Require `ADMIN_PASSWORD` in `.env`. If absent, generate a cryptographically secure random ephemeral password at server startup, log it once to stdout, and instruct the user to configure `.env`.

### SEC-02: Absence of Rate Limiting & Account Lockout
- **File & Line:** `app/main.py:2183-2280` (`/api/auth/login`, `/api/auth/signin`, `/api/auth/login-admin`)
- **Root Cause:** Endpoints verify credentials using `secrets.compare_digest`, but an attacker can submit thousands of attempts per minute without trigger delays or IP lockouts.
- **Risk:** High exposure to credential stuffing and TOTP/MPIN brute-force exhaustion.
- **Remediation:** Introduce an in-memory sliding-window rate limiter and consecutive-failure lockout table (e.g., max 5 failed attempts per 15-minute window per IP/user identifier).

### SEC-03: Permissive CORS Origin Reflection
- **File & Line:** `app/main.py:180-210`
- **Root Cause:**
  ```python
  cors_headers = {
      "Access-Control-Allow-Origin": origin or "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Bridge-Token",
      "Access-Control-Allow-Credentials": "true",
  }
  ```
- **Risk:** A malicious site visited by the user in the same browser could make authenticated cross-origin requests to the local/cloud terminal if origins are mirrored dynamically.
- **Remediation:** Restrict CORS origins strictly to:
  - `https://neo-pip-terminal.vercel.app`
  - `http://127.0.0.1:8000` / `http://localhost:8000`
  - `http://127.0.0.1:3000` / `http://localhost:3000`
  - User-configured custom domains via `ALLOWED_ORIGINS` env.

### SEC-04: Direct API Security Headers
- **File & Line:** `app/main.py` middleware
- **Root Cause:** Direct API queries bypass Vercel headers if connected to Oracle directly.
- **Remediation:** Add mandatory security response headers:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: SAMEORIGIN` (to permit Document PiP iframe contexts while blocking foreign framing)
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy: geolocation=(), microphone=(), camera=()`

---

## 4. Verification & Testing Plan
- Test suite verifying failed attempts trigger HTTP 429 Too Many Requests.
- Test suite verifying untrusted CORS origins receive no `Access-Control-Allow-Origin` header.
- Test suite verifying absent `ADMIN_PASSWORD` forces safe startup with no static credentials.
