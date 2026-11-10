// Neo PIP — Exness WebTrading Engine
// Multi-Pane Lightweight Charts + Exness Layout + Order Form + Live Quotes + Option Chain
(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  // Indicators State (TradingView Technicals - Default ONLY EMA 9 & EMA 21)
  const indicators = {
    showEma9: true,
    showEma21: true,
    showVwap: false,
    showSupertrend: false,
    showVpvr: false,
    showVol: false,
    showBb: false,
    showEma50: false,
    showEma200: false,
  };

  // Auth, User Isolation & Market Session State
  let ownerToken = localStorage.getItem('neo_owner_token') || '';
  let isAuthenticated = false;
  let isOwner = false;
  let isAdminUser = false;
  let currentUser = null;
  let currentMarketMode = 'indian'; // 'forex' | 'indian'
  let lastUserActivity = Date.now();
  let inactivityTimerInterval = null;
  const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  // Active Layout: 1 (Full), 2 (Dual Split), 3 (3-Charts)
  let activeLayout = 1;
  let activePaneIdx = 0;

  // Order Ticket State
  let selectedProduct = 'NRML'; // Default NRML (Carry Forward)
  let selectedOrderType = 'MKT'; // MKT, L, SL
  let selectedLots = 1;
  let updateLotDisplayFn = null;
  let openKeysModalFn = null;
  let cachedPositions = [];
  let cachedOrders = [];
  let cachedClosedPositions = [];
  let cachedExecutions = [];
  let cachedPnlSummary = {};
  let activeSltpRules = [];
  let updateMobileOrdersFn = null;
  let _lastSltpTickMs = 0;

  const FOREX_CATALOG = {
    XAUUSD: { symbol: 'XAUUSD', name: 'Gold Spot / US Dollar', type: 'COMMODITY', decimals: 2, spread: 0.40, leverage: 200, qty_per_lot: 100, lot_units: 100, multiplier: 1.0, signal: 'BUY' },
    BTCUSD: { symbol: 'BTCUSD', name: 'Bitcoin / US Dollar', type: 'CRYPTO', decimals: 2, spread: 18.0, leverage: 200, qty_per_lot: 100, lot_units: 1.0, multiplier: 0.01, signal: 'BUY' },
    ETHUSD: { symbol: 'ETHUSD', name: 'Ethereum / US Dollar', type: 'CRYPTO', decimals: 2, spread: 1.40, leverage: 200, qty_per_lot: 100, lot_units: 10.0, multiplier: 0.1, signal: 'BUY' },
    EURUSD: { symbol: 'EURUSD', name: 'Euro / US Dollar', type: 'FOREX', decimals: 5, spread: 0.00012, leverage: 200, qty_per_lot: 100000, lot_units: 100000, multiplier: 1.0, signal: 'BUY' },
    GBPUSD: { symbol: 'GBPUSD', name: 'British Pound / US Dollar', type: 'FOREX', decimals: 5, spread: 0.00015, leverage: 200, qty_per_lot: 100000, lot_units: 100000, multiplier: 1.0, signal: 'SELL' },
    USDJPY: { symbol: 'USDJPY', name: 'US Dollar / Japanese Yen', type: 'FOREX', decimals: 3, spread: 0.015, leverage: 200, qty_per_lot: 100000, lot_units: 100000, multiplier: 0.0065, signal: 'BUY' },
    AUDUSD: { symbol: 'AUDUSD', name: 'Australian Dollar / US Dollar', type: 'FOREX', decimals: 5, spread: 0.00014, leverage: 200, qty_per_lot: 100000, lot_units: 100000, multiplier: 1.0, signal: 'SELL' },
    XAGUSD: { symbol: 'XAGUSD', name: 'Silver Spot / US Dollar', type: 'COMMODITY', decimals: 3, spread: 0.030, leverage: 200, qty_per_lot: 5000, lot_units: 5000, multiplier: 1.0, signal: 'BUY' },
    USOIL:  { symbol: 'USOIL',  name: 'WTI Crude Oil / USD', type: 'COMMODITY', decimals: 2, spread: 0.03, leverage: 200, qty_per_lot: 1000, lot_units: 1000, multiplier: 1.0, signal: 'SELL' },
    USTEC:  { symbol: 'USTEC',  name: 'US Tech 100 (Nasdaq)', type: 'INDEX', decimals: 2, spread: 1.50, leverage: 200, qty_per_lot: 100, lot_units: 10.0, multiplier: 0.1, signal: 'BUY' },
  };

  function normFxSym(sym) {
    return String(sym || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function isForexSym(sym) {
    return Boolean(FOREX_CATALOG[normFxSym(sym)]);
  }

  function getForexSpec(sym) {
    return FOREX_CATALOG[normFxSym(sym)] || null;
  }

  function getSymbolDecimals(sym) {
    const fx = getForexSpec(sym);
    return fx ? fx.decimals : 2;
  }

  function curSym(sym = '') {
    if (sym && isForexSym(sym)) return '$';
    return currentMarketMode === 'forex' ? '$' : '₹';
  }

  function fmtMoney(val, decimals = 2, sym = '') {
    const n = Number(val || 0);
    const c = curSym(sym);
    const locale = c === '$' ? 'en-US' : 'en-IN';
    const sign = n < 0 ? '-' : '';
    return `${sign}${c}${Math.abs(n).toLocaleString(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
  }

  function fmtSigned(val, c = '₹', decimals = 2) {
    const n = Number(val || 0);
    return `${n >= 0 ? '+' : '-'}${c}${Math.abs(n).toFixed(decimals)}`;
  }

  function saveActiveTabSession(tabObj) {
    if (!tabObj || !tabObj.symbol) return;
    try {
      sessionStorage.setItem(`neo_active_tab_${currentMarketMode}`, JSON.stringify({
        symbol: tabObj.symbol,
        token: tabObj.token || '',
        interval: tabObj.interval || '1m',
        segment: tabObj.segment || '',
        rangeDays: tabObj.rangeDays || 5,
      }));
    } catch (_) {}
  }

  function loadInitialSingleTab(mode = currentMarketMode) {
    try {
      const raw = sessionStorage.getItem(`neo_active_tab_${mode}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.symbol) {
          const isFx = isForexSym(parsed.symbol);
          if ((mode === 'forex' && isFx) || (mode === 'indian' && !isFx)) {
            return [{
              symbol: parsed.symbol,
              token: parsed.token || '',
              interval: parsed.interval || '1m',
              isOption: isOptionSymbol(parsed.symbol),
              segment: parsed.segment || (isFx ? 'FOREX' : ''),
              rangeDays: parsed.rangeDays || 5,
            }];
          }
        }
      }
    } catch (_) {}
    if (mode === 'forex') {
      return [{ symbol: 'XAUUSD', token: 'FOREX|XAUUSD', interval: '1m', isOption: false, segment: 'FOREX', rangeDays: 5 }];
    }
    return [{ symbol: 'NIFTY', token: 'NSE_INDEX|Nifty 50', interval: '1m', isOption: false, segment: 'NSE_INDEX', rangeDays: 5 }];
  }

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

  // Open Symbol Tabs: ALWAYS start with 1 tab (NIFTY Index by default or active saved symbol on refresh)
  let openTabs = loadInitialSingleTab('indian');
  let activeTabIndex = 0;

  // Watchlist Favorites & Category lists (Indian + Forex)
  const WATCHLIST_PRESETS = {
    favorites: [
      { symbol: 'NIFTY', name: 'Nifty 50 Index', token: 'NSE_INDEX|Nifty 50', signal: 'BUY' },
      { symbol: 'BANKNIFTY', name: 'Bank Nifty Index', token: 'NSE_INDEX|Nifty Bank', signal: 'SELL' },
      { symbol: 'SENSEX', name: 'BSE Sensex Index', token: 'BSE_INDEX|SENSEX', signal: 'BUY' },
      { symbol: 'NIFTY 25000 CE', name: 'Nifty 50 25000 Call', token: '', signal: 'BUY' },
      { symbol: 'NIFTY 25000 PE', name: 'Nifty 50 25000 Put', token: '', signal: 'SELL' },
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
    forex_all: Object.values(FOREX_CATALOG).map(f => ({ symbol: f.symbol, name: f.name, token: `FOREX|${f.symbol}`, signal: f.signal, segment: 'FOREX' })),
    forex_crypto: ['XAUUSD', 'XAGUSD', 'BTCUSD', 'ETHUSD'].map(s => ({ symbol: s, name: FOREX_CATALOG[s].name, token: `FOREX|${s}`, signal: FOREX_CATALOG[s].signal, segment: 'FOREX' })),
    forex_pairs: ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD'].map(s => ({ symbol: s, name: FOREX_CATALOG[s].name, token: `FOREX|${s}`, signal: FOREX_CATALOG[s].signal, segment: 'FOREX' })),
    forex_indices: ['USOIL', 'USTEC'].map(s => ({ symbol: s, name: FOREX_CATALOG[s].name, token: `FOREX|${s}`, signal: FOREX_CATALOG[s].signal, segment: 'FOREX' })),
  };

  // Pane configurations
  const panes = [
    {
      idx: 0,
      id: 'pane-1',
      sym: openTabs[0].symbol,
      token: openTabs[0].token,
      tf: openTabs[0].interval || '1m',
      rangeDays: 5,
      isOption: openTabs[0].isOption || false,
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

    // Indicators Series (omit title & disable lastValueVisible so NO EMA/indicator labels appear on Y-axis)
    const ema9Series = chart.addLineSeries({ color: '#00d2d3', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });
    const ema21Series = chart.addLineSeries({ color: '#fb8500', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });
    const ema50Series = chart.addLineSeries({ color: '#8e44ad', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });
    const ema200Series = chart.addLineSeries({ color: '#ffb703', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
    const vwapSeries = chart.addLineSeries({ color: '#9b59b6', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
    const supertrendSeries = chart.addLineSeries({ color: '#00b074', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
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

    const plusBtn = $(`p${pane.idx + 1}-yaxis-plus`);
    if (plusBtn && !plusBtn.dataset.bound) {
      plusBtn.dataset.bound = '1';
      plusBtn.addEventListener('click', e => {
        e.stopPropagation();
        const hp = Number(pane.hoverPrice || pane.lastLtp || 0);
        if (hp > 0) openChartPlusMenu(pane, hp, plusBtn);
      });
    }

    // Crosshair move handler (updates OHLC header & floating '+' quick-order trigger on right Y-axis)
    chart.subscribeCrosshairMove(param => {
      if (param && param.time) {
        const bar = param.seriesData.get(candleSeries);
        if (bar) {
          updatePaneHeaderQuote(pane, bar.open, bar.high, bar.low, bar.close);
        }
      }
      if (plusBtn && param && param.point && Number.isFinite(param.point.y) && pane.candleSeries) {
        try {
          const pVal = pane.candleSeries.coordinateToPrice(param.point.y);
          if (pVal !== null && Number.isFinite(pVal) && pVal > 0) {
            const decs = getSymbolDecimals(pane.sym);
            const hWrap = canvasWrap ? canvasWrap.clientHeight : 320;
            const yClamped = Math.max(18, Math.min(hWrap - 36, param.point.y));
            pane.hoverPrice = Number(pVal.toFixed(decs));
            plusBtn.style.top = `${yClamped}px`;
            plusBtn.title = `Order @ ${curSym(pane.sym)}${pane.hoverPrice.toFixed(decs)}`;
            plusBtn.classList.remove('hidden');
          }
        } catch (_) {}
      } else if (plusBtn && (!param || !param.point)) {
        // Keep visible briefly unless pointer left wrap cleanly
      }
    });

    if (canvasWrap && !canvasWrap.dataset.plusLeaveBound) {
      canvasWrap.dataset.plusLeaveBound = '1';
      canvasWrap.addEventListener('mouseleave', () => {
        if (plusBtn) plusBtn.classList.add('hidden');
      });
      canvasWrap.addEventListener('wheel', () => requestAnimationFrame(() => renderPaneTradeLines(pane)), { passive: true });
      canvasWrap.addEventListener('pointermove', () => renderPaneTradeLines(pane), { passive: true });
    }

    // Visible logical range change for VPVR + Draggable Chart Trade Lines sync
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      renderPaneTradeLines(pane);
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
            renderPaneTradeLines(pane);
          }
        }
      });
      ro.observe(observeTarget);
      pane._ro = ro;
    }
  }

  // --- Y-Axis Floating '+' Quick Order Menu ---
  let activePlusMenuTarget = null;

  function openChartPlusMenu(pane, priceVal, anchorBtn) {
    const menu = $('chart-plus-order-menu');
    const stage = $('chart-stage');
    if (!menu || !stage || !pane) return;

    const decs = getSymbolDecimals(pane.sym);
    const roundedP = Number(priceVal.toFixed(decs));
    const ltp = Number(pane.lastLtp || roundedP);
    activePlusMenuTarget = { pane, price: roundedP, ltp };

    const cSym = curSym(pane.sym);
    if ($('cp-menu-sym')) $('cp-menu-sym').textContent = pane.sym;
    if ($('cp-menu-price')) $('cp-menu-price').textContent = `${cSym}${roundedP.toFixed(decs)}`;

    document.querySelectorAll('.cp-lot-lbl').forEach(el => { el.textContent = selectedLots; });
    const btnPendBuy = $('cp-btn-pend-buy');
    const btnPendSell = $('cp-btn-pend-sell');
    const buyType = roundedP < ltp ? 'Buy Limit' : 'Buy Stop-Limit';
    const sellType = roundedP > ltp ? 'Sell Limit' : 'Sell Stop-Limit';
    if (btnPendBuy) btnPendBuy.innerHTML = `${buyType} @ <span class="cp-price-txt">${cSym}${roundedP.toFixed(decs)}</span>`;
    if (btnPendSell) btnPendSell.innerHTML = `${sellType} @ <span class="cp-price-txt">${cSym}${roundedP.toFixed(decs)}</span>`;

    const stageRect = stage.getBoundingClientRect();
    const btnRect = anchorBtn.getBoundingClientRect();
    const topPos = Math.max(8, Math.min(stageRect.height - 175, btnRect.top - stageRect.top - 20));
    const leftPos = Math.max(8, btnRect.left - stageRect.left - 228);
    menu.style.top = `${topPos}px`;
    menu.style.left = `${leftPos}px`;
    menu.classList.remove('hidden');
  }

  function setupChartPlusMenuListeners() {
    const menu = $('chart-plus-order-menu');
    if (!menu) return;

    document.addEventListener('click', e => {
      if (!menu.classList.contains('hidden') && !menu.contains(e.target) && !e.target.classList.contains('yaxis-plus-btn')) {
        menu.classList.add('hidden');
      }
    });

    async function placePlusOrder(side, orderType, priceVal) {
      if (!activePlusMenuTarget) return;
      const pane = activePlusMenuTarget.pane;
      const sym = pane.sym;
      const fx = getForexSpec(sym);
      const isFx = Boolean(fx) || currentMarketMode === 'forex';
      const lotSize = fx ? fx.qty_per_lot : getIndexLotSize(sym);
      const meta = symbolMeta[String(sym || '').trim().toUpperCase()] || {};
      const isFo = Boolean(pane.isOption || isOptionSymbol(sym) || /\bFUT\b/i.test(sym) || String(meta.segment || '').toUpperCase().includes('_FO'));
      const seg = isFx ? 'forex' : (isFo ? 'nse_fo' : 'nse_cm');

      const payload = {
        symbol: sym,
        exchange_segment: seg,
        side,
        lots: selectedLots,
        lot_size: lotSize,
        product: selectedProduct,
        order_type: orderType,
        price: orderType === 'MKT' ? null : priceVal,
        trigger_price: orderType === 'SL' ? priceVal : null,
        validity: 'DAY',
        user_confirmed: true,
      };
      menu.classList.add('hidden');
      try {
        toast(`Submitting ${side} ${orderType} ${sym}...`);
        const res = await api(`/api/orders?market=${encodeURIComponent(currentMarketMode)}`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          toast(`✅ ${res.message || `${side} order placed!`}`);
          await fetchPositionsAndOrders();
        }
      } catch (err) {
        toast(`❌ ${err.message}`);
      }
    }

    if ($('cp-btn-mkt-buy')) $('cp-btn-mkt-buy').addEventListener('click', () => placePlusOrder('BUY', 'MKT', null));
    if ($('cp-btn-mkt-sell')) $('cp-btn-mkt-sell').addEventListener('click', () => placePlusOrder('SELL', 'MKT', null));
    if ($('cp-btn-pend-buy')) {
      $('cp-btn-pend-buy').addEventListener('click', () => {
        if (!activePlusMenuTarget) return;
        const { price, ltp } = activePlusMenuTarget;
        placePlusOrder('BUY', price < ltp ? 'L' : 'SL', price);
      });
    }
    if ($('cp-btn-pend-sell')) {
      $('cp-btn-pend-sell').addEventListener('click', () => {
        if (!activePlusMenuTarget) return;
        const { price, ltp } = activePlusMenuTarget;
        placePlusOrder('SELL', price > ltp ? 'L' : 'SL', price);
      });
    }
  }

  // --- Draggable Entry / SL / TP Price Lines Directly on Chart Canvas ---
  function attachPriceLineDrag(handleEl, lineEl, pane, rule, fieldKey, labelPrefix, decs) {
    let dragging = false;

    const getClientY = ev => (ev.touches && ev.touches[0] ? ev.touches[0].clientY : ev.clientY);

    function onStart(ev) {
      ev.preventDefault();
      ev.stopPropagation();
      dragging = true;
      document.body.style.cursor = 'ns-resize';
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onEnd);
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('touchend', onEnd);
    }

    function onMove(ev) {
      if (!dragging || !pane.candleSeries || !pane.canvasWrap) return;
      if (ev.cancelable) ev.preventDefault();
      const wrapRect = pane.canvasWrap.getBoundingClientRect();
      const y = Math.max(8, Math.min(wrapRect.height - 28, getClientY(ev) - wrapRect.top));
      const newPrice = pane.candleSeries.coordinateToPrice(y);
      if (newPrice !== null && Number.isFinite(newPrice) && newPrice > 0) {
        const rounded = Number(newPrice.toFixed(decs));
        lineEl.style.top = `${y}px`;
        lineEl.dataset.dragPrice = String(rounded);
        handleEl.textContent = `${labelPrefix} ${curSym(pane.sym)}${rounded.toFixed(decs)}`;
      }
    }

    async function onEnd() {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);

      const finalP = Number(lineEl.dataset.dragPrice || 0);
      if (finalP > 0) {
        rule[fieldKey] = finalP;
        try {
          await api(`/api/sltp/${rule.id}?market=${encodeURIComponent(currentMarketMode)}`, {
            method: 'PATCH',
            body: JSON.stringify({ [fieldKey]: finalP }),
          });
          toast(`✅ Updated ${labelPrefix} to ${curSym(pane.sym)}${finalP.toFixed(decs)}`);
          renderPaneTradeLines(pane);
        } catch (err) {
          toast(`❌ ${err.message}`);
          renderPaneTradeLines(pane);
        }
      }
    }

    handleEl.addEventListener('mousedown', onStart);
    handleEl.addEventListener('touchstart', onStart, { passive: false });
  }

  function renderPaneTradeLines(pane) {
    if (!pane) return;
    const overlay = $(`p${pane.idx + 1}-trade-overlay`);
    if (!overlay || !pane.candleSeries || !pane.candles || !pane.candles.length) {
      if (overlay) overlay.innerHTML = '';
      return;
    }

    const symUpper = String(pane.sym || '').trim().toUpperCase();
    const pos = cachedPositions.find(p => String(p.symbol || p.trading_symbol || p.trdSym || '').trim().toUpperCase() === symUpper);
    const rules = activeSltpRules.filter(r => String(r.symbol || '').trim().toUpperCase() === symUpper && r.status === 'active');

    overlay.innerHTML = '';
    const decs = getSymbolDecimals(pane.sym);
    const cs = curSym(pane.sym);
    const wrapH = overlay.clientHeight || 280;

    function createLineEl(cls, priceVal) {
      const y = pane.candleSeries.priceToCoordinate(Number(priceVal));
      if (y === null || !Number.isFinite(y) || y < 2 || y > wrapH - 2) return null;
      const el = document.createElement('div');
      el.className = `trade-price-line ${cls}`;
      el.style.top = `${y}px`;
      el.innerHTML = '<div class="tpl-line"></div>';
      return el;
    }

    // 1. Entry Price Line for open position
    if (pos) {
      const avg = Number(pos.average_price || pos.avg_price || 0);
      const side = String(pos.side || (pos.direction === 'SHORT' ? 'SELL' : 'BUY')).toUpperCase();
      const qtyDisp = pos.lots && isForexSym(pane.sym) ? `${pos.lots} lot` : `${Math.abs(Number(pos.quantity || 0))}`;
      const m2m = Number(pos.m2m || 0);
      const entryLine = createLineEl('tpl-entry', avg);
      if (entryLine) {
        const bg = document.createElement('div');
        bg.className = 'tpl-badge-group';
        const tag = document.createElement('span');
        tag.className = 'tpl-drag-handle';
        tag.textContent = `${side} ${qtyDisp} (${m2m >= 0 ? '+' : ''}${cs}${m2m.toFixed(2)})`;
        bg.appendChild(tag);

        if (!rules.length) {
          const addSltpBtn = document.createElement('button');
          addSltpBtn.type = 'button';
          addSltpBtn.className = 'tpl-action-chip';
          addSltpBtn.textContent = '+SL/TP';
          addSltpBtn.title = 'Attach draggable SL & TP lines on chart';
          addSltpBtn.addEventListener('click', async e => {
            e.stopPropagation();
            const ref = Number(pane.lastLtp || avg);
            const delta = Math.max(ref * 0.004, decs >= 3 ? 0.0020 : 1.0);
            const slP = Number((side === 'BUY' ? ref - delta : ref + delta).toFixed(decs));
            const tpP = Number((side === 'BUY' ? ref + delta * 1.5 : ref - delta * 1.5).toFixed(decs));
            try {
              const fx = getForexSpec(pane.sym);
              await api(`/api/sltp?market=${encodeURIComponent(currentMarketMode)}`, {
                method: 'POST',
                body: JSON.stringify({
                  symbol: pane.sym,
                  exchange_segment: fx ? 'forex' : 'nse_fo',
                  product: pos.product || 'NRML',
                  side,
                  quantity: Math.abs(Number(pos.quantity || 1)),
                  entry_price: avg,
                  sl_price: slP,
                  tp_price: tpP,
                }),
              });
              toast('✅ Added draggable SL & TP lines! Drag them up/down on chart.');
              await fetchPositionsAndOrders();
            } catch (err) {
              toast(`❌ ${err.message}`);
            }
          });
          bg.appendChild(addSltpBtn);
        }

        const closePosBtn = document.createElement('button');
        closePosBtn.type = 'button';
        closePosBtn.className = 'tpl-action-chip close-x';
        closePosBtn.textContent = '✕';
        closePosBtn.title = 'Close position at market';
        closePosBtn.addEventListener('click', async e => {
          e.stopPropagation();
          try {
            await api(`/api/positions/${encodeURIComponent(pane.sym)}/exit?market=${encodeURIComponent(currentMarketMode)}`, {
              method: 'POST',
              body: JSON.stringify({ percentage: 100 }),
            });
            toast(`✅ Closed ${pane.sym}`);
            fetchPositionsAndOrders();
          } catch (err) {
            toast(`❌ ${err.message}`);
          }
        });
        bg.appendChild(closePosBtn);
        entryLine.appendChild(bg);
        overlay.appendChild(entryLine);
      }
    }

    // 2. Draggable SL & TP Price Lines
    rules.forEach(rule => {
      if (rule.tp_price !== null && rule.tp_price !== undefined && Number(rule.tp_price) > 0) {
        const tpP = Number(rule.tp_price);
        const tpLine = createLineEl('tpl-tp', tpP);
        if (tpLine) {
          const bg = document.createElement('div');
          bg.className = 'tpl-badge-group';
          const handle = document.createElement('span');
          handle.className = 'tpl-drag-handle';
          handle.textContent = `TP ${cs}${tpP.toFixed(decs)}`;
          handle.title = 'Drag up/down to adjust Take Profit';
          attachPriceLineDrag(handle, tpLine, pane, rule, 'tp_price', 'TP', decs);
          const rmBtn = document.createElement('button');
          rmBtn.type = 'button';
          rmBtn.className = 'tpl-action-chip close-x';
          rmBtn.textContent = '✕';
          rmBtn.title = 'Remove Take Profit line';
          rmBtn.addEventListener('click', async e => {
            e.stopPropagation();
            if (rule.sl_price) {
              await api(`/api/sltp/${rule.id}?market=${encodeURIComponent(currentMarketMode)}`, {
                method: 'PATCH',
                body: JSON.stringify({ clear_tp: true }),
              }).catch(() => {});
            } else {
              await api(`/api/sltp/${rule.id}?market=${encodeURIComponent(currentMarketMode)}`, { method: 'DELETE' }).catch(() => {});
            }
            fetchPositionsAndOrders();
          });
          bg.appendChild(handle);
          bg.appendChild(rmBtn);
          tpLine.appendChild(bg);
          overlay.appendChild(tpLine);
        }
      }

      if (rule.sl_price !== null && rule.sl_price !== undefined && Number(rule.sl_price) > 0) {
        const slP = Number(rule.sl_price);
        const slLine = createLineEl('tpl-sl', slP);
        if (slLine) {
          const bg = document.createElement('div');
          bg.className = 'tpl-badge-group';
          const handle = document.createElement('span');
          handle.className = 'tpl-drag-handle';
          handle.textContent = `SL ${cs}${slP.toFixed(decs)}`;
          handle.title = 'Drag up/down to adjust Stop Loss';
          attachPriceLineDrag(handle, slLine, pane, rule, 'sl_price', 'SL', decs);
          const rmBtn = document.createElement('button');
          rmBtn.type = 'button';
          rmBtn.className = 'tpl-action-chip close-x';
          rmBtn.textContent = '✕';
          rmBtn.title = 'Remove Stop Loss line';
          rmBtn.addEventListener('click', async e => {
            e.stopPropagation();
            if (rule.tp_price) {
              await api(`/api/sltp/${rule.id}?market=${encodeURIComponent(currentMarketMode)}`, {
                method: 'PATCH',
                body: JSON.stringify({ clear_sl: true }),
              }).catch(() => {});
            } else {
              await api(`/api/sltp/${rule.id}?market=${encodeURIComponent(currentMarketMode)}`, { method: 'DELETE' }).catch(() => {});
            }
            fetchPositionsAndOrders();
          });
          bg.appendChild(handle);
          bg.appendChild(rmBtn);
          slLine.appendChild(bg);
          overlay.appendChild(slLine);
        }
      }
    });
  }

  function renderAllPaneTradeLines() {
    panes.forEach(p => {
      if (p && p.chart) renderPaneTradeLines(p);
    });
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
    const decs = getSymbolDecimals(pane.sym);
    const oEl = $(`p${pane.idx + 1}-o`);
    const hEl = $(`p${pane.idx + 1}-h`);
    const lEl = $(`p${pane.idx + 1}-l`);
    const cEl = $(`p${pane.idx + 1}-c`);
    if (oEl) oEl.textContent = open ? open.toFixed(decs) : '—';
    if (hEl) hEl.textContent = high ? high.toFixed(decs) : '—';
    if (lEl) lEl.textContent = low ? low.toFixed(decs) : '—';
    if (cEl) cEl.textContent = close ? close.toFixed(decs) : '—';

    // If active pane, also update top bar OHLC
    if (pane.idx === 0) {
      const co = $('c-open');
      const ch = $('c-high');
      const cl = $('c-low');
      const cc = $('c-close');
      if (co) co.textContent = open ? open.toFixed(decs) : '—';
      if (ch) ch.textContent = high ? high.toFixed(decs) : '—';
      if (cl) cl.textContent = low ? low.toFixed(decs) : '—';
      if (cc) cc.textContent = close ? close.toFixed(decs) : '—';
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

    const decs = getSymbolDecimals(pane.sym);
    const cs = curSym(pane.sym);
    const ref = (pane.prevClose && pane.prevClose > 0) ? pane.prevClose : (pane.candles[0] ? pane.candles[0].open : ltp);
    const diff = ltp - ref;
    const pct = ref > 0 ? (diff / ref) * 100 : 0;
    const isPos = diff >= 0;

    const ltpEl = $(`p${pane.idx + 1}-ltp`);
    const chgEl = $(`p${pane.idx + 1}-chg`);
    if (ltpEl) ltpEl.textContent = `${cs}${ltp.toFixed(decs)}`;
    if (chgEl) {
      chgEl.textContent = `${isPos ? '+' : ''}${diff.toFixed(decs)} (${isPos ? '+' : ''}${pct.toFixed(2)}%)`;
      chgEl.className = `pane-chg ${isPos ? 'pos' : 'neg'}`;
    }

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
      const isFxResolved = Boolean(data && data.is_forex) || isForexSym(pane.sym) || ikey.startsWith('FOREX|');
      pane.isOption = !isFxResolved && (isOptionSymbol(pane.sym) || isOptResolved);
      const segLabel = isFxResolved ? 'FOREX' : (isOptResolved ? 'NSE F&O' : (ikey.includes('_INDEX') ? 'NSE INDEX' : 'NSE EQ'));
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
        renderPaneTradeLines(pane);
        return;
      }

      if (!pane.chart || !pane.candleSeries) {
        initChartPane(pane);
      }
      if (!pane.candleSeries || !pane.volSeries) return;

      const decs = getSymbolDecimals(pane.sym);
      const minMove = Number((1 / Math.pow(10, decs)).toFixed(decs));
      try {
        pane.candleSeries.applyOptions({
          priceFormat: { type: 'price', precision: decs, minMove },
        });
        pane.chart.priceScale('right').applyOptions({ autoScale: true });
      } catch (_) {}

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

      // Auto-scale Y axis + fit X axis cleanly whenever candles or symbol load (Fix #4: NIFTY -> SENSEX auto fit)
      function refitPane() {
        if (!pane.chart || reqId !== pane._reqId) return;
        resizePaneChart(pane);
        try {
          pane.chart.priceScale('right').applyOptions({ autoScale: true });
          pane.chart.timeScale().fitContent();
          renderPaneTradeLines(pane);
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

  async function maybeCheckLiveTriggers(pane, ltp) {
    if (!isAuthenticated || !pane || !ltp || ltp <= 0) return;
    const now = Date.now();
    if (now - _lastSltpTickMs < 650) return;
    const symU = String(pane.sym || '').trim().toUpperCase();
    const hasPending = cachedOrders.some(o => o.status === 'pending' && String(o.symbol || '').trim().toUpperCase() === symU);
    const hasRules = activeSltpRules.some(r => r.status === 'active' && String(r.symbol || '').trim().toUpperCase() === symU);
    if (!hasPending && !hasRules) return;

    _lastSltpTickMs = now;
    try {
      const res = await api(`/api/sltp/check?market=${encodeURIComponent(currentMarketMode)}`, {
        method: 'POST',
        body: JSON.stringify({ symbol: pane.sym, ltp: Number(ltp) }),
      });
      if (res && (res.triggered_count > 0 || res.filled_pending_count > 0)) {
        if (res.triggered_count > 0) toast(`🎯 ${res.triggered[0].trigger_type} hit on ${pane.sym} @ ${curSym(pane.sym)}${ltp}`);
        if (res.filled_pending_count > 0) toast(`⚡ Pending order filled on ${pane.sym} @ ${curSym(pane.sym)}${res.filled_pending[0].fill_price}`);
        fetchPositionsAndOrders();
      }
    } catch (_) {}
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
              // Update live candle bar safely
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
              maybeCheckLiveTriggers(pane, q.ltp);
            }
          });
        }
        if (pollTickCount % 15 === 0) {
          updateWatchlistQuotes();
        }
      } catch (e) {
        // quiet error
      }
      setTimeout(tick, 180);
    }
    tick();
  }

  // --- Exness Order Ticket Controls ---
  function getIndexLotSize(symbol) {
    const fx = getForexSpec(symbol);
    if (fx) return fx.qty_per_lot;
    const s = String(symbol || '').trim().toUpperCase();
    if (symbolMeta[s] && Number(symbolMeta[s].lotSize) > 0) {
      return Number(symbolMeta[s].lotSize);
    }
    const isDeriv = isOptionSymbol(s) || /\bFUT\b/i.test(s) || s === 'NIFTY' || s === 'BANKNIFTY' || s === 'FINNIFTY' || s === 'MIDCPNIFTY' || s === 'SENSEX' || s === 'BANKEX';
    if (!isDeriv) return 1;
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
    const sym = panes[0].sym;
    const fx = getForexSpec(sym);
    const decs = fx ? fx.decimals : 2;
    const spread = fx ? fx.spread : ((ltp * 0.0005) + 0.05);
    const askPrice = ltp + (spread / 2);
    const bidPrice = Math.max(decs >= 4 ? 0.0001 : 0.05, ltp - (spread / 2));

    const sellLbl = $('lbl-sell-price');
    const buyLbl = $('lbl-buy-price');
    if (sellLbl) sellLbl.textContent = bidPrice.toFixed(decs);
    if (buyLbl) buyLbl.textContent = askPrice.toFixed(decs);

    const spreadText = $('op-spread-text');
    if (spreadText) spreadText.textContent = `${spread.toFixed(decs)} Spread`;

    let estMargin = 0;
    if (fx) {
      const notional = Number(selectedLots) * Number(fx.lot_units || 1) * (normFxSym(sym) === 'USDJPY' ? 1.0 : ltp);
      estMargin = notional / Number(fx.leverage || 200);
    } else {
      const lotSize = getIndexLotSize(sym);
      const totalQty = selectedLots * lotSize;
      estMargin = ltp * totalQty;
    }
    const marginEl = $('op-margin-req');
    if (marginEl) marginEl.textContent = fmtMoney(estMargin, 2, sym);

    const cs = curSym(sym);
    const lblLimCur = $('lbl-limit-cur');
    const lblTrigCur = $('lbl-trigger-cur');
    if (lblLimCur) lblLimCur.textContent = cs === '$' ? 'USD ($)' : 'INR (₹)';
    if (lblTrigCur) lblTrigCur.textContent = cs === '$' ? 'USD ($)' : 'INR (₹)';

    const limitInput = $('input-limit-price');
    if (limitInput && (!limitInput.value || limitInput.dataset.manual !== 'true')) {
      limitInput.value = ltp.toFixed(decs);
    }
    const trigInput = $('input-trigger-price');
    if (trigInput && (!trigInput.value || trigInput.dataset.manual !== 'true')) {
      trigInput.value = Math.max(0.0001, ltp - spread).toFixed(decs);
    }

    const mSell = $('m-sell-price');
    const mBuy = $('m-buy-price');
    const mSpread = $('m-spread-val');
    const mMargin = $('m-margin-val');
    if (mSell) mSell.textContent = bidPrice.toFixed(decs);
    if (mBuy) mBuy.textContent = askPrice.toFixed(decs);
    if (mSpread) mSpread.textContent = spread.toFixed(decs);
    if (mMargin) mMargin.textContent = fmtMoney(estMargin, 2, sym);
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
        toast('Product set to NRML (Carry Forward)');
      });
      btnMis.addEventListener('click', () => {
        selectedProduct = 'MIS';
        btnMis.classList.add('active');
        btnNrml.classList.remove('active');
        toast('Product set to MIS (Intraday)');
      });
    }

    // Auto SL / TP ticket toggle
    const chkSltp = $('chk-ticket-sltp');
    const sltpInputsBox = $('op-sltp-inputs');
    if (chkSltp && sltpInputsBox) {
      chkSltp.addEventListener('change', () => {
        sltpInputsBox.classList.toggle('hidden', !chkSltp.checked);
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

    // 3. Lots Stepper (Supports 0.01 fractional lots in Forex and integer lots in Indian)
    const inputLots = $('input-lots');
    const btnLotsMinus = $('btn-lots-minus');
    const btnLotsPlus = $('btn-lots-plus');
    const unitsSub = $('op-units-sub');

    function updateLotDisplay() {
      const sym = panes[0].sym;
      const fx = getForexSpec(sym);
      const isFx = Boolean(fx) || currentMarketMode === 'forex';
      if (inputLots) {
        inputLots.step = isFx ? '0.01' : '1';
        inputLots.min = isFx ? '0.01' : '1';
      }
      if (isFx) {
        const parsed = parseFloat(inputLots ? inputLots.value : selectedLots);
        selectedLots = Number.isFinite(parsed) && parsed >= 0.01 ? Number(parsed.toFixed(2)) : 0.01;
      } else {
        selectedLots = Math.max(1, parseInt(inputLots ? inputLots.value : selectedLots) || 1);
      }
      if (inputLots) inputLots.value = selectedLots;

      if (unitsSub) {
        if (fx) {
          const effUnits = (selectedLots * Number(fx.lot_units || 1)).toFixed(fx.lot_units < 10 ? 2 : 0);
          unitsSub.textContent = `${selectedLots} lot (Leverage 1:${fx.leverage}, ${effUnits} units)`;
        } else {
          const lotSize = getIndexLotSize(sym);
          const units = selectedLots * lotSize;
          unitsSub.textContent = lotSize === 1 ? `${units} share${units > 1 ? 's' : ''}` : `${units} units (${selectedLots} Lot × ${lotSize})`;
        }
      }
      const mLotsVal = $('m-lots-val');
      if (mLotsVal) mLotsVal.textContent = selectedLots;
      if (panes[0].lastLtp) updateOrderFormPrices(panes[0].lastLtp);
    }
    updateLotDisplayFn = updateLotDisplay;

    if (btnLotsMinus && btnLotsPlus && inputLots) {
      btnLotsMinus.addEventListener('click', () => {
        const isFx = isForexSym(panes[0].sym) || currentMarketMode === 'forex';
        const step = isFx ? 0.05 : 1;
        const minV = isFx ? 0.01 : 1;
        const next = Math.max(minV, Number((selectedLots - step).toFixed(2)));
        inputLots.value = next;
        updateLotDisplay();
      });
      btnLotsPlus.addEventListener('click', () => {
        const isFx = isForexSym(panes[0].sym) || currentMarketMode === 'forex';
        const step = isFx ? 0.05 : 1;
        inputLots.value = Number((selectedLots + step).toFixed(2));
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
      const isFx = isForexSym(panes[0].sym) || currentMarketMode === 'forex';
      const step = isFx ? 0.05 : 1;
      const minV = isFx ? 0.01 : 1;
      selectedLots = Math.max(minV, Number((selectedLots - step).toFixed(2)));
      if (inputLots) inputLots.value = selectedLots;
      updateLotDisplay();
    });
    if (mLotsPlus) mLotsPlus.addEventListener('click', () => {
      const isFx = isForexSym(panes[0].sym) || currentMarketMode === 'forex';
      const step = isFx ? 0.05 : 1;
      selectedLots = Number((selectedLots + step).toFixed(2));
      if (inputLots) inputLots.value = selectedLots;
      updateLotDisplay();
    });

    // 4. Steppers for Limit Price & Trigger Price
    const btnPriceMinus = $('btn-price-minus');
    const btnPricePlus = $('btn-price-plus');
    const inputPrice = $('input-limit-price');
    if (btnPriceMinus && btnPricePlus && inputPrice) {
      const getStep = () => {
        const decs = getSymbolDecimals(panes[0].sym);
        return decs >= 4 ? 0.0005 : (decs === 3 ? 0.05 : 0.25);
      };
      btnPriceMinus.addEventListener('click', () => {
        const decs = getSymbolDecimals(panes[0].sym);
        const cur = parseFloat(inputPrice.value) || (panes[0].lastLtp || 40);
        inputPrice.value = Math.max(0.0001, cur - getStep()).toFixed(decs);
        inputPrice.dataset.manual = 'true';
      });
      btnPricePlus.addEventListener('click', () => {
        const decs = getSymbolDecimals(panes[0].sym);
        const cur = parseFloat(inputPrice.value) || (panes[0].lastLtp || 40);
        inputPrice.value = (cur + getStep()).toFixed(decs);
        inputPrice.dataset.manual = 'true';
      });
      inputPrice.addEventListener('input', () => { inputPrice.dataset.manual = 'true'; });
    }

    const btnTriggerMinus = $('btn-trigger-minus');
    const btnTriggerPlus = $('btn-trigger-plus');
    const inputTrigger = $('input-trigger-price');
    if (btnTriggerMinus && btnTriggerPlus && inputTrigger) {
      const getStep = () => {
        const decs = getSymbolDecimals(panes[0].sym);
        return decs >= 4 ? 0.0005 : (decs === 3 ? 0.05 : 0.25);
      };
      btnTriggerMinus.addEventListener('click', () => {
        const decs = getSymbolDecimals(panes[0].sym);
        const cur = parseFloat(inputTrigger.value) || (panes[0].lastLtp || 40);
        inputTrigger.value = Math.max(0.0001, cur - getStep()).toFixed(decs);
        inputTrigger.dataset.manual = 'true';
      });
      btnTriggerPlus.addEventListener('click', () => {
        const decs = getSymbolDecimals(panes[0].sym);
        const cur = parseFloat(inputTrigger.value) || (panes[0].lastLtp || 40);
        inputTrigger.value = (cur + getStep()).toFixed(decs);
        inputTrigger.dataset.manual = 'true';
      });
      inputTrigger.addEventListener('input', () => { inputTrigger.dataset.manual = 'true'; });
    }

    // 5. Submit Order (Buy / Sell)
    async function submitOrder(side) {
      const sym = panes[0].sym;
      const fx = getForexSpec(sym);
      const isFx = Boolean(fx) || currentMarketMode === 'forex';
      const lotSize = fx ? fx.qty_per_lot : getIndexLotSize(sym);
      const qty = Math.max(1, Math.round(selectedLots * lotSize));
      const meta = symbolMeta[String(sym || '').trim().toUpperCase()] || {};
      const isFo = Boolean(
        !isFx && (
          panes[0].isOption ||
          isOptionSymbol(sym) ||
          /\bFUT\b/i.test(sym) ||
          String(meta.segment || '').toUpperCase().includes('_FO')
        )
      );
      const seg = isFx ? 'forex' : (isFo ? 'nse_fo' : 'nse_cm');

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

      const qtyLabel = isFx ? `${selectedLots} Lot(s) ${sym}` : (lotSize === 1 ? `${qty} share${qty > 1 ? 's' : ''}` : `${selectedLots} Lot(s) (${qty} qty)`);

      try {
        toast(`Submitting ${side} ${qtyLabel}...`);
        const res = await api(`/api/orders?market=${encodeURIComponent(currentMarketMode)}`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });

        if (res.ok) {
          const modeTag = res.mode === 'live' ? 'Kotak Live' : (isFx ? 'Forex Paper' : 'Indian Paper');
          toast(`✅ ${res.message || `${side} order placed (${modeTag})!`}`);

          // Attach Auto SL / TP rule if toggled in ticket and executed immediately
          if (chkSltp && chkSltp.checked && selectedOrderType === 'MKT') {
            const slVal = parseFloat($('op-sl-input')?.value || '');
            const tpVal = parseFloat($('op-tp-input')?.value || '');
            if (slVal > 0 || tpVal > 0) {
              await api(`/api/sltp?market=${encodeURIComponent(currentMarketMode)}`, {
                method: 'POST',
                body: JSON.stringify({
                  symbol: sym,
                  exchange_segment: seg,
                  product: selectedProduct,
                  side,
                  quantity: qty,
                  entry_price: Number(res.fill_price || panes[0].lastLtp || 1),
                  sl_price: slVal > 0 ? slVal : null,
                  tp_price: tpVal > 0 ? tpVal : null,
                }),
              }).catch(() => {});
            }
          }

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
    saveActiveTabSession(selected);
    const meta = symbolMeta[String(selected.symbol || '').trim().toUpperCase()] || {};
    const segUpper = String(selected.segment || meta.segment || '').toUpperCase();
    const isFx = isForexSym(selected.symbol) || segUpper === 'FOREX';
    const isOpt = !isFx && isOptionSymbol(selected.symbol);
    const isFo = !isFx && Boolean(isOpt || /\bFUT\b/i.test(selected.symbol) || segUpper.includes('_FO'));

    panes[0].sym = selected.symbol;
    panes[0].token = selected.token || '';
    panes[0].tf = selected.interval || '1m';
    panes[0].rangeDays = selected.rangeDays || 5;
    panes[0].isOption = isOpt;
    panes[0].lastLtp = null;
    panes[0].prevClose = null;
    clearPaneChartData(panes[0]);

    // Explicitly re-enable Y-axis autoScale before switching symbol so high/low price jumps auto-fit cleanly (Fix #4)
    if (panes[0].chart) {
      try {
        panes[0].chart.priceScale('right').applyOptions({ autoScale: true });
      } catch (_) {}
    }

    const symTitle = $('chart-active-sym');
    const symSeg = $('chart-active-seg');
    const p1Sym = $('p1-sym');
    const p1Tf = $('p1-tf');
    const pane1El = $('pane-1');
    const p1SegBadge = pane1El ? pane1El.querySelector('.pane-seg') : null;
    const isIdxSym = String(selected.token || '').includes('_INDEX') || ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'].includes(selected.symbol.toUpperCase());
    const segLabel = isFx ? 'FOREX' : (isFo ? 'NSE F&O' : (isIdxSym ? 'NSE INDEX' : 'NSE EQ'));

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

    if (typeof updateLotDisplayFn === 'function') {
      updateLotDisplayFn();
    }

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
    const isFx = isForexSym(cleanSym) || String(segment || '').toUpperCase() === 'FOREX';
    if (isFx && currentMarketMode !== 'forex') {
      // Automatically adapt mode UI when selecting FX instrument
      applyMarketModeUI('forex', false);
    } else if (!isFx && currentMarketMode === 'forex') {
      applyMarketModeUI('indian', false);
    }

    if (lotSize || segment) {
      registerSymbolMeta(cleanSym, { lotSize, segment });
    }
    const segUpper = String(segment || '').toUpperCase();
    const isOpt = !isFx && isOptionSymbol(cleanSym);
    const existing = openTabs.findIndex(t => t.symbol.toUpperCase() === cleanSym.toUpperCase());
    if (existing >= 0) {
      if (token && !openTabs[existing].token) {
        openTabs[existing].token = token;
      }
      if (segment && !openTabs[existing].segment) {
        openTabs[existing].segment = segment;
      }
      // Mobile Fix #3: enforce at most 2 tabs kept open on mobile
      if (window.innerWidth <= 768 && openTabs.length > 2) {
        const picked = openTabs.splice(existing, 1)[0];
        openTabs.push(picked);
        openTabs = openTabs.slice(-2);
        switchTab(openTabs.length - 1);
        return;
      }
      switchTab(existing);
      return;
    }
    openTabs.push({
      symbol: cleanSym,
      token: token || (isFx ? `FOREX|${normFxSym(cleanSym)}` : ''),
      interval: '1m',
      rangeDays: 5,
      isOption: !isFx && (isOpt || segUpper === 'NSE_FO' || /\bFUT\b/i.test(cleanSym)),
      segment: segment || (isFx ? 'FOREX' : ''),
    });
    // Mobile Fix #3: close all other tabs except the last two on mobile screens
    if (window.innerWidth <= 768 && openTabs.length > 2) {
      openTabs = openTabs.slice(-2);
    }
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

    function searchPromptHint() {
      return currentMarketMode === 'forex'
        ? '<div class="quick-search-hint">Search XAUUSD, BTCUSD, ETHUSD, EURUSD, GBPUSD, USOIL, USTEC…</div>'
        : '<div class="quick-search-hint">Type 3+ characters to search Upstox / Kotak (e.g. REL, MAR, 25000 CE)</div>';
    }

    function openSearchPopup(e) {
      if (e) e.stopPropagation();
      if (leftPanel) leftPanel.classList.remove('collapsed');
      if (popup) {
        popup.classList.toggle('hidden');
        if (!popup.classList.contains('hidden') && input) {
          if (input) input.placeholder = currentMarketMode === 'forex' ? 'Search XAUUSD, BTCUSD, EURUSD...' : 'Search NSE stock or strike (3+ chars, e.g. REL, 25000 CE)';
          if (!input.value.trim() && resultsBox) {
            if (currentMarketMode === 'forex') {
              renderQuickSearchList(WATCHLIST_PRESETS.forex_all);
            } else {
              resultsBox.innerHTML = searchPromptHint();
            }
          }
          input.focus();
          input.select();
        }
      }
    }

    function renderQuickSearchList(items) {
      if (!resultsBox) return;
      resultsBox.innerHTML = '';
      items.forEach(r => {
        registerSymbolMeta(r.symbol, { lotSize: r.lot_size, segment: r.segment });
        const item = document.createElement('div');
        item.className = 'quick-search-item';
        const hasSubName = r.name && r.name.toUpperCase() !== r.symbol.toUpperCase();
        item.innerHTML = `
          <div class="item-main">
            <b>${escapeHtml(r.symbol)}</b>
            ${hasSubName ? `<div class="ex-search-row-sub">${escapeHtml(r.name)}</div>` : ''}
          </div>
          <div class="item-sub">${escapeHtml(r.segment || (currentMarketMode === 'forex' ? 'FOREX' : 'NSE'))}</div>
        `;
        item.addEventListener('click', () => {
          addSymbolTab(r.symbol, r.token || '', r.lot_size || 0, r.segment || '');
          popup.classList.add('hidden');
          input.value = '';
        });
        resultsBox.appendChild(item);
      });
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
          if (currentMarketMode === 'forex') renderQuickSearchList(WATCHLIST_PRESETS.forex_all);
          else resultsBox.innerHTML = searchPromptHint();
          return;
        }
        const minLen = currentMarketMode === 'forex' ? 1 : 3;
        if (q.length < minLen) {
          const need = minLen - q.length;
          resultsBox.innerHTML = `<div class="quick-search-hint">Type ${need} more character${need > 1 ? 's' : ''} to search…</div>`;
          return;
        }

        const reqSeq = ++quickSearchSeq;
        debounceTimer = setTimeout(async () => {
          try {
            resultsBox.innerHTML = '<div class="quick-search-hint">Searching…</div>';
            const data = await api(`/api/chart/search?q=${encodeURIComponent(q)}&market=${encodeURIComponent(currentMarketMode)}`);
            if (reqSeq !== quickSearchSeq) return;
            if (data.ok && data.results && data.results.length) {
              renderQuickSearchList(data.results);
            } else {
              resultsBox.innerHTML = '<div class="quick-search-hint">No matching symbols</div>';
            }
          } catch (err) {
            if (reqSeq !== quickSearchSeq) return;
            resultsBox.innerHTML = `<div class="quick-search-hint" style="color:var(--bear);">Error: ${escapeHtml(err.message)}</div>`;
          }
        }, 120);
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
        if (!isAdminUser) {
          toast('API token configuration is restricted to Admin only.');
          return;
        }
        if (typeof openKeysModalFn === 'function') {
          openKeysModalFn();
        } else {
          const km = $('modal-api-keys');
          if (km) km.classList.remove('hidden');
        }
      });
    }

    const catSelect = $('ex-inst-category');
    if (catSelect) {
      catSelect.addEventListener('change', () => {
        renderInstrumentsList(catSelect.value);
      });
    }

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
        const minLen = currentMarketMode === 'forex' ? 1 : 3;
        if (q.length < minLen) {
          const need = minLen - q.length;
          searchDropdown.innerHTML = `<div class="quick-search-hint">Type ${need} more character${need > 1 ? 's' : ''} to search…</div>`;
          searchDropdown.classList.remove('hidden');
          return;
        }

        const reqSeq = ++drawerSearchSeq;
        searchDropdown.innerHTML = '<div class="quick-search-hint">Searching…</div>';
        searchDropdown.classList.remove('hidden');

        searchDebounce = setTimeout(async () => {
          try {
            const data = await api(`/api/chart/search?q=${encodeURIComponent(q)}&market=${encodeURIComponent(currentMarketMode)}`);
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
              searchDropdown.innerHTML = '<div class="quick-search-hint">No matching instruments</div>';
              searchDropdown.classList.remove('hidden');
            }
          } catch (e) {
            if (reqSeq !== drawerSearchSeq) return;
            searchDropdown.innerHTML = `<div class="quick-search-hint" style="color:var(--bear);">Search failed: ${escapeHtml(e.message)}</div>`;
            searchDropdown.classList.remove('hidden');
          }
        }, 120);
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

    renderInstrumentsList(currentMarketMode === 'forex' ? 'forex_all' : 'favorites');
  }

  function renderInstrumentsList(category = null) {
    const tbody = $('ex-instruments-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    const effCat = category || (currentMarketMode === 'forex' ? 'forex_all' : 'favorites');
    const list = WATCHLIST_PRESETS[effCat] || (currentMarketMode === 'forex' ? WATCHLIST_PRESETS.forex_all : WATCHLIST_PRESETS.favorites);
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
        addSymbolTab(inst.symbol, inst.token, 0, inst.segment || '');
      });

      const bidBtn = tr.querySelector('.btn-price-bid');
      const askBtn = tr.querySelector('.btn-price-ask');
      bidBtn.addEventListener('click', e => {
        e.stopPropagation();
        addSymbolTab(inst.symbol, inst.token, 0, inst.segment || '');
        const op = $('ex-order-panel');
        if (op) op.classList.remove('collapsed');
      });
      askBtn.addEventListener('click', e => {
        e.stopPropagation();
        addSymbolTab(inst.symbol, inst.token, 0, inst.segment || '');
        const op = $('ex-order-panel');
        if (op) op.classList.remove('collapsed');
      });

      tbody.appendChild(tr);
    });

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
            const fx = getForexSpec(sym);
            const decs = fx ? fx.decimals : 2;
            const spread = fx ? fx.spread : ((q.ltp * 0.0005) + 0.05);
            const bidVal = q.bid ? Number(q.bid) : Math.max(0.0001, q.ltp - spread / 2);
            const askVal = q.ask ? Number(q.ask) : (q.ltp + spread / 2);
            if (bidBtn) bidBtn.textContent = bidVal.toFixed(decs);
            if (askBtn) askBtn.textContent = askVal.toFixed(decs);
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

    // Toggle minimize (Fix #7: '+' to expand, '−' to collapse + refit chart panes)
    const toggleDockBtn = $('btn-toggle-dock');
    const bottomPanel = $('ex-bottom-panel');
    if (toggleDockBtn && bottomPanel) {
      toggleDockBtn.textContent = bottomPanel.classList.contains('minimized') ? '+' : '−';
      toggleDockBtn.addEventListener('click', () => {
        bottomPanel.classList.toggle('minimized');
        toggleDockBtn.textContent = bottomPanel.classList.contains('minimized') ? '+' : '−';
        setTimeout(() => {
          panes.forEach(p => { if (p.chart) { resizePaneChart(p); renderPaneTradeLines(p); } });
        }, 50);
      });
    }

    // Exit All Button
    const btnExitAll = $('btn-dock-exit-all');
    if (btnExitAll) {
      btnExitAll.addEventListener('click', async () => {
        if (!confirm('Are you sure you want to SQUARE OFF ALL open positions immediately?')) return;
        try {
          toast('Squaring off all positions...');
          const res = await api(`/api/positions/exit-all?market=${encodeURIComponent(currentMarketMode)}`, { method: 'POST' });
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
    if (!isAuthenticated) return;
    try {
      const mQ = `market=${encodeURIComponent(currentMarketMode)}`;
      const c = curSym();

      // 1. Open Positions & SL/TP Rules
      const [posData, sltpData] = await Promise.all([
        api(`/api/positions?tab=open&${mQ}`).catch(() => ({ positions: [] })),
        api(`/api/sltp?${mQ}`).catch(() => ({ rules: [] })),
      ]);

      activeSltpRules = Array.isArray(sltpData) ? sltpData : (sltpData && Array.isArray(sltpData.rules) ? sltpData.rules : []);

      const openTbody = $('open-positions-tbody');
      const openCountBadge = $('open-pos-count');
      const openCurLbl = $('th-open-cur');
      if (openCurLbl) openCurLbl.textContent = c;

      const positions = Array.isArray(posData) ? posData : (posData.positions || []);
      if (openCountBadge) openCountBadge.textContent = positions.length;

      if (openTbody) {
        if (!positions.length) {
          openTbody.innerHTML = '<tr><td colspan="8" class="empty-row">No open positions. Select an instrument to trade.</td></tr>';
        } else {
          openTbody.innerHTML = '';
          positions.forEach(p => {
            const sym = p.symbol || p.trading_symbol || p.trdSym || '—';
            const side = (p.side || (p.direction === 'SHORT' ? 'SELL' : 'BUY') || (Number(p.quantity) > 0 ? 'BUY' : 'SELL')).toUpperCase();
            const qty = Math.abs(Number(p.quantity || p.qty || 0));
            const lotsDisp = (p.lots && isForexSym(sym)) ? `${p.lots} lot` : `${qty}`;
            const decs = getSymbolDecimals(sym);
            const pc = curSym(sym);
            const avg = Number(p.average_price || p.avg_price || p.avgPrc || 0);
            const ltp = Number(p.ltp || avg);
            const mult = Number(p.multiplier || 1.0);
            const m2m = Number(p.m2m !== undefined ? p.m2m : ((side === 'BUY' ? (ltp - avg) : (avg - ltp)) * qty * mult));
            const isPos = m2m >= 0;

            const tr = document.createElement('tr');
            tr.innerHTML = `
              <td><b>${escapeHtml(sym)}</b></td>
              <td><span class="side-badge ${side.toLowerCase()}">${side}</span></td>
              <td>${escapeHtml(p.product || 'NRML')}</td>
              <td>${escapeHtml(lotsDisp)}</td>
              <td>${pc}${avg.toFixed(decs)}</td>
              <td>${pc}${ltp.toFixed(decs)}</td>
              <td style="color: ${isPos ? 'var(--bull)' : 'var(--bear)'}; font-weight:700;">
                ${isPos ? '+' : ''}${pc}${m2m.toFixed(2)}
              </td>
              <td>
                <button type="button" class="pos-action-btn danger btn-pos-exit" data-sym="${escapeHtml(sym)}">Exit</button>
              </td>
            `;

            tr.querySelector('.btn-pos-exit').addEventListener('click', async () => {
              try {
                toast(`Exiting position ${sym}...`);
                const res = await api(`/api/positions/${encodeURIComponent(sym)}/exit?${mQ}`, {
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
      const fundsData = await api(`/api/funds?${mQ}`).catch(() => ({}));
      const eqEl = $('f-equity');
      const fmEl = $('f-free-margin');
      const muEl = $('f-margin-used');
      const accBal = $('ex-acc-balance');

      if (fundsData && fundsData.funds_error) {
        const errText = fundsData.error || 'Connect Kotak Neo';
        const errStyle = 'color: #ff4757 !important; font-weight: 700;';
        if (accBal) { accBal.textContent = errText; accBal.setAttribute('style', errStyle); }
        if (eqEl) { eqEl.textContent = errText; eqEl.setAttribute('style', errStyle); }
        if (fmEl) { fmEl.textContent = errText; fmEl.setAttribute('style', errStyle); }
        if (muEl) { muEl.textContent = fmtMoney(0); }
      } else if (fundsData && fundsData.available_margin !== undefined) {
        const avail = Number(fundsData.available_margin);
        const used = Number(fundsData.used_margin || 0);
        const equity = Number(fundsData.total_equity !== undefined ? fundsData.total_equity : avail);
        if (accBal) { accBal.textContent = fmtMoney(avail); accBal.removeAttribute('style'); }
        if (eqEl) { eqEl.textContent = fmtMoney(equity); eqEl.removeAttribute('style'); }
        if (fmEl) { fmEl.textContent = fmtMoney(avail); fmEl.removeAttribute('style'); }
        if (muEl) { muEl.textContent = fmtMoney(used); }
      }

      // 3. Orders report (Pending)
      const ordersData = await api(`/api/orders?${mQ}`).catch(() => []);
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
            const pc = curSym(o.symbol);
            const decs = getSymbolDecimals(o.symbol);
            const tr = document.createElement('tr');
            tr.innerHTML = `
              <td>${escapeHtml(o.symbol)}</td>
              <td>${escapeHtml(o.id)}</td>
              <td>${escapeHtml(o.order_type)}</td>
              <td><span class="side-badge ${(o.side || 'BUY').toLowerCase()}">${escapeHtml(o.side)}</span></td>
              <td>${o.lots && isForexSym(o.symbol) ? `${o.lots} lot` : o.quantity}</td>
              <td>${pc}${Number(o.price || 0).toFixed(decs)}</td>
              <td><span class="tag-pending">Pending</span></td>
              <td><button type="button" class="pos-action-btn danger btn-cancel-order" data-id="${o.id}">Cancel</button></td>
            `;
            tr.querySelector('.btn-cancel-order').addEventListener('click', async () => {
              try {
                toast(`Cancelling order #${o.id}...`);
                await api(`/api/orders/${o.id}/cancel?${mQ}`, { method: 'POST' });
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

      // 4. Closed Positions (Accounting Lifecycles) & Performance Metrics (Win Rate / R-Mult / Sharpe)
      const closedData = await api(`/api/positions/closed?${mQ}`).catch(() => ({ positions: [], summary: {} }));
      const pnlSummaryData = await api(`/api/pnl/summary?${mQ}`).catch(() => ({}));
      const closedTbody = $('closed-trades-tbody');
      const closedCount = $('closed-trades-count');

      const closedPositions = Array.isArray(closedData) ? closedData : (closedData.positions || []);
      const closedSummary = (!Array.isArray(closedData) && closedData.summary) ? closedData.summary : {};
      const perfMetrics = (pnlSummaryData && pnlSummaryData.metrics) ? pnlSummaryData.metrics : { win_rate: 0, avg_r_multiple: 0, sharpe_ratio: 0 };
      if (closedCount) closedCount.textContent = closedPositions.length;

      const grossEl = $('cs-gross-pnl');
      const chargesEl = $('cs-charges');
      const netEl = $('cs-net-pnl');
      const winRatioEl = $('cs-win-ratio');
      const winRateEl = $('cs-win-rate');
      const rMultEl = $('cs-r-mult');
      const sharpeEl = $('cs-sharpe');

      const gross = Number(closedSummary.gross_realised_pnl !== undefined ? closedSummary.gross_realised_pnl : (pnlSummaryData.total_realised_gross_pnl || 0));
      const charges = Number(closedSummary.total_charges !== undefined ? closedSummary.total_charges : (pnlSummaryData.total_charges || 0));
      const net = Number(closedSummary.net_realised_pnl !== undefined ? closedSummary.net_realised_pnl : (pnlSummaryData.total_realised_net_pnl || 0));
      const wins = Number(closedSummary.winning_positions !== undefined ? closedSummary.winning_positions : (pnlSummaryData.winning_trades || 0));
      const losses = Number(closedSummary.losing_positions !== undefined ? closedSummary.losing_positions : (pnlSummaryData.losing_trades || 0));
      const winRateVal = Number(perfMetrics.win_rate || 0);
      const rMultVal = Number(perfMetrics.avg_r_multiple || 0);
      const sharpeVal = Number(perfMetrics.sharpe_ratio || 0);

      if (grossEl) {
        grossEl.textContent = fmtSigned(gross, c);
        grossEl.className = `cs-value ${gross >= 0 ? 'pos' : 'neg'}`;
      }
      if (chargesEl) chargesEl.textContent = `${c}${charges.toFixed(2)}`;
      if (netEl) {
        netEl.textContent = fmtSigned(net, c);
        netEl.className = `cs-value ${net >= 0 ? 'pos' : 'neg'}`;
      }
      if (winRatioEl) winRatioEl.textContent = `${wins}W / ${losses}L`;
      if (winRateEl) winRateEl.textContent = `${winRateVal.toFixed(1)}%`;
      if (rMultEl) {
        rMultEl.textContent = `${rMultVal >= 0 ? '+' : ''}${rMultVal.toFixed(2)}R`;
        rMultEl.className = `cs-value ${rMultVal >= 0 ? 'pos' : 'neg'}`;
      }
      if (sharpeEl) sharpeEl.textContent = sharpeVal.toFixed(2);

      // Mirror Performance Metrics on Mobile Performance Screen (Fix #8)
      const mWinRate = $('m-perf-winrate');
      const mRMult = $('m-perf-rmult');
      const mSharpe = $('m-perf-sharpe');
      if (mWinRate) mWinRate.textContent = `${winRateVal.toFixed(1)}% (${wins}W/${losses}L)`;
      if (mRMult) mRMult.textContent = `${rMultVal >= 0 ? '+' : ''}${rMultVal.toFixed(2)}R`;
      if (mSharpe) mSharpe.textContent = sharpeVal.toFixed(2);

      if (closedTbody) {
        const fRealized = $('f-realized-pnl');
        if (fRealized) {
          fRealized.textContent = `${net >= 0 ? '+' : ''}${c}${net.toFixed(2)}`;
          fRealized.style.color = net >= 0 ? 'var(--bull)' : 'var(--bear)';
        }
        if (!closedPositions.length) {
          closedTbody.innerHTML = '<tr><td colspan="11" class="empty-row">No closed positions recorded.</td></tr>';
        } else {
          closedTbody.innerHTML = '';
          closedPositions.forEach((cp, idx) => {
            const sym = cp.symbol || cp.trading_symbol || '—';
            const pc = curSym(sym);
            const decs = getSymbolDecimals(sym);
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
              <td><b>${escapeHtml(sym)}</b></td>
              <td>${escapeHtml(cp.product || 'NRML')}</td>
              <td><span class="side-badge ${side.toLowerCase()}">${side}</span></td>
              <td>${qty}</td>
              <td>${pc}${avgBuy.toFixed(decs)}</td>
              <td>${pc}${avgSell.toFixed(decs)}</td>
              <td style="color: ${grossPnl >= 0 ? 'var(--bull)' : 'var(--bear)'}; font-weight:700;">
                ${grossPnl >= 0 ? '+' : ''}${pc}${grossPnl.toFixed(2)}
              </td>
              <td class="text-dim">${pc}${cpCharges.toFixed(2)}</td>
              <td style="color: ${isPos ? 'var(--bull)' : 'var(--bear)'}; font-weight:800;">
                ${isPos ? '+' : ''}${pc}${netPnl.toFixed(2)}
              </td>
              <td>${escapeHtml(closedTime)}</td>
              <td>
                <button type="button" class="btn-toggle-matches" data-match-idx="${idx}">FIFO Fills ▾</button>
              </td>
            `;

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
                matchesHtml += `<tr><td>${m.quantity}</td><td>${pc}${Number(m.buy_price).toFixed(decs)}</td><td>${pc}${Number(m.sell_price).toFixed(decs)}</td><td style="color:${mPnl >= 0 ? 'var(--bull)' : 'var(--bear)'};font-weight:700;">${mPnl >= 0 ? '+' : ''}${pc}${mPnl.toFixed(2)}</td><td>${m.matched_at ? m.matched_at.split('T')[1]?.slice(0, 8) || m.matched_at : 'Today'}</td></tr>`;
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
      const executionsData = await api(`/api/executions?${mQ}`).catch(() => []);
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
            const pc = curSym(sym);
            const decs = getSymbolDecimals(sym);
            const side = (e.side || 'BUY').toUpperCase();
            const qty = Number(e.quantity || 0);
            const price = Number(e.price || 0);
            const turnover = (qty * price);
            const totalChg = Number(e.charges?.total_charges || 0);
            const time = e.executed_at ? (e.executed_at.split('T')[1]?.slice(0, 8) || e.executed_at) : 'Today';

            const tr = document.createElement('tr');
            tr.innerHTML = `
              <td>${escapeHtml(time)}</td>
              <td style="font-family:var(--font-mono);font-size:11px;">#${escapeHtml(e.id || e.broker_execution_id)}</td>
              <td style="font-family:var(--font-mono);font-size:11px;">${escapeHtml(e.order_id || '—')}</td>
              <td><b>${escapeHtml(sym)}</b></td>
              <td><span class="side-badge ${side.toLowerCase()}">${side}</span></td>
              <td>${qty}</td>
              <td>${pc}${price.toFixed(decs)}</td>
              <td>${pc}${turnover.toFixed(2)}</td>
              <td class="text-dim">${pc}${totalChg.toFixed(2)}</td>
              <td>${escapeHtml(e.product || 'NRML')}</td>
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

      renderAllPaneTradeLines();

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

  // --- Market Mode UI Synchronizer (Forex USD 24/7 vs Indian INR NSE/BSE) ---
  function applyMarketModeUI(mode, reloadTab = true) {
    const clean = mode === 'forex' ? 'forex' : 'indian';
    currentMarketMode = clean;
    localStorage.setItem('neo_market_mode', clean);

    const pill = $('btn-market-switcher');
    const flag = $('mkt-pill-flag');
    const lbl = $('mkt-pill-label');
    if (pill) pill.classList.remove('hidden');
    if (flag) flag.textContent = clean === 'forex' ? '🌍' : '🇮🇳';
    if (lbl) lbl.textContent = clean === 'forex' ? 'FOREX' : 'INDIAN';

    const ocHeaderBtn = $('btn-header-opt-chain');
    if (ocHeaderBtn) ocHeaderBtn.classList.toggle('hidden', clean === 'forex');

    const catSelect = $('ex-inst-category');
    const searchIn = $('ex-inst-search');
    if (catSelect) {
      if (clean === 'forex') {
        catSelect.innerHTML = `
          <option value="forex_all">🌍 All Forex, Gold &amp; Crypto</option>
          <option value="forex_crypto">🪙 Gold, Silver &amp; Crypto</option>
          <option value="forex_pairs">💱 Major FX Pairs</option>
          <option value="forex_indices">🛢 Oil &amp; US Tech 100</option>
        `;
      } else {
        catSelect.innerHTML = `
          <option value="favorites">⭐ Favorites</option>
          <option value="indices">📈 Indices (NIFTY / BANK / SENSEX)</option>
          <option value="nifty_options">⚡ NIFTY Options (ATM Strikes)</option>
          <option value="bank_options">⚡ BANKNIFTY Options</option>
          <option value="stocks">🏢 Top F&amp;O Stocks</option>
        `;
      }
      renderInstrumentsList(catSelect.value);
    }
    if (searchIn) {
      searchIn.placeholder = clean === 'forex'
        ? 'Search XAUUSD, BTCUSD, EURUSD, USOIL...'
        : 'Search NSE stock or strike (3+ chars, e.g. REL, MAR)';
    }

    const mSearchIn = $('m-trade-search-input');
    if (mSearchIn) {
      mSearchIn.placeholder = clean === 'forex'
        ? 'Search XAUUSD, BTCUSD, EURUSD, GBPUSD...'
        : 'Search NSE stock or strike (3+ chars, e.g. REL, 25000 CE)';
    }
    const mAccCur = document.querySelector('.m-acc-balance-cur');
    if (mAccCur) mAccCur.textContent = clean === 'forex' ? 'USD' : 'INR';
    const opBrk = $('op-brokerage-val');
    if (opBrk) opBrk.textContent = clean === 'forex' ? '$0.00 (24/7 Zero Comm)' : '₹0.00 (Kotak Neo Free F&O)';

    if (reloadTab) {
      const targetTab = loadInitialSingleTab(clean);
      openTabs = targetTab;
      activeTabIndex = 0;
      renderSymbolTabs();
      switchTab(0);
    }

    if (typeof updateLotDisplayFn === 'function') updateLotDisplayFn();
    if (isAuthenticated) fetchPositionsAndOrders();
  }

  function updateAuthModeUI(adminActive, username = '', kotakConnected = false) {
    const pill = $('ex-acc-pill');
    const idEl = $('ex-acc-id');
    const modeBadge = $('op-mode-badge');
    const btnLogoutEl = $('btn-logout');
    const menuTitle = $('menu-mode-title');
    const menuSub = $('menu-mode-sub');
    const profileLogin = $('m-profile-login');
    const sessionBadge = $('session-timer-badge');

    // Strictly hide API token & Kotak Admin controls from non-admin users
    document.querySelectorAll('.admin-only-ctrl').forEach(el => {
      el.classList.toggle('hidden', !adminActive);
    });

    const uname = (username || (currentUser && currentUser.username) || 'Trader').trim();
    if (adminActive) {
      const liveMode = kotakConnected && currentMarketMode === 'indian';
      if (pill) {
        pill.className = `ex-acc-pill ${liveMode ? 'live' : 'demo'}`;
        pill.textContent = liveMode ? 'Live' : 'Admin';
      }
      if (idEl) idEl.textContent = liveMode ? '#KOTAK-LIVE' : `@${uname.toUpperCase()}`;
      if (modeBadge) {
        modeBadge.textContent = liveMode ? 'Kotak Live (0 Brokerage)' : (currentMarketMode === 'forex' ? 'Admin Forex Paper' : 'Admin (Connect Kotak)');
        modeBadge.className = liveMode ? 'text-green' : 'mode-badge-demo';
      }
      if (btnLogoutEl) btnLogoutEl.classList.remove('hidden');
      if (menuTitle) menuTitle.textContent = liveMode ? 'Kotak Live Account' : 'Admin Account';
      if (menuSub) menuSub.textContent = liveMode ? 'Connected to Kotak Neo' : 'Connect TOTP & MPIN for Live Trading';
      if (sessionBadge) sessionBadge.classList.remove('hidden');
      if (profileLogin) profileLogin.textContent = `${uname} (Admin)`;
    } else if (isAuthenticated) {
      if (pill) { pill.className = 'ex-acc-pill demo'; pill.textContent = 'Paper'; }
      if (idEl) idEl.textContent = `@${uname.toUpperCase().slice(0, 12)}`;
      if (modeBadge) {
        modeBadge.textContent = currentMarketMode === 'forex' ? 'Forex Paper ($10K USD)' : 'Indian Paper (₹10L INR)';
        modeBadge.className = 'mode-badge-demo';
      }
      if (btnLogoutEl) btnLogoutEl.classList.remove('hidden');
      if (menuTitle) menuTitle.textContent = 'Personal Paper Account';
      if (menuSub) menuSub.textContent = `${uname} • Isolated Portfolio`;
      if (sessionBadge) sessionBadge.classList.add('hidden');
      if (profileLogin) profileLogin.textContent = `@${uname}`;
    } else {
      if (pill) { pill.className = 'ex-acc-pill demo'; pill.textContent = 'Sign In'; }
      if (idEl) idEl.textContent = '#LOCKED';
      if (modeBadge) { modeBadge.textContent = 'Sign in required'; modeBadge.className = 'mode-badge-demo'; }
      if (btnLogoutEl) btnLogoutEl.classList.add('hidden');
      if (sessionBadge) sessionBadge.classList.add('hidden');
    }
  }

  function setupMarketChoiceModal() {
    const mktModal = $('modal-market-choice');
    const btnForex = $('btn-choose-forex');
    const btnIndian = $('btn-choose-indian');
    const switcherPill = $('btn-market-switcher');
    const switchMenuBtn = $('btn-switch-market-menu');

    async function chooseMarket(mkt) {
      try {
        await api('/api/user/select-market', {
          method: 'POST',
          body: JSON.stringify({ market: mkt }),
        });
      } catch (_) {}
      if (mktModal) mktModal.classList.add('hidden');
      applyMarketModeUI(mkt, true);
      updateAuthModeUI(isAdminUser, (currentUser && currentUser.username) || '', Boolean(currentUser && currentUser.kotak_connected));
      toast(mkt === 'forex'
        ? '🌍 Switched to Forex & Crypto ($10,000.00 Virtual Capital, 24/7 Live)'
        : '🇮🇳 Switched to Indian Markets (₹10,00,000.00 Paper Balance)');
    }

    window._chooseMarketFn = chooseMarket;
    if (btnForex) btnForex.addEventListener('click', () => chooseMarket('forex'));
    if (btnIndian) btnIndian.addEventListener('click', () => chooseMarket('indian'));
    if (switcherPill) {
      switcherPill.addEventListener('click', () => {
        if (!isAuthenticated) {
          const gm = $('modal-gatekeeper');
          if (gm) gm.classList.remove('hidden');
          return;
        }
        chooseMarket(currentMarketMode === 'forex' ? 'indian' : 'forex');
      });
    }
    if (switchMenuBtn) {
      switchMenuBtn.addEventListener('click', () => {
        const am = $('ex-account-menu');
        if (am) am.classList.add('hidden');
        if (mktModal) mktModal.classList.remove('hidden');
      });
    }
  }

  function setupAdminModals() {
    const kotakModal = $('modal-kotak-connect');
    const btnOpenKotak = $('btn-open-owner-login');
    const btnCloseKotak = $('btn-close-kotak-modal');
    const btnCancelKotak = $('btn-cancel-kotak');
    const kotakForm = $('kotak-connect-form');
    const kotakErr = $('kotak-connect-error');

    function openKotakModal() {
      if (!isAdminUser) return;
      if (kotakErr) kotakErr.classList.add('hidden');
      if (kotakModal) kotakModal.classList.remove('hidden');
      const totpIn = $('input-kotak-totp');
      if (totpIn) setTimeout(() => totpIn.focus(), 80);
    }

    if (btnOpenKotak) btnOpenKotak.addEventListener('click', openKotakModal);
    if (btnCloseKotak) btnCloseKotak.addEventListener('click', () => kotakModal && kotakModal.classList.add('hidden'));
    if (btnCancelKotak) btnCancelKotak.addEventListener('click', () => kotakModal && kotakModal.classList.add('hidden'));

    if (kotakForm) {
      kotakForm.addEventListener('submit', async e => {
        e.preventDefault();
        if (kotakErr) kotakErr.classList.add('hidden');
        const totp = ($('input-kotak-totp')?.value || '').trim();
        const mpin = ($('input-kotak-mpin-login')?.value || '').trim();
        try {
          const res = await api('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ totp, mpin }),
          });
          if (res && res.ok) {
            if (currentUser) currentUser.kotak_connected = true;
            if (kotakModal) kotakModal.classList.add('hidden');
            updateAuthModeUI(true, (currentUser && currentUser.username) || '', true);
            toast('✅ Kotak Neo Live Session Connected!');
            fetchPositionsAndOrders();
          }
        } catch (err) {
          if (kotakErr) {
            kotakErr.textContent = err.message;
            kotakErr.classList.remove('hidden');
          }
        }
      });
    }

    const admModal = $('modal-admin-analytics');
    const btnAdmHeader = $('btn-admin-users');
    const btnAdmMenu = $('btn-open-admin-analytics-menu');
    const btnAdmClose = $('btn-close-admin-analytics');

    async function openAdminAnalytics() {
      if (!isAdminUser || !admModal) return;
      admModal.classList.remove('hidden');
      const tbody = $('admin-users-tbody');
      if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="empty-row">Loading user analytics…</td></tr>';
      try {
        const res = await api('/api/admin/users-analytics');
        if (res && res.ok) {
          const ov = res.overall_metrics || {};
          if ($('adm-total-users')) $('adm-total-users').textContent = res.total_users || 0;
          if ($('adm-total-trades')) $('adm-total-trades').textContent = ov.total_trades || 0;
          if ($('adm-win-rate')) $('adm-win-rate').textContent = `${Number(ov.win_rate || 0).toFixed(1)}%`;
          if ($('adm-r-mult')) $('adm-r-mult').textContent = `${Number(ov.avg_r_multiple || 0).toFixed(2)}R`;
          if ($('adm-sharpe')) $('adm-sharpe').textContent = Number(ov.sharpe_ratio || 0).toFixed(2);

          if (tbody) {
            const users = res.users || [];
            if (!users.length) {
              tbody.innerHTML = '<tr><td colspan="8" class="empty-row">No registered users yet.</td></tr>';
            } else {
              tbody.innerHTML = '';
              users.forEach(u => {
                const pnlFx = Number(u.forex_net_pnl || 0);
                const pnlInd = Number(u.indian_net_pnl || 0);
                const netDisp = u.market_mode === 'forex'
                  ? fmtSigned(pnlFx, '$').replace(/^\+/, '')
                  : `₹${pnlInd.toFixed(2)} (FX ${fmtSigned(pnlFx, '$').replace(/^\+/, '')})`;
                const tr = document.createElement('tr');
                tr.innerHTML = `
                  <td><b>${escapeHtml(u.username)}</b></td>
                  <td>${u.is_admin ? '<span style="color:#f3c623;font-weight:700;">ADMIN</span>' : 'User'}</td>
                  <td>${escapeHtml((u.market_mode || 'unset').toUpperCase())}</td>
                  <td>${u.closed_trades_count || 0}</td>
                  <td>${u.executions_count || 0}</td>
                  <td>${Number(u.win_rate || 0).toFixed(1)}%</td>
                  <td style="font-weight:700;color:${(pnlFx + pnlInd) >= 0 ? 'var(--bull)' : 'var(--bear)'};">${netDisp}</td>
                  <td style="font-size:11px;color:var(--text-dim);">${escapeHtml((u.last_login || '—').slice(0, 16).replace('T', ' '))}</td>
                `;
                tbody.appendChild(tr);
              });
            }
          }
        }
      } catch (err) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="empty-row" style="color:var(--bear);">${escapeHtml(err.message)}</td></tr>`;
      }
    }

    window._openAdminAnalyticsFn = openAdminAnalytics;
    window._openKotakConnectFn = openKotakModal;
    if (btnAdmHeader) btnAdmHeader.addEventListener('click', openAdminAnalytics);
    if (btnAdmMenu) btnAdmMenu.addEventListener('click', openAdminAnalytics);
    if (btnAdmClose) btnAdmClose.addEventListener('click', () => admModal && admModal.classList.add('hidden'));
  }

  // --- Gatekeeper Auth Flow (Strict User ID + Password, Isolated Multi-User) ---
  function setupGatekeeper() {
    const gateModal = $('modal-gatekeeper');
    const tabSignin = $('tab-auth-signin');
    const tabSignup = $('tab-auth-signup');
    const formSignin = $('auth-signin-form');
    const formSignup = $('auth-signup-form');
    const signinErr = $('signin-error-msg');
    const signupErr = $('signup-error-msg');

    const accBtn = $('ex-account-btn');
    const accMenu = $('ex-account-menu');
    const btnLogout = $('btn-logout');
    const sessionTimerText = $('session-timer-text');

    function switchAuthTab(mode) {
      if (signinErr) signinErr.classList.add('hidden');
      if (signupErr) signupErr.classList.add('hidden');
      if (tabSignin) tabSignin.classList.toggle('active', mode === 'signin');
      if (tabSignup) tabSignup.classList.toggle('active', mode === 'signup');
      if (formSignin) formSignin.classList.toggle('hidden', mode !== 'signin');
      if (formSignup) formSignup.classList.toggle('hidden', mode !== 'signup');
    }

    if (tabSignin) tabSignin.addEventListener('click', () => switchAuthTab('signin'));
    if (tabSignup) tabSignup.addEventListener('click', () => switchAuthTab('signup'));

    if (accBtn && accMenu) {
      accBtn.addEventListener('click', e => {
        e.stopPropagation();
        accMenu.classList.toggle('hidden');
      });
      document.addEventListener('click', () => {
        accMenu.classList.add('hidden');
      });
    }

    async function handleLogout(msg = 'Signed out. Please sign in to continue.') {
      await api('/api/auth/owner-logout', { method: 'POST' }).catch(() => ({}));
      localStorage.removeItem('neo_owner_token');
      ownerToken = '';
      isAuthenticated = false;
      isOwner = false;
      isAdminUser = false;
      currentUser = null;
      cachedPositions = [];
      cachedOrders = [];
      cachedClosedPositions = [];
      cachedExecutions = [];
      activeSltpRules = [];
      updateAuthModeUI(false, '');
      renderAllPaneTradeLines();
      if (gateModal) {
        switchAuthTab('signin');
        gateModal.classList.remove('hidden');
      }
      toast(msg);
    }
    window._handleLogoutFn = handleLogout;

    if (btnLogout) {
      btnLogout.addEventListener('click', () => handleLogout());
    }

    function onAuthenticatedSuccess(res) {
      ownerToken = res.token || '';
      if (ownerToken) localStorage.setItem('neo_owner_token', ownerToken);
      isAuthenticated = true;
      isAdminUser = Boolean(res.is_admin);
      isOwner = isAdminUser;
      currentUser = {
        username: res.username,
        is_admin: isAdminUser,
        market_mode: res.market_mode || '',
        kotak_connected: Boolean(res.kotak_connected),
      };
      recordUserActivity();
      if (gateModal) gateModal.classList.add('hidden');

      if (!isAdminUser && !res.market_mode) {
        updateAuthModeUI(false, res.username, false);
        const mktModal = $('modal-market-choice');
        if (mktModal) mktModal.classList.remove('hidden');
      } else {
        const effMode = res.market_mode || 'indian';
        applyMarketModeUI(effMode, true);
        updateAuthModeUI(isAdminUser, res.username, Boolean(res.kotak_connected));
        fetchPositionsAndOrders();
      }
    }

    if (formSignin) {
      formSignin.addEventListener('submit', async e => {
        e.preventDefault();
        if (signinErr) signinErr.classList.add('hidden');
        const uid = ($('signin-userid')?.value || '').trim();
        const pwd = $('signin-password')?.value || '';
        try {
          const res = await api('/api/auth/signin', {
            method: 'POST',
            body: JSON.stringify({ username: uid, password: pwd }),
          });
          if (res && res.ok) {
            onAuthenticatedSuccess(res);
            toast(`✅ Signed in as ${res.username}`);
          }
        } catch (err) {
          if (signinErr) {
            signinErr.textContent = err.message;
            signinErr.classList.remove('hidden');
          }
        }
      });
    }

    if (formSignup) {
      formSignup.addEventListener('submit', async e => {
        e.preventDefault();
        if (signupErr) signupErr.classList.add('hidden');
        const uid = ($('signup-userid')?.value || '').trim();
        const pwd = $('signup-password')?.value || '';
        const email = ($('signup-email')?.value || '').trim();
        try {
          const res = await api('/api/auth/signup', {
            method: 'POST',
            body: JSON.stringify({ username: uid, password: pwd, email }),
          });
          if (res && res.ok) {
            onAuthenticatedSuccess(res);
            toast('✅ Account created! Choose Forex or Indian markets to begin.');
          }
        } catch (err) {
          if (signupErr) {
            signupErr.textContent = err.message;
            signupErr.classList.remove('hidden');
          }
        }
      });
    }

    async function checkSession() {
      try {
        const st = await api('/api/auth/session-status');
        if (st && st.authenticated) {
          isAuthenticated = true;
          isAdminUser = Boolean(st.is_admin);
          isOwner = isAdminUser;
          currentUser = st;
          if (gateModal) gateModal.classList.add('hidden');

          if (!isAdminUser && !st.market_mode) {
            updateAuthModeUI(false, st.username, false);
            const mktModal = $('modal-market-choice');
            if (mktModal) mktModal.classList.remove('hidden');
          } else {
            const effMode = st.market_mode || 'indian';
            applyMarketModeUI(effMode, true);
            updateAuthModeUI(isAdminUser, st.username, Boolean(st.kotak_connected));
            fetchPositionsAndOrders();
          }
        } else {
          isAuthenticated = false;
          isAdminUser = false;
          isOwner = false;
          currentUser = null;
          updateAuthModeUI(false, '');
          if (gateModal) {
            switchAuthTab('signin');
            gateModal.classList.remove('hidden');
          }
        }
      } catch (e) {
        updateAuthModeUI(false, '');
        if (gateModal) gateModal.classList.remove('hidden');
      }
    }

    clearInterval(inactivityTimerInterval);
    inactivityTimerInterval = setInterval(() => {
      if (!isAdminUser || !isAuthenticated) return;
      const elapsed = Date.now() - lastUserActivity;
      const remainingMs = INACTIVITY_TIMEOUT_MS - elapsed;

      if (remainingMs <= 0) {
        handleLogout('Admin session expired after 5 minutes of inactivity.');
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
        if (!isAdminUser) { toast('Upstox token setup is Admin-only.'); return; }
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
        if (!isAdminUser) { toast('Restricted to Admin only.'); return; }
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

  // --- Change API Keys Modal (Kotak Consumer Key & Upstox Analytics Key - Admin Only) ---
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
      if (!isAdminUser) { toast('API key management is restricted to Admin only.'); return; }
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

    const mRowSwitchMkt = $('m-row-switch-market');
    if (mRowSwitchMkt) {
      mRowSwitchMkt.addEventListener('click', () => {
        const mktModal = $('modal-market-choice');
        if (mktModal) mktModal.classList.remove('hidden');
      });
    }

    const mRowKotakConnect = $('m-row-kotak-connect');
    if (mRowKotakConnect) {
      mRowKotakConnect.addEventListener('click', () => {
        if (typeof window._openKotakConnectFn === 'function') window._openKotakConnectFn();
      });
    }

    const mRowAdminUsers = $('m-row-admin-users');
    if (mRowAdminUsers) {
      mRowAdminUsers.addEventListener('click', () => {
        if (typeof window._openAdminAnalyticsFn === 'function') window._openAdminAnalyticsFn();
      });
    }

    const mRowLogout = $('m-row-logout');
    if (mRowLogout) {
      mRowLogout.addEventListener('click', () => {
        if (typeof window._handleLogoutFn === 'function') window._handleLogoutFn();
      });
    }

    const mBtnGuideKotak = $('m-btn-open-guide');
    if (mBtnGuideKotak) {
      mBtnGuideKotak.addEventListener('click', () => {
        if (isAdminUser && typeof window._openKotakConnectFn === 'function') window._openKotakConnectFn();
        else if (guideModal) guideModal.classList.remove('hidden');
      });
    }

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
      const mQ = `market=${encodeURIComponent(currentMarketMode)}`;

      if (tab === 'open') {
        if (!cachedPositions.length) {
          const cardsHtml = currentMarketMode === 'forex'
            ? `
              <div class="m-quick-card" data-sym="XAUUSD">
                <div class="m-qc-title">XAU / USD</div>
                <div class="m-qc-icon">🪙</div>
                <div class="m-qc-price" id="qc-xau-ltp">Live Gold</div>
                <div class="m-qc-chg pos">24/7 Spot</div>
              </div>
              <div class="m-quick-card" data-sym="BTCUSD">
                <div class="m-qc-title">BTC / USD</div>
                <div class="m-qc-icon">₿</div>
                <div class="m-qc-price" id="qc-btc-ltp">Live BTC</div>
                <div class="m-qc-chg pos">24/7 Crypto</div>
              </div>
              <div class="m-quick-card" data-sym="EURUSD">
                <div class="m-qc-title">EUR / USD</div>
                <div class="m-qc-icon">💶</div>
                <div class="m-qc-price" id="qc-eur-ltp">Major FX</div>
                <div class="m-qc-chg pos">1:200 Lev</div>
              </div>
              <div class="m-quick-card" data-sym="USTEC">
                <div class="m-qc-title">USTEC 100</div>
                <div class="m-qc-icon">🇺🇸</div>
                <div class="m-qc-price" id="qc-ndx-ltp">Nasdaq CFD</div>
                <div class="m-qc-chg pos">Index</div>
              </div>
            `
            : `
              <div class="m-quick-card" data-sym="NIFTY">
                <div class="m-qc-title">NIFTY 50</div>
                <div class="m-qc-icon">🇮🇳</div>
                <div class="m-qc-price" id="qc-nifty-ltp">NIFTY</div>
                <div class="m-qc-chg pos">Index</div>
              </div>
              <div class="m-quick-card" data-sym="BANKNIFTY">
                <div class="m-qc-title">BANK NIFTY</div>
                <div class="m-qc-icon">🏦</div>
                <div class="m-qc-price" id="qc-bank-ltp">BANK</div>
                <div class="m-qc-chg pos">Index</div>
              </div>
              <div class="m-quick-card" data-sym="SENSEX">
                <div class="m-qc-title">SENSEX</div>
                <div class="m-qc-icon">📈</div>
                <div class="m-qc-price" id="qc-sensex-ltp">BSE</div>
                <div class="m-qc-chg pos">Index</div>
              </div>
              <div class="m-quick-card" data-sym="RELIANCE">
                <div class="m-qc-title">RELIANCE</div>
                <div class="m-qc-icon">⚡</div>
                <div class="m-qc-price" id="qc-rel-ltp">NSE EQ</div>
                <div class="m-qc-chg pos">Equity</div>
              </div>
            `;
          container.innerHTML = `
            <div class="m-orders-empty-msg">No open positions. Find your next trade:</div>
            <div class="m-quick-carousel" id="m-quick-carousel">${cardsHtml}</div>
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
            const pc = curSym(sym);
            const decs = getSymbolDecimals(sym);
            const side = (p.side || (p.direction === 'SHORT' ? 'SELL' : 'BUY') || (Number(p.quantity) > 0 ? 'BUY' : 'SELL')).toUpperCase();
            const qty = Math.abs(Number(p.quantity || p.qty || 0));
            const lotsDisp = (p.lots && isForexSym(sym)) ? `${p.lots} lot` : `${qty} qty`;
            const avg = Number(p.average_price || p.avg_price || p.avgPrc || 0);
            const ltp = Number(p.ltp || avg);
            const mult = Number(p.multiplier || 1.0);
            const m2m = Number(p.m2m !== undefined ? p.m2m : ((side === 'BUY' ? (ltp - avg) : (avg - ltp)) * qty * mult));
            const isPos = m2m >= 0;

            const card = document.createElement('div');
            card.className = 'm-order-card';
            card.innerHTML = `
              <div class="m-card-top">
                <div class="m-card-sym-wrap">
                  <span class="m-card-icon">${isForexSym(sym) ? '🌍' : (sym.includes('BANK') ? '🏦' : (sym.includes('SENSEX') ? '📈' : '🪙'))}</span>
                  <span class="m-card-sym">${escapeHtml(sym)}</span>
                  <span class="m-tag-pill tp">TP</span>
                  <span class="m-tag-pill sl">SL</span>
                </div>
                <div class="m-card-pnl ${isPos ? 'pos' : 'neg'}">
                  ${isPos ? '+' : ''}${pc}${m2m.toFixed(2)}
                </div>
              </div>
              <div class="m-card-bot">
                <div class="m-card-sub ${side.toLowerCase()}">${side} ${lotsDisp} @ ${pc}${avg.toFixed(decs)}</div>
                <div class="m-card-ltp">${pc}${ltp.toFixed(decs)}</div>
              </div>
              <div class="m-card-actions">
                <button type="button" class="m-card-btn-close" data-sym="${escapeHtml(sym)}">Close Position</button>
              </div>
            `;

            const closeBtn = card.querySelector('.m-card-btn-close');
            if (closeBtn) {
              closeBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                try {
                  toast(`Closing position ${sym}...`);
                  const res = await api(`/api/positions/${encodeURIComponent(sym)}/exit?${mQ}`, {
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
            const pc = curSym(o.symbol);
            const decs = getSymbolDecimals(o.symbol);
            const side = (o.side || 'BUY').toUpperCase();
            const card = document.createElement('div');
            card.className = 'm-order-card';
            card.innerHTML = `
              <div class="m-card-top">
                <div class="m-card-sym-wrap">
                  <span class="m-card-icon">⚡</span>
                  <span class="m-card-sym">${escapeHtml(o.symbol)}</span>
                </div>
                <div class="m-card-dash">
                  <button type="button" class="m-card-btn-cancel" data-id="${o.id}">✕ Cancel</button>
                </div>
              </div>
              <div class="m-card-bot">
                <div class="m-card-sub ${side.toLowerCase()}">${side} ${o.order_type || 'Limit'} ${o.lots && isForexSym(o.symbol) ? `${o.lots} lot` : o.quantity} @ ${pc}${Number(o.price || 0).toFixed(decs)}</div>
                <div class="m-card-ltp">${o.ltp ? pc + Number(o.ltp).toFixed(decs) : 'Pending'}</div>
              </div>
            `;
            const cancelBtn = card.querySelector('.m-card-btn-cancel');
            if (cancelBtn) {
              cancelBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                try {
                  toast(`Cancelling order #${o.id}...`);
                  await api(`/api/orders/${o.id}/cancel?${mQ}`, { method: 'POST' });
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

          const cSymAll = curSym();
          const dateHdr = document.createElement('div');
          dateHdr.className = 'm-closed-date-header';
          dateHdr.innerHTML = `
            <span class="m-cd-title">Realised P&amp;L</span>
            <span class="m-cd-pnl ${totalDayPnl >= 0 ? 'pos' : 'neg'}">
              ${totalDayPnl >= 0 ? '+' : ''}${cSymAll}${totalDayPnl.toFixed(2)}
            </span>
          `;
          container.appendChild(dateHdr);

          cachedClosedPositions.forEach((c, idx) => {
            const sym = c.symbol || c.trading_symbol || '—';
            const pc = curSym(sym);
            const decs = getSymbolDecimals(sym);
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
                  <span class="m-card-sym">${escapeHtml(sym)}</span>
                </div>
                <div class="m-card-pnl ${isPos ? 'pos' : 'neg'}">
                  ${isPos ? '+' : ''}${pc}${netPnl.toFixed(2)}
                </div>
              </div>
              <div class="m-card-bot">
                <div class="m-card-sub ${side.toLowerCase()}">Entry ${qty} @ ${pc}${openPrc.toFixed(decs)}</div>
                <div class="m-card-ltp">Exit @ ${pc}${closePrc.toFixed(decs)}</div>
              </div>
              <div class="m-card-meta-row">
                <span>Gross: ${grossPnl >= 0 ? '+' : ''}${pc}${grossPnl.toFixed(2)} | Chg: ${pc}${cpCharges.toFixed(2)}</span>
                <span class="m-card-expand-toggle" data-idx="${idx}">FIFO Fills ▾</span>
              </div>
              <div class="m-card-fifo-drawer hidden" id="m-fifo-drawer-${idx}">
                ${matches.length ? matches.map(m => `
                  <div class="m-fifo-item">
                    <span>${m.quantity} qty @ ${pc}${Number(m.buy_price).toFixed(decs)} ➔ ${pc}${Number(m.sell_price).toFixed(decs)}</span>
                    <span style="color:${Number(m.gross_pnl||0)>=0?'var(--bull)':'var(--bear)'};font-weight:700;">
                      ${Number(m.gross_pnl||0)>=0?'+':''}${pc}${Number(m.gross_pnl||0).toFixed(2)}
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
            const pc = curSym(sym);
            const decs = getSymbolDecimals(sym);
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
                  <span class="m-card-sym">${escapeHtml(sym)}</span>
                  <span class="m-exec-badge ${side.toLowerCase()}">${side}</span>
                </div>
                <div class="m-card-pnl" style="color:var(--text-main);font-size:13px;">
                  ${pc}${turnover.toFixed(2)}
                </div>
              </div>
              <div class="m-card-bot">
                <div class="m-card-sub">${qty} qty at ${pc}${price.toFixed(decs)}</div>
                <div class="m-card-ltp" style="font-size:11px;color:var(--text-dim);">${escapeHtml(time)}</div>
              </div>
              <div class="m-card-meta-row">
                <span>Charges: ${pc}${totalChg.toFixed(2)}</span>
                <span style="font-family:var(--font-mono);font-size:10.5px;">#${escapeHtml(e.id || e.broker_execution_id)}</span>
              </div>
            `;
            container.appendChild(card);
          });
        }
      }
    }

    updateMobileOrdersFn = () => {
      updateMobileAccountsView();
      updateMobilePerformanceView();
      renderMobileOrdersList(activeOrdersTab);
    };

    document.querySelectorAll('.m-quick-card').forEach(card => {
      card.addEventListener('click', () => {
        const sym = card.dataset.sym;
        if (sym) {
          addSymbolTab(sym, '');
          switchMobileTab('chart');
        }
      });
    });

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

    const mSearchInput = $('m-trade-search-input');
    if (mSearchInput) {
      let mDebounce = null;
      mSearchInput.addEventListener('input', () => {
        clearTimeout(mDebounce);
        mDebounce = setTimeout(() => {
          renderMobileTradeList(currentCat, mSearchInput.value.trim());
        }, 120);
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
          const pc = curSym(symbol);
          const decs = getSymbolDecimals(symbol);
          const ltp = Number(q.ltp);
          const pct = Number(q.change_percent || 0);
          const isPos = pct >= 0;
          if (priceEl) priceEl.textContent = `${pc}${ltp.toLocaleString(pc === '$' ? 'en-US' : 'en-IN', { minimumFractionDigits: decs, maximumFractionDigits: decs })}`;
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
      const minLen = currentMarketMode === 'forex' ? 1 : 3;

      if (query && query.length >= minLen) {
        container.innerHTML = '<div class="m-orders-empty-msg" style="padding:16px;">Searching instruments…</div>';
        try {
          const res = await api(`/api/chart/search?q=${encodeURIComponent(query)}&market=${encodeURIComponent(currentMarketMode)}`);
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
      } else if (currentMarketMode === 'forex') {
        items = WATCHLIST_PRESETS.forex_all;
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

      if (query && query.length > 0 && query.length < minLen) {
        const need = minLen - query.length;
        const hint = document.createElement('div');
        hint.className = 'm-orders-empty-msg';
        hint.style.padding = '10px 16px 4px';
        hint.textContent = `Type ${need} more char${need > 1 ? 's' : ''} to search instruments…`;
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
        const icon = isForexSym(it.symbol) ? '🌍' : (it.symbol.includes('BANK') ? '🏦' : (it.symbol.includes('NIFTY') ? '🇮🇳' : (it.symbol.includes('SENSEX') ? '📈' : '⚡')));
        row.innerHTML = `
          <div class="m-ti-left">
            <div class="m-ti-icon">${icon}</div>
            <div class="m-ti-names">
              <span class="m-ti-sym">${escapeHtml(it.symbol)}</span>
              <span class="m-ti-sub">${escapeHtml(it.name || (currentMarketMode === 'forex' ? 'FOREX' : 'NSE'))}</span>
            </div>
          </div>
          <div class="m-ti-right">
            <span class="m-ti-price">—</span>
            <span class="m-ti-chg ${isPos ? 'pos' : 'neg'}">—</span>
          </div>
        `;
        row.addEventListener('click', () => {
          switchMobileTab('chart');
          addSymbolTab(it.symbol, it.token || '', it.lotSize || 0, it.segment || '');
        });
        container.appendChild(row);
        renderedRows.push({ symbol: it.symbol, token: it.token || '', row });
      });

      hydrateMobileTradeQuotes(renderedRows);
    }

    function updateMobileAccountsView() {
      const uname = (currentUser && currentUser.username) || 'TRADER';
      const accIdEl = $('m-acc-id');
      const accBalEl = $('m-acc-balance');
      const pillBal = $('m-trade-pill-bal');
      const desktopBal = $('ex-acc-balance');
      const badgeEl = $('m-acc-badge-demo');

      if (accIdEl) accIdEl.textContent = `@${uname.toUpperCase()}`;
      if (badgeEl) badgeEl.textContent = currentMarketMode === 'forex' ? 'Forex Paper' : (isAdminUser && currentUser && currentUser.kotak_connected ? 'Kotak Live' : 'Indian Paper');
      if (desktopBal && accBalEl) accBalEl.textContent = desktopBal.textContent;
      if (desktopBal && pillBal) pillBal.textContent = desktopBal.textContent;
    }

    function updateMobilePerformanceView() {
      const grossPnl = $('cs-gross-pnl');
      const netPnl = $('cs-net-pnl');
      const csWr = $('cs-win-rate');
      const csR = $('cs-r-mult');
      const csSh = $('cs-sharpe');
      const mRealized = $('m-perf-realized');
      const mNet = $('m-perf-net');
      const mWr = $('m-perf-winrate');
      const mR = $('m-perf-rmult');
      const mSh = $('m-perf-sharpe');
      const mBrk = $('m-perf-brokerage');
      if (grossPnl && mRealized) {
        mRealized.textContent = grossPnl.textContent;
        mRealized.className = `m-metric-val ${grossPnl.textContent.includes('-') ? 'neg' : 'pos'}`;
      }
      if (netPnl && mNet) {
        mNet.textContent = netPnl.textContent;
        mNet.className = `m-metric-val ${netPnl.textContent.includes('-') ? 'neg' : 'pos'}`;
      }
      if (csWr && mWr) mWr.textContent = csWr.textContent;
      if (csR && mR) {
        mR.textContent = csR.textContent;
        mR.className = `m-metric-val ${csR.textContent.includes('-') ? 'neg' : 'pos'}`;
      }
      if (csSh && mSh) mSh.textContent = csSh.textContent;
      if (mBrk) mBrk.textContent = `${curSym()}0.00 (Zero)`;
    }

    function updateMobileProfileView() {
      const uname = (currentUser && currentUser.username) || 'trader';
      const loginEl = $('m-profile-login');
      if (loginEl) {
        loginEl.textContent = isAdminUser ? `@${uname} (Admin)` : `@${uname}`;
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
    setupChartPlusMenuListeners();
    setupMarketChoiceModal();
    setupAdminModals();
    setupGatekeeper();
    setupGuideModal();
    setupIndicatorsMenu();
    setupTokenModal();
    setupKeysModal();
    setupGuestProfileModal();
    setupMobileFlow();

    loadCandles(panes[0]);
    startQuotesPolling();

    // Regular position refresh (guarded by isAuthenticated)
    setInterval(fetchPositionsAndOrders, 4000);
  });
})();
