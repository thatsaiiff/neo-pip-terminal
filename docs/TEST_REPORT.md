# Test Report — Neo PIP Trading and Options Research

**Scope:** local automated checks for the trading terminal, Indian options risk controls, and the options research workspace. No live order was submitted, and the test suite does not establish market profitability.

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
| Indian options algo / risk controls | PASS (automated tests) | Live feed, paper-session and live-order validation remain outstanding |
| Options research engine | PASS (automated tests) | Tests use controlled fixtures to verify software behavior, not actual market results |
| Research API, private sharing, scoped links, CSV/XLSX/PDF export | PASS (automated tests) | Public shared links are read-only; deployment and browser visual review remain outstanding |
| Live quote feed / trailing SL | software-managed path implemented | Not validated against a live account; stops depend on the local process and feed |

## Previously recorded baseline checks

- `pytest -q`: **19 passed**.
- `node --check app/static/app.js`: passed.
- `node --check extension/background.js`: passed.
- `node --check extension/content.js`: passed.
- `python -m compileall -q app tests`: passed.
- Chrome extension `manifest.json` JSON parse: passed.

**Not verified here:** visual/interactive browser and PiP testing. Chromium navigation to both loopback and local-file preview pages was blocked by the environment's browser policy. Also not verified against a live Kotak account, current Kotak Neo DOM, or real order API. These are explicitly outstanding steps, not passed tests.

## Current verification status

- The last recorded full suite before deployment-hardening edits: **100 passed**.
- The Vercel proxy/build and Oracle deployment script changes in version 0.2.1 have not been run through the full test suite yet.
- The Docker image has not been built on this workstation because Docker is unavailable. Rust wheel build previously succeeded for this Mac; Linux container build remains outstanding.
- Live market-data download, paper trading, live orders, and visual browser QA were not performed.
- Research fixtures are synthetic test inputs. They are not market backtest results.
