# System Architecture — Neo PIP Trading Ticket

## 1. Component diagram

```text
┌────────────────────────────────────┐        ┌───────────────────────────┐
│ Kotak Neo browser tab              │        │ Neo PIP UI                 │
│ ┌────────────────────────────────┐ │        │ main tab OR Chrome Doc PiP │
│ │ MV3 content script             │ │        │ HTML/CSS/vanilla JS        │
│ │ symbol candidates + Capture UI │ │        └─────────────┬─────────────┘
│ └───────────────┬────────────────┘ │                      │ HTTP
└─────────────────┼──────────────────┘                      ▼
                  │ chrome.runtime msg        ┌───────────────────────────┐
                  ▼                           │ FastAPI on 127.0.0.1:8000 │
┌────────────────────────────────────┐        │ validation + safety gates │
│ MV3 service worker                 │───────▶│ bridge + orders + audit   │
│ X-Bridge-Token header              │        └───────┬───────────┬───────┘
└────────────────────────────────────┘                │           │
                                                       ▼           ▼
                                               ┌────────────┐ ┌────────────┐
                                               │ SQLite DB  │ │ Kotak Neo  │
                                               │ order/audit│ │ Python SDK │
                                               └────────────┘ └────────────┘
```

## 2. Trust boundaries

- Browser content script runs on configured Kotak domains and reads visible DOM candidate text only. It does not read browser cookies or broker session storage.
- Extension service worker can call the explicitly permitted loopback bridge endpoint. Bridge requests require `X-Bridge-Token`.
- UI is served from the loopback FastAPI process. The process rejects non-local host/origin requests and is not intended for remote exposure.
- Broker credentials and SDK session live in the Python backend process, not JavaScript.
- SQLite stores orders/audit data but no consumer key, MPIN, TOTP or session token.

## 3. Core runtime flows

### Symbol flow

The content script examines selected-looking DOM attributes, page title, and ticker patterns. A strong match can auto-send after repeated detection; weaker matches require user Capture. The service worker posts to `/api/bridge/symbol`; the backend checks the bridge token, segment, symbol format, and confidence before replacing current selection. The UI polls status and updates the current ticket. The bridge is heuristic, not proof that the string is a broker-valid order symbol.

### Order flow

The UI creates an order snapshot, renders review details and requires explicit checkbox confirmation. The API schema validates quantity, segments, product, order types and required prices. Simulation writes a simulated record only. Live mode additionally requires `LIVE_TRADING_ENABLED=true` and an authenticated SDK session, then makes one SDK call. A transport error is treated as potentially ambiguous; it is never auto-replayed.

### Authentication flow

Consumer key, mobile and UCC are loaded from local `.env`. TOTP and MPIN are submitted to the local backend from the connect dialog. The SDK performs TOTP login and MPIN validation; the backend keeps the SDK client in process memory. On logout, the SDK logout method is called best-effort and the session reference is cleared.

## 4. State ownership

- **Frontend transient state:** active side, unsubmitted form fields, pending review snapshot, PiP window state.
- **Backend transient state:** authenticated SDK client, current selected symbol, session state.
- **Persistent state:** order records and audit events in SQLite.
- **Extension transient state:** current candidate, repeated detection count, last symbol sent.

## 5. Failure modes

| Failure | Expected response |
|---|---|
| Backend unavailable | UI marks service offline; no order call can occur |
| Bridge token invalid | HTTP 401; UI remains on existing symbol |
| Candidate is uncertain | Manual Capture or typed symbol; user must verify |
| Invalid order parameters | HTTP 422 before broker call |
| Live gate off | Simulation records only; auth route rejects live login |
| Session invalid | Broker SDK error; no order success is claimed |
| Mutating call times out | No retry; instruct reconciliation with broker order book |
| PiP unsupported | Ordinary popup fallback; no always-on-top claim |

## 6. Deployment stance

Single-user desktop-only local deployment. Do not deploy this service to a public IP, reverse proxy, tunnel, shared machine or hosted cloud without a separate security architecture, authentication, CSRF strategy and broker policy review.
