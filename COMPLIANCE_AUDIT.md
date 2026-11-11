# Indian Compliance, Regulatory & Privacy Audit
**Project:** Kotak Neo PIP Trading Terminal  
**Date:** November 11, 2026  
**Regulatory Focus:** Digital Personal Data Protection Act (DPDP), 2023 / Rules 2025; SEBI Broker API Guidelines; RBI Payment & Digital Lending Norms.

---

## 1. Regulatory Context & Scope Assessment

| Domain | Governing Authority / Statute | Applicability Assessment |
|---|---|---|
| **Data Protection** | DPDP Act, 2023 & DPDP Rules 2025 | **Directly Applicable**: Processing of personal data (email, name, phone, user identifiers). |
| **Broker Trading APIs** | SEBI (Stock Brokers) Regulations, Kotak Neo Developer Terms | **Directly Applicable**: Use of personal retail broker API credentials, order automation, and market data display. |
| **Payment Gateways** | RBI PA/PG Guidelines & e-Mandates | **Not Applicable**: The terminal does **not** process fiat payments, deposit collection, credit cards, or UPI subscriptions. Paper funds are strictly simulated. |
| **Financial Advice** | SEBI (Investment Advisers) Regulations, 2013 | **Safeguarded**: The terminal provides charting tools and technical indicators (EMA, VPVR) with **no** financial advice, tip generation, or automated copy-trading claims. |

---

## 2. Personal Data Inventory (DPDP Compliance)

| Data Category | Specific Fields | Legal Basis & Purpose | Storage Location | Retention Period | Third-Party Sharing |
|---|---|---|---|---|---|
| **Identity Data** | Username, Full Name | Account identification for local trading ticket | SQLite (`users` table) | Duration of account lifecycle | None (local server only) |
| **Contact Data** | Email Address, Mobile Number | Account verification OTP, Kotak Neo login | SQLite (`users`, `email_otps`) | OTPs expire in 10 minutes | Kotak Neo SDK during login |
| **Financial Auth** | TOTP, MPIN, UCC | Kotak Neo session establishment | Ephemeral in-memory only (Never stored in DB) | Discarded after auth | Kotak Neo Authentication API |
| **Trading Logs** | Orders, Executions, Charges, P&L | Financial transaction history, audit trails | SQLite (`orders`, `executions`) | Required for tax and trade accounting | Kotak Neo broker |

---

## 3. SEBI & Broker Market Data Regulatory Analysis

### 3.1 Personal Broker API vs. Redistribution
- **SEBI Position:** Retail broker APIs (such as Kotak Neo API) are authorized solely for the personal use of the registered individual demat/trading account holder.
- **Redistribution Prohibition:** Market data received from Kotak Neo or Upstox must **not** be redistributed commercially or displayed publicly to unauthorized third parties.
- **Current System Compliance:**
  - Multi-user authentication exists for the paper-trading terminal.
  - Live execution and real-time Kotak broker connectivity is **strictly restricted to the Admin (Operator)** (`is_admin=True` and `account_id="KOTAK_OWNER"`).
  - Public users only receive simulated paper execution and isolated local ledgers.

### 3.2 Automated & Algorithmic Trading Rules
- **Regulation:** Orders placed automatically without human intervention may trigger SEBI algorithmic trading guidelines (SEBI Circular on Algorithmic Trading).
- **Terminal Design:** The PIP terminal is primarily an **execution assist tool** (one-click scalping, manual drag-to-modify stop-loss/take-profit, manual review confirmation).
- **Safety Gate:** Live trading enforces `user_confirmed: true` on order submission, ensuring discretionary human-in-the-loop control.

---

## 4. Dark Patterns & User Protection Review (Consumer Protection Act)

1. **Clear Trading Mode Indicator:**
   - The UI displays an explicit badge: `[LIVE]` vs `[PAPER]`.
   - Live orders are blocked if `LIVE_TRADING_ENABLED` is false, accompanied by a prominent warning banner.
2. **No Forced Actions or Misleading Defaults:**
   - Paper trading is default for all sessions.
   - Live mode requires deliberate environment configuration and admin re-authentication with TOTP & MPIN.
3. **Execution Transparency:**
   - Order review tickets clearly display: Symbol, Lots, Lot Size, Total Quantity, Order Type, Limit Price, Trigger Price, and Est. Value before confirmation.

---

## 5. Professional Legal Review Questions
For formal commercial deployment, the operator should review the following with an Indian securities and technology lawyer:
1. *Does providing multi-user paper trading with real-time delayed index feeds trigger any SEBI platform registration requirements?*
2. *Under DPDP Rules 2025, what explicit consent notice language is required for retail operators hosting single-tenant VPS instances?*
3. *Do Kotak Neo developer terms permit Document Picture-in-Picture window wrappers for order execution?*
