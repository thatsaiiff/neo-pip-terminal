# TradingView Advanced Charts (Charting Library) Integration Guide
**Project**: Kotak Neo PIP Trading Terminal  
**Comparing**: TradingView Advanced Charts vs Lightweight Charts with Upstox Datafeed

---

## 1. Why Did We Start with Lightweight Charts?

1. **Lightweight Charts is TradingView's Official Open-Source Engine**:
   - It is created and maintained by the exact same team at TradingView.
   - It is 100% open-source (Apache 2.0 license) with zero restrictions, zero licensing forms, and zero legal review needed.
   - It renders directly on HTML5 Canvas at an ultra-smooth 60–120 FPS with virtually zero CPU overhead, making it ideal for mobile devices and multi-pane (1-chart, 2-chart split, 3-chart) layouts.

2. **What is TradingView Advanced Charts (Formerly Technical Analysis Charts / Charting Library)?**
   - This is the full desktop/mobile widget used by brokers like **Dhan, Zerodha (Kite), and TradingView.com**.
   - It includes the complete left drawing toolbar, top interval selector, indicators modal with 100+ indicators, Scales & Lines popup, and Pine Script editor.
   - **Licensing Constraint**: TradingView Advanced Charts is **NOT available on public npm or GitHub**. TradingView requires every company/developer to apply for a free commercial license at:  
     👉 [https://www.tradingview.com/advanced-charts/](https://www.tradingview.com/advanced-charts/)
   - Once your GitHub username is approved by TradingView, they grant access to their private repository (`tradingview/charting_library`). You then download the static `charting_library` folder and place it in your web server.

---

## 2. Upstox Datafeed Adapter (`UpstoxTVDatafeed`)

We have already implemented the complete TradingView Datafeed adapter in:
[`app/static/tradingview-datafeed.js`](file:///Users/saif/Downloads/PropDesk/neo-pip-terminal/app/static/tradingview-datafeed.js)

This adapter implements TradingView's official JS API specifications:
- `onReady`: Exposes resolutions (`1`, `3`, `5`, `15`, `30`, `60`, `D`), exchanges (NSE, BSE, MCX, FOREX).
- `searchSymbols`: Calls our Upstox instrument search.
- `resolveSymbol`: Formats Indian strikes, 0.05 tick size (`minmov: 5, pricescale: 100`), market session (`0915-1530`), and timezone (`Asia/Kolkata`).
- `getBars`: Fetches historical candles from `/api/candles?symbol=...&interval=...`.
- `subscribeBars` / `unsubscribeBars`: Streams live ticks directly from our Upstox WebSocket feed.

### How to Enable TradingView Advanced Charts Immediately:
When you obtain the `charting_library` zip/folder from TradingView:
1. Extract it into `app/static/charting_library/`.
2. Initialize the widget with our Upstox datafeed:
   ```javascript
   const tvWidget = new TradingView.widget({
     symbol: 'NSE:NIFTY',
     interval: '1',
     container: 'tv_chart_container',
     datafeed: new UpstoxTVDatafeed(''),
     library_path: '/static/charting_library/',
     locale: 'en',
     disabled_features: ['use_localstorage_for_settings'],
     enabled_features: ['study_templates'],
     theme: 'Dark',
     auto_save_delay: 5,
   });
   ```

---

## 3. Improvements Applied to Current Terminal Charts

To match the Dhan/TradingView screenshots you shared right now:
1. **Initial 60 Bars Fit**:
   - The chart automatically zooms and frames exactly **60 bars** of the active timeframe with 4 bars of breathing room on the right.
   - It no longer squashes hundreds of historical candles into needles.
2. **Volume Candles**:
   - Volume histogram is now enabled by default (`showVol: true`).
   - Renders at the bottom 20% of the chart with semi-transparent green/red bars matching price action and a live volume badge on the price scale.
3. **Strict 0.05 Tick Size Enforced**:
   - All Indian F&O order prices, limit prices, trigger prices, SL, and TP snap strictly to legal 0.05 multiples.
4. **Live Top Bid/Ask & Depth**:
   - Bid and ask buttons display genuine top order book prices from Upstox/Kotak rather than simulated estimates.
