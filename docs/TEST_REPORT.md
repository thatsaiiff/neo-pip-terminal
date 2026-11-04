# Test Report — Neo PIP Trading Ticket

**Scope:** local build verification only. No user account or live broker environment was accessed.

## Test layers

| Layer | Tests | Status |
|---|---|---|
| API health and startup | health route; SQLite table initialisation | PASS |
| Order simulation | order log creation; lots × lot size arithmetic; no broker order ID; irrelevant hidden price values discarded | PASS |
| Broker rejection handling | `emsg`/`errMsg` parsing; error code surfaced; rejected attempt saved locally but not represented as a Kotak order | PASS |
| Order validation | explicit confirmation; bad side; bad lots; missing limit price; missing trigger price; concurrency lock | PASS |
| Bridge | token required; valid token accepted; low confidence/invalid segment rejected | PASS |
| Security behaviour | live authentication blocked when gate is disabled; sensitive audit fields filtered; external Host and untrusted Origin rejected; extension Origin limited to bridge route | PASS |
| Live Kotak account integration | not run | Requires user's credentials/account consent; must be tested by the operator |
| PiP browser integration | not automated in this environment | Verify manually in target Chrome build |
| Kotak DOM symbol extraction | not validated against user's current live page | Heuristic; requires manual validation/tuning |
| Live quote feed / trailing SL | not implemented | Out of release scope |

## Executed local checks

- `pytest -q`: **19 passed**.
- `node --check app/static/app.js`: passed.
- `node --check extension/background.js`: passed.
- `node --check extension/content.js`: passed.
- `python -m compileall -q app tests`: passed.
- Chrome extension `manifest.json` JSON parse: passed.

**Not verified here:** visual/interactive browser and PiP testing. Chromium navigation to both loopback and local-file preview pages was blocked by the environment's browser policy. Also not verified against a live Kotak account, current Kotak Neo DOM, or real order API. These are explicitly outstanding steps, not passed tests.
