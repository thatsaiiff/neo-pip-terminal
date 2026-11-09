// Neo PIP — Exness WebTrading Engine
// Multi-Pane Lightweight Charts + Exness Layout + Order Form + Live Quotes + Option Chain
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

  // Auth & Session State
  let ownerToken = localStorage.getItem('neo_owner_token') || '';
  let isOwner = false;
  let lastUserActivity = Date.now();
  let inactivityTimerInterval = null;
  const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  // Active Layout: 1 (Full), 2 (Dual Split), 3 (3-Charts)
  let activeLayout = 1;
  let activePaneIdx = 0;

  // Order Ticket State
  let selectedProduct = 'NRML'; // Default NRML (Carry Forward) as requested
  let selectedOrderType = 'MKT'; // MKT, L, SL
  let selectedLots = 1;

  // Open Symbol Tabs
  let openTabs = [
    { symbol: 'NIFTY 25000 CE', token: 'NSE_FO|40037', interval: '1m', isOption: true },
    { symbol: 'NIFTY 25000 PE', token: 'NSE_FO|40038', interval: '1m', isOption: true },
    { symbol: 'NIFTY', token: 'NSE_INDEX|Nifty 50', interval: '5m', isOption: false },
    { symbol: 'BANKNIFTY', token: 'NSE_INDEX|Nifty Bank', interval: '5m', isOption: false },
  ];
  let activeTabIndex = 0;

  // Watchlist Favorites & Category lists
  const WATCHLIST_PRESETS = {
    favorites: [
      { symbol: 'NIFTY 25000 CE', name: 'Nifty 50 25000 Call', token: 'NSE_FO|40037', signal: 'BUY' },
      { symbol: 'NIFTY 25000 PE', name: 'Nifty 50 25000 Put', token: 'NSE_FO|40038', signal: 'SELL' },
      { symbol: 'NIFTY', name: 'Nifty 50 Index', token: 'NSE_INDEX|Nifty 50', signal: 'BUY' },
      { symbol: 'BANKNIFTY', name: 'Bank Nifty Index', token: 'NSE_INDEX|Nifty Bank', signal: 'SELL' },
      { symbol: 'RELIANCE', name: 'Reliance Industries', token: 'NSE_EQ|INE002A01018', signal: 'BUY' },
      { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd', token: 'NSE_EQ|INE040A01034', signal: 'BUY' },
    ],
    indices: [
      { symbol: 'NIFTY', name: 'Nifty 50 Spot', token: 'NSE_INDEX|Nifty 50', signal: 'BUY' },
      { symbol: 'BANKNIFTY', name: 'Bank Nifty Spot', token: 'NSE_INDEX|Nifty Bank', signal: 'SELL' },
      { symbol: 'FINNIFTY', name: 'Fin Nifty Spot', token: 'NSE_INDEX|Nifty Fin Service', signal: 'BUY' },
      { symbol: 'SENSEX', name: 'BSE Sensex Spot', token: 'BSE_INDEX|SENSEX', signal: 'BUY' },
    ],
    nifty_options: [
      { symbol: 'NIFTY 25000 CE', name: 'ATM 25000 Call', token: 'NSE_FO|40037', signal: 'BUY' },
      { symbol: 'NIFTY 25000 PE', name: 'ATM 25000 Put', token: 'NSE_FO|40038', signal: 'SELL' },
      { symbol: 'NIFTY 25050 CE', name: 'OTM 25050 Call', token: 'NSE_FO|40039', signal: 'BUY' },
      { symbol: 'NIFTY 24950 PE', name: 'OTM 24950 Put', token: 'NSE_FO|40036', signal: 'SELL' },
    ],
    bank_options: [
      { symbol: 'BANKNIFTY 59200 CE', name: 'Bank 59200 Call', token: '', signal: 'BUY' },
      { symbol: 'BANKNIFTY 59200 PE', name: 'Bank 59200 Put', token: '', signal: 'SELL' },
      { symbol: 'BANKNIFTY 59000 PE', name: 'Bank 59000 Put', token: '', signal: 'SELL' },
    ],
    stocks: [
      { symbol: 'RELIANCE', name: 'Reliance Industries', token: 'NSE_EQ|INE002A01018', signal: 'BUY' },
      { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd', token: 'NSE_EQ|INE040A01034', signal: 'BUY' },
      { symbol: 'ICICIBANK', name: 'ICICI Bank Ltd', token: 'NSE_EQ|INE090A01021', signal: 'BUY' },
      { symbol: 'TCS', name: 'Tata Consultancy Services', token: 'NSE_EQ|INE467B01029', signal: 'SELL' },
    ],
  };

  // Pane configurations
  const panes = [
    {
      idx: 0,
      id: 'pane-1',
      sym: 'NIFTY 25000 CE',
      token: 'NSE_FO|40037',
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
    {
      idx: 1,
      id: 'pane-2',
      sym: 'NIFTY 25000 PE',
      token: 'NSE_FO|40038',
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
    {
      idx: 2,
      id: 'pane-3',
      sym: 'NIFTY',
      token: 'NSE_INDEX|Nifty 50',
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
  ];

  // URL query parameter parsing
  const urlParams = new URLSearchParams(window.location.search);
  const qSym = urlParams.get('symbol');
  const qTok = urlParams.get('token');
  const qTf = urlParams.get('interval');
  if (qSym) {
    panes[0].sym = qSym.toUpperCase();
    panes[0].token = qTok || '';
    if (qTf) panes[0].tf = qTf;
    panes[0].isOption = /(CE|PE)$/i.test(qSym);
    openTabs[0].symbol = panes[0].sym;
    openTabs[0].token = panes[0].token;
  }

  function toast(msg, duration = 3000) {
    const el = $('toast');
    const txt = $('toast-message');
    if (!el || !txt) return;
    txt.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), duration);
  }

  async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (ownerToken) {
      headers['X-Owner-Token'] = ownerToken;
      headers['Authorization'] = `Bearer ${ownerToken}`;
    }
    const res = await fetch(path, {
      cache: 'no-store',
      headers,
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    return data;
  }

  // Activity tracking for 5-minute inactivity timeout
  function recordUserActivity() {
    lastUserActivity = Date.now();
    localStorage.setItem('neo_last_active', String(lastUserActivity));
  }

  ['mousemove', 'keydown', 'mousedown', 'touchstart', 'scroll'].forEach(evt => {
    window.addEventListener(evt, recordUserActivity, { passive: true });
  });

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
        color: inUptrend ? '#00b074' : '#ff4757',
      });

      prevUpper = finalUpper;
      prevLower = finalLower;
    }
    return result;
  }

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

  function computeVPVR(visibleCandles) {
    if (!visibleCandles || visibleCandles.length < 5) return { bins: [], pocPrice: null, maxVol: 0 };
    let minP = Infinity;
    let maxP = -Infinity;
    visibleCandles.forEach(c => {
      if (c.low < minP) minP = c.low;
      if (c.high > maxP) maxP = c.high;
    });
    if (minP >= maxP) return { bins: [], pocPrice: null, maxVol: 0 };

    const binCount = 30;
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

  function renderVPVR(pane) {
    const canvas = pane.vpvrCanvas;
    const ctx = pane.vpvrCtx;
    if (!canvas || !ctx || !indicators.showVpvr || !pane.candleSeries) {
      if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== rect.width || canvas.height !== rect.height) {
      canvas.width = rect.width;
      canvas.height = rect.height;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const { bins, pocPrice, maxVol } = pane.vpvrData;
    if (!bins.length || maxVol === 0) return;

    const maxBarW = canvas.width - 15;
    bins.forEach(b => {
      const yTop = pane.candleSeries.priceToCoordinate(b.priceHigh);
      const yBot = pane.candleSeries.priceToCoordinate(b.priceLow);
      if (yTop === null || yBot === null) return;
      const y = Math.min(yTop, yBot);
      const h = Math.max(2, Math.abs(yBot - yTop));

      const buyW = (b.buyVol / maxVol) * maxBarW;
      const sellW = (b.sellVol / maxVol) * maxBarW;
      const xRight = canvas.width;

      ctx.fillStyle = 'rgba(0, 176, 116, 0.45)';
      ctx.fillRect(xRight - (buyW + sellW), y, buyW, h - 0.5);

      ctx.fillStyle = 'rgba(255, 71, 87, 0.45)';
      ctx.fillRect(xRight - sellW, y, sellW, h - 0.5);
    });

    if (pocPrice !== null) {
      const yPOC = pane.candleSeries.priceToCoordinate(pocPrice);
      if (yPOC !== null) {
        ctx.strokeStyle = '#ffb703';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 2]);
        ctx.beginPath();
        ctx.moveTo(0, yPOC);
        ctx.lineTo(canvas.width, yPOC);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#ffb703';
        ctx.font = '9px DM Mono';
        ctx.fillText(`POC: ${pocPrice.toFixed(2)}`, 6, yPOC - 3);
      }
    }
  }

  // --- Lightweight Charts Initialization ---
  function initChartPane(pane) {
    const container = $(`${pane.id}-chart-container`);
    const canvasWrap = $(`${pane.id}-canvas-wrap`);
    if (!container) return;

    container.innerHTML = '';
    const chart = LightweightCharts.createChart(container, {
      width: container.clientWidth || 600,
      height: container.clientHeight || 400,
      layout: {
        background: { color: '#0e1117' },
        textColor: '#8b95a5',
        fontFamily: "'Inter', sans-serif",
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.04)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.04)' },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: '#ffb703', width: 1, style: 3 },
        horzLine: { color: '#ffb703', width: 1, style: 3 },
      },
      rightPriceScale: {
        borderColor: '#202735',
        scaleMargins: { top: 0.1, bottom: 0.18 },
        autoScale: true,
      },
      timeScale: {
        borderColor: '#202735',
        timeVisible: true,
        secondsVisible: pane.tf.includes('s'),
      },
    });

    // Candlestick Series
    const candleSeries = chart.addCandlestickSeries({
      upColor: '#00b074',
      downColor: '#ff4757',
      borderVisible: false,
      wickUpColor: '#00b074',
      wickDownColor: '#ff4757',
    });

    // Volume Series
    const volSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    // Indicators Series
    const ema9Series = chart.addLineSeries({ color: '#00d2d3', lineWidth: 1.5, title: 'EMA 9' });
    const ema21Series = chart.addLineSeries({ color: '#fb8500', lineWidth: 1.5, title: 'EMA 21' });
    const ema50Series = chart.addLineSeries({ color: '#8e44ad', lineWidth: 1.5, title: 'EMA 50' });
    const ema200Series = chart.addLineSeries({ color: '#ffb703', lineWidth: 2, title: 'EMA 200' });
    const vwapSeries = chart.addLineSeries({ color: '#9b59b6', lineWidth: 2, title: 'VWAP' });
    const supertrendSeries = chart.addLineSeries({ color: '#00b074', lineWidth: 2, title: 'Supertrend' });
    const bbUpperSeries = chart.addLineSeries({ color: 'rgba(30, 136, 229, 0.6)', lineWidth: 1 });
    const bbBasisSeries = chart.addLineSeries({ color: '#1e88e5', lineWidth: 1.5 });
    const bbLowerSeries = chart.addLineSeries({ color: 'rgba(30, 136, 229, 0.6)', lineWidth: 1 });

    pane.chart = chart;
    pane.candleSeries = candleSeries;
    pane.volSeries = volSeries;
    pane.ema9Series = ema9Series;
    pane.ema21Series = ema21Series;
    pane.ema50Series = ema50Series;
    pane.ema200Series = ema200Series;
    pane.vwapSeries = vwapSeries;
    pane.supertrendSeries = supertrendSeries;
    pane.bbUpperSeries = bbUpperSeries;
    pane.bbBasisSeries = bbBasisSeries;
    pane.bbLowerSeries = bbLowerSeries;

    pane.vpvrCanvas = $(`${pane.id}-vpvr-canvas`);
    if (pane.vpvrCanvas) {
      pane.vpvrCtx = pane.vpvrCanvas.getContext('2d');
    }

    // Crosshair move handler
    chart.subscribeCrosshairMove(param => {
      if (!param || !param.time) return;
      const bar = param.seriesData.get(candleSeries);
      if (bar) {
        updatePaneHeaderQuote(pane, bar.open, bar.high, bar.low, bar.close);
      }
    });

    // Visible logical range change for VPVR re-render
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      if (indicators.showVpvr && pane.candles.length) {
        const range = chart.timeScale().getVisibleLogicalRange();
        if (range) {
          const fromIdx = Math.max(0, Math.floor(range.from));
          const toIdx = Math.min(pane.candles.length - 1, Math.ceil(range.to));
          const visible = pane.candles.slice(fromIdx, toIdx + 1);
          pane.vpvrData = computeVPVR(visible);
          renderVPVR(pane);
        }
      }
    });

    // Resize observer
    if (window.ResizeObserver && canvasWrap) {
      const ro = new ResizeObserver(() => {
        if (pane.chart && container) {
          pane.chart.applyOptions({
            width: container.clientWidth,
            height: container.clientHeight,
          });
          renderVPVR(pane);
        }
      });
      ro.observe(canvasWrap);
    }
  }

  function applyPaneIndicators(pane) {
    if (!pane.candles.length) return;

    if (indicators.showEma9) pane.ema9Series.setData(calculateEMA(pane.candles, 9));
    else pane.ema9Series.setData([]);

    if (indicators.showEma21) pane.ema21Series.setData(calculateEMA(pane.candles, 21));
    else pane.ema21Series.setData([]);

    if (indicators.showEma50) pane.ema50Series.setData(calculateEMA(pane.candles, 50));
    else pane.ema50Series.setData([]);

    if (indicators.showEma200) pane.ema200Series.setData(calculateEMA(pane.candles, 200));
    else pane.ema200Series.setData([]);

    if (indicators.showVwap) pane.vwapSeries.setData(calculateVWAP(pane.candles));
    else pane.vwapSeries.setData([]);

    if (indicators.showSupertrend) pane.supertrendSeries.setData(calculateSupertrend(pane.candles, 10, 3));
    else pane.supertrendSeries.setData([]);

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

    if (indicators.showVol) {
      pane.volSeries.setData(
        pane.volumes.map(v => ({
          time: v.time,
          value: v.value,
          color: v.color,
        }))
      );
    } else {
      pane.volSeries.setData([]);
    }

    if (indicators.showVpvr) {
      pane.vpvrData = computeVPVR(pane.candles.slice(-100));
      renderVPVR(pane);
    } else if (pane.vpvrCtx && pane.vpvrCanvas) {
      pane.vpvrCtx.clearRect(0, 0, pane.vpvrCanvas.width, pane.vpvrCanvas.height);
    }
  }

  function updatePaneHeaderQuote(pane, open, high, low, close) {
    const oEl = $(`p${pane.idx + 1}-o`);
    const hEl = $(`p${pane.idx + 1}-h`);
    const lEl = $(`p${pane.idx + 1}-l`);
    const cEl = $(`p${pane.idx + 1}-c`);
    if (oEl) oEl.textContent = open ? open.toFixed(2) : '—';
    if (hEl) hEl.textContent = high ? high.toFixed(2) : '—';
    if (lEl) lEl.textContent = low ? low.toFixed(2) : '—';
    if (cEl) cEl.textContent = close ? close.toFixed(2) : '—';

    // If active pane, also update top bar OHLC
    if (pane.idx === 0) {
      const co = $('c-open');
      const ch = $('c-high');
      const cl = $('c-low');
      const cc = $('c-close');
      if (co) co.textContent = open ? open.toFixed(2) : '—';
      if (ch) ch.textContent = high ? high.toFixed(2) : '—';
      if (cl) cl.textContent = low ? low.toFixed(2) : '—';
      if (cc) cc.textContent = close ? close.toFixed(2) : '—';
    }
  }

  function updatePaneQuote(pane, quote) {
    if (!quote || quote.ltp === undefined) return;
    const ltp = Number(quote.ltp);
    pane.lastLtp = ltp;

    if (quote.prev_close !== undefined && quote.prev_close > 0) {
      pane.prevClose = Number(quote.prev_close);
    }

    const ref = (pane.prevClose && pane.prevClose > 0) ? pane.prevClose : (pane.candles[0] ? pane.candles[0].open : ltp);
    const diff = ltp - ref;
    const pct = ref > 0 ? (diff / ref) * 100 : 0;
    const isPos = diff >= 0;

    const ltpEl = $(`p${pane.idx + 1}-ltp`);
    const chgEl = $(`p${pane.idx + 1}-chg`);
    if (ltpEl) ltpEl.textContent = `₹${ltp.toFixed(2)}`;
    if (chgEl) {
      chgEl.textContent = `${isPos ? '+' : ''}${diff.toFixed(2)} (${isPos ? '+' : ''}${pct.toFixed(2)}%)`;
      chgEl.className = `pane-chg ${isPos ? 'pos' : 'neg'}`;
    }

    // If this is primary pane, update Right Order Ticket values!
    if (pane.idx === 0) {
      updateOrderFormPrices(ltp);
    }
  }

  async function loadCandles(pane) {
    try {
      const tokenEnc = encodeURIComponent(pane.token || '');
      const symEnc = encodeURIComponent(pane.sym);
      const url = `/api/chart/candles?symbol=${symEnc}&token=${tokenEnc}&interval=${pane.tf}&days=5`;
      const data = await api(url);

      if (!data || !data.ok || !data.candles || !data.candles.length) {
        return;
      }

      if (data.prev_close) pane.prevClose = Number(data.prev_close);
      if (data.ltp) pane.lastLtp = Number(data.ltp);

      pane.candles = data.candles.map(c => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume || 100,
      }));

      pane.volumes = pane.candles.map(c => ({
        time: c.time,
        value: c.volume,
        color: c.close >= c.open ? 'rgba(0, 176, 116, 0.4)' : 'rgba(255, 71, 87, 0.4)',
      }));

      pane.candleSeries.setData(pane.candles);
      pane.volSeries.setData(pane.volumes);

      applyPaneIndicators(pane);

      // Auto-fit to recent bars
      pane.chart.timeScale().fitContent();

      const lastBar = pane.candles[pane.candles.length - 1];
      if (lastBar) {
        pane.activeBar = { ...lastBar };
        updatePaneHeaderQuote(pane, lastBar.open, lastBar.high, lastBar.low, lastBar.close);
        updatePaneQuote(pane, { ltp: lastBar.close, prev_close: pane.prevClose });
      }
    } catch (err) {
      console.warn(`[Candles] Failed loading candles for ${pane.sym}:`, err.message);
    }
  }

  // --- Sub-second Quotes Stream ---
  function startQuotesPolling() {
    async function tick() {
      try {
        const items = panes.map(p => ({ symbol: p.sym, token: p.token }));
        const res = await api('/api/chart/live-quotes', {
          method: 'POST',
          body: JSON.stringify({ items }),
        });
        if (res && res.ok && res.quotes) {
          panes.forEach(pane => {
            const q = res.quotes[pane.sym];
            if (q) {
              updatePaneQuote(pane, q);
              // Update live candle bar
              if (pane.activeBar && q.ltp) {
                const ltp = Number(q.ltp);
                pane.activeBar.close = ltp;
                if (ltp > pane.activeBar.high) pane.activeBar.high = ltp;
                if (ltp < pane.activeBar.low) pane.activeBar.low = ltp;
                pane.candleSeries.update(pane.activeBar);
                updatePaneHeaderQuote(pane, pane.activeBar.open, pane.activeBar.high, pane.activeBar.low, pane.activeBar.close);
              }
            }
          });
        }
      } catch (e) {
        // quiet error
      }
      setTimeout(tick, 500); // 500ms ultra-fast quote refresh
    }
    tick();
  }

  // --- Exness Order Ticket Controls ---
  function getIndexLotSize(symbol) {
    const s = symbol.toUpperCase();
    if (s.includes('BANKNIFTY')) return 15;
    if (s.includes('FINNIFTY')) return 25;
    if (s.includes('SENSEX')) return 10;
    return 25; // Default Nifty lot size
  }

  function updateOrderFormPrices(ltp) {
    if (!ltp) return;
    const spread = (ltp * 0.0005) + 0.05;
    const askPrice = ltp + (spread / 2);
    const bidPrice = Math.max(0.05, ltp - (spread / 2));

    const sellLbl = $('lbl-sell-price');
    const buyLbl = $('lbl-buy-price');
    if (sellLbl) sellLbl.textContent = bidPrice.toFixed(2);
    if (buyLbl) buyLbl.textContent = askPrice.toFixed(2);

    const spreadText = $('op-spread-text');
    if (spreadText) spreadText.textContent = `${spread.toFixed(2)} Spread`;

    // Margin estimation
    const lotSize = getIndexLotSize(panes[0].sym);
    const totalQty = selectedLots * lotSize;
    const estMargin = (ltp * totalQty).toFixed(2);
    const marginEl = $('op-margin-req');
    if (marginEl) marginEl.textContent = `₹${Number(estMargin).toLocaleString('en-IN')}`;

    // Auto-fill limit price input if empty or at default
    const limitInput = $('input-limit-price');
    if (limitInput && (!limitInput.value || limitInput.dataset.manual !== 'true')) {
      limitInput.value = ltp.toFixed(2);
    }
  }

  function setupOrderPanelInteractions() {
    // 1. Product Toggle (NRML vs MIS)
    const btnNrml = $('btn-prod-nrml');
    const btnMis = $('btn-prod-mis');
    if (btnNrml && btnMis) {
      btnNrml.addEventListener('click', () => {
        selectedProduct = 'NRML';
        btnNrml.classList.add('active');
        btnMis.classList.remove('active');
        toast('Product set to NRML (Carry Forward Overnight)');
      });
      btnMis.addEventListener('click', () => {
        selectedProduct = 'MIS';
        btnMis.classList.add('active');
        btnNrml.classList.remove('active');
        toast('Product set to MIS (Intraday — auto squared-off at 3:15 PM)');
      });
    }

    // 2. Order Type Tabs (MKT, L, SL)
    const typeTabs = document.querySelectorAll('.op-type-tab');
    typeTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        typeTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        selectedOrderType = tab.dataset.type;

        const fLimit = $('field-limit-price');
        const fTrigger = $('field-trigger-price');
        if (fLimit) fLimit.classList.toggle('hidden', selectedOrderType === 'MKT');
        if (fTrigger) fTrigger.classList.toggle('hidden', selectedOrderType !== 'SL');

        const lblSellAction = $('lbl-sell-action');
        const lblBuyAction = $('lbl-buy-action');
        if (selectedOrderType === 'L') {
          if (lblSellAction) lblSellAction.textContent = 'Sell Limit';
          if (lblBuyAction) lblBuyAction.textContent = 'Buy Limit';
        } else if (selectedOrderType === 'SL') {
          if (lblSellAction) lblSellAction.textContent = 'Sell Stop';
          if (lblBuyAction) lblBuyAction.textContent = 'Buy Stop';
        } else {
          if (lblSellAction) lblSellAction.textContent = 'Sell';
          if (lblBuyAction) lblBuyAction.textContent = 'Buy';
        }
      });
    });

    // 3. Lots Stepper
    const inputLots = $('input-lots');
    const btnLotsMinus = $('btn-lots-minus');
    const btnLotsPlus = $('btn-lots-plus');
    const unitsSub = $('op-units-sub');

    function updateLotDisplay() {
      selectedLots = Math.max(1, parseInt(inputLots.value) || 1);
      inputLots.value = selectedLots;
      const lotSize = getIndexLotSize(panes[0].sym);
      const units = selectedLots * lotSize;
      if (unitsSub) unitsSub.textContent = `${units} units (${selectedLots} Lot${selectedLots > 1 ? 's' : ''})`;
      if (panes[0].lastLtp) updateOrderFormPrices(panes[0].lastLtp);
    }

    if (btnLotsMinus && btnLotsPlus && inputLots) {
      btnLotsMinus.addEventListener('click', () => {
        if (selectedLots > 1) {
          inputLots.value = selectedLots - 1;
          updateLotDisplay();
        }
      });
      btnLotsPlus.addEventListener('click', () => {
        inputLots.value = selectedLots + 1;
        updateLotDisplay();
      });
      inputLots.addEventListener('change', updateLotDisplay);
    }

    // 4. Steppers for Limit Price & Trigger Price
    const btnPriceMinus = $('btn-price-minus');
    const btnPricePlus = $('btn-price-plus');
    const inputPrice = $('input-limit-price');
    if (btnPriceMinus && btnPricePlus && inputPrice) {
      btnPriceMinus.addEventListener('click', () => {
        const cur = parseFloat(inputPrice.value) || (panes[0].lastLtp || 40);
        inputPrice.value = Math.max(0.05, cur - 0.05).toFixed(2);
        inputPrice.dataset.manual = 'true';
      });
      btnPricePlus.addEventListener('click', () => {
        const cur = parseFloat(inputPrice.value) || (panes[0].lastLtp || 40);
        inputPrice.value = (cur + 0.05).toFixed(2);
        inputPrice.dataset.manual = 'true';
      });
      inputPrice.addEventListener('input', () => { inputPrice.dataset.manual = 'true'; });
    }

    // 5. Submit Order (Buy / Sell)
    async function submitOrder(side) {
      const sym = panes[0].sym;
      const lotSize = getIndexLotSize(sym);
      const qty = selectedLots * lotSize;
      const seg = panes[0].isOption ? 'nse_fo' : 'nse_cm';

      let limitPrice = null;
      let triggerPrice = null;
      if (selectedOrderType === 'L' || selectedOrderType === 'SL') {
        limitPrice = parseFloat($('input-limit-price').value) || panes[0].lastLtp;
      }
      if (selectedOrderType === 'SL') {
        triggerPrice = parseFloat($('input-trigger-price').value) || panes[0].lastLtp;
      }

      const payload = {
        symbol: sym,
        exchange_segment: seg,
        side: side,
        lots: selectedLots,
        lot_size: lotSize,
        product: selectedProduct,
        order_type: selectedOrderType,
        price: limitPrice,
        trigger_price: triggerPrice,
        validity: 'DAY',
        user_confirmed: true,
      };

      try {
        toast(`Submitting ${side} ${selectedLots} Lot(s) ${sym}...`);
        const res = await api('/api/orders', {
          method: 'POST',
          body: JSON.stringify(payload),
        });

        if (res.ok) {
          const modeTag = res.mode === 'live' ? 'Kotak Live' : 'Demo Paper';
          toast(`✅ ${side} order placed (${modeTag})! Qty: ${qty}`);
          fetchPositionsAndOrders();
        } else {
          toast(`❌ Order failed: ${res.detail || 'Rejection'}`);
        }
      } catch (err) {
        toast(`❌ Error: ${err.message}`);
      }
    }

    const btnSell = $('btn-order-sell');
    const btnBuy = $('btn-order-buy');
    if (btnSell) btnSell.addEventListener('click', () => submitOrder('SELL'));
    if (btnBuy) btnBuy.addEventListener('click', () => submitOrder('BUY'));

    // Toggle Order Panel visibility
    const btnToggleOrder = $('btn-toggle-order-panel');
    const btnCloseOrder = $('btn-close-order-panel');
    const orderPanel = $('ex-order-panel');
    if (btnToggleOrder && orderPanel) {
      btnToggleOrder.addEventListener('click', () => {
        orderPanel.classList.toggle('collapsed');
      });
    }
    if (btnCloseOrder && orderPanel) {
      btnCloseOrder.addEventListener('click', () => {
        orderPanel.classList.add('collapsed');
      });
    }
  }

  // --- Exness Symbol Tabs ---
  function renderSymbolTabs() {
    const tabsBar = $('ex-tabs-bar');
    if (!tabsBar) return;
    tabsBar.innerHTML = '';

    openTabs.forEach((tab, idx) => {
      const tabEl = document.createElement('div');
      tabEl.className = `ex-tab ${idx === activeTabIndex ? 'active' : ''}`;
      tabEl.innerHTML = `
        <span class="tab-icon">${tab.isOption ? '🪙' : '📈'}</span>
        <span class="tab-name">${tab.symbol}</span>
        <button type="button" class="tab-close" data-idx="${idx}" title="Close Tab">✕</button>
      `;

      tabEl.addEventListener('click', e => {
        if (e.target.classList.contains('tab-close')) return;
        switchTab(idx);
      });

      const closeBtn = tabEl.querySelector('.tab-close');
      closeBtn.addEventListener('click', e => {
        e.stopPropagation();
        closeTab(idx);
      });

      tabsBar.appendChild(tabEl);
    });
  }

  function switchTab(index) {
    if (index < 0 || index >= openTabs.length) return;
    activeTabIndex = index;
    renderSymbolTabs();

    const selected = openTabs[index];
    panes[0].sym = selected.symbol;
    panes[0].token = selected.token || '';
    panes[0].tf = selected.interval || '1m';
    panes[0].isOption = /(CE|PE)$/i.test(selected.symbol);

    const symTitle = $('chart-active-sym');
    const symSeg = $('chart-active-seg');
    if (symTitle) symTitle.textContent = selected.symbol;
    if (symSeg) symSeg.textContent = panes[0].isOption ? 'NSE F&O' : 'NSE';

    const opSym = $('op-sym-name');
    if (opSym) opSym.textContent = selected.symbol;

    loadCandles(panes[0]);
  }

  function closeTab(index) {
    if (openTabs.length <= 1) {
      toast('Cannot close the last remaining tab');
      return;
    }
    openTabs.splice(index, 1);
    if (activeTabIndex >= openTabs.length) {
      activeTabIndex = openTabs.length - 1;
    }
    renderSymbolTabs();
    switchTab(activeTabIndex);
  }

  function addSymbolTab(sym, token = '') {
    const isOpt = /(CE|PE)$/i.test(sym);
    const existing = openTabs.findIndex(t => t.symbol === sym);
    if (existing >= 0) {
      switchTab(existing);
      return;
    }
    openTabs.push({ symbol: sym, token, interval: '1m', isOption: isOpt });
    activeTabIndex = openTabs.length - 1;
    renderSymbolTabs();
    switchTab(activeTabIndex);
  }

  // --- Left Collapsible Instruments Watchlist ---
  function setupLeftDrawer() {
    const leftPanel = $('ex-left-panel');
    const btnCollapse = $('btn-collapse-drawer');
    const railBtnInst = $('rail-btn-instruments');

    if (btnCollapse && leftPanel) {
      btnCollapse.addEventListener('click', () => {
        leftPanel.classList.toggle('collapsed');
      });
    }

    if (railBtnInst && leftPanel) {
      railBtnInst.addEventListener('click', () => {
        leftPanel.classList.toggle('collapsed');
      });
    }

    // Category filter dropdown
    const catSelect = $('ex-inst-category');
    if (catSelect) {
      catSelect.addEventListener('change', () => {
        renderInstrumentsList(catSelect.value);
      });
    }

    // Search input
    const searchInput = $('ex-inst-search');
    const searchDropdown = $('ex-inst-search-results');
    let searchDebounce = null;

    if (searchInput && searchDropdown) {
      searchInput.addEventListener('input', () => {
        clearTimeout(searchDebounce);
        const q = searchInput.value.trim();
        if (q.length < 2) {
          searchDropdown.classList.add('hidden');
          return;
        }

        searchDebounce = setTimeout(async () => {
          try {
            const data = await api(`/api/chart/search?q=${encodeURIComponent(q)}`);
            if (data.ok && data.results && data.results.length) {
              searchDropdown.innerHTML = '';
              data.results.slice(0, 10).forEach(r => {
                const item = document.createElement('div');
                item.className = 'acc-menu-item';
                item.innerHTML = `<b>${r.symbol}</b> <small style="margin-left:auto; color:#8b95a5;">${r.segment}</small>`;
                item.addEventListener('click', () => {
                  addSymbolTab(r.symbol, r.token || '');
                  searchDropdown.classList.add('hidden');
                  searchInput.value = '';
                });
                searchDropdown.appendChild(item);
              });
              searchDropdown.classList.remove('hidden');
            }
          } catch (e) {
            // quiet
          }
        }, 200);
      });

      document.addEventListener('click', e => {
        if (!searchInput.contains(e.target) && !searchDropdown.contains(e.target)) {
          searchDropdown.classList.add('hidden');
        }
      });
    }

    renderInstrumentsList('favorites');
  }

  function renderInstrumentsList(category = 'favorites') {
    const tbody = $('ex-instruments-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    const list = WATCHLIST_PRESETS[category] || WATCHLIST_PRESETS.favorites;
    list.forEach(inst => {
      const tr = document.createElement('tr');
      tr.className = 'ex-inst-row';
      tr.innerHTML = `
        <td>
          <div class="td-sym-wrap">
            <span class="sym-main">${inst.symbol}</span>
            <span class="sym-sub">${inst.name}</span>
          </div>
        </td>
        <td>
          <span class="sig-badge ${inst.signal.toLowerCase()}">${inst.signal === 'BUY' ? '▲' : '▼'} ${inst.signal}</span>
        </td>
        <td>
          <button type="button" class="btn-price-bid" data-sym="${inst.symbol}" title="Sell @ Bid">—</button>
        </td>
        <td>
          <button type="button" class="btn-price-ask" data-sym="${inst.symbol}" title="Buy @ Ask">—</button>
        </td>
      `;

      tr.addEventListener('click', e => {
        if (e.target.classList.contains('btn-price-bid') || e.target.classList.contains('btn-price-ask')) return;
        addSymbolTab(inst.symbol, inst.token);
      });

      const bidBtn = tr.querySelector('.btn-price-bid');
      const askBtn = tr.querySelector('.btn-price-ask');
      bidBtn.addEventListener('click', e => {
        e.stopPropagation();
        addSymbolTab(inst.symbol, inst.token);
        $('ex-order-panel').classList.remove('collapsed');
      });
      askBtn.addEventListener('click', e => {
        e.stopPropagation();
        addSymbolTab(inst.symbol, inst.token);
        $('ex-order-panel').classList.remove('collapsed');
      });

      tbody.appendChild(tr);
    });

    // Populate prices for watchlist
    updateWatchlistQuotes();
  }

  async function updateWatchlistQuotes() {
    try {
      const rows = document.querySelectorAll('.ex-inst-row');
      const symbols = Array.from(rows).map(r => ({ symbol: r.querySelector('.sym-main').textContent }));
      if (!symbols.length) return;

      const data = await api('/api/chart/live-quotes', {
        method: 'POST',
        body: JSON.stringify({ items: symbols }),
      });

      if (data && data.ok && data.quotes) {
        rows.forEach(r => {
          const sym = r.querySelector('.sym-main').textContent;
          const q = data.quotes[sym];
          if (q && q.ltp) {
            const bidBtn = r.querySelector('.btn-price-bid');
            const askBtn = r.querySelector('.btn-price-ask');
            const spread = (q.ltp * 0.0005) + 0.05;
            if (bidBtn) bidBtn.textContent = Math.max(0.05, q.ltp - spread / 2).toFixed(2);
            if (askBtn) askBtn.textContent = (q.ltp + spread / 2).toFixed(2);
          }
        });
      }
    } catch (e) {
      // quiet
    }
  }

  // --- Bottom Docked Positions & Orders ---
  function setupBottomPanel() {
    const btnOpen = $('tab-btn-open');
    const btnPending = $('tab-btn-pending');
    const btnClosed = $('tab-btn-closed');

    const vOpen = $('view-open-positions');
    const vPending = $('view-pending-orders');
    const vClosed = $('view-closed-trades');

    function switchDockTab(tab) {
      [btnOpen, btnPending, btnClosed].forEach(b => b && b.classList.remove('active'));
      [vOpen, vPending, vClosed].forEach(v => v && v.classList.add('hidden'));

      if (tab === 'open') {
        if (btnOpen) btnOpen.classList.add('active');
        if (vOpen) vOpen.classList.remove('hidden');
      } else if (tab === 'pending') {
        if (btnPending) btnPending.classList.add('active');
        if (vPending) vPending.classList.remove('hidden');
      } else if (tab === 'closed') {
        if (btnClosed) btnClosed.classList.add('active');
        if (vClosed) vClosed.classList.remove('hidden');
      }
    }

    if (btnOpen) btnOpen.addEventListener('click', () => switchDockTab('open'));
    if (btnPending) btnPending.addEventListener('click', () => switchDockTab('pending'));
    if (btnClosed) btnClosed.addEventListener('click', () => switchDockTab('closed'));

    // Toggle minimize
    const toggleDockBtn = $('btn-toggle-dock');
    const bottomPanel = $('ex-bottom-panel');
    if (toggleDockBtn && bottomPanel) {
      toggleDockBtn.addEventListener('click', () => {
        bottomPanel.classList.toggle('minimized');
        toggleDockBtn.textContent = bottomPanel.classList.contains('minimized') ? '▢' : '_';
      });
    }

    // Exit All Button
    const btnExitAll = $('btn-dock-exit-all');
    if (btnExitAll) {
      btnExitAll.addEventListener('click', async () => {
        if (!confirm('Are you sure you want to SQUARE OFF ALL open positions immediately?')) return;
        try {
          toast('Squaring off all positions...');
          const res = await api('/api/positions/exit-all', { method: 'POST' });
          if (res.ok) {
            toast(`✅ ${res.message || 'All positions squared off!'}`);
            fetchPositionsAndOrders();
          }
        } catch (err) {
          toast(`❌ Error: ${err.message}`);
        }
      });
    }
  }

  async function fetchPositionsAndOrders() {
    try {
      const posData = await api('/api/positions?tab=open');
      const openTbody = $('open-positions-tbody');
      const openCountBadge = $('open-pos-count');

      const positions = Array.isArray(posData) ? posData : (posData.positions || []);
      if (openCountBadge) openCountBadge.textContent = positions.length;

      if (openTbody) {
        if (!positions.length) {
          openTbody.innerHTML = '<tr><td colspan="8" class="empty-row">No open positions. Select a strike to trade.</td></tr>';
        } else {
          openTbody.innerHTML = '';
          positions.forEach(p => {
            const sym = p.symbol || p.trdSym || '—';
            const side = (p.side || (Number(p.quantity) > 0 ? 'BUY' : 'SELL')).toUpperCase();
            const qty = Math.abs(Number(p.quantity || p.qty || 0));
            const avg = Number(p.average_price || p.avgPrc || 0);
            const ltp = Number(p.ltp || avg);
            const m2m = Number(p.m2m || (side === 'BUY' ? (ltp - avg) * qty : (avg - ltp) * qty));
            const isPos = m2m >= 0;

            const tr = document.createElement('tr');
            tr.innerHTML = `
              <td><b>${sym}</b></td>
              <td><span class="side-badge ${side.toLowerCase()}">${side}</span></td>
              <td>${p.product || 'NRML'}</td>
              <td>${qty}</td>
              <td>₹${avg.toFixed(2)}</td>
              <td>₹${ltp.toFixed(2)}</td>
              <td style="color: ${isPos ? 'var(--bull)' : 'var(--bear)'}; font-weight:700;">
                ${isPos ? '+' : ''}₹${m2m.toFixed(2)}
              </td>
              <td>
                <button type="button" class="pos-action-btn danger btn-pos-exit" data-sym="${sym}">Exit</button>
              </td>
            `;

            tr.querySelector('.btn-pos-exit').addEventListener('click', async () => {
              try {
                toast(`Exiting position ${sym}...`);
                const res = await api(`/api/positions/${encodeURIComponent(sym)}/exit`, {
                  method: 'POST',
                  body: JSON.stringify({ percentage: 100 }),
                });
                if (res.ok) {
                  toast(`✅ Position ${sym} closed!`);
                  fetchPositionsAndOrders();
                }
              } catch (e) {
                toast(`❌ ${e.message}`);
              }
            });

            openTbody.appendChild(tr);
          });
        }
      }

      // Update Footer Equity & PnL
      const fundsData = await api('/api/funds').catch(() => ({}));
      if (fundsData && fundsData.available_margin !== undefined) {
        const eqEl = $('f-equity');
        const fmEl = $('f-free-margin');
        const muEl = $('f-margin-used');
        const accBal = $('ex-acc-balance');

        const avail = Number(fundsData.available_margin || 1000000);
        const used = Number(fundsData.used_margin || 0);
        const equity = Number(fundsData.total_equity || (avail + used));

        if (eqEl) eqEl.textContent = `₹${equity.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
        if (fmEl) fmEl.textContent = `₹${avail.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
        if (muEl) muEl.textContent = `₹${used.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
        if (accBal) accBal.textContent = `₹${avail.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
      }

      // Orders report
      const ordersData = await api('/api/orders').catch(() => []);
      const pendingTbody = $('pending-orders-tbody');
      const pendingCount = $('pending-orders-count');
      const closedTbody = $('closed-trades-tbody');
      const closedCount = $('closed-trades-count');

      const allOrders = Array.isArray(ordersData) ? ordersData : [];
      const pendingList = allOrders.filter(o => o.status === 'pending');
      const closedList = allOrders.filter(o => o.status === 'completed' || o.status === 'simulated');

      if (pendingCount) pendingCount.textContent = pendingList.length;
      if (closedCount) closedCount.textContent = closedList.length;

      if (pendingTbody) {
        if (!pendingList.length) {
          pendingTbody.innerHTML = '<tr><td colspan="8" class="empty-row">No pending limit or trigger orders.</td></tr>';
        } else {
          pendingTbody.innerHTML = '';
          pendingList.forEach(o => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
              <td>${o.symbol}</td>
              <td>${o.id}</td>
              <td>${o.order_type}</td>
              <td><span class="side-badge ${(o.side || 'BUY').toLowerCase()}">${o.side}</span></td>
              <td>${o.quantity}</td>
              <td>₹${Number(o.price || 0).toFixed(2)}</td>
              <td><span class="tag-pending">Pending</span></td>
              <td><button type="button" class="pos-action-btn danger">Cancel</button></td>
            `;
            pendingTbody.appendChild(tr);
          });
        }
      }

      if (closedTbody) {
        if (!closedList.length) {
          closedTbody.innerHTML = '<tr><td colspan="7" class="empty-row">Showing closed trades for today.</td></tr>';
        } else {
          closedTbody.innerHTML = '';
          closedList.forEach(o => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
              <td><b>${o.symbol}</b></td>
              <td><span class="side-badge ${(o.side || 'BUY').toLowerCase()}">${o.side}</span></td>
              <td>${o.quantity}</td>
              <td>₹${Number(o.price || 0).toFixed(2)}</td>
              <td>₹${Number(o.price || 0).toFixed(2)}</td>
              <td class="text-green">+₹0.00</td>
              <td>${o.created_at ? o.created_at.split('T')[1] || o.created_at : 'Today'}</td>
            `;
            closedTbody.appendChild(tr);
          });
        }
      }
    } catch (e) {
      // quiet
    }
  }

  // --- Option Chain Modal (Matching Upstox TV) ---
  function setupOptionChainModal() {
    const modal = $('option-chain-modal');
    const openBtn = $('btn-chart-opt-chain');
    const railBtn = $('rail-btn-option-chain');
    const closeBtn = $('close-oc-modal');
    const expirySelect = $('oc-expiry-select');
    const spotBadge = $('oc-spot-badge');
    const tbody = $('oc-table-body');

    let currentUnd = 'NIFTY';

    function openModal() {
      if (!modal) return;
      modal.classList.remove('hidden');
      loadOptionChain(currentUnd);
    }

    function closeModal() {
      if (!modal) return;
      modal.classList.add('hidden');
    }

    if (openBtn) openBtn.addEventListener('click', openModal);
    if (railBtn) railBtn.addEventListener('click', openModal);
    if (closeBtn) closeBtn.addEventListener('click', closeModal);

    document.querySelectorAll('.oc-und-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.oc-und-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentUnd = btn.dataset.und;
        loadOptionChain(currentUnd);
      });
    });

    if (expirySelect) {
      expirySelect.addEventListener('change', () => {
        loadOptionChain(currentUnd, expirySelect.value);
      });
    }

    async function loadOptionChain(underlying, expiry = '') {
      if (!tbody) return;
      tbody.innerHTML = '<tr><td colspan="7" class="oc-loading" style="text-align:center; padding:30px; color:#8b95a5;">Loading real-time option chain…</td></tr>';

      try {
        const qUrl = `/api/chart/option-chain?symbol=${encodeURIComponent(underlying)}${expiry ? `&expiry=${encodeURIComponent(expiry)}` : ''}`;
        const data = await api(qUrl);

        if (!data || !data.ok) {
          tbody.innerHTML = `<tr><td colspan="7" class="oc-loading" style="text-align:center; padding:20px; color:#ff4757;">Failed loading option chain: ${data.message || 'Error'}</td></tr>`;
          return;
        }

        if (spotBadge) {
          const diff = Number(data.spot_change || 0);
          spotBadge.textContent = `Spot: ₹${Number(data.spot_price).toLocaleString('en-IN', { minimumFractionDigits: 2 })} (${diff >= 0 ? '+' : ''}${diff.toFixed(2)})`;
        }

        if (expirySelect && data.expiries && data.expiries.length) {
          expirySelect.innerHTML = '';
          data.expiries.forEach(exp => {
            const opt = document.createElement('option');
            opt.value = exp;
            opt.textContent = exp;
            if (exp === data.selected_expiry) opt.selected = true;
            expirySelect.appendChild(opt);
          });
        }

        tbody.innerHTML = '';
        data.chain.forEach(row => {
          const tr = document.createElement('tr');
          tr.className = `oc-strike-row ${row.is_atm ? 'atm-row' : ''}`;
          tr.innerHTML = `
            <td class="col-oi">${row.call_oi ? row.call_oi.toLocaleString('en-IN') : '—'}</td>
            <td class="col-vol">${row.call_vol ? row.call_vol.toLocaleString('en-IN') : '—'}</td>
            <td class="col-ltp">
              <button type="button" class="oc-ltp-btn call-ltp" data-sym="${row.call_symbol}" data-tok="${row.call_token}">
                ${row.call_ltp ? Number(row.call_ltp).toFixed(2) : '—'}
              </button>
            </td>
            <td class="col-strike">
              <b>${row.strike}</b>
              ${row.is_atm ? '<span style="font-size:9px; color:#ffb703; display:block;">ATM</span>' : ''}
            </td>
            <td class="col-ltp">
              <button type="button" class="oc-ltp-btn put-ltp" data-sym="${row.put_symbol}" data-tok="${row.put_token}">
                ${row.put_ltp ? Number(row.put_ltp).toFixed(2) : '—'}
              </button>
            </td>
            <td class="col-vol">${row.put_vol ? row.put_vol.toLocaleString('en-IN') : '—'}</td>
            <td class="col-oi">${row.put_oi ? row.put_oi.toLocaleString('en-IN') : '—'}</td>
          `;

          // Click Call LTP
          const callBtn = tr.querySelector('.call-ltp');
          if (callBtn) {
            callBtn.addEventListener('click', () => {
              addSymbolTab(row.call_symbol, row.call_token);
              closeModal();
              toast(`Loaded ${row.call_symbol} chart & ticket`);
            });
          }

          // Click Put LTP
          const putBtn = tr.querySelector('.put-ltp');
          if (putBtn) {
            putBtn.addEventListener('click', () => {
              addSymbolTab(row.put_symbol, row.put_token);
              closeModal();
              toast(`Loaded ${row.put_symbol} chart & ticket`);
            });
          }

          tbody.appendChild(tr);
        });
      } catch (err) {
        tbody.innerHTML = `<tr><td colspan="7" class="oc-loading" style="text-align:center; padding:20px; color:#ff4757;">Error loading chain: ${err.message}</td></tr>`;
      }
    }
  }

  // --- Gatekeeper & Owner Auth ---
  function setupGatekeeper() {
    const gateModal = $('modal-gatekeeper');
    const btnEnterGuest = $('btn-enter-guest');
    const btnOwnerSubmit = $('btn-owner-login-submit');
    const ownerTotp = $('owner-totp-input');
    const ownerMpin = $('owner-mpin-input');

    const accBtn = $('ex-account-btn');
    const accMenu = $('ex-account-menu');
    const btnOpenOwner = $('btn-open-owner-login');
    const btnResetDemo = $('btn-reset-demo');
    const btnLogout = $('btn-logout');
    const sessionBadge = $('session-timer-badge');
    const sessionTimerText = $('session-timer-text');

    // Toggle Account Menu
    if (accBtn && accMenu) {
      accBtn.addEventListener('click', e => {
        e.stopPropagation();
        accMenu.classList.toggle('hidden');
      });
      document.addEventListener('click', () => {
        accMenu.classList.add('hidden');
      });
    }

    if (btnOpenOwner) {
      btnOpenOwner.addEventListener('click', () => {
        if (gateModal) gateModal.classList.remove('hidden');
      });
    }

    if (btnResetDemo) {
      btnResetDemo.addEventListener('click', () => {
        toast('Demo paper balance reset to ₹10,00,000.00');
        fetchPositionsAndOrders();
      });
    }

    if (btnLogout) {
      btnLogout.addEventListener('click', async () => {
        await api('/api/auth/owner-logout', { method: 'POST' }).catch(() => ({}));
        localStorage.removeItem('neo_owner_token');
        ownerToken = '';
        isOwner = false;
        updateAuthModeUI(false);
        toast('Logged out. Switched to Guest Demo Mode.');
        if (gateModal) gateModal.classList.remove('hidden');
      });
    }

    // Guest Entry
    if (btnEnterGuest) {
      btnEnterGuest.addEventListener('click', () => {
        gateModal.classList.add('hidden');
        localStorage.setItem('neo_visited_as_guest', 'true');
        updateAuthModeUI(false);
        toast('Welcome! You are trading in Guest Demo Mode with ₹10,00,000 virtual balance.');
      });
    }

    // Owner Login Submit
    if (btnOwnerSubmit) {
      btnOwnerSubmit.addEventListener('click', async () => {
        const totp = (ownerTotp ? ownerTotp.value : '').trim();
        const mpin = (ownerMpin ? ownerMpin.value : '').trim();
        if (!mpin) {
          toast('Please enter your 6-digit MPIN');
          return;
        }

        try {
          toast('Verifying credentials...');
          const res = await api('/api/auth/owner-login', {
            method: 'POST',
            body: JSON.stringify({ totp, mpin }),
          });

          if (res.ok && res.token) {
            ownerToken = res.token;
            localStorage.setItem('neo_owner_token', ownerToken);
            recordUserActivity();
            isOwner = true;
            updateAuthModeUI(true);
            gateModal.classList.add('hidden');
            toast('✅ Authenticated as Owner! Live Kotak 0-Brokerage Active.');
            fetchPositionsAndOrders();
          }
        } catch (err) {
          toast(`❌ Authentication failed: ${err.message}`);
        }
      });
    }

    // Check Initial Session
    async function checkSession() {
      try {
        const st = await api('/api/auth/session-status');
        if (st.authenticated) {
          isOwner = true;
          updateAuthModeUI(true);
        } else {
          isOwner = false;
          updateAuthModeUI(false);
          const hasVisited = localStorage.getItem('neo_visited_as_guest');
          if (!hasVisited && gateModal) {
            gateModal.classList.remove('hidden');
          }
        }
      } catch (e) {
        updateAuthModeUI(false);
      }
    }

    function updateAuthModeUI(ownerActive) {
      const pill = $('ex-acc-pill');
      const idEl = $('ex-acc-id');
      const modeBadge = $('op-mode-badge');
      const btnLogoutEl = $('btn-logout');
      const btnOwnerLoginEl = $('btn-open-owner-login');
      const menuTitle = $('menu-mode-title');
      const menuSub = $('menu-mode-sub');

      if (ownerActive) {
        if (pill) { pill.className = 'ex-acc-pill live'; pill.textContent = 'Live'; }
        if (idEl) idEl.textContent = '#KOTAK-LIVE';
        if (modeBadge) { modeBadge.textContent = 'Kotak Live (0 Brokerage)'; modeBadge.className = 'text-green'; }
        if (btnLogoutEl) btnLogoutEl.classList.remove('hidden');
        if (btnOwnerLoginEl) btnOwnerLoginEl.classList.add('hidden');
        if (menuTitle) menuTitle.textContent = 'Kotak Live Account';
        if (menuSub) menuSub.textContent = '0 Brokerage F&O Enabled';
        if (sessionBadge) sessionBadge.classList.remove('hidden');
      } else {
        if (pill) { pill.className = 'ex-acc-pill demo'; pill.textContent = 'Demo'; }
        if (idEl) idEl.textContent = '#GUEST-8842';
        if (modeBadge) { modeBadge.textContent = 'Demo Paper Trading'; modeBadge.className = 'mode-badge-demo'; }
        if (btnLogoutEl) btnLogoutEl.classList.add('hidden');
        if (btnOwnerLoginEl) btnOwnerLoginEl.classList.remove('hidden');
        if (menuTitle) menuTitle.textContent = 'Guest Demo Mode';
        if (menuSub) menuSub.textContent = 'Virtual paper trading active';
        if (sessionBadge) sessionBadge.classList.add('hidden');
      }
    }

    // 5-minute Inactivity Timer Interval
    clearInterval(inactivityTimerInterval);
    inactivityTimerInterval = setInterval(() => {
      if (!isOwner) return;
      const elapsed = Date.now() - lastUserActivity;
      const remainingMs = INACTIVITY_TIMEOUT_MS - elapsed;

      if (remainingMs <= 0) {
        // Auto-logout
        ownerToken = '';
        localStorage.removeItem('neo_owner_token');
        isOwner = false;
        updateAuthModeUI(false);
        toast('Session expired due to 5 minutes of inactivity. Switched to Guest Demo Mode.');
        if (gateModal) gateModal.classList.remove('hidden');
      } else if (sessionTimerText) {
        const totalSec = Math.floor(remainingMs / 1000);
        const mins = Math.floor(totalSec / 60);
        const secs = totalSec % 60;
        sessionTimerText.textContent = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
      }
    }, 1000);

    checkSession();
  }

  // --- Setup Guide Modal ---
  function setupGuideModal() {
    const guideModal = $('modal-setup-guide');
    const openBtn = $('btn-setup-guide');
    const railBtn = $('rail-btn-guide');
    const menuBtn = $('btn-open-guide-from-menu');
    const closeBtn = $('btn-close-guide');

    function openGuide() {
      if (guideModal) guideModal.classList.remove('hidden');
    }
    function closeGuide() {
      if (guideModal) guideModal.classList.add('hidden');
    }

    if (openBtn) openBtn.addEventListener('click', openGuide);
    if (railBtn) railBtn.addEventListener('click', openGuide);
    if (menuBtn) menuBtn.addEventListener('click', openGuide);
    if (closeBtn) closeBtn.addEventListener('click', closeGuide);
  }

  // --- Indicators Dropdown & Layout Switcher ---
  function setupIndicatorsMenu() {
    const btn = $('btn-indicators-dropdown');
    const railBtn = $('rail-btn-indicators');
    const menu = $('indicators-menu');

    function toggleMenu(e) {
      if (e) e.stopPropagation();
      menu.classList.toggle('hidden');
    }

    if (btn && menu) btn.addEventListener('click', toggleMenu);
    if (railBtn && menu) railBtn.addEventListener('click', toggleMenu);

    document.addEventListener('click', e => {
      if (menu && !menu.contains(e.target) && e.target !== btn && e.target !== railBtn) {
        menu.classList.add('hidden');
      }
    });

    const mapping = [
      { id: 'chk-ind-ema9', key: 'showEma9' },
      { id: 'chk-ind-ema21', key: 'showEma21' },
      { id: 'chk-ind-vwap', key: 'showVwap' },
      { id: 'chk-ind-supertrend', key: 'showSupertrend' },
      { id: 'chk-ind-vpvr', key: 'showVpvr' },
      { id: 'chk-ind-vol', key: 'showVol' },
      { id: 'chk-ind-bb', key: 'showBb' },
      { id: 'chk-ind-ema50', key: 'showEma50' },
      { id: 'chk-ind-ema200', key: 'showEma200' },
    ];

    mapping.forEach(({ id, key }) => {
      const el = $(id);
      if (el) {
        el.checked = indicators[key];
        el.addEventListener('change', () => {
          indicators[key] = el.checked;
          panes.forEach(applyPaneIndicators);
        });
      }
    });

    // Timeframe Buttons
    document.querySelectorAll('.ex-tf-btn').forEach(tfBtn => {
      tfBtn.addEventListener('click', () => {
        document.querySelectorAll('.ex-tf-btn').forEach(b => b.classList.remove('active'));
        tfBtn.classList.add('active');
        panes[0].tf = tfBtn.dataset.tf;
        loadCandles(panes[0]);
      });
    });

    // Layout Dropdown
    const lBtn = $('layout-toggle-btn');
    const lDrop = $('layout-dropdown');
    const lLbl = $('current-layout-label');
    const stage = $('chart-stage');

    if (lBtn && lDrop) {
      lBtn.addEventListener('click', e => {
        e.stopPropagation();
        lDrop.classList.toggle('hidden');
      });
      document.addEventListener('click', () => lDrop.classList.add('hidden'));

      document.querySelectorAll('.layout-opt').forEach(opt => {
        opt.addEventListener('click', () => {
          document.querySelectorAll('.layout-opt').forEach(o => o.classList.remove('active'));
          opt.classList.add('active');
          const lay = parseInt(opt.dataset.layout) || 1;
          activeLayout = lay;
          stage.className = `ex-chart-stage layout-${lay}`;
          if (lLbl) lLbl.textContent = `${lay} CHART${lay > 1 ? 'S' : ''}`;

          // Initialize pane charts if not yet done
          if (lay >= 2 && !panes[1].chart) {
            initChartPane(panes[1]);
            loadCandles(panes[1]);
          }
          if (lay === 3 && !panes[2].chart) {
            initChartPane(panes[2]);
            loadCandles(panes[2]);
          }

          panes.forEach(p => {
            if (p.chart) p.chart.timeScale().fitContent();
          });
        });
      });
    }
  }

  // --- Upstox Token Setup Modal ---
  function setupTokenModal() {
    const modal = $('token-modal');
    const openBtn = $('chart-token-btn');
    const closeBtn = $('close-token-modal');
    const saveBtn = $('save-token-submit');
    const input = $('upstox-token-val');
    const statusPill = $('token-status-pill');

    if (openBtn) {
      openBtn.addEventListener('click', async () => {
        modal.classList.remove('hidden');
        const st = await api('/api/chart/upstox-status').catch(() => ({}));
        if (statusPill) {
          statusPill.textContent = st.token_configured ? `Active (${st.token_preview})` : 'No Token Configured';
          statusPill.className = `token-status-pill ${st.token_configured ? 'active' : ''}`;
        }
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
    }

    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const tokenVal = input.value.trim();
        if (!tokenVal) {
          toast('Please enter a valid Upstox Access Token');
          return;
        }
        try {
          const res = await api('/api/chart/upstox-token', {
            method: 'POST',
            body: JSON.stringify({ token: tokenVal }),
          });
          if (res.ok) {
            toast('✅ Upstox token saved successfully!');
            modal.classList.add('hidden');
            loadCandles(panes[0]);
          }
        } catch (e) {
          toast(`❌ ${e.message}`);
        }
      });
    }
  }

  // --- Bootloader ---
  window.addEventListener('DOMContentLoaded', () => {
    initChartPane(panes[0]);
    renderSymbolTabs();
    setupOrderPanelInteractions();
    setupLeftDrawer();
    setupBottomPanel();
    setupOptionChainModal();
    setupGatekeeper();
    setupGuideModal();
    setupIndicatorsMenu();
    setupTokenModal();

    loadCandles(panes[0]);
    startQuotesPolling();
    fetchPositionsAndOrders();

    // Regular position refresh
    setInterval(fetchPositionsAndOrders, 4000);
  });
})();
