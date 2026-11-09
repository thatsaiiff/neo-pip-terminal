// Neo PIP — Trade From Charts (Kotak Neo Dark Engine)
// Multi-Pane Lightweight Charts + Fast Sub-Second Quotes + Scalper Window + VPVR
(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  // Indicators State (TradingView Technicals)
  const indicators = {
    showEma9: true,
    showEma21: true,
    showVwap: true,
    showSupertrend: true,
    showVpvr: true,
    showVol: true,
    showBb: false,
    showEma50: false,
    showEma200: false,
  };

  let activeLayout = 3; // 1, 2, or 3
  let activePaneIdx = 0; // 0, 1, or 2

  // Pane configurations
  const panes = [
    {
      idx: 0,
      id: 'pane-1',
      sym: 'NIFTY',
      token: '',
      tf: '5m',
      isOption: false,
      candles: [],
      volumes: [],
      chart: null,
      candleSeries: null,
      volSeries: null,
      ema9Series: null,
      ema21Series: null,
      ema50Series: null,
      ema200Series: null,
      vwapSeries: null,
      supertrendSeries: null,
      bbUpperSeries: null,
      bbBasisSeries: null,
      bbLowerSeries: null,
      vpvrCanvas: null,
      vpvrCtx: null,
      vpvrData: { bins: [], pocPrice: null, maxVol: 0 },
      activeBar: null,
      lastLtp: null,
      prevClose: null,
    },
    {
      idx: 1,
      id: 'pane-2',
      sym: 'NIFTY26N0925000CE',
      token: '',
      tf: '3m',
      isOption: true,
      candles: [],
      volumes: [],
      chart: null,
      candleSeries: null,
      volSeries: null,
      ema9Series: null,
      ema21Series: null,
      ema50Series: null,
      ema200Series: null,
      vwapSeries: null,
      supertrendSeries: null,
      bbUpperSeries: null,
      bbBasisSeries: null,
      bbLowerSeries: null,
      vpvrCanvas: null,
      vpvrCtx: null,
      vpvrData: { bins: [], pocPrice: null, maxVol: 0 },
      activeBar: null,
      lastLtp: null,
      prevClose: null,
    },
    {
      idx: 2,
      id: 'pane-3',
      sym: 'NIFTY26N0925000PE',
      token: '',
      tf: '1m',
      isOption: true,
      candles: [],
      volumes: [],
      chart: null,
      candleSeries: null,
      volSeries: null,
      ema9Series: null,
      ema21Series: null,
      ema50Series: null,
      ema200Series: null,
      vwapSeries: null,
      supertrendSeries: null,
      bbUpperSeries: null,
      bbBasisSeries: null,
      bbLowerSeries: null,
      vpvrCanvas: null,
      vpvrCtx: null,
      vpvrData: { bins: [], pocPrice: null, maxVol: 0 },
      activeBar: null,
      lastLtp: null,
      prevClose: null,
    },
  ];

  // Read URL query params to initialize active symbol
  const urlParams = new URLSearchParams(window.location.search);
  const qSym = urlParams.get('symbol');
  const qTok = urlParams.get('token');
  const qTf = urlParams.get('interval');

  if (qSym) {
    const isOpt = /(CE|PE)$/i.test(qSym);
    if (isOpt) {
      panes[1].sym = qSym.toUpperCase();
      panes[1].token = qTok || '';
      if (qTf) panes[1].tf = qTf;
      activePaneIdx = 1;
    } else {
      panes[0].sym = qSym.toUpperCase();
      panes[0].token = qTok || '';
      if (qTf) panes[0].tf = qTf;
      activePaneIdx = 0;
    }
  }

  function toast(msg, duration = 3000) {
    const el = $('toast');
    const txt = $('toast-message');
    if (!el || !txt) return;
    txt.textContent = msg;
    el.classList.add('visible');
    setTimeout(() => el.classList.remove('visible'), duration);
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    return data;
  }

  // --- Technical Math (TradingView Indicators) ---
  function calculateEMA(candles, period) {
    if (!candles || candles.length < period) return [];
    const k = 2 / (period + 1);
    const result = [];
    let sum = 0;
    for (let i = 0; i < period; i++) sum += candles[i].close;
    let ema = sum / period;
    result.push({ time: candles[period - 1].time, value: Math.round(ema * 100) / 100 });
    for (let i = period; i < candles.length; i++) {
      ema = (candles[i].close - ema) * k + ema;
      result.push({ time: candles[i].time, value: Math.round(ema * 100) / 100 });
    }
    return result;
  }

  // Institutional Intraday VWAP (Volume Weighted Average Price)
  function calculateVWAP(candles) {
    if (!candles || !candles.length) return [];
    const result = [];
    let cumPV = 0;
    let cumVol = 0;
    let lastDay = '';

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const d = new Date(c.time * 1000);
      const dayStr = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (dayStr !== lastDay) {
        cumPV = 0;
        cumVol = 0;
        lastDay = dayStr;
      }
      const typPrice = (c.high + c.low + c.close) / 3;
      const vol = c.volume || 100;
      cumPV += typPrice * vol;
      cumVol += vol;
      const vwapVal = cumVol > 0 ? cumPV / cumVol : c.close;
      result.push({ time: c.time, value: Math.round(vwapVal * 100) / 100 });
    }
    return result;
  }

  // Supertrend (10, 3)
  function calculateSupertrend(candles, period = 10, multiplier = 3) {
    if (!candles || candles.length < period) return [];
    const tr = [candles[0].high - candles[0].low];
    for (let i = 1; i < candles.length; i++) {
      const h = candles[i].high;
      const l = candles[i].low;
      const prevC = candles[i - 1].close;
      tr.push(Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC)));
    }

    const atr = [];
    let sumTR = 0;
    for (let i = 0; i < period; i++) sumTR += tr[i];
    atr[period - 1] = sumTR / period;
    for (let i = period; i < candles.length; i++) {
      atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
    }

    const result = [];
    let prevUpper = 0;
    let prevLower = 0;
    let inUptrend = true;

    for (let i = period - 1; i < candles.length; i++) {
      const c = candles[i];
      const curATR = atr[i];
      const hl2 = (c.high + c.low) / 2;
      let basicUpper = hl2 + multiplier * curATR;
      let basicLower = hl2 - multiplier * curATR;

      let finalUpper = (basicUpper < prevUpper || (i > 0 && candles[i - 1].close > prevUpper)) ? basicUpper : prevUpper;
      let finalLower = (basicLower > prevLower || (i > 0 && candles[i - 1].close < prevLower)) ? basicLower : prevLower;

      if (inUptrend) {
        if (c.close < finalLower) inUptrend = false;
      } else {
        if (c.close > finalUpper) inUptrend = true;
      }

      const stVal = inUptrend ? finalLower : finalUpper;
      result.push({
        time: c.time,
        value: Math.round(stVal * 100) / 100,
        color: inUptrend ? '#10b981' : '#ef4444',
      });

      prevUpper = finalUpper;
      prevLower = finalLower;
    }
    return result;
  }

  // Bollinger Bands (20, 2)
  function calculateBollingerBands(candles, period = 20, mult = 2) {
    if (!candles || candles.length < period) return { upper: [], basis: [], lower: [] };
    const upper = [];
    const basis = [];
    const lower = [];

    for (let i = period - 1; i < candles.length; i++) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += candles[i - j].close;
      const sma = sum / period;
      let sumSq = 0;
      for (let j = 0; j < period; j++) sumSq += Math.pow(candles[i - j].close - sma, 2);
      const std = Math.sqrt(sumSq / period);

      const time = candles[i].time;
      basis.push({ time, value: Math.round(sma * 100) / 100 });
      upper.push({ time, value: Math.round((sma + mult * std) * 100) / 100 });
      lower.push({ time, value: Math.round((sma - mult * std) * 100) / 100 });
    }
    return { upper, basis, lower };
  }

  // --- VPVR Calculation & Rendering ---
  function computeVPVR(visibleCandles) {
    if (!visibleCandles || visibleCandles.length < 5) return { bins: [], pocPrice: null, maxVol: 0 };
    let minP = Infinity;
    let maxP = -Infinity;
    visibleCandles.forEach(c => {
      if (c.low < minP) minP = c.low;
      if (c.high > maxP) maxP = c.high;
    });
    if (minP >= maxP) return { bins: [], pocPrice: null, maxVol: 0 };

    const binCount = 32;
    const binSize = (maxP - minP) / binCount;
    const bins = Array.from({ length: binCount }, (_, i) => ({
      priceLow: minP + i * binSize,
      priceHigh: minP + (i + 1) * binSize,
      priceMid: minP + (i + 0.5) * binSize,
      buyVol: 0,
      sellVol: 0,
      totalVol: 0,
    }));

    visibleCandles.forEach(c => {
      const vol = c.volume || 100;
      const isBull = c.close >= c.open;
      const binIdx = Math.min(binCount - 1, Math.max(0, Math.floor((c.close - minP) / binSize)));
      if (isBull) bins[binIdx].buyVol += vol;
      else bins[binIdx].sellVol += vol;
      bins[binIdx].totalVol += vol;
    });

    let maxVol = 0;
    let pocPrice = null;
    bins.forEach(b => {
      if (b.totalVol > maxVol) {
        maxVol = b.totalVol;
        pocPrice = b.priceMid;
      }
    });

    return { bins, pocPrice, maxVol };
  }

  function drawPaneVPVR(pane) {
    if (!pane.vpvrCanvas || !pane.vpvrCtx || !pane.chart || !indicators.showVpvr) {
      if (pane.vpvrCtx && pane.vpvrCanvas) pane.vpvrCtx.clearRect(0, 0, pane.vpvrCanvas.width, pane.vpvrCanvas.height);
      return;
    }

    const { bins, pocPrice, maxVol } = pane.vpvrData;
    const ctx = pane.vpvrCtx;
    const w = pane.vpvrCanvas.width;
    ctx.clearRect(0, 0, w, pane.vpvrCanvas.height);
    if (!bins.length || maxVol <= 0) return;

    const maxBarW = w * 0.85;

    bins.forEach(b => {
      const yTop = pane.candleSeries.priceToCoordinate(b.priceHigh);
      const yBottom = pane.candleSeries.priceToCoordinate(b.priceLow);
      if (yTop == null || yBottom == null) return;

      const barH = Math.max(2, Math.abs(yBottom - yTop) - 1);
      const y = Math.min(yTop, yBottom);

      const buyW = (b.buyVol / maxVol) * maxBarW;
      const sellW = (b.sellVol / maxVol) * maxBarW;

      // Buy Volume (Soft Cyan/Teal)
      ctx.fillStyle = 'rgba(0, 188, 212, 0.45)';
      ctx.fillRect(w - buyW - sellW, y, buyW, barH);

      // Sell Volume (Soft Magenta/Red)
      ctx.fillStyle = 'rgba(233, 30, 99, 0.45)';
      ctx.fillRect(w - sellW, y, sellW, barH);
    });

    // Draw POC Line (Yellow Dashed)
    if (pocPrice != null) {
      const yPoc = pane.candleSeries.priceToCoordinate(pocPrice);
      if (yPoc != null) {
        ctx.strokeStyle = '#ffeb3b';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, yPoc);
        ctx.lineTo(w, yPoc);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#ffeb3b';
        ctx.font = 'bold 9px "DM Mono", monospace';
        ctx.fillText(`POC ${pocPrice.toFixed(2)}`, 6, yPoc - 4);
      }
    }
  }

  function recalculatePaneVPVR(pane) {
    if (!pane.chart || !pane.candles.length || !indicators.showVpvr) return;
    const range = pane.chart.timeScale().getVisibleLogicalRange();
    if (!range) return;

    const from = Math.max(0, Math.floor(range.from));
    const to = Math.min(pane.candles.length - 1, Math.ceil(range.to));
    const visible = pane.candles.slice(from, to + 1);

    pane.vpvrData = computeVPVR(visible);
    drawPaneVPVR(pane);
  }

  // --- Initialize a Single Chart Pane ---
  function initChartPane(pane) {
    const wrap = $(`p${pane.idx + 1}-canvas-wrap`);
    const container = $(`p${pane.idx + 1}-chart-container`);
    const vpvrEl = $(`p${pane.idx + 1}-vpvr-canvas`);
    if (!container || !window.LightweightCharts) return;

    if (vpvrEl) {
      pane.vpvrCanvas = vpvrEl;
      pane.vpvrCtx = vpvrEl.getContext('2d');
      vpvrEl.width = 160;
      vpvrEl.height = wrap.clientHeight || 300;
    }

    pane.chart = window.LightweightCharts.createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: { type: 'solid', color: '#131722' },
        textColor: '#94a3b8',
        fontFamily: "'DM Mono', monospace, -apple-system, sans-serif",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.04)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.04)' },
      },
      crosshair: {
        mode: window.LightweightCharts.CrosshairMode.Normal,
      },
      rightPriceScale: {
        borderColor: 'rgba(255, 255, 255, 0.08)',
        scaleMargins: { top: 0.06, bottom: 0.16 },
        autoScale: true,
      },
      timeScale: {
        borderColor: 'rgba(255, 255, 255, 0.08)',
        timeVisible: true,
        secondsVisible: false,
        visible: true,
        fixLeftEdge: false,
        fixRightEdge: false,
        rightOffset: 12,
        barSpacing: 9,
        minBarSpacing: 0.5,
      },
    });

    // 1. Candlestick Series (Kotak Neo colors: #089981 bull, #f23645 bear)
    pane.candleSeries = pane.chart.addCandlestickSeries({
      upColor: '#089981',
      downColor: '#f23645',
      borderVisible: false,
      wickUpColor: '#089981',
      wickDownColor: '#f23645',
    });

    // 2. Volume Series (Dedicated 'vol' scale confined to bottom 12% so it never overlaps candles)
    pane.volSeries = pane.chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
    });
    pane.chart.priceScale('vol').applyOptions({
      scaleMargins: {
        top: 0.88,
        bottom: 0,
      },
    });

    // 3. EMA 9 (Blue)
    pane.ema9Series = pane.chart.addLineSeries({
      color: '#2962ff',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'EMA 9',
    });

    // 4. EMA 21 (Orange)
    pane.ema21Series = pane.chart.addLineSeries({
      color: '#ff9800',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'EMA 21',
    });

    // 5. VWAP (Cyan)
    pane.vwapSeries = pane.chart.addLineSeries({
      color: '#06b6d4',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'VWAP',
    });

    // 6. Supertrend (Green / Red Trend Line)
    pane.supertrendSeries = pane.chart.addLineSeries({
      color: '#10b981',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'Supertrend',
    });

    // 7. EMA 50 (Purple)
    pane.ema50Series = pane.chart.addLineSeries({
      color: '#a855f7',
      lineWidth: 1.5,
      priceLineVisible: false,
      title: 'EMA 50',
    });

    // 8. EMA 200 (Yellow)
    pane.ema200Series = pane.chart.addLineSeries({
      color: '#eab308',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'EMA 200',
    });

    // 9. Bollinger Bands (Upper, Basis, Lower)
    pane.bbUpperSeries = pane.chart.addLineSeries({
      color: '#38bdf8',
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      title: 'BB Upper',
    });
    pane.bbBasisSeries = pane.chart.addLineSeries({
      color: '#94a3b8',
      lineWidth: 1,
      priceLineVisible: false,
      title: 'BB Basis',
    });
    pane.bbLowerSeries = pane.chart.addLineSeries({
      color: '#38bdf8',
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      title: 'BB Lower',
    });

    // Crosshair info sync
    pane.chart.subscribeCrosshairMove(param => {
      if (!param || !param.time || !param.seriesData) return;
      const c = param.seriesData.get(pane.candleSeries);
      if (c) {
        const idPrefix = `p${pane.idx + 1}`;
        if ($(idPrefix + '-o')) $(idPrefix + '-o').textContent = Number(c.open).toFixed(2);
        if ($(idPrefix + '-h')) $(idPrefix + '-h').textContent = Number(c.high).toFixed(2);
        if ($(idPrefix + '-l')) $(idPrefix + '-l').textContent = Number(c.low).toFixed(2);
        if ($(idPrefix + '-c')) $(idPrefix + '-c').textContent = Number(c.close).toFixed(2);
      }
    });

    // Range subscriber for real-time VPVR
    pane.chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      recalculatePaneVPVR(pane);
    });

    // Click pane to select it
    const paneEl = $(pane.id);
    if (paneEl) {
      paneEl.addEventListener('click', () => {
        setActivePane(pane.idx);
      });
    }
  }

  function setActivePane(idx) {
    activePaneIdx = idx;
    panes.forEach((p, i) => {
      const el = $(p.id);
      if (el) el.classList.toggle('active', i === idx);
    });

    const activePane = panes[idx];
    if (activePane) {
      // Sync topbar search & timeframe
      const searchIn = $('symbol-search-input');
      if (searchIn) searchIn.value = activePane.sym;

      document.querySelectorAll('.tf-pill').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tf === activePane.tf);
      });

      // Sync floating scalper window to this contract
      updateScalperContract(activePane);
    }
  }

  function applyPaneIndicators(pane) {
    if (!pane.chart || !pane.candles || !pane.candles.length) return;

    // 1. Volume Series
    const isIndex = !pane.isOption && /^(NIFTY|BANKNIFTY|FINNIFTY|SENSEX|MIDCPNIFTY)/i.test(pane.sym);
    if (pane.volSeries) {
      pane.volSeries.setData((indicators.showVol && !isIndex) ? pane.volumes : []);
    }

    // 2. EMA 9 & 21
    if (pane.ema9Series) {
      const ema9 = calculateEMA(pane.candles, 9);
      pane.ema9Series.setData(indicators.showEma9 ? ema9 : []);
    }
    if (pane.ema21Series) {
      const ema21 = calculateEMA(pane.candles, 21);
      pane.ema21Series.setData(indicators.showEma21 ? ema21 : []);
    }

    // 3. VWAP
    if (pane.vwapSeries) {
      const vwap = calculateVWAP(pane.candles);
      pane.vwapSeries.setData(indicators.showVwap ? vwap : []);
    }

    // 4. Supertrend (10, 3)
    if (pane.supertrendSeries) {
      const st = calculateSupertrend(pane.candles, 10, 3);
      pane.supertrendSeries.setData(indicators.showSupertrend ? st : []);
    }

    // 5. EMA 50 & 200
    if (pane.ema50Series) {
      const ema50 = calculateEMA(pane.candles, 50);
      pane.ema50Series.setData(indicators.showEma50 ? ema50 : []);
    }
    if (pane.ema200Series) {
      const ema200 = calculateEMA(pane.candles, 200);
      pane.ema200Series.setData(indicators.showEma200 ? ema200 : []);
    }

    // 6. Bollinger Bands (20, 2)
    if (pane.bbUpperSeries && pane.bbBasisSeries && pane.bbLowerSeries) {
      if (indicators.showBb) {
        const bb = calculateBollingerBands(pane.candles, 20, 2);
        pane.bbUpperSeries.setData(bb.upper);
        pane.bbBasisSeries.setData(bb.basis);
        pane.bbLowerSeries.setData(bb.lower);
      } else {
        pane.bbUpperSeries.setData([]);
        pane.bbBasisSeries.setData([]);
        pane.bbLowerSeries.setData([]);
      }
    }

    // 7. VPVR
    recalculatePaneVPVR(pane);
  }

  // --- Load Candles for a Pane ---
  async function loadPaneData(pane) {
    const ltpEl = $(`p${pane.idx + 1}-ltp`);
    const chgEl = $(`p${pane.idx + 1}-chg`);
    const symEl = $(`p${pane.idx + 1}-sym`);
    const tfEl = $(`p${pane.idx + 1}-tf`);

    if (symEl) symEl.textContent = pane.sym;
    if (tfEl) tfEl.textContent = pane.tf;

    try {
      const url = `/api/chart/candles?symbol=${encodeURIComponent(pane.sym)}&token=${encodeURIComponent(pane.token)}&interval=${encodeURIComponent(pane.tf)}`;
      const data = await api(url);

      if (!data.candles || !data.candles.length) return;

      pane.isOption = !!data.is_option;
      pane.prevClose = data.prev_close || (data.candles[0]?.open || data.candles[0]?.close);
      pane.lastLtp = data.ltp || (data.candles[data.candles.length - 1]?.close);

      pane.candles = data.candles.map(c => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume || 100,
      }));

      pane.volumes = data.candles.map(c => ({
        time: c.time,
        value: c.volume || 0,
        color: c.close >= c.open ? 'rgba(8, 153, 129, 0.4)' : 'rgba(242, 54, 69, 0.4)',
      }));

      pane.candleSeries.setData(pane.candles);

      // Fit content and restore spacious right margin
      pane.chart.timeScale().applyOptions({
        rightOffset: 12,
        barSpacing: 9,
        minBarSpacing: 0.5,
      });

      const last = pane.candles[pane.candles.length - 1];
      if (last) {
        pane.activeBar = { ...last };
      }

      applyPaneIndicators(pane);
      updatePaneQuote(pane, pane.lastLtp, pane.prevClose, data.change, data.change_percent);
    } catch (err) {
      console.warn(`Load pane ${pane.idx} error:`, err);
    }
  }

  function updatePaneQuote(pane, ltp, refPrice, changePts, changePct) {
    const ltpEl = $(`p${pane.idx + 1}-ltp`);
    const chgEl = $(`p${pane.idx + 1}-chg`);
    if (!ltpEl) return;

    const oldLtp = pane.lastLtp;
    pane.lastLtp = ltp;

    ltpEl.textContent = `₹${Number(ltp).toFixed(2)}`;

    // Subtle tick flash animation
    if (oldLtp != null && ltp !== oldLtp) {
      ltpEl.classList.remove('flash-up', 'flash-down');
      void ltpEl.offsetWidth; // trigger reflow
      ltpEl.classList.add(ltp > oldLtp ? 'flash-up' : 'flash-down');
      setTimeout(() => ltpEl.classList.remove('flash-up', 'flash-down'), 400);
    }

    const base = refPrice || pane.prevClose || ltp;
    const diff = (changePts != null && !isNaN(changePts)) ? changePts : (ltp - base);
    const pct = (changePct != null && !isNaN(changePct)) ? changePct : (base > 0 ? (diff / base) * 100 : 0);

    if (chgEl) {
      const isPos = diff >= 0;
      chgEl.className = `pane-chg ${isPos ? 'pos' : 'neg'}`;
      chgEl.textContent = `${isPos ? '+' : ''}${diff.toFixed(2)} (${isPos ? '+' : ''}${pct.toFixed(2)}%)`;
    }

    // Sync to scalper window if this pane is currently active
    if (pane.idx === activePaneIdx) {
      const scLtp = $('sc-ltp');
      const scChg = $('sc-chg');
      if (scLtp) scLtp.textContent = Number(ltp).toFixed(2);
      if (scChg) {
        const isPos = diff >= 0;
        scChg.className = `sc-chg ${isPos ? 'pos' : 'neg'}`;
        scChg.textContent = `${isPos ? '▲ +' : '▼ '}${diff.toFixed(2)} (${pct.toFixed(2)}%)`;
      }
    }
  }

  // --- Real-Time Market Data Engine (Ultra-Low Latency WebSocket + 350ms Fallback Polling) ---
  let openPositions = [];
  let allPositions = [];
  let quoteWs = null;
  let wsConnected = false;

  function handleTick(q) {
    if (!q || !q.symbol || !q.ltp) return;
    const pane = panes.find(p => p.sym === q.symbol);
    if (!pane || !pane.candleSeries) return;

    const ltp = q.ltp;
    pane.lastLtp = ltp;
    if (q.prev_close) pane.prevClose = q.prev_close;

    const nowSec = Math.floor(Date.now() / 1000);
    const tfSec = pane.tf === '15s' ? 15 : (pane.tf === '1m' ? 60 : (pane.tf === '3m' ? 180 : (pane.tf === '5m' ? 300 : (pane.tf === '15m' ? 900 : (pane.tf === '1h' ? 3600 : (pane.tf === '1d' ? 86400 : 5))))));
    const bucketTime = Math.floor(nowSec / tfSec) * tfSec;

    if (!pane.activeBar || bucketTime > pane.activeBar.time) {
      pane.activeBar = {
        time: bucketTime,
        open: ltp,
        high: ltp,
        low: ltp,
        close: ltp,
        volume: 10,
      };
    } else {
      pane.activeBar.high = Math.max(pane.activeBar.high, ltp);
      pane.activeBar.low = Math.min(pane.activeBar.low, ltp);
      pane.activeBar.close = ltp;
      pane.activeBar.volume += 10;
    }

    try {
      pane.candleSeries.update(pane.activeBar);
    } catch (_) {}

    updatePaneQuote(pane, ltp, pane.prevClose, q.change, q.change_percent);

    // If this symbol has an open position, dynamically update running P&L with every tick
    const matchPos = openPositions.find(p => p.symbol === q.symbol);
    if (matchPos && pane.idx === activePaneIdx) {
      const livePnl = (ltp - matchPos.avg_price) * matchPos.quantity;
      const posPnl = $('sc-pos-pnl');
      const scalperPnlEl = $('val-scalper-pnl');
      const isPos = livePnl >= 0;
      if (posPnl) {
        posPnl.className = `sc-pnl-pill ${isPos ? 'pos' : 'neg'}`;
        posPnl.textContent = `P&L: ${isPos ? '+' : ''}₹${livePnl.toFixed(2)}`;
      }
      if (scalperPnlEl) {
        scalperPnlEl.className = `pnl-num ${isPos ? 'pos' : 'neg'}`;
        scalperPnlEl.textContent = `${isPos ? '+' : ''}₹${livePnl.toFixed(2)}`;
      }
    }
  }

  function getWsEndpoint() {
    const loc = window.location;
    if (loc.hostname === 'localhost' || loc.hostname === '127.0.0.1') {
      return `ws://${loc.hostname}:8000/api/ws/quotes`;
    }
    if (loc.hostname === '92.4.87.82') {
      return `ws://92.4.87.82:8000/api/ws/quotes`;
    }
    // Remote or Vercel
    return `ws://92.4.87.82:8000/api/ws/quotes`;
  }

  function initWebSocket() {
    try {
      const wsUrl = getWsEndpoint();
      quoteWs = new WebSocket(wsUrl);

      quoteWs.onopen = () => {
        wsConnected = true;
        syncWebSocketSubscriptions();
      };

      quoteWs.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'ticks' && Array.isArray(msg.quotes)) {
            msg.quotes.forEach(handleTick);
          }
        } catch (_) {}
      };

      quoteWs.onclose = () => {
        wsConnected = false;
        setTimeout(initWebSocket, 3000);
      };

      quoteWs.onerror = () => {
        wsConnected = false;
        try { quoteWs.close(); } catch (_) {}
      };
    } catch (_) {
      wsConnected = false;
    }
  }

  function syncWebSocketSubscriptions() {
    if (!quoteWs || quoteWs.readyState !== WebSocket.OPEN) return;
    const visiblePanes = activeLayout === 1 ? [panes[0]] : (activeLayout === 2 ? [panes[0], panes[1]] : panes);
    const syms = visiblePanes.map(p => p.sym).filter(Boolean);
    quoteWs.send(JSON.stringify({ action: 'subscribe', symbols: syms }));
  }

  // Fallback high-frequency polling when WS is offline
  function startRealtimeTickLoop() {
    initWebSocket();

    setInterval(async () => {
      if (wsConnected) return; // WebSocket is handling sub-30ms ticks
      const visiblePanes = activeLayout === 1 ? [panes[0]] : (activeLayout === 2 ? [panes[0], panes[1]] : panes);
      const items = visiblePanes.map(p => ({ symbol: p.sym, token: p.token }));

      try {
        const data = await api('/api/chart/live-quotes', {
          method: 'POST',
          body: JSON.stringify({ items }),
        });

        if (data.quotes && Array.isArray(data.quotes)) {
          data.quotes.forEach(handleTick);
        }
      } catch (_) {}
    }, 350);

    // Indices Ticker & Position P&L update every 2.0 seconds
    setInterval(async () => {
      try {
        const idxData = await api('/api/indices/quotes');
        if (idxData.indices && Array.isArray(idxData.indices)) {
          idxData.indices.forEach(idx => {
            const elId = `ticker-${idx.name.toLowerCase().replace(/[^a-z]/g, '')}`;
            const el = $(elId);
            if (el) {
              const ltpEl = el.querySelector('.t-ltp');
              const chgEl = el.querySelector('.t-chg');
              if (ltpEl) ltpEl.textContent = Number(idx.ltp).toLocaleString('en-IN', { minimumFractionDigits: 2 });
              if (chgEl) {
                const isPos = idx.change >= 0;
                chgEl.className = `t-chg ${isPos ? 'pos' : 'neg'}`;
                chgEl.textContent = `${isPos ? '+' : ''}${idx.change_percent.toFixed(2)}%`;
              }
            }
          });
        }

        await updatePositionsReport();
      } catch (_) {}
    }, 2000);
  }

  // --- Real-time Positions, Charges, & Scalper Position Sync ---
  async function updatePositionsReport() {
    try {
      const posData = await api('/api/positions?tab=open');
      allPositions = posData.positions || [];
      openPositions = allPositions.filter(p => Math.abs(p.quantity || 0) > 0);

      // 1. POSITIONS P&L (Gross MTM + Realized)
      const grossPnl = posData.total_today_pnl != null ? posData.total_today_pnl : (posData.total_pnl || 0);
      const posPnlEl = $('val-pos-pnl');
      if (posPnlEl) {
        const isPos = grossPnl >= 0;
        posPnlEl.className = `pnl-num ${isPos ? 'pos' : 'neg'}`;
        posPnlEl.textContent = `${isPos ? '+' : ''}₹${grossPnl.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      }

      // 2. NET P&L (After Charges)
      const netPnl = posData.total_net_pnl != null ? posData.total_net_pnl : (posData.net_pnl || grossPnl);
      const netPnlEl = $('val-net-pnl');
      if (netPnlEl) {
        const isPos = netPnl >= 0;
        netPnlEl.className = `pnl-num ${isPos ? 'pos' : 'neg'}`;
        netPnlEl.textContent = `${isPos ? '+' : ''}₹${netPnl.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      }

      // 3. Open Positions Alert Pill in Header
      const alertBtn = $('open-positions-alert');
      const alertText = $('open-pos-alert-text');
      if (alertBtn && alertText) {
        if (openPositions.length > 0) {
          alertBtn.classList.remove('hidden');
          alertText.textContent = `${openPositions.length} Open Position${openPositions.length > 1 ? 's' : ''}`;
        } else {
          alertBtn.classList.add('hidden');
        }
      }

      // 4. Sync Scalper Position
      syncScalperPosition();
    } catch (err) {
      console.warn('Failed to update positions:', err);
    }
  }

  function syncScalperPosition() {
    const activePane = panes[activePaneIdx];
    const activeSym = activePane?.sym;
    const matchPos = openPositions.find(p => p.symbol === activeSym);

    const posSection = $('sc-position-section');
    const posBadge = $('sc-pos-badge');
    const posSum = $('sc-pos-summary');
    const posPnl = $('sc-pos-pnl');
    const scalperPnlEl = $('val-scalper-pnl');

    if (matchPos && Math.abs(matchPos.quantity || 0) > 0) {
      if (posSection) posSection.classList.remove('hidden');
      if (posBadge) {
        posBadge.textContent = `${matchPos.quantity > 0 ? 'LONG' : 'SHORT'} ${Math.abs(matchPos.quantity)} Qty`;
        posBadge.style.color = matchPos.quantity > 0 ? '#34d399' : '#f87171';
      }
      const lotSize = matchPos.lot_size || (activePane.isOption ? 65 : 1);
      const lots = Math.max(1, Math.round(Math.abs(matchPos.quantity) / lotSize));
      if (posSum) {
        posSum.textContent = `Position: ${Math.abs(matchPos.quantity)} units (${lots} Lot) @ Avg ₹${Number(matchPos.avg_price || 0).toFixed(2)}`;
      }
      const ltp = activePane.lastLtp || matchPos.ltp || matchPos.avg_price;
      const runningPnl = (ltp - matchPos.avg_price) * matchPos.quantity;
      if (posPnl) {
        const isPos = runningPnl >= 0;
        posPnl.className = `sc-pnl-pill ${isPos ? 'pos' : 'neg'}`;
        posPnl.textContent = `P&L: ${isPos ? '+' : ''}₹${runningPnl.toFixed(2)}`;
      }
      if (scalperPnlEl) {
        const isPos = runningPnl >= 0;
        scalperPnlEl.className = `pnl-num ${isPos ? 'pos' : 'neg'}`;
        scalperPnlEl.textContent = `${isPos ? '+' : ''}₹${runningPnl.toFixed(2)}`;
      }
    } else {
      if (scalperPnlEl) {
        scalperPnlEl.className = 'pnl-num';
        scalperPnlEl.textContent = '₹0.00';
      }
      if (posBadge) {
        posBadge.textContent = 'No Position';
        posBadge.style.color = 'var(--text-muted)';
      }

      if (openPositions.length > 0) {
        if (posSection) posSection.classList.remove('hidden');
        if (posSum) {
          posSum.textContent = `${openPositions.length} other position(s) active in account`;
        }
        if (posPnl) {
          posPnl.className = 'sc-pnl-pill';
          posPnl.textContent = 'Click Alert to View';
        }
      } else {
        if (posSection) posSection.classList.add('hidden');
      }
    }
  }

  // --- Scalper Form & Window Controls ---
  function updateScalperContract(pane) {
    const title = $('sc-contract-title');
    if (title) title.textContent = pane.sym;
    const ltpEl = $('sc-ltp');
    if (ltpEl && pane.lastLtp) ltpEl.textContent = Number(pane.lastLtp).toFixed(2);
    syncScalperPosition();
  }

  function setupScalperDrag() {
    const box = $('floating-scalper');
    const handle = $('scalper-drag-handle');
    if (!box || !handle) return;

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let initLeft = 0;
    let initTop = 0;

    handle.addEventListener('mousedown', e => {
      if (e.target.tagName === 'BUTTON') return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = box.getBoundingClientRect();
      initLeft = rect.left;
      initTop = rect.top;
      box.style.bottom = 'auto';
      box.style.right = 'auto';
      box.style.left = `${initLeft}px`;
      box.style.top = `${initTop}px`;
    });

    window.addEventListener('mousemove', e => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      box.style.left = `${Math.max(10, Math.min(window.innerWidth - box.offsetWidth - 10, initLeft + dx))}px`;
      box.style.top = `${Math.max(40, Math.min(window.innerHeight - box.offsetHeight - 10, initTop + dy))}px`;
    });

    window.addEventListener('mouseup', () => { isDragging = false; });

    // Close button
    const closeBtn = $('scalper-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', () => box.classList.add('hidden'));

    // Toggle button in toolbar
    const toggleBtn = $('scalper-mode-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        box.classList.toggle('hidden');
        toggleBtn.classList.toggle('active', !box.classList.contains('hidden'));
      });
    }

    // Header Open Positions Alert Pill: Click to switch to most losing position!
    $('open-positions-alert')?.addEventListener('click', () => {
      if (!openPositions || !openPositions.length) return;

      // Sort ascending by P&L (worst losing / lowest P&L position first)
      const sorted = [...openPositions].sort((a, b) => (a.pnl || 0) - (b.pnl || 0));
      const target = sorted[0];

      const pane = panes[activePaneIdx];
      pane.sym = target.symbol;
      pane.token = target.token || '';
      pane.isOption = /(CE|PE)$/i.test(target.symbol);
      loadPaneData(pane);
      updateScalperContract(pane);
      syncWebSocketSubscriptions();

      const searchIn = $('symbol-search-input');
      if (searchIn) searchIn.value = target.symbol;

      if (openPositions.length === 1) {
        toast(`📍 Switched to active position: ${target.symbol} (P&L: ${target.pnl >= 0 ? '+' : ''}₹${Number(target.pnl || 0).toFixed(2)})`, 3500);
      } else {
        const others = openPositions.length - 1;
        toast(`⚠️ Priority: Opened lowest P&L position ${target.symbol} (${target.pnl >= 0 ? '+' : ''}₹${Number(target.pnl || 0).toFixed(2)}). ${others} other open position${others > 1 ? 's' : ''} running — manage or click Exit All!`, 5500);
      }
    });

    // Lots Stepper
    const lotInput = $('sc-lots');
    $('lot-up')?.addEventListener('click', () => {
      if (lotInput) lotInput.value = Math.min(200, parseInt(lotInput.value || '1', 10) + 1);
    });
    $('lot-down')?.addEventListener('click', () => {
      if (lotInput) lotInput.value = Math.max(1, parseInt(lotInput.value || '1', 10) - 1);
    });

    // Buy & Sell execution
    const executeOrder = async (side) => {
      const pane = panes[activePaneIdx];
      const lots = parseInt(lotInput?.value || '1', 10);
      try {
        await api('/api/orders', {
          method: 'POST',
          body: JSON.stringify({
            symbol: pane.sym,
            exchange_segment: pane.isOption ? 'nse_fo' : 'nse_cm',
            product: 'MIS',
            side: side,
            lots: lots,
            lot_size: pane.isOption ? 65 : 1,
            order_type: 'MKT',
            price: 0,
            trigger_price: 0,
            validity: 'DAY',
          }),
        });
        toast(`⚡ Dispatched ${side} ${lots} lot(s) for ${pane.sym}`, 3000);
        setTimeout(updatePositionsReport, 600);
      } catch (err) {
        toast(`Order Failed: ${err.message}`, 4000);
      }
    };

    $('sc-buy-btn')?.addEventListener('click', () => executeOrder('BUY'));
    $('sc-sell-btn')?.addEventListener('click', () => executeOrder('SELL'));
    $('tb-quick-buy')?.addEventListener('click', () => executeOrder('BUY'));
    $('tb-quick-sell')?.addEventListener('click', () => executeOrder('SELL'));

    // Quick Action 1: Trail SL to Cost
    $('sc-trail-cost-btn')?.addEventListener('click', async () => {
      const pane = panes[activePaneIdx];
      const matchPos = openPositions.find(p => p.symbol === pane.sym) || openPositions[0];
      const sym = matchPos ? matchPos.symbol : pane.sym;
      try {
        const res = await api('/api/positions/trail-to-cost', {
          method: 'POST',
          body: JSON.stringify({ symbol: sym }),
        });
        toast(res.message || `🛡️ SL Trailed to Cost Price for ${sym}!`, 3500);
      } catch (err) {
        toast(`Trail SL Failed: ${err.message}`, 4000);
      }
    });

    // Quick Action 2: Exit 50%
    $('sc-exit-50-btn')?.addEventListener('click', async () => {
      const pane = panes[activePaneIdx];
      const matchPos = openPositions.find(p => p.symbol === pane.sym) || openPositions[0];
      const sym = matchPos ? matchPos.symbol : pane.sym;
      try {
        const res = await api('/api/positions/exit-partial', {
          method: 'POST',
          body: JSON.stringify({ symbol: sym, percentage: 50 }),
        });
        toast(res.message || `½ Closed 50% Position for ${sym}!`, 3500);
        setTimeout(updatePositionsReport, 600);
      } catch (err) {
        toast(`Exit 50% Failed: ${err.message}`, 4000);
      }
    });

    // Quick Action 3: Exit All
    $('sc-exit-all-btn')?.addEventListener('click', async () => {
      try {
        const res = await api('/api/positions/exit-all', { method: 'POST' });
        toast(`🚨 Emergency Exit Complete: ${res.closed_positions || 0} positions closed!`, 4000);
        setTimeout(updatePositionsReport, 600);
      } catch (err) {
        toast(`Exit All Failed: ${err.message}`, 4000);
      }
    });

    // Quick Action 3: Exit All
    $('sc-exit-all-btn')?.addEventListener('click', async () => {
      try {
        const res = await api('/api/positions/exit-all', { method: 'POST' });
        toast(`🚨 Emergency Exit Complete: ${res.closed_positions || 0} positions closed!`, 4000);
      } catch (err) {
        toast(`Exit All Failed: ${err.message}`, 4000);
      }
    });
  }

  // --- Smart Search with Autocomplete Dropdown ---
  function setupSearch() {
    const input = $('symbol-search-input');
    const dropdown = $('search-dropdown');
    if (!input || !dropdown) return;

    let debounceTimer = null;

    input.addEventListener('input', () => {
      const q = input.value.trim();
      clearTimeout(debounceTimer);
      if (!q) {
        dropdown.classList.add('hidden');
        return;
      }

      debounceTimer = setTimeout(async () => {
        try {
          const res = await api(`/api/chart/search?q=${encodeURIComponent(q)}`);
          if (res.results && res.results.length) {
            renderSearchDropdown(res.results);
          } else {
            dropdown.innerHTML = `<div class="search-item"><span class="item-name">No matches for "${q}"</span></div>`;
            dropdown.classList.remove('hidden');
          }
        } catch (_) {}
      }, 150);
    });

    function renderSearchDropdown(items) {
      dropdown.innerHTML = items.map(item => `
        <div class="search-item" data-sym="${item.symbol}" data-token="${item.token || ''}">
          <div class="item-left">
            <span class="item-sym">${item.symbol}</span>
            <span class="item-name">${item.name || ''}</span>
          </div>
          <span class="item-badge ${item.type.toLowerCase().includes('ce') ? 'ce' : (item.type.toLowerCase().includes('pe') ? 'pe' : 'index')}">${item.type}</span>
        </div>
      `).join('');

      dropdown.classList.remove('hidden');

      dropdown.querySelectorAll('.search-item').forEach(el => {
        el.addEventListener('click', () => {
          const sym = el.dataset.sym;
          const tok = el.dataset.token;
          if (sym) {
            const pane = panes[activePaneIdx];
            pane.sym = sym;
            pane.token = tok;
            pane.isOption = /(CE|PE)$/i.test(sym);
            loadPaneData(pane);
            updateScalperContract(pane);
            syncWebSocketSubscriptions();
            input.value = sym;
            dropdown.classList.add('hidden');
          }
        });
      });
    }

    // Hide dropdown on click outside
    document.addEventListener('click', e => {
      if (!e.target.closest('#search-wrap')) {
        dropdown.classList.add('hidden');
      }
    });
  }

  // --- Layout Selector & Event Handlers ---
  function setupLayoutSelector() {
    const btn = $('layout-toggle-btn');
    const dropdown = $('layout-dropdown');
    const stage = $('chart-stage');
    const label = $('current-layout-label');

    btn?.addEventListener('click', () => dropdown?.classList.toggle('hidden'));

    dropdown?.querySelectorAll('.layout-opt').forEach(opt => {
      opt.addEventListener('click', () => {
        dropdown.querySelectorAll('.layout-opt').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        const l = parseInt(opt.dataset.layout, 10);
        activeLayout = l;
        dropdown.classList.add('hidden');

        stage.className = `chart-stage layout-${l}`;
        if (label) {
          label.textContent = l === 1 ? '1 CHART' : (l === 2 ? '2 CHARTS' : '3 CHARTS');
        }
        syncWebSocketSubscriptions();

        // Trigger resize on visible charts
        setTimeout(handleResize, 100);
      });
    });

    document.addEventListener('click', e => {
      if (!e.target.closest('.layout-selector-wrap')) {
        dropdown?.classList.add('hidden');
      }
    });
  }

  // --- Timeframe Buttons ---
  function setupTimeframeButtons() {
    document.querySelectorAll('.tf-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tf-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tf = btn.dataset.tf;
        const pane = panes[activePaneIdx];
        if (pane) {
          pane.tf = tf;
          loadPaneData(pane);
        }
      });
    });
  }

  // --- TradingView Technical Indicators Dropdown Menu ---
  function setupIndicatorsMenu() {
    const btn = $('btn-indicators-dropdown');
    const menu = $('indicators-menu');
    if (!btn || !menu) return;

    btn.addEventListener('click', e => {
      e.stopPropagation();
      menu.classList.toggle('hidden');
    });

    document.addEventListener('click', e => {
      if (!e.target.closest('.indicators-wrap')) {
        menu.classList.add('hidden');
      }
    });

    const bindChk = (id, key) => {
      const el = $(id);
      if (!el) return;
      el.checked = !!indicators[key];
      el.addEventListener('change', () => {
        indicators[key] = el.checked;
        panes.forEach(p => applyPaneIndicators(p));
      });
    };

    bindChk('chk-ind-ema9', 'showEma9');
    bindChk('chk-ind-ema21', 'showEma21');
    bindChk('chk-ind-vwap', 'showVwap');
    bindChk('chk-ind-supertrend', 'showSupertrend');
    bindChk('chk-ind-vpvr', 'showVpvr');
    bindChk('chk-ind-vol', 'showVol');
    bindChk('chk-ind-bb', 'showBb');
    bindChk('chk-ind-ema50', 'showEma50');
    bindChk('chk-ind-ema200', 'showEma200');
  }

  // --- Real-time Option Chain Modal (Matches Upstox TV) ---
  let activeOcUnderlying = 'NIFTY';
  let activeOcExpiry = '';

  function setupOptionChainModal() {
    const btn = $('btn-option-chain');
    const modal = $('option-chain-modal');
    const closeBtn = $('close-oc-modal');
    const expirySelect = $('oc-expiry-select');
    const tableBody = $('oc-table-body');
    const spotBadge = $('oc-spot-badge');

    if (!btn || !modal) return;

    btn.addEventListener('click', () => {
      const curSym = panes[activePaneIdx].sym.toUpperCase();
      if (curSym.includes('BANK')) activeOcUnderlying = 'BANKNIFTY';
      else if (curSym.includes('FIN')) activeOcUnderlying = 'FINNIFTY';
      else if (curSym.includes('SENSEX')) activeOcUnderlying = 'SENSEX';
      else activeOcUnderlying = 'NIFTY';

      modal.classList.remove('hidden');
      updateOcUnderlyingButtons();
      loadOptionChainData();
    });

    closeBtn?.addEventListener('click', () => modal.classList.add('hidden'));

    // Underlying tabs
    modal.querySelectorAll('.oc-und-btn').forEach(b => {
      b.addEventListener('click', () => {
        activeOcUnderlying = b.dataset.und;
        activeOcExpiry = '';
        updateOcUnderlyingButtons();
        loadOptionChainData();
      });
    });

    expirySelect?.addEventListener('change', () => {
      activeOcExpiry = expirySelect.value;
      loadOptionChainData();
    });

    function updateOcUnderlyingButtons() {
      modal.querySelectorAll('.oc-und-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.und === activeOcUnderlying);
      });
    }

    async function loadOptionChainData() {
      if (tableBody) tableBody.innerHTML = '<tr><td colspan="7" class="oc-loading">Fetching real-time option chain…</td></tr>';
      try {
        const query = `/api/chart/option-chain?symbol=${activeOcUnderlying}${activeOcExpiry ? `&expiry=${activeOcExpiry}` : ''}`;
        const data = await api(query);

        if (!data.ok || !data.rows || !data.rows.length) {
          if (tableBody) tableBody.innerHTML = '<tr><td colspan="7" class="oc-loading">No option strikes available for this expiry.</td></tr>';
          return;
        }

        if (spotBadge) {
          spotBadge.textContent = `Spot: ₹${Number(data.spot_price).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
        }

        // Populate expiries dropdown if not populated or underlying changed
        if (expirySelect && data.expiries && data.expiries.length) {
          expirySelect.innerHTML = data.expiries.map(e => `<option value="${e}" ${e === data.selected_expiry ? 'selected' : ''}>${e}</option>`).join('');
          activeOcExpiry = data.selected_expiry;
        }

        // Render strikes table
        renderOptionChainTable(data.rows, data.spot_price);
      } catch (err) {
        if (tableBody) tableBody.innerHTML = `<tr class="oc-loading"><td colspan="7">Failed to load chain: ${err.message}</td></tr>`;
      }
    }

    function renderOptionChainTable(rows, spotPrice) {
      if (!tableBody) return;
      tableBody.innerHTML = rows.map(r => {
        const isATM = Math.abs(r.strike - spotPrice) <= 50;
        const callITM = r.strike < spotPrice;
        const putITM = r.strike > spotPrice;

        const c = r.call || {};
        const p = r.put || {};

        return `
          <tr class="${isATM ? 'atm-row' : ''}">
            <td class="col-oi ${callITM ? 'call-itm' : ''}">${c.oi ? c.oi.toLocaleString() : '—'}</td>
            <td class="col-vol ${callITM ? 'call-itm' : ''}">${c.volume ? c.volume.toLocaleString() : '—'}</td>
            <td class="col-ltp ${callITM ? 'call-itm' : ''}">
              <button type="button" class="oc-ltp-btn call" data-sym="${c.symbol}" data-key="${c.instrument_key}" data-ltp="${c.ltp}">
                ₹${Number(c.ltp || 0).toFixed(2)}
              </button>
            </td>
            <td class="cell-strike">${Number(r.strike).toFixed(0)}</td>
            <td class="col-ltp ${putITM ? 'put-itm' : ''}">
              <button type="button" class="oc-ltp-btn put" data-sym="${p.symbol}" data-key="${p.instrument_key}" data-ltp="${p.ltp}">
                ₹${Number(p.ltp || 0).toFixed(2)}
              </button>
            </td>
            <td class="col-vol ${putITM ? 'put-itm' : ''}">${p.volume ? p.volume.toLocaleString() : '—'}</td>
            <td class="col-oi ${putITM ? 'put-itm' : ''}">${p.oi ? p.oi.toLocaleString() : '—'}</td>
          </tr>
        `;
      }).join('');

      tableBody.querySelectorAll('.oc-ltp-btn').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const sym = btn.dataset.sym;
          const key = btn.dataset.key;
          const ltp = btn.dataset.ltp;
          if (!sym || !key) return;

          const pane = panes[activePaneIdx];
          pane.sym = sym;
          pane.token = key;
          pane.isOption = true;

          const searchIn = $('symbol-search-input');
          if (searchIn) searchIn.value = sym;

          loadPaneData(pane);
          updateScalperContract(pane);
          syncWebSocketSubscriptions();

          modal.classList.add('hidden');
          toast(`⚡ Loaded ${sym} (₹${ltp}) on chart!`, 3500);
        });
      });
    }
  }

  // --- Window Resize Handler ---
  function handleResize() {
    panes.forEach(pane => {
      const container = $(`p${pane.idx + 1}-chart-container`);
      if (pane.chart && container) {
        pane.chart.applyOptions({
          width: container.clientWidth,
          height: container.clientHeight,
        });
      }
      if (pane.vpvrCanvas && container) {
        pane.vpvrCanvas.width = 160;
        pane.vpvrCanvas.height = container.clientHeight;
        drawPaneVPVR(pane);
      }
    });
  }

  // --- Upstox Token Dialog ---
  function setupTokenModal() {
    const tokenBtn = $('chart-token-btn');
    const modal = $('token-modal');
    const closeBtn = $('close-token-modal');
    const saveBtn = $('save-token-submit');

    tokenBtn?.addEventListener('click', async () => {
      modal?.classList.remove('hidden');
      const pill = $('token-status-pill');
      try {
        const res = await api('/api/chart/upstox-status');
        if (pill) {
          pill.textContent = res.token_configured ? `Active (${res.token_preview})` : 'Not Configured (Free Historical Active)';
          pill.style.color = res.token_configured ? '#34d399' : '#94a3b8';
        }
      } catch (_) {}
    });

    closeBtn?.addEventListener('click', () => modal?.classList.add('hidden'));

    saveBtn?.addEventListener('click', async () => {
      const val = $('upstox-token-val')?.value.trim() || '';
      try {
        const res = await api('/api/chart/upstox-token', {
          method: 'POST',
          body: JSON.stringify({ token: val }),
        });
        toast(res.message || 'Upstox Token Saved!', 3000);
        modal?.classList.add('hidden');
        panes.forEach(p => loadPaneData(p));
      } catch (err) {
        toast(`Error: ${err.message}`, 4000);
      }
    });
  }

  // --- Initial Boot ---
  window.addEventListener('DOMContentLoaded', () => {
    panes.forEach(pane => {
      initChartPane(pane);
    });

    setupLayoutSelector();
    setupTimeframeButtons();
    setupIndicatorsMenu();
    setupOptionChainModal();
    setupSearch();
    setupScalperDrag();
    setupTokenModal();

    window.addEventListener('resize', handleResize);

    // Initial Data Fetch for all panes
    panes.forEach(pane => {
      loadPaneData(pane);
    });

    setActivePane(activePaneIdx);

    // Start fast real-time tick loop
    startRealtimeTickLoop();
  });
})();
