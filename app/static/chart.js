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
  let updateLotDisplayFn = null;
  let openKeysModalFn = null;
  let cachedPositions = [];
  let cachedOrders = [];
  let cachedClosedPositions = [];
  let cachedExecutions = [];
  let cachedPnlSummary = {};
  let updateMobileOrdersFn = null;

  // Symbol metadata cache (populated from Upstox/Kotak search & option chain)
  const symbolMeta = {};

  function isOptionSymbol(sym) {
    const s = String(sym || '').trim().toUpperCase();
    return /\d\s*(?:CE|PE)(?:\b|$)/i.test(s);
  }

  function registerSymbolMeta(sym, meta = {}) {
    const key = String(sym || '').trim().toUpperCase();
    if (!key) return;
    const prev = symbolMeta[key] || {};
    symbolMeta[key] = {
      ...prev,
      ...meta,
      lotSize: Number(meta.lotSize || meta.lot_size || prev.lotSize || 0) || prev.lotSize || 0,
      segment: meta.segment || prev.segment || (isOptionSymbol(key) ? 'NSE_FO' : ''),
    };
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Open Symbol Tabs
  let openTabs = [
    { symbol: 'NIFTY 25000 CE', token: '', interval: '1m', isOption: true, rangeDays: 5 },
    { symbol: 'NIFTY 25000 PE', token: '', interval: '1m', isOption: true, rangeDays: 5 },
    { symbol: 'NIFTY', token: 'NSE_INDEX|Nifty 50', interval: '5m', isOption: false, rangeDays: 5 },
    { symbol: 'BANKNIFTY', token: 'NSE_INDEX|Nifty Bank', interval: '5m', isOption: false, rangeDays: 5 },
  ];
  let activeTabIndex = 0;

  // Watchlist Favorites & Category lists
  const WATCHLIST_PRESETS = {
    favorites: [
      { symbol: 'NIFTY 25000 CE', name: 'Nifty 50 25000 Call', token: '', signal: 'BUY' },
      { symbol: 'NIFTY 25000 PE', name: 'Nifty 50 25000 Put', token: '', signal: 'SELL' },
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
      { symbol: 'NIFTY 25000 CE', name: 'ATM 25000 Call', token: '', signal: 'BUY' },
      { symbol: 'NIFTY 25000 PE', name: 'ATM 25000 Put', token: '', signal: 'SELL' },
      { symbol: 'NIFTY 25050 CE', name: 'OTM 25050 Call', token: '', signal: 'BUY' },
      { symbol: 'NIFTY 24950 PE', name: 'OTM 24950 Put', token: '', signal: 'SELL' },
    ],
    bank_options: [
      { symbol: 'BANKNIFTY 52000 CE', name: 'Bank 52000 Call', token: '', signal: 'BUY' },
      { symbol: 'BANKNIFTY 52000 PE', name: 'Bank 52000 Put', token: '', signal: 'SELL' },
      { symbol: 'BANKNIFTY 52200 CE', name: 'Bank 52200 Call', token: '', signal: 'BUY' },
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
      token: '',
      tf: '1m',
      rangeDays: 5,
      isOption: true,
      candles: [],
      volumes: [],
      chart: null,
      container: null,
      canvasWrap: null,
      _ro: null,
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
      token: '',
      tf: '1m',
      rangeDays: 5,
      isOption: true,
      candles: [],
      volumes: [],
      chart: null,
      container: null,
      canvasWrap: null,
      _ro: null,
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
      rangeDays: 5,
      isOption: false,
      candles: [],
      volumes: [],
      chart: null,
      container: null,
      canvasWrap: null,
      _ro: null,
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
    panes[0].isOption = isOptionSymbol(qSym);
    openTabs[0].symbol = panes[0].sym;
    openTabs[0].token = panes[0].token;
    openTabs[0].isOption = panes[0].isOption;
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

  // --- Pane DOM Lookup Helpers ---
  function getPanePrefix(pane) {
    return `p${(pane && typeof pane.idx === 'number' ? pane.idx : 0) + 1}`;
  }

  function getPaneCanvasWrap(pane) {
    return $(`${getPanePrefix(pane)}-canvas-wrap`);
  }

  function getPaneContainer(pane) {
    return $(`${getPanePrefix(pane)}-chart-container`);
  }

  function getPaneVpvrCanvas(pane) {
    return $(`${getPanePrefix(pane)}-vpvr-canvas`);
  }

  function resizePaneChart(pane) {
    if (!pane || !pane.chart) return;
    const canvasWrap = getPaneCanvasWrap(pane);
    const container = getPaneContainer(pane);
    const targetEl = canvasWrap || container;
    if (!targetEl) return;
    const cr = targetEl.getBoundingClientRect();
    const w = Math.floor(cr.width || targetEl.clientWidth || 0);
    const h = Math.floor(cr.height || targetEl.clientHeight || 0);
    if (w > 40 && h > 40) {
      if (typeof pane.chart.resize === 'function') {
        pane.chart.resize(w, h);
      } else {
        pane.chart.applyOptions({ width: w, height: h });
      }
      renderVPVR(pane);
    }
  }

  // --- Lightweight Charts Initialization ---
  function initChartPane(pane) {
    if (!pane) return;
    if (typeof LightweightCharts === 'undefined' || typeof LightweightCharts.createChart !== 'function') {
      console.error('[Chart] LightweightCharts library is not loaded');
      return;
    }

    const container = getPaneContainer(pane);
    const canvasWrap = getPaneCanvasWrap(pane);
    if (!container) return;

    if (pane._ro) {
      try { pane._ro.disconnect(); } catch (_) {}
      pane._ro = null;
    }
    if (pane.chart) {
      try { pane.chart.remove(); } catch (_) {}
      pane.chart = null;
    }

    container.innerHTML = '';
    pane.container = container;
    pane.canvasWrap = canvasWrap;

    const rect = canvasWrap ? canvasWrap.getBoundingClientRect() : container.getBoundingClientRect();
    const fallbackW = window.innerWidth <= 768 ? window.innerWidth : Math.max(360, window.innerWidth - 620);
    const fallbackH = window.innerWidth <= 768 ? Math.max(180, window.innerHeight - 260) : Math.max(240, window.innerHeight - 360);
    const initW = Math.max(200, Math.floor((rect && rect.width) || container.clientWidth || fallbackW));
    const initH = Math.max(140, Math.floor((rect && rect.height) || container.clientHeight || fallbackH));

    const chart = LightweightCharts.createChart(container, {
      width: initW,
      height: initH,
      layout: {
        background: { type: 'solid', color: '#0e1117' },
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
        scaleMargins: { top: 0.08, bottom: 0.18 },
        autoScale: true,
      },
      timeScale: {
        borderColor: '#202735',
        timeVisible: true,
        secondsVisible: pane.tf.includes('s'),
        rightOffset: 6,
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

    // Volume Series (confined to bottom 18% via LWC v4 priceScale().applyOptions)
    const volSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol_overlay',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    try {
      volSeries.priceScale().applyOptions({
        scaleMargins: { top: 0.82, bottom: 0 },
      });
    } catch (_) {}

    // Indicators Series (hide extra horizontal price lines so live LTP stands out clearly)
    const ema9Series = chart.addLineSeries({ color: '#00d2d3', lineWidth: 1.5, title: 'EMA 9', priceLineVisible: false, lastValueVisible: false });
    const ema21Series = chart.addLineSeries({ color: '#fb8500', lineWidth: 1.5, title: 'EMA 21', priceLineVisible: false, lastValueVisible: false });
    const ema50Series = chart.addLineSeries({ color: '#8e44ad', lineWidth: 1.5, title: 'EMA 50', priceLineVisible: false, lastValueVisible: false });
    const ema200Series = chart.addLineSeries({ color: '#ffb703', lineWidth: 2, title: 'EMA 200', priceLineVisible: false, lastValueVisible: false });
    const vwapSeries = chart.addLineSeries({ color: '#9b59b6', lineWidth: 2, title: 'VWAP', priceLineVisible: false, lastValueVisible: false });
    const supertrendSeries = chart.addLineSeries({ color: '#00b074', lineWidth: 2, title: 'Supertrend', priceLineVisible: false, lastValueVisible: false });
    const bbUpperSeries = chart.addLineSeries({ color: 'rgba(30, 136, 229, 0.6)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const bbBasisSeries = chart.addLineSeries({ color: '#1e88e5', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });
    const bbLowerSeries = chart.addLineSeries({ color: 'rgba(30, 136, 229, 0.6)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });

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

    pane.vpvrCanvas = getPaneVpvrCanvas(pane);
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
    const observeTarget = canvasWrap || container;
    if (window.ResizeObserver && observeTarget) {
      const ro = new ResizeObserver(entries => {
        for (const entry of entries) {
          const cr = entry.contentRect;
          const w = Math.floor(cr.width);
          const h = Math.floor(cr.height);
          if (w > 40 && h > 40 && pane.chart) {
            if (typeof pane.chart.resize === 'function') {
              pane.chart.resize(w, h);
            } else {
              pane.chart.applyOptions({ width: w, height: h });
            }
            renderVPVR(pane);
          }
        }
      });
      ro.observe(observeTarget);
      pane._ro = ro;
    }
  }

  function clearPaneChartData(pane) {
    if (!pane) return;
    pane.candles = [];
    pane.volumes = [];
    pane.activeBar = null;
    pane.vpvrData = { bins: [], pocPrice: null, maxVol: 0 };
    [
      pane.candleSeries,
      pane.volSeries,
      pane.ema9Series,
      pane.ema21Series,
      pane.ema50Series,
      pane.ema200Series,
      pane.vwapSeries,
      pane.supertrendSeries,
      pane.bbUpperSeries,
      pane.bbBasisSeries,
      pane.bbLowerSeries,
    ].forEach(s => {
      if (s) {
        try { s.setData([]); } catch (_) {}
      }
    });
    if (pane.vpvrCtx && pane.vpvrCanvas) {
      pane.vpvrCtx.clearRect(0, 0, pane.vpvrCanvas.width, pane.vpvrCanvas.height);
    }
  }

  function applyPaneIndicators(pane) {
    if (!pane || !pane.chart || !pane.candleSeries || !pane.candles.length) return;

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

    if (quote.prev_close !== undefined && Number(quote.prev_close) > 0 && Math.abs(Number(quote.prev_close) - ltp) > 1e-6) {
      pane.prevClose = Number(quote.prev_close);
    } else if (quote.change !== undefined && Number(quote.change) !== 0) {
      pane.prevClose = ltp - Number(quote.change);
    } else if (quote.prev_close !== undefined && Number(quote.prev_close) > 0 && !pane.prevClose) {
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
      if (!pane) return;
      pane._reqId = (pane._reqId || 0) + 1;
      const reqId = pane._reqId;

      if (!pane.chart || !pane.candleSeries) {
        initChartPane(pane);
      }

      const tokenEnc = encodeURIComponent(pane.token || '');
      const symEnc = encodeURIComponent(pane.sym);
      const reqDays = Math.max(1, Math.min(Number(pane.rangeDays || 5), 365));
      const url = `/api/chart/candles?symbol=${symEnc}&token=${tokenEnc}&interval=${encodeURIComponent(pane.tf)}&days=${reqDays}`;
      const data = await api(url);
      if (reqId !== pane._reqId) return;

      const prefix = getPanePrefix(pane);
      const pSym = $(`${prefix}-sym`);
      const pTf = $(`${prefix}-tf`);
      const paneEl = $(pane.id);
      const segBadge = paneEl ? paneEl.querySelector('.pane-seg') : null;
      const ikey = String((data && data.instrument_key) || pane.token || '');
      const isOptResolved = Boolean(data && data.is_option) || isOptionSymbol(pane.sym) || ikey.includes('NSE_FO|');
      pane.isOption = isOptionSymbol(pane.sym) || isOptResolved;
      const segLabel = isOptResolved ? 'NSE F&O' : (ikey.includes('_INDEX') ? 'NSE INDEX' : 'NSE EQ');
      if (ikey) {
        registerSymbolMeta(pane.sym, { segment: ikey.split('|')[0] || segLabel });
      }

      if (pSym) pSym.textContent = pane.sym;
      if (pTf) pTf.textContent = pane.tf;
      if (segBadge) segBadge.textContent = segLabel;

      if (pane.idx === 0) {
        const topSym = $('chart-active-sym');
        const topSeg = $('chart-active-seg');
        const opSym = $('op-sym-name');
        if (topSym) topSym.textContent = pane.sym;
        if (topSeg) topSeg.textContent = segLabel;
        if (opSym) opSym.textContent = pane.sym;
        if (typeof updateLotDisplayFn === 'function') updateLotDisplayFn();
      }

      if (!data || !data.ok || !data.candles || !data.candles.length) {
        clearPaneChartData(pane);
        return;
      }

      if (!pane.chart || !pane.candleSeries) {
        initChartPane(pane);
      }
      if (!pane.candleSeries || !pane.volSeries) return;

      pane.chart.timeScale().applyOptions({ secondsVisible: String(pane.tf || '').includes('s') });

      if (data.prev_close) pane.prevClose = Number(data.prev_close);
      if (data.ltp) pane.lastLtp = Number(data.ltp);

      // Ensure ascending unique timestamps for LightweightCharts setData
      const byTime = new Map();
      data.candles.forEach(c => {
        const t = Number(c.time);
        if (!Number.isFinite(t)) return;
        byTime.set(t, {
          time: t,
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
          volume: Number(c.volume || 0),
        });
      });
      pane.candles = Array.from(byTime.values()).sort((a, b) => a.time - b.time);

      const isIndexInst = ikey.startsWith('NSE_INDEX|') || ikey.startsWith('BSE_INDEX|');
      pane.volumes = pane.candles.map(c => ({
        time: c.time,
        value: isIndexInst ? 0 : (c.volume || 0),
        color: c.close >= c.open ? 'rgba(0, 176, 116, 0.4)' : 'rgba(255, 71, 87, 0.4)',
      }));

      pane.candleSeries.setData(pane.candles);
      applyPaneIndicators(pane);

      // Fit container dimensions and content robustly
      function refitPane() {
        if (!pane.chart || reqId !== pane._reqId) return;
        resizePaneChart(pane);
        try {
          pane.chart.timeScale().fitContent();
        } catch (_) {}
      }
      refitPane();
      requestAnimationFrame(refitPane);
      setTimeout(refitPane, 60);
      setTimeout(refitPane, 250);

      const lastBar = pane.candles[pane.candles.length - 1];
      if (lastBar) {
        pane.activeBar = { ...lastBar };
        updatePaneHeaderQuote(pane, lastBar.open, lastBar.high, lastBar.low, lastBar.close);
        updatePaneQuote(pane, {
          ltp: Number(data.ltp || lastBar.close),
          prev_close: pane.prevClose || Number(data.prev_close || lastBar.open),
          change: data.change,
        });
      }
    } catch (err) {
      console.warn(`[Candles] Failed loading candles for ${pane && pane.sym}:`, err && err.message ? err.message : err);
    }
  }

  // --- Sub-second Quotes Stream ---
  function startQuotesPolling() {
    let pollTickCount = 0;
    async function tick() {
      try {
        pollTickCount += 1;
        const visibleCount = activeLayout === 3 ? 3 : (activeLayout === 2 ? 2 : 1);
        const activePanes = panes.slice(0, visibleCount);
        const items = activePanes.map(p => ({ symbol: p.sym, token: p.token }));
        const res = await api('/api/chart/live-quotes', {
          method: 'POST',
          body: JSON.stringify({ items }),
        });
        if (res && res.ok && res.quotes) {
          const qList = Array.isArray(res.quotes) ? res.quotes : Object.values(res.quotes);
          const qMap = res.quotes_by_symbol || {};
          qList.forEach(q => { if (q && q.symbol) qMap[q.symbol] = q; });

          activePanes.forEach(pane => {
            const q = qMap[pane.sym];
            if (q && q.ltp && !q.is_fallback) {
              updatePaneQuote(pane, q);
              // Update live candle bar safely only if series initialized and scale matches
              if (pane.candleSeries && pane.activeBar && q.ltp > 0) {
                const ltp = Number(q.ltp);
                if (pane.activeBar.close > 0 && Math.abs(ltp - pane.activeBar.close) / pane.activeBar.close < 0.25) {
                  pane.activeBar.close = ltp;
                  if (ltp > pane.activeBar.high) pane.activeBar.high = ltp;
                  if (ltp < pane.activeBar.low) pane.activeBar.low = ltp;
                  try {
                    pane.candleSeries.update(pane.activeBar);
                  } catch (_) {}
                  updatePaneHeaderQuote(pane, pane.activeBar.open, pane.activeBar.high, pane.activeBar.low, pane.activeBar.close);
                }
              }
            }
          });
        }
        if (pollTickCount % 15 === 0) {
          updateWatchlistQuotes();
        }
      } catch (e) {
        // quiet error
      }
      setTimeout(tick, 100); // 100ms ultra-fast quote refresh for real-time ticket & chart
    }
    tick();
  }

  // --- Exness Order Ticket Controls ---
  function getIndexLotSize(symbol) {
    const s = String(symbol || '').trim().toUpperCase();
    if (symbolMeta[s] && Number(symbolMeta[s].lotSize) > 0) {
      return Number(symbolMeta[s].lotSize);
    }
    const isDeriv = isOptionSymbol(s) || /\bFUT\b/i.test(s) || s === 'NIFTY' || s === 'BANKNIFTY' || s === 'FINNIFTY' || s === 'MIDCPNIFTY' || s === 'SENSEX' || s === 'BANKEX';
    if (!isDeriv) return 1; // Equities & ETFs (e.g. RELIANCE, MARUTI, NIFTYBEES)
    if (s.includes('BANKNIFTY')) return 30;
    if (s.includes('MIDCPNIFTY')) return 120;
    if (s.includes('FINNIFTY')) return 60;
    if (s.includes('SENSEX')) return 10;
    if (s.includes('BANKEX')) return 30;
    if (s.includes('NIFTY')) return 65;
    return 1;
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

    // Auto-fill limit / trigger price inputs if empty or not manually overridden
    const limitInput = $('input-limit-price');
    if (limitInput && (!limitInput.value || limitInput.dataset.manual !== 'true')) {
      limitInput.value = ltp.toFixed(2);
    }
    const trigInput = $('input-trigger-price');
    if (trigInput && (!trigInput.value || trigInput.dataset.manual !== 'true')) {
      trigInput.value = Math.max(0.05, ltp - 0.5).toFixed(2);
    }

    // Update Mobile Trade Dock (Screenshot 5)
    const mSell = $('m-sell-price');
    const mBuy = $('m-buy-price');
    const mSpread = $('m-spread-val');
    const mMargin = $('m-margin-val');
    if (mSell) mSell.textContent = bidPrice.toFixed(2);
    if (mBuy) mBuy.textContent = askPrice.toFixed(2);
    if (mSpread) mSpread.textContent = spread.toFixed(2);
    if (mMargin) mMargin.textContent = `₹${Number(estMargin).toLocaleString('en-IN')}`;
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
      selectedLots = Math.max(1, parseInt(inputLots ? inputLots.value : selectedLots) || 1);
      if (inputLots) inputLots.value = selectedLots;
      const lotSize = getIndexLotSize(panes[0].sym);
      const units = selectedLots * lotSize;
      if (unitsSub) {
        if (lotSize === 1) {
          unitsSub.textContent = `${units} share${units > 1 ? 's' : ''}`;
        } else {
          unitsSub.textContent = `${units} units (${selectedLots} Lot${selectedLots > 1 ? 's' : ''} × ${lotSize})`;
        }
      }
      const mLotsVal = $('m-lots-val');
      if (mLotsVal) mLotsVal.textContent = selectedLots;
      if (panes[0].lastLtp) updateOrderFormPrices(panes[0].lastLtp);
    }
    updateLotDisplayFn = updateLotDisplay;

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

    // Mobile Trade Dock Buttons
    const mBtnBuy = $('m-btn-buy');
    const mBtnSell = $('m-btn-sell');
    if (mBtnBuy) mBtnBuy.addEventListener('click', () => submitOrder('BUY'));
    if (mBtnSell) mBtnSell.addEventListener('click', () => submitOrder('SELL'));

    const mLotsMinus = $('m-lots-minus');
    const mLotsPlus = $('m-lots-plus');
    if (mLotsMinus) mLotsMinus.addEventListener('click', () => {
      if (selectedLots > 1) {
        selectedLots--;
        if (inputLots) inputLots.value = selectedLots;
        updateLotDisplay();
      }
    });
    if (mLotsPlus) mLotsPlus.addEventListener('click', () => {
      selectedLots++;
      if (inputLots) inputLots.value = selectedLots;
      updateLotDisplay();
    });

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

    const btnTriggerMinus = $('btn-trigger-minus');
    const btnTriggerPlus = $('btn-trigger-plus');
    const inputTrigger = $('input-trigger-price');
    if (btnTriggerMinus && btnTriggerPlus && inputTrigger) {
      btnTriggerMinus.addEventListener('click', () => {
        const cur = parseFloat(inputTrigger.value) || (panes[0].lastLtp || 40);
        inputTrigger.value = Math.max(0.05, cur - 0.05).toFixed(2);
        inputTrigger.dataset.manual = 'true';
      });
      btnTriggerPlus.addEventListener('click', () => {
        const cur = parseFloat(inputTrigger.value) || (panes[0].lastLtp || 40);
        inputTrigger.value = (cur + 0.05).toFixed(2);
        inputTrigger.dataset.manual = 'true';
      });
      inputTrigger.addEventListener('input', () => { inputTrigger.dataset.manual = 'true'; });
    }

    // 5. Submit Order (Buy / Sell)
    async function submitOrder(side) {
      const sym = panes[0].sym;
      const lotSize = getIndexLotSize(sym);
      const qty = selectedLots * lotSize;
      const meta = symbolMeta[String(sym || '').trim().toUpperCase()] || {};
      const isFo = Boolean(
        panes[0].isOption ||
        isOptionSymbol(sym) ||
        /\bFUT\b/i.test(sym) ||
        String(meta.segment || '').toUpperCase().includes('_FO')
      );
      const seg = isFo ? 'nse_fo' : 'nse_cm';

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

      const qtyLabel = lotSize === 1
        ? `${qty} share${qty > 1 ? 's' : ''}`
        : `${selectedLots} Lot(s) (${qty} qty)`;

      try {
        toast(`Submitting ${side} ${qtyLabel} ${sym}...`);
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
        <span class="tab-name">${escapeHtml(tab.symbol)}</span>
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

  function syncToolbarForPane(pane) {
    if (!pane) return;
    document.querySelectorAll('.ex-tf-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tf === pane.tf);
    });
    const rangeDaysMap = { '1d': 5, '5d': 7, '1m': 30, '3m': 90, '6m': 180, '1y': 365 };
    document.querySelectorAll('.range-btn').forEach(b => {
      b.classList.toggle('active', (rangeDaysMap[b.dataset.range] || 5) === (pane.rangeDays || 5));
    });
  }

  function switchTab(index) {
    if (index < 0 || index >= openTabs.length) return;
    activeTabIndex = index;
    activePaneIdx = 0;
    document.querySelectorAll('.chart-pane').forEach((el, i) => {
      el.classList.toggle('active', i === 0);
    });
    renderSymbolTabs();

    const selected = openTabs[index];
    const meta = symbolMeta[String(selected.symbol || '').trim().toUpperCase()] || {};
    const segUpper = String(selected.segment || meta.segment || '').toUpperCase();
    const isOpt = isOptionSymbol(selected.symbol);
    const isFo = Boolean(isOpt || /\bFUT\b/i.test(selected.symbol) || segUpper.includes('_FO'));

    panes[0].sym = selected.symbol;
    panes[0].token = selected.token || '';
    panes[0].tf = selected.interval || '1m';
    panes[0].rangeDays = selected.rangeDays || 5;
    panes[0].isOption = isOpt;
    panes[0].lastLtp = null;
    panes[0].prevClose = null;
    clearPaneChartData(panes[0]);

    const symTitle = $('chart-active-sym');
    const symSeg = $('chart-active-seg');
    const p1Sym = $('p1-sym');
    const p1Tf = $('p1-tf');
    const pane1El = $('pane-1');
    const p1SegBadge = pane1El ? pane1El.querySelector('.pane-seg') : null;
    const isIdxSym = String(selected.token || '').includes('_INDEX') || ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'].includes(selected.symbol.toUpperCase());
    const segLabel = isFo ? 'NSE F&O' : (isIdxSym ? 'NSE INDEX' : 'NSE EQ');

    if (symTitle) symTitle.textContent = selected.symbol;
    if (symSeg) symSeg.textContent = segLabel;
    if (p1Sym) p1Sym.textContent = selected.symbol;
    if (p1Tf) p1Tf.textContent = panes[0].tf;
    if (p1SegBadge) p1SegBadge.textContent = segLabel;

    const ltpEl = $('p1-ltp');
    const chgEl = $('p1-chg');
    if (ltpEl) ltpEl.textContent = '—';
    if (chgEl) {
      chgEl.textContent = '—';
      chgEl.className = 'pane-chg pos';
    }
    updatePaneHeaderQuote(panes[0], 0, 0, 0, 0);

    const limitInput = $('input-limit-price');
    if (limitInput) {
      limitInput.value = '';
      delete limitInput.dataset.manual;
    }
    const trigInput = $('input-trigger-price');
    if (trigInput) {
      trigInput.value = '';
      delete trigInput.dataset.manual;
    }

    const opSym = $('op-sym-name');
    if (opSym) opSym.textContent = selected.symbol;

    syncToolbarForPane(panes[0]);

    if (!panes[0].chart) {
      initChartPane(panes[0]);
    }

    // Immediately update order ticket lot sizing for the selected symbol
    if (typeof updateLotDisplayFn === 'function') {
      updateLotDisplayFn();
    }

    // Instantly fetch real quote for order ticket without letting static fallback overwrite pending candles
    const reqSym = selected.symbol;
    api(`/api/chart/live-quote?symbol=${encodeURIComponent(selected.symbol)}&token=${encodeURIComponent(selected.token || '')}`)
      .then(q => {
        if (panes[0].sym !== reqSym) return;
        if (q && q.ok && q.ltp && !q.is_fallback) {
          panes[0].lastLtp = Number(q.ltp);
          if (q.prev_close) panes[0].prevClose = Number(q.prev_close);
          updateOrderFormPrices(panes[0].lastLtp);
          updatePaneQuote(panes[0], q);
        }
      })
      .catch(() => {});

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

  function addSymbolTab(sym, token = '', lotSize = 0, segment = '') {
    const cleanSym = String(sym || '').trim();
    if (!cleanSym) return;
    if (lotSize || segment) {
      registerSymbolMeta(cleanSym, { lotSize, segment });
    }
    const segUpper = String(segment || '').toUpperCase();
    const isOpt = isOptionSymbol(cleanSym);
    const existing = openTabs.findIndex(t => t.symbol.toUpperCase() === cleanSym.toUpperCase());
    if (existing >= 0) {
      if (token && !openTabs[existing].token) {
        openTabs[existing].token = token;
      }
      if (segment && !openTabs[existing].segment) {
        openTabs[existing].segment = segment;
      }
      switchTab(existing);
      return;
    }
    openTabs.push({
      symbol: cleanSym,
      token: token || '',
      interval: '1m',
      rangeDays: 5,
      isOption: isOpt || segUpper === 'NSE_FO' || /\bFUT\b/i.test(cleanSym),
      segment: segment || '',
    });
    activeTabIndex = openTabs.length - 1;
    renderSymbolTabs();
    switchTab(activeTabIndex);
  }

  // --- Quick Instrument Search & Tab Add Button ---
  function setupAddTabButton() {
    const addBtn = $('btn-add-tab');
    const popup = $('quick-tab-search-popup');
    const input = $('quick-tab-search-input');
    const resultsBox = $('quick-tab-search-results');
    const leftPanel = $('ex-left-panel');

    if (!addBtn) return;

    function openSearchPopup(e) {
      if (e) e.stopPropagation();
      if (leftPanel) leftPanel.classList.remove('collapsed');
      if (popup) {
        popup.classList.toggle('hidden');
        if (!popup.classList.contains('hidden') && input) {
          if (!input.value.trim() && resultsBox) {
            resultsBox.innerHTML = '<div class="quick-search-hint">Type 3+ characters to search Upstox / Kotak (e.g. REL, MAR, 25000 CE)</div>';
          }
          input.focus();
          input.select();
        }
      }
    }

    addBtn.addEventListener('click', openSearchPopup);

    document.addEventListener('click', e => {
      if (popup && !popup.contains(e.target) && e.target !== addBtn) {
        popup.classList.add('hidden');
      }
    });

    let debounceTimer = null;
    let quickSearchSeq = 0;
    if (input && resultsBox) {
      input.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        const q = input.value.trim();
        if (q.length === 0) {
          resultsBox.innerHTML = '<div class="quick-search-hint">Type 3+ characters to search Upstox / Kotak (e.g. REL, MAR, 25000 CE)</div>';
          return;
        }
        if (q.length < 3) {
          const need = 3 - q.length;
          resultsBox.innerHTML = `<div class="quick-search-hint">Type ${need} more character${need > 1 ? 's' : ''} to search Upstox &amp; Kotak…</div>`;
          return;
        }

        const reqSeq = ++quickSearchSeq;
        debounceTimer = setTimeout(async () => {
          try {
            resultsBox.innerHTML = '<div class="quick-search-hint">Searching Upstox &amp; Kotak…</div>';
            const data = await api(`/api/chart/search?q=${encodeURIComponent(q)}`);
            if (reqSeq !== quickSearchSeq) return;
            if (data.ok && data.results && data.results.length) {
              resultsBox.innerHTML = '';
              data.results.forEach(r => {
                registerSymbolMeta(r.symbol, { lotSize: r.lot_size, segment: r.segment });
                const item = document.createElement('div');
                item.className = 'quick-search-item';
                const hasSubName = r.name && r.name.toUpperCase() !== r.symbol.toUpperCase();
                item.innerHTML = `
                  <div class="item-main">
                    <b>${escapeHtml(r.symbol)}</b>
                    ${hasSubName ? `<div class="ex-search-row-sub">${escapeHtml(r.name)}</div>` : ''}
                  </div>
                  <div class="item-sub">${escapeHtml(r.segment || 'NSE')}</div>
                `;
                item.addEventListener('click', () => {
                  addSymbolTab(r.symbol, r.token || '', r.lot_size || 0, r.segment || '');
                  popup.classList.add('hidden');
                  input.value = '';
                });
                resultsBox.appendChild(item);
              });
            } else {
              resultsBox.innerHTML = '<div class="quick-search-hint">No matching symbols on Upstox / Kotak</div>';
            }
          } catch (err) {
            if (reqSeq !== quickSearchSeq) return;
            resultsBox.innerHTML = `<div class="quick-search-hint" style="color:var(--bear);">Error: ${escapeHtml(err.message)}</div>`;
          }
        }, 160);
      });

      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          const first = resultsBox.querySelector('.quick-search-item');
          if (first) first.click();
        } else if (e.key === 'Escape') {
          popup.classList.add('hidden');
        }
      });
    }
  }

  // --- Left Collapsible Instruments Watchlist ---
  function setupLeftDrawer() {
    const leftPanel = $('ex-left-panel');
    const btnCollapse = $('btn-collapse-drawer');
    const railBtnInst = $('rail-btn-instruments');
    const railBtnSettings = $('rail-btn-settings');

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

    if (railBtnSettings) {
      railBtnSettings.addEventListener('click', () => {
        if (typeof openKeysModalFn === 'function') {
          openKeysModalFn();
        } else {
          const km = $('modal-api-keys');
          if (km) km.classList.remove('hidden');
        }
      });
    }

    // Category filter dropdown
    const catSelect = $('ex-inst-category');
    if (catSelect) {
      catSelect.addEventListener('change', () => {
        renderInstrumentsList(catSelect.value);
      });
    }

    // Search input (triggers live Upstox/Kotak API search from 3+ chars)
    const searchInput = $('ex-inst-search');
    const searchDropdown = $('ex-inst-search-results');
    let searchDebounce = null;
    let drawerSearchSeq = 0;

    if (searchInput && searchDropdown) {
      searchInput.addEventListener('input', () => {
        clearTimeout(searchDebounce);
        const q = searchInput.value.trim();
        if (q.length === 0) {
          searchDropdown.classList.add('hidden');
          searchDropdown.innerHTML = '';
          return;
        }
        if (q.length < 3) {
          const need = 3 - q.length;
          searchDropdown.innerHTML = `<div class="quick-search-hint">Type ${need} more character${need > 1 ? 's' : ''} to search Upstox &amp; Kotak…</div>`;
          searchDropdown.classList.remove('hidden');
          return;
        }

        const reqSeq = ++drawerSearchSeq;
        searchDropdown.innerHTML = '<div class="quick-search-hint">Searching Upstox &amp; Kotak…</div>';
        searchDropdown.classList.remove('hidden');

        searchDebounce = setTimeout(async () => {
          try {
            const data = await api(`/api/chart/search?q=${encodeURIComponent(q)}`);
            if (reqSeq !== drawerSearchSeq) return;
            if (data.ok && data.results && data.results.length) {
              searchDropdown.innerHTML = '';
              data.results.slice(0, 15).forEach(r => {
                registerSymbolMeta(r.symbol, { lotSize: r.lot_size, segment: r.segment });
                const item = document.createElement('div');
                item.className = 'acc-menu-item ex-search-result-item';
                const hasSubName = r.name && r.name.toUpperCase() !== r.symbol.toUpperCase();
                item.innerHTML = `
                  <div style="display:flex;flex-direction:column;min-width:0;flex:1;">
                    <b>${escapeHtml(r.symbol)}</b>
                    ${hasSubName ? `<span class="ex-search-row-sub">${escapeHtml(r.name)}</span>` : ''}
                  </div>
                  <small style="margin-left:8px;color:#8b95a5;white-space:nowrap;">${escapeHtml(r.segment || 'NSE')}</small>
                `;
                item.addEventListener('click', () => {
                  addSymbolTab(r.symbol, r.token || '', r.lot_size || 0, r.segment || '');
                  searchDropdown.classList.add('hidden');
                  searchInput.value = '';
                });
                searchDropdown.appendChild(item);
              });
              searchDropdown.classList.remove('hidden');
            } else {
              searchDropdown.innerHTML = '<div class="quick-search-hint">No matching instruments on Upstox / Kotak</div>';
              searchDropdown.classList.remove('hidden');
            }
          } catch (e) {
            if (reqSeq !== drawerSearchSeq) return;
            searchDropdown.innerHTML = `<div class="quick-search-hint" style="color:var(--bear);">Search failed: ${escapeHtml(e.message)}</div>`;
            searchDropdown.classList.remove('hidden');
          }
        }, 160);
      });

      searchInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          const first = searchDropdown.querySelector('.ex-search-result-item');
          if (first) first.click();
        } else if (e.key === 'Escape') {
          searchDropdown.classList.add('hidden');
        }
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
      tr.dataset.token = inst.token || '';
      tr.innerHTML = `
        <td>
          <div class="td-sym-wrap">
            <span class="sym-main">${escapeHtml(inst.symbol)}</span>
            <span class="sym-sub">${escapeHtml(inst.name)}</span>
          </div>
        </td>
        <td>
          <span class="sig-badge ${inst.signal.toLowerCase()}">${inst.signal === 'BUY' ? '▲' : '▼'} ${inst.signal}</span>
        </td>
        <td>
          <button type="button" class="btn-price-bid" data-sym="${escapeHtml(inst.symbol)}" title="Sell @ Bid">—</button>
        </td>
        <td>
          <button type="button" class="btn-price-ask" data-sym="${escapeHtml(inst.symbol)}" title="Buy @ Ask">—</button>
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
        const op = $('ex-order-panel');
        if (op) op.classList.remove('collapsed');
      });
      askBtn.addEventListener('click', e => {
        e.stopPropagation();
        addSymbolTab(inst.symbol, inst.token);
        const op = $('ex-order-panel');
        if (op) op.classList.remove('collapsed');
      });

      tbody.appendChild(tr);
    });

    // Populate prices for watchlist
    updateWatchlistQuotes();
  }

  async function updateWatchlistQuotes() {
    try {
      const rows = document.querySelectorAll('.ex-inst-row');
      const symbols = Array.from(rows).map(r => ({
        symbol: r.querySelector('.sym-main').textContent.trim(),
        token: r.dataset.token || '',
      }));
      if (!symbols.length) return;

      const data = await api('/api/chart/live-quotes', {
        method: 'POST',
        body: JSON.stringify({ items: symbols }),
      });

      if (data && data.ok && data.quotes) {
        const qList = Array.isArray(data.quotes) ? data.quotes : Object.values(data.quotes);
        const qMap = data.quotes_by_symbol || {};
        qList.forEach(q => { if (q && q.symbol) qMap[q.symbol] = q; });

        rows.forEach(r => {
          const symEl = r.querySelector('.sym-main');
          if (!symEl) return;
          const sym = symEl.textContent.trim();
          const q = qMap[sym];
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
    const btnHistory = $('tab-btn-history');

    const vOpen = $('view-open-positions');
    const vPending = $('view-pending-orders');
    const vClosed = $('view-closed-trades');
    const vHistory = $('view-trade-history');

    function switchDockTab(tab) {
      [btnOpen, btnPending, btnClosed, btnHistory].forEach(b => b && b.classList.remove('active'));
      [vOpen, vPending, vClosed, vHistory].forEach(v => v && v.classList.add('hidden'));

      if (tab === 'open') {
        if (btnOpen) btnOpen.classList.add('active');
        if (vOpen) vOpen.classList.remove('hidden');
      } else if (tab === 'pending') {
        if (btnPending) btnPending.classList.add('active');
        if (vPending) vPending.classList.remove('hidden');
      } else if (tab === 'closed') {
        if (btnClosed) btnClosed.classList.add('active');
        if (vClosed) vClosed.classList.remove('hidden');
      } else if (tab === 'history') {
        if (btnHistory) btnHistory.classList.add('active');
        if (vHistory) vHistory.classList.remove('hidden');
      }
    }

    if (btnOpen) btnOpen.addEventListener('click', () => switchDockTab('open'));
    if (btnPending) btnPending.addEventListener('click', () => switchDockTab('pending'));
    if (btnClosed) btnClosed.addEventListener('click', () => switchDockTab('closed'));
    if (btnHistory) btnHistory.addEventListener('click', () => switchDockTab('history'));

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
      // 1. Open Positions
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
            const sym = p.symbol || p.trading_symbol || p.trdSym || '—';
            const side = (p.side || p.direction || (Number(p.quantity) > 0 ? 'BUY' : 'SELL')).toUpperCase();
            const qty = Math.abs(Number(p.quantity || p.qty || 0));
            const avg = Number(p.average_price || p.avg_price || p.avgPrc || 0);
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

      // 2. Funds & Equity
      const fundsData = await api('/api/funds').catch(() => ({}));
      const eqEl = $('f-equity');
      const fmEl = $('f-free-margin');
      const muEl = $('f-margin-used');
      const accBal = $('ex-acc-balance');

      if (fundsData && fundsData.funds_error) {
        const errText = 'Error: Failed to fetch';
        const errStyle = 'color: #ff4757 !important; font-weight: 700;';
        if (accBal) { accBal.textContent = errText; accBal.setAttribute('style', errStyle); }
        if (eqEl) { eqEl.textContent = errText; eqEl.setAttribute('style', errStyle); }
        if (fmEl) { fmEl.textContent = errText; fmEl.setAttribute('style', errStyle); }
        if (muEl) { muEl.textContent = '₹0.00'; }
      } else if (fundsData && fundsData.is_demo) {
        const avail = Number(fundsData.available_margin !== undefined ? fundsData.available_margin : 1000000);
        const used = Number(fundsData.used_margin || 0);
        const equity = Number(fundsData.total_equity || avail);
        const demoTag = ' (Demo)';
        if (accBal) { accBal.textContent = `₹${avail.toLocaleString('en-IN', { minimumFractionDigits: 2 })}${demoTag}`; accBal.removeAttribute('style'); }
        if (eqEl) { eqEl.textContent = `₹${equity.toLocaleString('en-IN', { minimumFractionDigits: 2 })}${demoTag}`; eqEl.removeAttribute('style'); }
        if (fmEl) { fmEl.textContent = `₹${avail.toLocaleString('en-IN', { minimumFractionDigits: 2 })}${demoTag}`; fmEl.removeAttribute('style'); }
        if (muEl) { muEl.textContent = `₹${used.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`; }
      } else if (fundsData && fundsData.available_margin !== undefined) {
        const avail = Number(fundsData.available_margin);
        const used = Number(fundsData.used_margin || 0);
        const equity = Number(fundsData.total_equity || avail);
        if (accBal) { accBal.textContent = `₹${avail.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`; accBal.removeAttribute('style'); }
        if (eqEl) { eqEl.textContent = `₹${equity.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`; eqEl.removeAttribute('style'); }
        if (fmEl) { fmEl.textContent = `₹${avail.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`; fmEl.removeAttribute('style'); }
        if (muEl) { muEl.textContent = `₹${used.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`; }
      } else {
        const errText = 'Error: Failed to fetch';
        const errStyle = 'color: #ff4757 !important; font-weight: 700;';
        if (accBal) { accBal.textContent = errText; accBal.setAttribute('style', errStyle); }
        if (eqEl) { eqEl.textContent = errText; eqEl.setAttribute('style', errStyle); }
        if (fmEl) { fmEl.textContent = errText; fmEl.setAttribute('style', errStyle); }
      }

      // 3. Orders report (Pending)
      const ordersData = await api('/api/orders').catch(() => []);
      const pendingTbody = $('pending-orders-tbody');
      const pendingCount = $('pending-orders-count');
      const allOrders = Array.isArray(ordersData) ? ordersData : [];
      const pendingList = allOrders.filter(o => o.status === 'pending');
      if (pendingCount) pendingCount.textContent = pendingList.length;

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
              <td><button type="button" class="pos-action-btn danger btn-cancel-order" data-id="${o.id}">Cancel</button></td>
            `;
            tr.querySelector('.btn-cancel-order').addEventListener('click', async () => {
              try {
                toast(`Cancelling order #${o.id}...`);
                await api(`/api/orders/${o.id}/cancel`, { method: 'POST' });
                toast(`✅ Order cancelled`);
                fetchPositionsAndOrders();
              } catch (e) {
                toast(`❌ ${e.message}`);
              }
            });
            pendingTbody.appendChild(tr);
          });
        }
      }

      // 4. Closed Positions (Accounting Lifecycles) & Summary
      const closedData = await api('/api/positions/closed').catch(() => ({ positions: [], summary: {} }));
      const pnlSummaryData = await api('/api/pnl/summary').catch(() => ({}));
      const closedTbody = $('closed-trades-tbody');
      const closedCount = $('closed-trades-count');

      const closedPositions = Array.isArray(closedData) ? closedData : (closedData.positions || []);
      const closedSummary = (!Array.isArray(closedData) && closedData.summary) ? closedData.summary : {};
      if (closedCount) closedCount.textContent = closedPositions.length;

      // Update Desktop Closed Summary Bar
      const grossEl = $('cs-gross-pnl');
      const chargesEl = $('cs-charges');
      const netEl = $('cs-net-pnl');
      const winRatioEl = $('cs-win-ratio');

      const gross = Number(closedSummary.gross_realised_pnl !== undefined ? closedSummary.gross_realised_pnl : (pnlSummaryData.total_realised_gross_pnl || 0));
      const charges = Number(closedSummary.total_charges !== undefined ? closedSummary.total_charges : (pnlSummaryData.total_charges || 0));
      const net = Number(closedSummary.net_realised_pnl !== undefined ? closedSummary.net_realised_pnl : (pnlSummaryData.total_realised_net_pnl || 0));
      const wins = Number(closedSummary.winning_positions !== undefined ? closedSummary.winning_positions : (pnlSummaryData.winning_trades || 0));
      const losses = Number(closedSummary.losing_positions !== undefined ? closedSummary.losing_positions : (pnlSummaryData.losing_trades || 0));

      if (grossEl) {
        grossEl.textContent = `${gross >= 0 ? '+' : ''}₹${gross.toFixed(2)}`;
        grossEl.className = `cs-value ${gross >= 0 ? 'pos' : 'neg'}`;
      }
      if (chargesEl) {
        chargesEl.textContent = `₹${charges.toFixed(2)}`;
      }
      if (netEl) {
        netEl.textContent = `${net >= 0 ? '+' : ''}₹${net.toFixed(2)}`;
        netEl.className = `cs-value ${net >= 0 ? 'pos' : 'neg'}`;
      }
      if (winRatioEl) {
        winRatioEl.textContent = `${wins}W / ${losses}L`;
      }

      if (closedTbody) {
        const fRealized = $('f-realized-pnl');
        if (fRealized) {
          fRealized.textContent = `${net >= 0 ? '+' : ''}₹${net.toFixed(2)}`;
          fRealized.style.color = net >= 0 ? 'var(--bull)' : 'var(--bear)';
        }
        if (!closedPositions.length) {
          closedTbody.innerHTML = '<tr><td colspan="11" class="empty-row">No closed positions recorded.</td></tr>';
        } else {
          closedTbody.innerHTML = '';
          closedPositions.forEach((cp, idx) => {
            const sym = cp.symbol || cp.trading_symbol || '—';
            const netPnl = Number(cp.realised_net_pnl !== undefined ? cp.realised_net_pnl : (cp.realised_gross_pnl || 0));
            const grossPnl = Number(cp.realised_gross_pnl || 0);
            const cpCharges = Number(cp.total_charges || 0);
            const avgBuy = Number(cp.avg_buy_price || 0);
            const avgSell = Number(cp.avg_sell_price || 0);
            const qty = Math.max(Number(cp.total_buy_quantity || 0), Number(cp.total_sell_quantity || 0));
            const side = (cp.total_buy_quantity >= cp.total_sell_quantity ? 'BUY' : 'SELL');
            const isPos = netPnl >= 0;
            const closedTime = cp.closed_at ? (cp.closed_at.split('T')[1]?.slice(0, 8) || cp.closed_at) : 'Today';

            const tr = document.createElement('tr');
            tr.innerHTML = `
              <td><b>${sym}</b></td>
              <td>${cp.product || 'NRML'}</td>
              <td><span class="side-badge ${side.toLowerCase()}">${side}</span></td>
              <td>${qty}</td>
              <td>₹${avgBuy.toFixed(2)}</td>
              <td>₹${avgSell.toFixed(2)}</td>
              <td style="color: ${grossPnl >= 0 ? 'var(--bull)' : 'var(--bear)'}; font-weight:700;">
                ${grossPnl >= 0 ? '+' : ''}₹${grossPnl.toFixed(2)}
              </td>
              <td class="text-dim">₹${cpCharges.toFixed(2)}</td>
              <td style="color: ${isPos ? 'var(--bull)' : 'var(--bear)'}; font-weight:800;">
                ${isPos ? '+' : ''}₹${netPnl.toFixed(2)}
              </td>
              <td>${closedTime}</td>
              <td>
                <button type="button" class="btn-toggle-matches" data-match-idx="${idx}">FIFO Fills ▾</button>
              </td>
            `;

            // Nested detail row for FIFO lot matches
            const detailTr = document.createElement('tr');
            detailTr.className = 'matches-details-row hidden';
            detailTr.id = `matches-row-${idx}`;
            const matches = cp.matches || [];
            let matchesHtml = '<div class="matches-nested-wrap"><h4>FIFO Execution Lot Matches:</h4>';
            if (!matches.length) {
              matchesHtml += '<p style="color:var(--text-dim);font-size:11px;margin:0;">Single lot match executed directly.</p>';
            } else {
              matchesHtml += '<table style="width:100%;font-size:11px;border-collapse:collapse;"><thead><tr style="color:var(--text-dim);text-align:left;"><th>Matched Qty</th><th>Buy Price</th><th>Sell Price</th><th>Gross P&amp;L</th><th>Matched At</th></tr></thead><tbody>';
              matches.forEach(m => {
                const mPnl = Number(m.gross_pnl || 0);
                matchesHtml += `<tr><td>${m.quantity}</td><td>₹${Number(m.buy_price).toFixed(2)}</td><td>₹${Number(m.sell_price).toFixed(2)}</td><td style="color:${mPnl >= 0 ? 'var(--bull)' : 'var(--bear)'};font-weight:700;">${mPnl >= 0 ? '+' : ''}₹${mPnl.toFixed(2)}</td><td>${m.matched_at ? m.matched_at.split('T')[1]?.slice(0, 8) || m.matched_at : 'Today'}</td></tr>`;
              });
              matchesHtml += '</tbody></table>';
            }
            matchesHtml += '</div>';
            detailTr.innerHTML = `<td colspan="11">${matchesHtml}</td>`;

            tr.querySelector('.btn-toggle-matches').addEventListener('click', (e) => {
              e.stopPropagation();
              const isHidden = detailTr.classList.contains('hidden');
              detailTr.classList.toggle('hidden', !isHidden);
              e.currentTarget.textContent = isHidden ? 'FIFO Fills ▴' : 'FIFO Fills ▾';
            });

            closedTbody.appendChild(tr);
            closedTbody.appendChild(detailTr);
          });
        }
      }

      // 5. Executions Ledger (Trade History)
      const executionsData = await api('/api/executions').catch(() => []);
      const execList = Array.isArray(executionsData) ? executionsData : [];
      const historyTbody = $('trade-history-tbody');
      const historyCount = $('trade-history-count');
      if (historyCount) historyCount.textContent = execList.length;

      if (historyTbody) {
        if (!execList.length) {
          historyTbody.innerHTML = '<tr><td colspan="10" class="empty-row">No trade executions yet.</td></tr>';
        } else {
          historyTbody.innerHTML = '';
          execList.forEach(e => {
            const sym = e.symbol || e.trading_symbol || '—';
            const side = (e.side || 'BUY').toUpperCase();
            const qty = Number(e.quantity || 0);
            const price = Number(e.price || 0);
            const turnover = (qty * price);
            const totalChg = Number(e.charges?.total_charges || 0);
            const time = e.executed_at ? (e.executed_at.split('T')[1]?.slice(0, 8) || e.executed_at) : 'Today';

            const tr = document.createElement('tr');
            tr.innerHTML = `
              <td>${time}</td>
              <td style="font-family:var(--font-mono);font-size:11px;">#${e.id || e.broker_execution_id}</td>
              <td style="font-family:var(--font-mono);font-size:11px;">${e.order_id || '—'}</td>
              <td><b>${sym}</b></td>
              <td><span class="side-badge ${side.toLowerCase()}">${side}</span></td>
              <td>${qty}</td>
              <td>₹${price.toFixed(2)}</td>
              <td>₹${turnover.toFixed(2)}</td>
              <td class="text-dim" title="STT: ₹${Number(e.charges?.stt||0).toFixed(2)}, Turnover: ₹${Number(e.charges?.turnover_charges||0).toFixed(2)}, GST: ₹${Number(e.charges?.gst||0).toFixed(2)}">₹${totalChg.toFixed(2)}</td>
              <td>${e.product || 'NRML'}</td>
            `;
            historyTbody.appendChild(tr);
          });
        }
      }

      cachedPositions = positions;
      cachedOrders = allOrders;
      cachedClosedPositions = closedPositions;
      cachedExecutions = execList;
      cachedPnlSummary = pnlSummaryData;

      if (typeof updateMobileOrdersFn === 'function') {
        updateMobileOrdersFn();
      }
    } catch (e) {
      // quiet
    }
  }

  // --- Option Chain Modal (Matching Upstox TV) ---
  function setupOptionChainModal() {
    const modal = $('option-chain-modal');
    const openBtn = $('btn-chart-opt-chain');
    const headerBtn = $('btn-header-opt-chain');
    const railBtn = $('rail-btn-option-chain');
    const closeBtn = $('close-oc-modal');
    const undSelect = $('oc-und-select');
    const expirySelect = $('oc-expiry-select');
    const spotBadge = $('oc-spot-badge');
    const tbody = $('oc-table-body');

    let currentUnd = (undSelect && undSelect.value) ? undSelect.value : 'NIFTY';

    function formatOI(val) {
      const n = Number(val) || 0;
      if (n >= 10000000) return (n / 10000000).toFixed(2) + 'Cr';
      if (n >= 100000) return (n / 100000).toFixed(2) + 'L';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
      return n > 0 ? n.toString() : '—';
    }

    function openModal() {
      if (!modal) return;
      modal.classList.remove('hidden');
      if (undSelect) currentUnd = undSelect.value;
      loadOptionChain(currentUnd);
    }

    function closeModal() {
      if (!modal) return;
      modal.classList.add('hidden');
    }

    if (openBtn) openBtn.addEventListener('click', openModal);
    if (headerBtn) headerBtn.addEventListener('click', openModal);
    if (railBtn) railBtn.addEventListener('click', openModal);
    if (closeBtn) closeBtn.addEventListener('click', closeModal);

    if (undSelect) {
      undSelect.addEventListener('change', () => {
        currentUnd = undSelect.value;
        loadOptionChain(currentUnd);
      });
    }

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
          const spot = Number(data.spot_price || 0);
          const diff = Number(data.spot_change || 0);
          spotBadge.textContent = `Spot: ₹${spot.toLocaleString('en-IN', { minimumFractionDigits: 2 })} (${diff >= 0 ? '+' : ''}${diff.toFixed(2)})`;
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

        const chainRows = data.chain || data.rows || [];
        tbody.innerHTML = '';
        if (!chainRows.length) {
          tbody.innerHTML = '<tr><td colspan="7" class="oc-loading" style="text-align:center; padding:20px; color:#8b95a5;">No active option strikes found for this expiry.</td></tr>';
          return;
        }

        // Find max OI across chain for proportional visual bars
        let maxOi = 1;
        chainRows.forEach(row => {
          const cOi = Number(row.call_oi !== undefined ? row.call_oi : (row.call && row.call.oi ? row.call.oi : 0));
          const pOi = Number(row.put_oi !== undefined ? row.put_oi : (row.put && row.put.oi ? row.put.oi : 0));
          if (cOi > maxOi) maxOi = cOi;
          if (pOi > maxOi) maxOi = pOi;
        });

        chainRows.forEach(row => {
          const strike = row.strike;
          const callSym = row.call_symbol || (row.call && row.call.symbol) || `${underlying} ${strike} CE`;
          const callTok = row.call_token || (row.call && row.call.instrument_key) || '';
          const callLtp = Number(row.call_ltp !== undefined ? row.call_ltp : (row.call && row.call.ltp ? row.call.ltp : 0));
          const callOi = Number(row.call_oi !== undefined ? row.call_oi : (row.call && row.call.oi ? row.call.oi : 0));
          const callVol = row.call_vol || (row.call && row.call.volume) || 0;

          const putSym = row.put_symbol || (row.put && row.put.symbol) || `${underlying} ${strike} PE`;
          const putTok = row.put_token || (row.put && row.put.instrument_key) || '';
          const putLtp = Number(row.put_ltp !== undefined ? row.put_ltp : (row.put && row.put.ltp ? row.put.ltp : 0));
          const putOi = Number(row.put_oi !== undefined ? row.put_oi : (row.put && row.put.oi ? row.put.oi : 0));
          const putVol = row.put_vol || (row.put && row.put.volume) || 0;

          const callOiPct = Math.min(100, Math.max(3, Math.round((callOi / maxOi) * 100)));
          const putOiPct = Math.min(100, Math.max(3, Math.round((putOi / maxOi) * 100)));

          const tr = document.createElement('tr');
          tr.className = `oc-strike-row ${row.is_atm ? 'atm-row' : ''}`;
          tr.innerHTML = `
            <td class="col-oi">
              <div class="oi-cell-wrap">
                <div class="oi-bar ce-bar" style="width: ${callOi ? callOiPct : 0}%"></div>
                <span class="oi-val">${formatOI(callOi)}</span>
              </div>
            </td>
            <td class="col-vol">${callVol ? formatOI(callVol) : '—'}</td>
            <td class="col-ltp">
              <button type="button" class="oc-ltp-btn call-ltp" data-sym="${callSym}" data-tok="${callTok}">
                ₹${callLtp ? callLtp.toFixed(2) : '—'}
              </button>
            </td>
            <td class="col-strike">
              <b>${strike}</b>
              ${row.is_atm ? '<span style="font-size:9px; color:#ffb703; display:block;">ATM</span>' : ''}
            </td>
            <td class="col-ltp">
              <button type="button" class="oc-ltp-btn put-ltp" data-sym="${putSym}" data-tok="${putTok}">
                ₹${putLtp ? putLtp.toFixed(2) : '—'}
              </button>
            </td>
            <td class="col-vol">${putVol ? formatOI(putVol) : '—'}</td>
            <td class="col-oi">
              <div class="oi-cell-wrap pe-wrap">
                <div class="oi-bar pe-bar" style="width: ${putOi ? putOiPct : 0}%"></div>
                <span class="oi-val">${formatOI(putOi)}</span>
              </div>
            </td>
          `;

          // Click Call LTP
          const callBtn = tr.querySelector('.call-ltp');
          if (callBtn) {
            callBtn.addEventListener('click', () => {
              addSymbolTab(callSym, callTok, 0, 'NSE_FO');
              closeModal();
              toast(`Loaded ${callSym} chart & ticket`);
            });
          }

          // Click Put LTP
          const putBtn = tr.querySelector('.put-ltp');
          if (putBtn) {
            putBtn.addEventListener('click', () => {
              addSymbolTab(putSym, putTok, 0, 'NSE_FO');
              closeModal();
              toast(`Loaded ${putSym} chart & ticket`);
            });
          }

          tbody.appendChild(tr);
        });
      } catch (err) {
        tbody.innerHTML = `<tr><td colspan="7" class="oc-loading" style="text-align:center; padding:20px; color:#ff4757;">Error loading chain: ${err.message}</td></tr>`;
      }
    }
  }

  // --- Gatekeeper & Modern Auth Flow (Email Check -> Admin Password or User OTP) ---
  function setupGatekeeper() {
    const gateModal = $('modal-gatekeeper');
    const emailStep = $('auth-email-step');
    const adminStep = $('auth-admin-step');
    const otpStep = $('auth-otp-step');

    const emailInput = $('auth-email-input');
    const adminPwdInput = $('auth-admin-pwd');
    const otpInput = $('auth-otp-input');
    const usernameInput = $('auth-username-input');
    const otpEmailLabel = $('auth-otp-email-label');

    const btnEnterGuest = $('btn-enter-guest');
    const btnResendOtp = $('btn-auth-resend-otp');

    const accBtn = $('ex-account-btn');
    const accMenu = $('ex-account-menu');
    const btnOpenOwner = $('btn-open-owner-login');
    const btnResetDemo = $('btn-reset-demo');
    const btnLogout = $('btn-logout');
    const sessionBadge = $('session-timer-badge');
    const sessionTimerText = $('session-timer-text');

    let pendingEmail = '';

    function showEmailStep() {
      if (emailStep) emailStep.classList.remove('hidden');
      if (adminStep) adminStep.classList.add('hidden');
      if (otpStep) otpStep.classList.add('hidden');
      if (emailInput) setTimeout(() => emailInput.focus(), 100);
    }

    function showAdminStep() {
      if (emailStep) emailStep.classList.add('hidden');
      if (adminStep) adminStep.classList.remove('hidden');
      if (otpStep) otpStep.classList.add('hidden');
      if (adminPwdInput) {
        adminPwdInput.value = '';
        setTimeout(() => adminPwdInput.focus(), 100);
      }
    }

    function showOtpStep(email, suggestedUser = '') {
      if (emailStep) emailStep.classList.add('hidden');
      if (adminStep) adminStep.classList.add('hidden');
      if (otpStep) otpStep.classList.remove('hidden');
      if (otpEmailLabel) otpEmailLabel.textContent = email;
      if (usernameInput && suggestedUser) usernameInput.value = suggestedUser;
      if (otpInput) {
        otpInput.value = '';
        setTimeout(() => otpInput.focus(), 100);
      }
    }

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
        showEmailStep();
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
        localStorage.removeItem('neo_guest_handle');
        ownerToken = '';
        isOwner = false;
        updateAuthModeUI(false, 'Guest');
        toast('Logged out. Switched to Guest Demo Mode.');
        showEmailStep();
        if (gateModal) gateModal.classList.remove('hidden');
      });
    }

    // 1. Submit Email Step
    if (emailStep) {
      emailStep.addEventListener('submit', async e => {
        e.preventDefault();
        const email = (emailInput ? emailInput.value : '').trim().toLowerCase();
        if (!email || !email.includes('@')) {
          toast('Please enter a valid email address');
          return;
        }
        pendingEmail = email;
        toast('Checking email address…');

        try {
          const res = await api('/api/auth/check-email', {
            method: 'POST',
            body: JSON.stringify({ email }),
          });

          if (res && res.ok) {
            if (res.is_admin) {
              showAdminStep();
              toast('Admin recognized! Please enter password.');
            } else {
              showOtpStep(email, res.suggested_username || '');
              toast(res.email_sent ? `Verification OTP sent to ${email}` : `OTP prepared for ${email}`);
            }
          } else {
            toast(`Error: ${(res && res.message) || 'Failed to verify email'}`);
          }
        } catch (err) {
          toast(`Error: ${err.message}`);
        }
      });
    }

    // 2. Submit Admin Password Step
    if (adminStep) {
      adminStep.addEventListener('submit', async e => {
        e.preventDefault();
        const pwd = (adminPwdInput ? adminPwdInput.value : '').trim();
        if (!pwd) {
          toast('Please enter your admin password');
          return;
        }

        toast('Verifying admin credentials…');
        try {
          const res = await api('/api/auth/login-admin', {
            method: 'POST',
            body: JSON.stringify({ email: pendingEmail, password: pwd }),
          });

          if (res && res.ok && res.token) {
            ownerToken = res.token;
            localStorage.setItem('neo_owner_token', ownerToken);
            recordUserActivity();
            isOwner = true;
            updateAuthModeUI(true, 'Admin (Saif)');
            if (gateModal) gateModal.classList.add('hidden');
            toast('✅ Welcome Saif! Admin Terminal Unlocked with Live Kotak F&O.');
            fetchPositionsAndOrders();
          } else {
            toast(`❌ ${(res && res.message) || 'Invalid admin password'}`);
          }
        } catch (err) {
          toast(`❌ Authentication failed: ${err.message}`);
        }
      });
    }

    // 3. Submit OTP Step (Guest / New User Signup)
    if (otpStep) {
      otpStep.addEventListener('submit', async e => {
        e.preventDefault();
        const otp = (otpInput ? otpInput.value : '').trim();
        const handle = (usernameInput ? usernameInput.value : '').trim();
        if (!otp || otp.length < 6) {
          toast('Please enter the 6-digit verification code');
          return;
        }

        toast('Verifying code…');
        try {
          const res = await api('/api/auth/verify-otp', {
            method: 'POST',
            body: JSON.stringify({ email: pendingEmail, otp, username: handle }),
          });

          if (res && res.ok && res.token) {
            ownerToken = res.token;
            localStorage.setItem('neo_owner_token', ownerToken);
            localStorage.setItem('neo_guest_handle', res.username || handle);
            recordUserActivity();
            isOwner = false;
            updateAuthModeUI(false, res.username || handle);
            if (gateModal) gateModal.classList.add('hidden');
            toast(`✅ Welcome ${res.username || handle}! Paper trading active with ₹10,00,000 balance.`);
            fetchPositionsAndOrders();
          } else {
            toast(`❌ ${(res && res.message) || 'Invalid verification code'}`);
          }
        } catch (err) {
          toast(`❌ Verification failed: ${err.message}`);
        }
      });
    }

    // Back Buttons
    document.querySelectorAll('.auth-back-to-email').forEach(btn => {
      btn.addEventListener('click', e => {
        e.preventDefault();
        showEmailStep();
      });
    });

    // Resend OTP
    if (btnResendOtp) {
      btnResendOtp.addEventListener('click', async e => {
        e.preventDefault();
        if (!pendingEmail) {
          showEmailStep();
          return;
        }
        toast('Resending verification code…');
        try {
          const res = await api('/api/auth/resend-otp', {
            method: 'POST',
            body: JSON.stringify({ email: pendingEmail }),
          });
          if (res && res.ok) {
            toast(`A new 6-digit code has been sent to ${pendingEmail}`);
          }
        } catch (err) {
          toast(`Failed to resend: ${err.message}`);
        }
      });
    }

    // Quick Demo / Skip Login
    if (btnEnterGuest) {
      btnEnterGuest.addEventListener('click', () => {
        if (gateModal) gateModal.classList.add('hidden');
        localStorage.setItem('neo_visited_as_guest', 'true');
        const handle = localStorage.getItem('neo_guest_handle') || 'DemoTrader';
        updateAuthModeUI(false, handle);
        toast('Welcome! You are trading in Guest Demo Mode with ₹10,00,000 virtual balance.');
      });
    }

    // Check Initial Session
    async function checkSession() {
      try {
        const st = await api('/api/auth/session-status');
        if (st && st.authenticated) {
          isOwner = Boolean(st.is_owner || st.is_admin);
          updateAuthModeUI(isOwner, st.username || (isOwner ? 'Admin (Saif)' : 'Trader'));
          if (gateModal) gateModal.classList.add('hidden');
        } else {
          isOwner = false;
          updateAuthModeUI(false, 'Guest');
          const hasVisited = localStorage.getItem('neo_visited_as_guest');
          if (!hasVisited && gateModal) {
            showEmailStep();
            gateModal.classList.remove('hidden');
          }
        }
      } catch (e) {
        updateAuthModeUI(false, 'Guest');
      }
    }

    function updateAuthModeUI(ownerActive, username = 'Guest') {
      const pill = $('ex-acc-pill');
      const idEl = $('ex-acc-id');
      const modeBadge = $('op-mode-badge');
      const btnLogoutEl = $('btn-logout');
      const btnOwnerLoginEl = $('btn-open-owner-login');
      const menuTitle = $('menu-mode-title');
      const menuSub = $('menu-mode-sub');
      const profileLogin = $('m-profile-login');

      if (ownerActive) {
        if (pill) { pill.className = 'ex-acc-pill live'; pill.textContent = 'Live'; }
        if (idEl) idEl.textContent = '#KOTAK-LIVE';
        if (modeBadge) { modeBadge.textContent = 'Kotak Live (0 Brokerage)'; modeBadge.className = 'text-green'; }
        if (btnLogoutEl) btnLogoutEl.classList.remove('hidden');
        if (btnOwnerLoginEl) btnOwnerLoginEl.classList.add('hidden');
        if (menuTitle) menuTitle.textContent = 'Kotak Live Account';
        if (menuSub) menuSub.textContent = 'Admin: Saif (0 Brokerage F&O)';
        if (sessionBadge) sessionBadge.classList.remove('hidden');
        if (profileLogin) profileLogin.textContent = 'osaifala@gmail.com (Owner)';
      } else {
        if (pill) { pill.className = 'ex-acc-pill demo'; pill.textContent = 'Demo'; }
        if (idEl) idEl.textContent = `#${(username || 'GUEST').toUpperCase().slice(0, 10)}`;
        if (modeBadge) { modeBadge.textContent = 'Demo Paper Trading'; modeBadge.className = 'mode-badge-demo'; }
        if (btnLogoutEl) btnLogoutEl.classList.add('hidden');
        if (btnOwnerLoginEl) btnOwnerLoginEl.classList.remove('hidden');
        if (menuTitle) menuTitle.textContent = 'Guest Paper Trading';
        if (menuSub) menuSub.textContent = `${username || 'Guest'} (₹10,00,000 Virtual Funds)`;
        if (sessionBadge) sessionBadge.classList.add('hidden');
        if (profileLogin) profileLogin.textContent = `${(username || 'guest').toLowerCase()}@pip-terminal`;
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

    function positionIndicatorsMenu(triggerEl) {
      if (!menu) return;
      const rect = (triggerEl || btn || railBtn).getBoundingClientRect();
      const menuWidth = 270;
      const left = Math.max(10, Math.min(rect.left, window.innerWidth - menuWidth - 10));
      const top = Math.min(rect.bottom + 6, window.innerHeight - 340);
      menu.style.position = 'fixed';
      menu.style.top = `${top}px`;
      menu.style.left = `${left}px`;
      menu.style.zIndex = '99999';
    }

    function toggleMenu(e) {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      const triggerEl = (e && e.currentTarget) ? e.currentTarget : btn;
      const isHidden = menu.classList.contains('hidden');
      if (isHidden) {
        positionIndicatorsMenu(triggerEl);
        menu.classList.remove('hidden');
      } else {
        menu.classList.add('hidden');
      }
    }

    if (btn && menu) btn.addEventListener('click', toggleMenu);
    if (railBtn && menu) railBtn.addEventListener('click', toggleMenu);

    window.addEventListener('resize', () => {
      if (menu && !menu.classList.contains('hidden')) {
        positionIndicatorsMenu();
      }
    });

    document.addEventListener('click', e => {
      if (menu && !menu.contains(e.target) && e.target !== btn && !btn?.contains(e.target) && e.target !== railBtn && !railBtn?.contains(e.target)) {
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

    // Active pane selection (in 2 or 3 chart split layout)
    document.querySelectorAll('.chart-pane').forEach((paneEl, idx) => {
      paneEl.addEventListener('click', () => {
        activePaneIdx = idx;
        document.querySelectorAll('.chart-pane').forEach((el, i) => {
          el.classList.toggle('active', i === idx);
        });
        if (panes[idx]) {
          syncToolbarForPane(panes[idx]);
        }
      });
    });

    // Timeframe Buttons
    document.querySelectorAll('.ex-tf-btn').forEach(tfBtn => {
      tfBtn.addEventListener('click', () => {
        document.querySelectorAll('.ex-tf-btn').forEach(b => b.classList.remove('active'));
        tfBtn.classList.add('active');
        const targetPane = panes[activePaneIdx] || panes[0];
        targetPane.tf = tfBtn.dataset.tf;
        if (targetPane.idx === 0 && openTabs[activeTabIndex]) {
          openTabs[activeTabIndex].interval = targetPane.tf;
        }
        loadCandles(targetPane);
      });
    });

    // Bottom Date Range Shortcuts (1D, 5D, 1M, 3M, 6M, 1Y)
    const rangeDaysMap = { '1d': 5, '5d': 7, '1m': 30, '3m': 90, '6m': 180, '1y': 365 };
    document.querySelectorAll('.range-btn').forEach(rBtn => {
      rBtn.addEventListener('click', () => {
        document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
        rBtn.classList.add('active');
        const targetPane = panes[activePaneIdx] || panes[0];
        const days = rangeDaysMap[rBtn.dataset.range] || 5;
        targetPane.rangeDays = days;
        if (targetPane.idx === 0 && openTabs[activeTabIndex]) {
          openTabs[activeTabIndex].rangeDays = days;
        }
        if (days > 30 && targetPane.tf !== '1d') {
          targetPane.tf = '1d';
          document.querySelectorAll('.ex-tf-btn').forEach(b => b.classList.toggle('active', b.dataset.tf === '1d'));
          if (targetPane.idx === 0 && openTabs[activeTabIndex]) {
            openTabs[activeTabIndex].interval = '1d';
          }
        }
        loadCandles(targetPane);
      });
    });

    // Layout Toggle Button (Direct Cycle: 1 -> 2 -> 3 -> 1 on single tap)
    const lBtn = $('layout-toggle-btn');
    const lDrop = $('layout-dropdown');
    const lLbl = $('current-layout-label');
    const stage = $('chart-stage');

    function applyLayout(lay) {
      activeLayout = lay;
      if (stage) stage.className = `ex-chart-stage layout-${lay}`;
      if (lLbl) lLbl.textContent = `${lay} CHART${lay > 1 ? 'S' : ''}`;

      document.querySelectorAll('.layout-opt').forEach(opt => {
        opt.classList.toggle('active', parseInt(opt.dataset.layout) === lay);
      });

      if (lay === 1) {
        activePaneIdx = 0;
        document.querySelectorAll('.chart-pane').forEach((el, i) => el.classList.toggle('active', i === 0));
      }

      // Initialize pane charts if not yet done
      if (lay >= 2 && !panes[1].chart) {
        initChartPane(panes[1]);
        loadCandles(panes[1]);
      }
      if (lay === 3 && !panes[2].chart) {
        initChartPane(panes[2]);
        loadCandles(panes[2]);
      }

      // Resize all active pane charts so they fill container seamlessly
      function refitVisiblePanes() {
        panes.slice(0, lay).forEach(p => {
          if (p.chart) {
            resizePaneChart(p);
            try { p.chart.timeScale().fitContent(); } catch (_) {}
          }
        });
      }
      requestAnimationFrame(refitVisiblePanes);
      setTimeout(refitVisiblePanes, 60);
      setTimeout(refitVisiblePanes, 220);
    }

    if (lBtn) {
      lBtn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        const nextLayout = (activeLayout % 3) + 1;
        applyLayout(nextLayout);
      });
    }

    if (lDrop) {
      document.querySelectorAll('.layout-opt').forEach(opt => {
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          const lay = parseInt(opt.dataset.layout) || 1;
          applyLayout(lay);
          lDrop.classList.add('hidden');
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

  // --- Change API Keys Modal (Kotak Consumer Key & Upstox Analytics Key) ---
  function setupKeysModal() {
    const modal = $('modal-api-keys');
    const openBtn = $('btn-open-change-keys');
    const closeBtn = $('btn-close-keys-modal');
    const cancelBtn = $('btn-cancel-keys');
    const saveBtn = $('btn-save-keys-submit');

    const inputKotak = $('input-kotak-consumer-key');
    const inputUpstox = $('input-upstox-analytics-key');
    const inputMpin = $('input-keys-mpin');
    const upStatusTxt = $('keys-upstox-status-txt');
    const kotakStatusTxt = $('keys-kotak-status-txt');

    async function openKeysModal() {
      if (!modal) return;
      modal.classList.remove('hidden');
      if (inputKotak) inputKotak.value = '';
      if (inputUpstox) inputUpstox.value = '';
      if (inputMpin) inputMpin.value = '';

      try {
        const st = await api('/api/settings/keys-status');
        if (st && st.ok) {
          if (upStatusTxt) upStatusTxt.textContent = `Upstox 1-Year Analytics Key: ${st.upstox_masked}`;
          if (kotakStatusTxt) kotakStatusTxt.textContent = `Kotak Neo Consumer Key: ${st.consumer_key_masked}`;
        }
      } catch (e) {
        // quiet
      }
    }

    function closeKeysModal() {
      if (modal) modal.classList.add('hidden');
    }

    openKeysModalFn = openKeysModal;
    if (openBtn) openBtn.addEventListener('click', openKeysModal);
    if (closeBtn) closeBtn.addEventListener('click', closeKeysModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeKeysModal);

    // Toggle mask buttons
    document.querySelectorAll('.btn-toggle-mask').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.target;
        const targetInput = $(targetId);
        if (targetInput) {
          const isPass = targetInput.type === 'password';
          targetInput.type = isPass ? 'text' : 'password';
          btn.textContent = isPass ? '🙈' : '👁';
        }
      });
    });

    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const ck = (inputKotak ? inputKotak.value : '').trim();
        const up = (inputUpstox ? inputUpstox.value : '').trim();
        const mpin = (inputMpin ? inputMpin.value : '').trim();

        if (!ck && !up) {
          toast('Please enter a new Kotak Consumer Key or Upstox Analytics Key');
          return;
        }

        try {
          toast('Updating API keys securely...');
          const payload = {};
          if (ck) payload.consumer_key = ck;
          if (up) payload.upstox_token = up;
          if (mpin) payload.mpin = mpin;

          const res = await api('/api/settings/keys', {
            method: 'POST',
            body: JSON.stringify(payload),
          });

          if (ck) {
            await api('/api/auth/save-kotak-keys', {
              method: 'POST',
              body: JSON.stringify({
                consumer_key: ck,
                mobile: ($('input-kotak-mobile') ? $('input-kotak-mobile').value : '').trim(),
                ucc: ($('input-kotak-ucc') ? $('input-kotak-ucc').value : '').trim(),
              }),
            }).catch(() => {});
          }

          if (res.ok) {
            toast(`✅ ${res.message || 'API keys successfully saved and applied!'}`);
            closeKeysModal();
            loadCandles(panes[0]);
          } else {
            toast(`❌ ${res.detail || 'Failed to update keys'}`);
          }
        } catch (err) {
          toast(`❌ Error: ${err.message}`);
        }
      });
    }
  }

  // --- Guest Paper Trading Profile Modal ---
  function setupGuestProfileModal() {
    const modal = $('modal-guest-profile');
    const openBtn = $('btn-open-guest-profile');
    const closeBtn = $('btn-close-profile-modal');
    const saveBtn = $('btn-save-profile');
    const nameInput = $('input-guest-name');
    const idEl = $('ex-acc-id');

    // Load saved handle
    const savedHandle = localStorage.getItem('neo_guest_handle');
    if (savedHandle && idEl && !isOwner) {
      idEl.textContent = `#${savedHandle.toUpperCase()}`;
    }

    if (openBtn) {
      openBtn.addEventListener('click', () => {
        if (modal) {
          modal.classList.remove('hidden');
          if (nameInput) nameInput.value = localStorage.getItem('neo_guest_handle') || '';
        }
      });
    }

    if (closeBtn) closeBtn.addEventListener('click', () => modal && modal.classList.add('hidden'));

    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const val = (nameInput ? nameInput.value : '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
        if (!val) {
          toast('Please enter a valid trader handle (alphanumeric)');
          return;
        }
        localStorage.setItem('neo_guest_handle', val);
        if (idEl && !isOwner) {
          idEl.textContent = `#${val.toUpperCase()}`;
        }
        if (modal) modal.classList.add('hidden');
        toast(`✅ Paper Trading Profile saved as #${val.toUpperCase()}!`);
      });
    }
  }

  // --- Mobile Exness App Flow Setup ---
  function setupMobileFlow() {
    const navItems = document.querySelectorAll('.mobile-nav-item');
    let currentCat = 'favorites';
    let mobileSearchSeq = 0;
    let activeOrdersTab = 'open';
    const views = {
      chart: null,
      accounts: $('mview-accounts'),
      trade: $('mview-trade'),
      performance: $('mview-perf'),
      profile: $('mview-profile'),
    };
    const keysModal = $('modal-api-keys');
    const guideModal = $('modal-setup-guide');
    const paperModal = $('modal-guest-profile');

    function openMobileKeys() {
      if (typeof openKeysModalFn === 'function') {
        openKeysModalFn();
      } else if (keysModal) {
        keysModal.classList.remove('hidden');
      }
    }

    function switchMobileTab(tabKey) {
      navItems.forEach(item => {
        item.classList.toggle('active', item.dataset.tab === tabKey);
      });

      if (tabKey === 'chart') {
        document.body.classList.remove('mobile-view-active');
        Object.values(views).forEach(v => v && v.classList.add('hidden'));

        // Trigger chart canvas resize and fit for all visible panes
        const visibleCount = activeLayout === 3 ? 3 : (activeLayout === 2 ? 2 : 1);
        function refitMobilePanes() {
          panes.slice(0, visibleCount).forEach(p => {
            if (!p.chart) {
              initChartPane(p);
              loadCandles(p);
            } else {
              resizePaneChart(p);
              try { p.chart.timeScale().fitContent(); } catch (_) {}
            }
          });
        }
        requestAnimationFrame(refitMobilePanes);
        setTimeout(refitMobilePanes, 60);
        setTimeout(refitMobilePanes, 220);
      } else {
        document.body.classList.add('mobile-view-active');
        Object.entries(views).forEach(([k, v]) => {
          if (v) v.classList.toggle('hidden', k !== tabKey);
        });

        if (tabKey === 'trade') {
          const msInput = $('m-trade-search-input');
          renderMobileTradeList(currentCat, msInput ? msInput.value.trim() : '');
        } else if (tabKey === 'accounts') {
          updateMobileAccountsView();
          if (typeof renderMobileOrdersList === 'function') {
            renderMobileOrdersList(activeOrdersTab);
          }
        } else if (tabKey === 'performance') {
          updateMobilePerformanceView();
        } else if (tabKey === 'profile') {
          updateMobileProfileView();
        }
      }
    }

    navItems.forEach(item => {
      item.addEventListener('click', () => switchMobileTab(item.dataset.tab));
    });

    // Accounts screen Trade button
    const mTradeBtn = $('m-action-trade');
    if (mTradeBtn) mTradeBtn.addEventListener('click', () => switchMobileTab('chart'));

    const mDepositBtn = $('m-action-deposit');
    if (mDepositBtn) {
      mDepositBtn.addEventListener('click', () => {
        toast('💡 Deposit funds directly via your Kotak Neo netbanking / UPI portal.');
      });
    }

    const mWithdrawBtn = $('m-action-withdraw');
    if (mWithdrawBtn) {
      mWithdrawBtn.addEventListener('click', () => {
        toast('💡 Withdrawals are settled to your linked primary bank account by Kotak Neo.');
      });
    }

    const mAccCog = $('m-btn-acc-settings');
    if (mAccCog) {
      mAccCog.addEventListener('click', openMobileKeys);
    }

    // Performance screen Start Trading button
    const mPerfTrade = $('m-btn-perf-trade');
    if (mPerfTrade) mPerfTrade.addEventListener('click', () => switchMobileTab('chart'));

    // Modals triggers from mobile
    const mBtnGuide = $('m-btn-open-guide');
    if (mBtnGuide && guideModal) mBtnGuide.addEventListener('click', () => guideModal.classList.remove('hidden'));

    const mBtnKeys = $('m-btn-open-keys');
    const mBtnProfKeys = $('m-btn-profile-keys');
    const mProfCog = $('m-profile-cog');
    if (mBtnKeys) mBtnKeys.addEventListener('click', openMobileKeys);
    if (mBtnProfKeys) mBtnProfKeys.addEventListener('click', openMobileKeys);
    if (mProfCog) mProfCog.addEventListener('click', openMobileKeys);

    const mRowPaper = $('m-row-paper-profile');
    if (mRowPaper && paperModal) mRowPaper.addEventListener('click', () => paperModal.classList.remove('hidden'));

    const mRowLocal = $('m-row-run-local');
    if (mRowLocal && guideModal) mRowLocal.addEventListener('click', () => guideModal.classList.remove('hidden'));

    const mRowReddit = $('m-row-reddit');
    if (mRowReddit) mRowReddit.addEventListener('click', () => window.open('https://reddit.com/user/thatsaiiff', '_blank'));

    // Mobile Accounts Open / Pending / Closed Tabs
    const otabs = document.querySelectorAll('.m-otab');
    otabs.forEach(tab => {
      tab.addEventListener('click', () => {
        otabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        activeOrdersTab = tab.dataset.otab || 'open';
        renderMobileOrdersList(activeOrdersTab);
      });
    });

    function renderMobileOrdersList(tab = activeOrdersTab) {
      const container = $('m-orders-list');
      if (!container) return;

      const mOpenTab = $('m-otab-open');
      const mPendingTab = $('m-otab-pending');
      const mClosedTab = $('m-otab-closed');
      const mHistoryTab = $('m-otab-history');

      const pendingList = cachedOrders.filter(o => o.status === 'pending');

      if (mOpenTab) {
        mOpenTab.innerHTML = 'Open' + (cachedPositions.length ? ` <span class="m-tab-badge">${cachedPositions.length}</span>` : '');
      }
      if (mPendingTab) {
        mPendingTab.innerHTML = 'Pending' + (pendingList.length ? ` <span class="m-tab-badge">${pendingList.length}</span>` : '');
      }
      if (mClosedTab) {
        mClosedTab.innerHTML = 'Closed' + (cachedClosedPositions.length ? ` <span class="m-tab-badge">${cachedClosedPositions.length}</span>` : '');
      }
      if (mHistoryTab) {
        mHistoryTab.innerHTML = 'Trade History' + (cachedExecutions.length ? ` <span class="m-tab-badge">${cachedExecutions.length}</span>` : '');
      }

      container.innerHTML = '';

      if (tab === 'open') {
        if (!cachedPositions.length) {
          container.innerHTML = `
            <div class="m-orders-empty-msg">No open orders. Find your next trade:</div>
            <div class="m-quick-carousel" id="m-quick-carousel">
              <div class="m-quick-card" data-sym="NIFTY">
                <div class="m-qc-title">NIFTY 50</div>
                <div class="m-qc-icon">🇮🇳</div>
                <div class="m-qc-price" id="qc-nifty-ltp">25,023.70</div>
                <div class="m-qc-chg neg" id="qc-nifty-chg">▼ 0.28%</div>
              </div>
              <div class="m-quick-card" data-sym="BANKNIFTY">
                <div class="m-qc-title">BANK NIFTY</div>
                <div class="m-qc-icon">🏦</div>
                <div class="m-qc-price" id="qc-bank-ltp">52,100.00</div>
                <div class="m-qc-chg pos" id="qc-bank-chg">▲ 0.45%</div>
              </div>
              <div class="m-quick-card" data-sym="SENSEX">
                <div class="m-qc-title">SENSEX</div>
                <div class="m-qc-icon">📈</div>
                <div class="m-qc-price" id="qc-sensex-ltp">81,200.00</div>
                <div class="m-qc-chg pos" id="qc-sensex-chg">▲ 0.35%</div>
              </div>
              <div class="m-quick-card" data-sym="RELIANCE">
                <div class="m-qc-title">RELIANCE</div>
                <div class="m-qc-icon">⚡</div>
                <div class="m-qc-price" id="qc-rel-ltp">1,340.00</div>
                <div class="m-qc-chg pos" id="qc-rel-chg">▲ 0.80%</div>
              </div>
            </div>
          `;
          container.querySelectorAll('.m-quick-card').forEach(card => {
            card.addEventListener('click', () => {
              const sym = card.dataset.sym;
              if (sym) {
                addSymbolTab(sym, '');
                switchMobileTab('chart');
              }
            });
          });
        } else {
          cachedPositions.forEach(p => {
            const sym = p.symbol || p.trading_symbol || p.trdSym || '—';
            const side = (p.side || p.direction || (Number(p.quantity) > 0 ? 'BUY' : 'SELL')).toUpperCase();
            const qty = Math.abs(Number(p.quantity || p.qty || 0));
            const avg = Number(p.average_price || p.avg_price || p.avgPrc || 0);
            const ltp = Number(p.ltp || avg);
            const m2m = Number(p.m2m || (side === 'BUY' ? (ltp - avg) * qty : (avg - ltp) * qty));
            const isPos = m2m >= 0;

            const card = document.createElement('div');
            card.className = 'm-order-card';
            card.innerHTML = `
              <div class="m-card-top">
                <div class="m-card-sym-wrap">
                  <span class="m-card-icon">${sym.includes('BANK') ? '🏦' : (sym.includes('SENSEX') ? '📈' : '🪙')}</span>
                  <span class="m-card-sym">${sym}</span>
                  <span class="m-tag-pill tp">TP</span>
                  <span class="m-tag-pill sl">SL</span>
                </div>
                <div class="m-card-pnl ${isPos ? 'pos' : 'neg'}">
                  ${isPos ? '+' : ''}₹${m2m.toFixed(2)}
                </div>
              </div>
              <div class="m-card-bot">
                <div class="m-card-sub ${side.toLowerCase()}">${side} ${qty} lot at ₹${avg.toFixed(2)}</div>
                <div class="m-card-ltp">₹${ltp.toFixed(2)}</div>
              </div>
              <div class="m-card-actions">
                <button type="button" class="m-card-btn-close" data-sym="${sym}">Close Position</button>
              </div>
            `;

            const closeBtn = card.querySelector('.m-card-btn-close');
            if (closeBtn) {
              closeBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                try {
                  toast(`Closing position ${sym}...`);
                  const res = await api(`/api/positions/${encodeURIComponent(sym)}/exit`, {
                    method: 'POST',
                    body: JSON.stringify({ percentage: 100 }),
                  });
                  if (res.ok) {
                    toast(`✅ Position ${sym} closed!`);
                    fetchPositionsAndOrders();
                  }
                } catch (err) {
                  toast(`❌ ${err.message}`);
                }
              });
            }

            card.addEventListener('click', () => {
              addSymbolTab(sym, '');
              switchMobileTab('chart');
            });

            container.appendChild(card);
          });
        }
      } else if (tab === 'pending') {
        if (!pendingList.length) {
          container.innerHTML = '<div class="m-orders-empty-msg">No pending limit or trigger orders.</div>';
        } else {
          pendingList.forEach(o => {
            const side = (o.side || 'BUY').toUpperCase();
            const card = document.createElement('div');
            card.className = 'm-order-card';
            card.innerHTML = `
              <div class="m-card-top">
                <div class="m-card-sym-wrap">
                  <span class="m-card-icon">⚡</span>
                  <span class="m-card-sym">${o.symbol}</span>
                </div>
                <div class="m-card-dash">
                  <button type="button" class="m-card-btn-cancel" data-id="${o.id}">✕ Cancel</button>
                </div>
              </div>
              <div class="m-card-bot">
                <div class="m-card-sub ${side.toLowerCase()}">${side} ${o.order_type || 'Limit'} ${o.quantity} lot at ₹${Number(o.price || 0).toFixed(2)}</div>
                <div class="m-card-ltp">${o.ltp ? '₹' + Number(o.ltp).toFixed(2) : '—'}</div>
              </div>
            `;
            const cancelBtn = card.querySelector('.m-card-btn-cancel');
            if (cancelBtn) {
              cancelBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                try {
                  toast(`Cancelling order #${o.id}...`);
                  await api(`/api/orders/${o.id}/cancel`, { method: 'POST' });
                  toast(`✅ Order cancelled`);
                  fetchPositionsAndOrders();
                } catch (err) {
                  toast(`❌ ${err.message}`);
                }
              });
            }
            container.appendChild(card);
          });
        }
      } else if (tab === 'closed') {
        if (!cachedClosedPositions.length) {
          container.innerHTML = '<div class="m-orders-empty-msg">No closed positions recorded.</div>';
        } else {
          let totalDayPnl = 0;
          cachedClosedPositions.forEach(c => {
            const pnl = Number(c.realised_net_pnl !== undefined ? c.realised_net_pnl : (c.realised_gross_pnl || 0));
            totalDayPnl += pnl;
          });

          const dateHdr = document.createElement('div');
          dateHdr.className = 'm-closed-date-header';
          dateHdr.innerHTML = `
            <span class="m-cd-title">Today</span>
            <span class="m-cd-pnl ${totalDayPnl >= 0 ? 'pos' : 'neg'}">
              ${totalDayPnl >= 0 ? '+' : ''}₹${totalDayPnl.toFixed(2)}
            </span>
          `;
          container.appendChild(dateHdr);

          cachedClosedPositions.forEach((c, idx) => {
            const sym = c.symbol || c.trading_symbol || '—';
            const netPnl = Number(c.realised_net_pnl !== undefined ? c.realised_net_pnl : (c.realised_gross_pnl || 0));
            const grossPnl = Number(c.realised_gross_pnl || 0);
            const cpCharges = Number(c.total_charges || 0);
            const isPos = netPnl >= 0;
            const openPrc = Number(c.avg_buy_price || 0);
            const closePrc = Number(c.avg_sell_price || 0);
            const qty = Math.max(Number(c.total_buy_quantity || 0), Number(c.total_sell_quantity || 0));
            const side = (c.total_buy_quantity >= c.total_sell_quantity ? 'BUY' : 'SELL');
            const matches = c.matches || [];

            const card = document.createElement('div');
            card.className = 'm-order-card closed';
            card.innerHTML = `
              <div class="m-card-top">
                <div class="m-card-sym-wrap">
                  <span class="m-card-icon">🪙</span>
                  <span class="m-card-sym">${sym}</span>
                  <span class="m-tag-pill tp">TP</span>
                  <span class="m-tag-pill sl">SL</span>
                </div>
                <div class="m-card-pnl ${isPos ? 'pos' : 'neg'}">
                  ${isPos ? '+' : ''}₹${netPnl.toFixed(2)}
                </div>
              </div>
              <div class="m-card-bot">
                <div class="m-card-sub ${side.toLowerCase()}">Bought ${qty} @ ₹${openPrc.toFixed(2)}</div>
                <div class="m-card-ltp">Sold @ ₹${closePrc.toFixed(2)}</div>
              </div>
              <div class="m-card-meta-row">
                <span>Gross: ${grossPnl >= 0 ? '+' : ''}₹${grossPnl.toFixed(2)} | Chg: ₹${cpCharges.toFixed(2)}</span>
                <span class="m-card-expand-toggle" data-idx="${idx}">FIFO Fills ▾</span>
              </div>
              <div class="m-card-fifo-drawer hidden" id="m-fifo-drawer-${idx}">
                ${matches.length ? matches.map(m => `
                  <div class="m-fifo-item">
                    <span>${m.quantity} qty @ ₹${Number(m.buy_price).toFixed(2)} ➔ ₹${Number(m.sell_price).toFixed(2)}</span>
                    <span style="color:${Number(m.gross_pnl||0)>=0?'var(--bull)':'var(--bear)'};font-weight:700;">
                      ${Number(m.gross_pnl||0)>=0?'+':''}₹${Number(m.gross_pnl||0).toFixed(2)}
                    </span>
                  </div>
                `).join('') : '<div class="m-fifo-item">Single execution lot closed</div>'}
              </div>
            `;

            const toggleBtn = card.querySelector('.m-card-expand-toggle');
            const drawer = card.querySelector(`#m-fifo-drawer-${idx}`);
            if (toggleBtn && drawer) {
              toggleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const isHidden = drawer.classList.contains('hidden');
                drawer.classList.toggle('hidden', !isHidden);
                toggleBtn.textContent = isHidden ? 'FIFO Fills ▴' : 'FIFO Fills ▾';
              });
            }

            container.appendChild(card);
          });
        }
      } else if (tab === 'history') {
        if (!cachedExecutions.length) {
          container.innerHTML = '<div class="m-orders-empty-msg">No executed trades recorded yet.</div>';
        } else {
          cachedExecutions.forEach(e => {
            const sym = e.symbol || e.trading_symbol || '—';
            const side = (e.side || 'BUY').toUpperCase();
            const qty = Number(e.quantity || 0);
            const price = Number(e.price || 0);
            const turnover = (qty * price);
            const totalChg = Number(e.charges?.total_charges || 0);
            const time = e.executed_at ? (e.executed_at.split('T')[1]?.slice(0, 8) || e.executed_at) : 'Today';

            const card = document.createElement('div');
            card.className = 'm-order-card history';
            card.innerHTML = `
              <div class="m-card-top">
                <div class="m-card-sym-wrap">
                  <span class="m-card-icon">⚡</span>
                  <span class="m-card-sym">${sym}</span>
                  <span class="m-exec-badge ${side.toLowerCase()}">${side}</span>
                </div>
                <div class="m-card-pnl" style="color:var(--text-main);font-size:13px;">
                  ₹${turnover.toFixed(2)}
                </div>
              </div>
              <div class="m-card-bot">
                <div class="m-card-sub">${qty} qty at ₹${price.toFixed(2)}</div>
                <div class="m-card-ltp" style="font-size:11px;color:var(--text-dim);">${time}</div>
              </div>
              <div class="m-card-meta-row">
                <span>Charges: ₹${totalChg.toFixed(2)} (STT: ₹${Number(e.charges?.stt||0).toFixed(2)})</span>
                <span style="font-family:var(--font-mono);font-size:10.5px;">#${e.id || e.broker_execution_id}</span>
              </div>
            `;
            container.appendChild(card);
          });
        }
      }
    }

    updateMobileOrdersFn = () => {
      updateMobileAccountsView();
      renderMobileOrdersList(activeOrdersTab);
    };

    // Quick trade carousel items
    document.querySelectorAll('.m-quick-card').forEach(card => {
      card.addEventListener('click', () => {
        const sym = card.dataset.sym;
        if (sym) {
          addSymbolTab(sym, '');
          switchMobileTab('chart');
        }
      });
    });

    // Mobile Watchlist Category Chips
    const catChips = document.querySelectorAll('.m-cat-chip');
    catChips.forEach(chip => {
      chip.addEventListener('click', () => {
        catChips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        currentCat = chip.dataset.cat;
        const mSearchInputEl = $('m-trade-search-input');
        renderMobileTradeList(currentCat, mSearchInputEl ? mSearchInputEl.value.trim() : '');
      });
    });

    // Mobile Watchlist Search Input (3+ chars calls live Upstox/Kotak API)
    const mSearchInput = $('m-trade-search-input');
    if (mSearchInput) {
      let mDebounce = null;
      mSearchInput.addEventListener('input', () => {
        clearTimeout(mDebounce);
        mDebounce = setTimeout(() => {
          renderMobileTradeList(currentCat, mSearchInput.value.trim());
        }, 160);
      });
      mSearchInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          const firstRow = document.querySelector('#m-trade-list .m-trade-item');
          if (firstRow) firstRow.click();
        }
      });
    }

    async function hydrateMobileTradeQuotes(rowsInfo) {
      if (!rowsInfo || !rowsInfo.length) return;
      try {
        const items = rowsInfo.slice(0, 15).map(r => ({ symbol: r.symbol, token: r.token || '' }));
        const data = await api('/api/chart/live-quotes', {
          method: 'POST',
          body: JSON.stringify({ items }),
        });
        if (!data || !data.ok) return;
        const qList = Array.isArray(data.quotes) ? data.quotes : Object.values(data.quotes || {});
        const qMap = data.quotes_by_symbol || {};
        qList.forEach(q => { if (q && q.symbol) qMap[q.symbol] = q; });

        rowsInfo.forEach(({ symbol, row }) => {
          const q = qMap[symbol] || qMap[String(symbol).toUpperCase()];
          if (!q || !q.ltp || !row.isConnected) return;
          const priceEl = row.querySelector('.m-ti-price');
          const chgEl = row.querySelector('.m-ti-chg');
          const ltp = Number(q.ltp);
          const pct = Number(q.change_percent || 0);
          const isPos = pct >= 0;
          if (priceEl) priceEl.textContent = `₹${ltp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
          if (chgEl) {
            chgEl.textContent = `${isPos ? '▲ +' : '▼ '}${pct.toFixed(2)}%`;
            chgEl.className = `m-ti-chg ${isPos ? 'pos' : 'neg'}`;
          }
        });
      } catch (_) {}
    }

    async function renderMobileTradeList(category = 'favorites', query = '') {
      const container = $('m-trade-list');
      if (!container) return;

      const reqSeq = ++mobileSearchSeq;
      let items = [];

      if (query && query.length >= 3) {
        container.innerHTML = '<div class="m-orders-empty-msg" style="padding:16px;">Searching Upstox &amp; Kotak instruments…</div>';
        try {
          const res = await api(`/api/chart/search?q=${encodeURIComponent(query)}`);
          if (reqSeq !== mobileSearchSeq) return;
          if (res && res.ok && res.results && res.results.length) {
            items = res.results.map(r => {
              registerSymbolMeta(r.symbol, { lotSize: r.lot_size, segment: r.segment });
              return {
                symbol: r.symbol,
                name: (r.name && r.name.toUpperCase() !== r.symbol.toUpperCase())
                  ? `${r.name} · ${r.segment || 'NSE'}`
                  : (r.segment || 'NSE'),
                token: r.token || '',
                lotSize: r.lot_size || 0,
                segment: r.segment || '',
                signal: isOptionSymbol(r.symbol) && r.symbol.includes('PE') ? 'SELL' : 'BUY',
              };
            });
          } else {
            container.innerHTML = `<div class="m-orders-empty-msg" style="padding:16px;">No matching symbols for "${escapeHtml(query)}"</div>`;
            return;
          }
        } catch (err) {
          if (reqSeq !== mobileSearchSeq) return;
          container.innerHTML = `<div class="m-orders-empty-msg" style="padding:16px;color:var(--bear);">Search error: ${escapeHtml(err.message)}</div>`;
          return;
        }
      } else {
        items = WATCHLIST_PRESETS[category] || WATCHLIST_PRESETS.favorites;
        if (category === 'options') {
          items = [...WATCHLIST_PRESETS.nifty_options, ...WATCHLIST_PRESETS.bank_options];
        }
        if (query) {
          const qUpper = query.toUpperCase();
          items = items.filter(it => it.symbol.toUpperCase().includes(qUpper) || it.name.toUpperCase().includes(qUpper));
        }
      }

      if (reqSeq !== mobileSearchSeq) return;
      container.innerHTML = '';

      if (query && query.length > 0 && query.length < 3) {
        const need = 3 - query.length;
        const hint = document.createElement('div');
        hint.className = 'm-orders-empty-msg';
        hint.style.padding = '10px 16px 4px';
        hint.textContent = `Type ${need} more char${need > 1 ? 's' : ''} to search all Upstox stocks & F&O strikes…`;
        container.appendChild(hint);
      }

      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'm-orders-empty-msg';
        empty.style.padding = '16px';
        empty.textContent = 'No matching instruments.';
        container.appendChild(empty);
        return;
      }

      const renderedRows = [];
      items.forEach(it => {
        const row = document.createElement('div');
        row.className = 'm-trade-item';
        const isPos = it.signal === 'BUY';
        row.innerHTML = `
          <div class="m-ti-left">
            <div class="m-ti-icon">${it.symbol.includes('BANK') ? '🏦' : (it.symbol.includes('NIFTY') ? '🇮🇳' : (it.symbol.includes('SENSEX') ? '📈' : '⚡'))}</div>
            <div class="m-ti-names">
              <span class="m-ti-sym">${escapeHtml(it.symbol)}</span>
              <span class="m-ti-sub">${escapeHtml(it.name || 'NSE')}</span>
            </div>
          </div>
          <div class="m-ti-right">
            <span class="m-ti-price">—</span>
            <span class="m-ti-chg ${isPos ? 'pos' : 'neg'}">—</span>
          </div>
        `;
        row.addEventListener('click', () => {
          addSymbolTab(it.symbol, it.token || '', it.lotSize || 0, it.segment || '');
          switchMobileTab('chart');
        });
        container.appendChild(row);
        renderedRows.push({ symbol: it.symbol, token: it.token || '', row });
      });

      hydrateMobileTradeQuotes(renderedRows);
    }

    function updateMobileAccountsView() {
      const storedHandle = localStorage.getItem('neo_guest_handle');
      const accIdEl = $('m-acc-id');
      const accBalEl = $('m-acc-balance');
      const pillBal = $('m-trade-pill-bal');
      const desktopBal = $('ex-acc-balance');

      if (accIdEl) {
        accIdEl.textContent = storedHandle ? `#${storedHandle.toUpperCase()}` : '# 472963350';
      }
      if (desktopBal && accBalEl) {
        accBalEl.textContent = desktopBal.textContent.replace(' (Demo)', '');
      }
      if (desktopBal && pillBal) {
        pillBal.textContent = desktopBal.textContent.replace(' (Demo)', '');
      }
    }

    function updateMobilePerformanceView() {
      const grossPnl = $('cs-gross-pnl');
      const netPnl = $('cs-net-pnl');
      const mRealized = $('m-perf-realized');
      const mNet = $('m-perf-net');
      if (grossPnl && mRealized) {
        mRealized.textContent = grossPnl.textContent;
        mRealized.className = `m-metric-val ${grossPnl.textContent.includes('-') ? 'neg' : 'pos'}`;
      }
      if (netPnl && mNet) {
        mNet.textContent = netPnl.textContent;
        mNet.className = `m-metric-val ${netPnl.textContent.includes('-') ? 'neg' : 'pos'}`;
      }
    }

    function updateMobileProfileView() {
      const storedHandle = localStorage.getItem('neo_guest_handle');
      const loginEl = $('m-profile-login');
      if (loginEl) {
        loginEl.textContent = storedHandle ? `${storedHandle.toLowerCase()}@pip-terminal` : 'guest@pip-terminal';
      }
    }
  }

  // --- Bootloader ---
  window.addEventListener('DOMContentLoaded', () => {
    initChartPane(panes[0]);
    renderSymbolTabs();
    setupAddTabButton();
    setupOrderPanelInteractions();
    setupLeftDrawer();
    setupBottomPanel();
    setupOptionChainModal();
    setupGatekeeper();
    setupGuideModal();
    setupIndicatorsMenu();
    setupTokenModal();
    setupKeysModal();
    setupGuestProfileModal();
    setupMobileFlow();

    loadCandles(panes[0]);
    startQuotesPolling();
    fetchPositionsAndOrders();

    // Regular position refresh
    setInterval(fetchPositionsAndOrders, 4000);
  });
})();
