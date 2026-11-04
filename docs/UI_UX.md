# UI/UX Specification — Neo PIP Trading Ticket

## 1. Design direction

A compact, low-noise, minimalist trading surface: warm off-white canvas, white cards, ink-black typography, thin neutral borders and sparing lime, green and red accents. Visual priority is symbol → side → quantity/order parameters → review. No charts, 3D embellishments, gradients or market-data theatre.

## 2. Layout

- **Top bar:** brand mark, mode badge, connection button and Pop out action.
- **Instrument card:** active symbol, exchange chip, source indicator, price-feed status and bridge hint.
- **Order ticket:** title, active BUY/SELL side, exchange/product/order-type fields, lots, unit size, conditional price fields, quantity summary, risk reminder and separate Review BUY / Review SELL buttons.
- **Activity:** recent local orders and their simulation/live status.
- **Review modal:** exact symbol, exchange, side, quantity arithmetic, product, order type, limit/trigger values, mode warning and required confirmation checkbox.
- **Connect modal:** TOTP and MPIN fields; no consumer key fields; secrets read from local `.env`.

## 3. Interaction rules

- Clicking BUY/SELL side selection changes active side; it does not submit.
- Review BUY/SELL opens a summary with no side effects.
- Confirm checkbox must be checked before the final submit is enabled.
- Simulated orders use a neutral mode badge. A broker-connected live order uses green `LIVE CONNECTED` badge and a live-specific confirmation warning.
- Quantity summary always displays `lots × units per lot = units` in review.
- Symbol source indicates `Manual`, `Manual override`, or `Linked`.
- Market price is labelled unavailable rather than inventing an LTP.
- Keyboard shortcut: Cmd/Ctrl + Enter reviews the selected side; Escape closes dialogs.

## 4. Responsive and floating behaviour

- Main page max width is 520 px.
- Intended PiP viewport is approximately 410 × 790 px.
- The PiP document uses a separate UI instance polling the same loopback API, so the main tab can be used for Kotak Neo concurrently.
- On browsers without Document Picture-in-Picture, a compact popup fallback opens; always-on-top is not guaranteed by this fallback.

## 5. Accessibility

- Semantic `button`, `select`, `input`, and `label` elements.
- ARIA labels on icon controls, status announcements through a live region, modal `role=dialog` and `aria-modal=true`.
- Keyboard focus styles, Escape to close dialogs, reduced-motion preference support.
- Inputs expose visible labels and use numeric input modes where appropriate.

## 6. Visual safety affordances

- Buy and sell are visually distinct and never use the same active treatment.
- Live status is separate from side direction.
- Warnings are visible before review and again before a live order.
- This interface does not represent price, margin availability or execution certainty unless verified from a source; v0.1 leaves price unavailable.
