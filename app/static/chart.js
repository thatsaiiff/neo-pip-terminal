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
  let selectedOrderType = 'MKT'; // MKT, PENDING
  let instantExecution = true; // ON: 1-click Market fill only | OFF: Market/Pending + Drag on Chart + SL/TP Window
  let selectedLots = 1;
  let updateLotDisplayFn = null;
  let openKeysModalFn = null;
  let cachedPositions = [];
  let cachedOrders = [];
  let cachedClosedPositions = [];
  let cachedExecutions = [];
  let cachedPnlSummary = {};
  let cachedFunds = {};
  let activeSltpRules = [];
  let updateMobileOrdersFn = null;
  let _lastSltpTickMs = 0;
  let _isDraggingTradeLine = false;
  let _chartDragCancelFn = null;

  function closeAllOverlays(exceptId = null) {
    [
      'modal-kotak-connect',
      'modal-admin-analytics',
      'modal-setup-guide',
      'modal-market-choice',
      'option-chain-modal',
      'token-modal',
      'modal-api-keys',
      'modal-guest-profile',
      'order-window-modal',
      'modal-paper-wallet',
      'modal-legal-disclaimer',
    ].forEach(id => {
      if (id !== exceptId && $(id)) $(id).classList.add('hidden');
    });
    if (exceptId !== 'modal-gatekeeper' && isAuthenticated && $('modal-gatekeeper')) {
      $('modal-gatekeeper').classList.add('hidden');
    }
    [
      'ex-account-menu',
      'indicators-menu',
      'layout-dropdown',
      'quick-tab-search-popup',
      'ex-inst-search-results',
      'chart-plus-menu',
      'tf-dropdown-menu',
    ].forEach(id => {
      if (id !== exceptId && $(id)) $(id).classList.add('hidden');
    });
  }

  // Fast Cached IST / UTC Timezone Formatters (zero-GC lag across zoom/pan/TF switches)
  let activeTimeZone = localStorage.getItem('neo_chart_tz') || 'Asia/Kolkata'; // Default UTC+5:30 (IST)
  let _tzFormatters = null;
  function getTzFormatters() {
    if (_tzFormatters && _tzFormatters.tz === activeTimeZone) return _tzFormatters;
    const tz = activeTimeZone;
    const locale = 'en-IN';
    _tzFormatters = {
      tz,
      year: new Intl.DateTimeFormat(locale, { timeZone: tz, year: 'numeric' }),
      month: new Intl.DateTimeFormat(locale, { timeZone: tz, month: 'short' }),
      day: new Intl.DateTimeFormat(locale, { timeZone: tz, day: '2-digit', month: 'short' }),
      time: new Intl.DateTimeFormat(locale, { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }),
      sec: new Intl.DateTimeFormat(locale, { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
      crosshairIntraday: new Intl.DateTimeFormat(locale, { timeZone: tz, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }),
      crosshairSec: new Intl.DateTimeFormat(locale, { timeZone: tz, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
    };
    return _tzFormatters;
  }

  function lwcTimeToDate(time) {
    if (typeof time === 'number') return new Date(time * 1000);
    if (time && typeof time === 'object' && time.year) {
      return new Date(Date.UTC(time.year, (time.month || 1) - 1, time.day || 1));
    }
    return new Date();
  }

  function formatChartTickMark(time, tickMarkType) {
    const fmts = getTzFormatters();
    const d = lwcTimeToDate(time);
    if (tickMarkType === 0) return fmts.year.format(d);
    if (tickMarkType === 1) return fmts.month.format(d);
    if (tickMarkType === 2) return fmts.day.format(d);
    if (tickMarkType === 4) return fmts.sec.format(d);
    return fmts.time.format(d);
  }

  function formatChartCrosshairTime(time) {
    const fmts = getTzFormatters();
    const d = lwcTimeToDate(time);
    if (typeof time === 'number') {
      const p = getActivePane();
      return String(p && p.tf || '').includes('s') ? fmts.crosshairSec.format(d) : fmts.crosshairIntraday.format(d);
    }
    return fmts.day.format(d) + ' ' + fmts.year.format(d);
  }

  function getActivePane() {
    return panes[activePaneIdx] || panes[0];
  }

  function updateTzBadgeUI() {
    const btn = $('btn-tz-toggle');
    if (btn) {
      btn.textContent = activeTimeZone === 'Asia/Kolkata' ? 'UTC+5:30 (IST)' : 'UTC+0 (GMT)';
    }
  }

  function _svgCurrencyFlag(code) {
    if (code === 'US') {
      return '<rect width="24" height="24" fill="#1d4ed8"/><path d="M0 5h24M0 10h24M0 15h24M0 20h24" stroke="#ef4444" stroke-width="2.2"/><rect width="11" height="12" fill="#1e3a8a"/><circle cx="3.5" cy="3.5" r="1" fill="#fff"/><circle cx="7.5" cy="3.5" r="1" fill="#fff"/><circle cx="5.5" cy="6.5" r="1" fill="#fff"/><circle cx="3.5" cy="9" r="1" fill="#fff"/><circle cx="7.5" cy="9" r="1" fill="#fff"/>';
    }
    if (code === 'EU') {
      return '<rect width="24" height="24" fill="#1d4ed8"/><circle cx="12" cy="12" r="6" fill="none" stroke="#facc15" stroke-width="2" stroke-dasharray="1.5 2.4"/>';
    }
    if (code === 'GB') {
      return '<rect width="24" height="24" fill="#1e3a8a"/><path d="M0 0L24 24M24 0L0 24" stroke="#fff" stroke-width="4"/><path d="M0 0L24 24M24 0L0 24" stroke="#ef4444" stroke-width="2"/><path d="M12 0v24M0 12h24" stroke="#fff" stroke-width="6"/><path d="M12 0v24M0 12h24" stroke="#ef4444" stroke-width="3.5"/>';
    }
    if (code === 'JP') {
      return '<rect width="24" height="24" fill="#f8fafc"/><circle cx="12" cy="12" r="5.5" fill="#dc2626"/>';
    }
    if (code === 'AU') {
      return '<rect width="24" height="24" fill="#1e3a8a"/><path d="M0 0h11v11H0z" fill="#1d4ed8"/><path d="M5.5 0v11M0 5.5h11" stroke="#ef4444" stroke-width="2.5"/><circle cx="18" cy="7" r="1.5" fill="#fff"/><circle cx="17" cy="17" r="2" fill="#fff"/>';
    }
    return '<rect width="24" height="24" fill="#334155"/>';
  }

  function getInstrumentIconHtml(sym, size = 24) {
    const raw = String(sym || '').trim().toUpperCase();
    const fx = normFxSym(raw);
    const s = size;
    const uid = Math.random().toString(36).slice(2, 7);

    if (fx === 'BTCUSD' || fx === 'BTC') {
      return `<span class="tv-sym-icon" style="width:${s}px;height:${s}px;"><svg viewBox="0 0 24 24" width="${s}" height="${s}"><circle cx="12" cy="12" r="11" fill="#f7931a"/><path d="M13.6 10.9c1.1-.3 1.7-1 1.5-2.1-.2-1.2-1.1-1.6-2.4-1.8V5.5h-1v1.4h-.8V5.5h-1v1.4H8.1v1.2h.7c.4 0 .6.2.6.5v6.8c0 .3-.1.5-.5.5h-.8v1.3h1.8v1.4h1v-1.4h.8v1.4h1v-1.4c1.9-.1 3.1-.7 3.3-2.3.1-1.2-.5-1.9-1.4-2.2zm-2.7-2.6h.8c.9 0 1.4.3 1.4 1s-.5 1-1.4 1h-.8v-2zm1.1 5.6h-1.1v-2.2h1.1c1 0 1.6.3 1.6 1.1s-.6 1.1-1.6 1.1z" fill="#fff"/></svg></span>`;
    }
    if (fx === 'ETHUSD' || fx === 'ETH') {
      return `<span class="tv-sym-icon" style="width:${s}px;height:${s}px;"><svg viewBox="0 0 24 24" width="${s}" height="${s}"><circle cx="12" cy="12" r="11" fill="#627eea"/><path d="M12 4.5l4.7 7.6L12 14.9l-4.7-2.8L12 4.5zm0 11.4l4.7-2.7L12 19.5l-4.7-6.3L12 15.9z" fill="#fff"/></svg></span>`;
    }
    if (fx === 'XAUUSD' || fx === 'XAGUSD') {
      const isGold = fx === 'XAUUSD';
      const c1 = isGold ? '#f59e0b' : '#94a3b8';
      const c2 = isGold ? '#fde68a' : '#e2e8f0';
      const c3 = isGold ? '#92400e' : '#334155';
      return `<span class="tv-sym-icon" style="width:${s}px;height:${s}px;"><svg viewBox="0 0 28 24" width="${Math.round(s * 1.16)}" height="${s}"><defs><clipPath id="cp_us_${uid}"><circle cx="19" cy="10" r="7.5"/></clipPath></defs><circle cx="10" cy="13" r="8.5" fill="${c1}" stroke="#0e1117" stroke-width="1.2"/><rect x="6" y="10" width="8" height="5.5" rx="1.2" fill="${c2}"/><circle cx="19" cy="10" r="7.5" fill="#1e3a8a" stroke="#0e1117" stroke-width="1.2"/><g clip-path="url(#cp_us_${uid})" transform="translate(11.5,2.5) scale(0.625)">${_svgCurrencyFlag('US')}</g><text x="10" y="14.5" text-anchor="middle" font-size="4.2" font-weight="800" fill="${c3}" font-family="sans-serif">${isGold ? 'Au' : 'Ag'}</text></svg></span>`;
    }
    if (fx === 'USOIL') {
      return `<span class="tv-sym-icon" style="width:${s}px;height:${s}px;"><svg viewBox="0 0 24 24" width="${s}" height="${s}"><circle cx="12" cy="12" r="11" fill="#0f172a" stroke="#334155" stroke-width="1"/><path d="M12 5.2C12 5.2 7.2 10.6 7.2 14.1a4.8 4.8 0 0 0 9.6 0C16.8 10.6 12 5.2 12 5.2zm-1.4 9.9a1.4 1.4 0 0 1-.8-1.5c.1-.7.7-1.6 1-2-.2.9.2 1.8.8 2.2-.3.7-.7 1.1-1 1.3z" fill="#f8fafc"/></svg></span>`;
    }
    if (fx === 'USTEC') {
      return `<span class="tv-sym-icon" style="width:${s}px;height:${s}px;"><svg viewBox="0 0 24 24" width="${s}" height="${s}"><defs><clipPath id="cp_ndx_${uid}"><circle cx="12" cy="12" r="10.5"/></clipPath></defs><g clip-path="url(#cp_ndx_${uid})">${_svgCurrencyFlag('US')}</g><rect x="3" y="8.2" width="18" height="7.6" rx="3" fill="rgba(14,17,23,0.9)"/><text x="12" y="13.8" text-anchor="middle" font-size="5.6" font-weight="800" fill="#fff" font-family="sans-serif">NDX</text></svg></span>`;
    }
    if (['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD'].includes(fx)) {
      const f1 = fx.slice(0, 2);
      const f2 = fx.slice(3, 5);
      return `<span class="tv-sym-icon" style="width:${s}px;height:${s}px;"><svg viewBox="0 0 28 24" width="${Math.round(s * 1.16)}" height="${s}"><defs><clipPath id="cp_a_${uid}"><circle cx="9.5" cy="14" r="8.2"/></clipPath><clipPath id="cp_b_${uid}"><circle cx="18.5" cy="9.5" r="8.2"/></clipPath></defs><g clip-path="url(#cp_b_${uid})" transform="translate(10.3,1.3) scale(0.683)">${_svgCurrencyFlag(f2)}</g><circle cx="18.5" cy="9.5" r="8.2" fill="none" stroke="#0e1117" stroke-width="1.3"/><g clip-path="url(#cp_a_${uid})" transform="translate(1.3,5.8) scale(0.683)">${_svgCurrencyFlag(f1)}</g><circle cx="9.5" cy="14" r="8.2" fill="none" stroke="#0e1117" stroke-width="1.3"/></svg></span>`;
    }

    const isCall = /\bCE\b/.test(raw);
    const isPut = /\bPE\b/.test(raw);
    let bg = '#2563eb';
    let label = raw.replace(/[^A-Z0-9]/g, '').slice(0, 2) || 'EQ';
    if (raw.includes('BANKNIFTY')) { bg = '#0891b2'; label = 'BN'; }
    else if (raw.includes('FINNIFTY')) { bg = '#7c3aed'; label = 'FN'; }
    else if (raw.includes('SENSEX')) { bg = '#d97706'; label = 'SX'; }
    else if (raw.includes('NIFTY')) { bg = '#2563eb'; label = 'N5'; }
    else if (raw.includes('RELIANCE')) { bg = '#0284c7'; label = 'RL'; }
    else if (raw.includes('HDFC')) { bg = '#dc2626'; label = 'HD'; }
    else if (raw.includes('ICICI')) { bg = '#ea580c'; label = 'IC'; }
    else if (raw.includes('TCS')) { bg = '#4f46e5'; label = 'TC'; }
    else if (raw.includes('INFY')) { bg = '#0d9488'; label = 'IN'; }
    else if (raw.includes('SBI')) { bg = '#1d4ed8'; label = 'SB'; }

    const optDot = isCall ? '#10b981' : (isPut ? '#f43f5e' : '');
    const optText = isCall ? 'C' : (isPut ? 'P' : '');
    return `<span class="tv-sym-icon" style="width:${s}px;height:${s}px;"><svg viewBox="0 0 24 24" width="${s}" height="${s}"><circle cx="12" cy="12" r="10.5" fill="${bg}" stroke="#1f2937" stroke-width="1"/><text x="12" y="14.7" text-anchor="middle" font-size="8.2" font-weight="800" fill="#fff" font-family="sans-serif">${escapeHtml(label)}</text>${optDot ? `<circle cx="18.5" cy="18.5" r="4.8" fill="${optDot}" stroke="#0e1117" stroke-width="1.2"/><text x="18.5" y="20.4" text-anchor="middle" font-size="5.6" font-weight="900" fill="#fff" font-family="sans-serif">${optText}</text>` : ''}</svg></span>`;
  }

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

  const INDEX_SPOT_SYMBOLS = new Set([
    'NIFTY', 'NIFTY50', 'BANKNIFTY', 'NIFTYBANK', 'FINNIFTY',
    'MIDCPNIFTY', 'SENSEX', 'BSESENSEX', 'SENSEX50', 'BANKEX',
    'INDIAVIX', 'CNXFINANCE', 'MIDCAP',
  ]);

  function isIndexSpotSymbol(sym, token = '', segment = '') {
    const raw = String(sym || '').trim().toUpperCase();
    if (!raw || isForexSym(raw) || isOptionSymbol(raw) || /\bFUT\b/i.test(raw)) return false;
    const compact = raw.replace(/\s+/g, '');
    if (INDEX_SPOT_SYMBOLS.has(compact)) return true;
    const tokU = String(token || '').toUpperCase();
    const metaSeg = String((symbolMeta[raw] && symbolMeta[raw].segment) || segment || '').toUpperCase();
    return tokU.includes('_INDEX|') || metaSeg.includes('INDEX');
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
      sym: 'BANKNIFTY',
      token: 'NSE_INDEX|Nifty Bank',
      tf: '1m',
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
      _userPicked: false,
    },
    {
      idx: 2,
      id: 'pane-3',
      sym: 'SENSEX',
      token: 'BSE_INDEX|SENSEX',
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
      _userPicked: false,
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

  function refreshAllPaneTimezones() {
    updateTzBadgeUI();
    panes.forEach(p => {
      if (p && p.chart) {
        try {
          p.chart.applyOptions({
            localization: { timeFormatter: formatChartCrosshairTime },
            timeScale: {
              secondsVisible: String(p.tf || '').includes('s'),
              tickMarkFormatter: formatChartTickMark,
            },
          });
        } catch (_) {}
      }
    });
  }

  function computeLivePosM2m(pos) {
    const symU = String(pos.symbol || pos.trading_symbol || pos.trdSym || '').trim().toUpperCase();
    const matchPane = panes.find(p => String(p.sym || '').trim().toUpperCase() === symU && Number(p.lastLtp) > 0);
    const avg = Number(pos.average_price || pos.avg_price || pos.avgPrc || 0);
    const ltp = matchPane ? Number(matchPane.lastLtp) : Number(pos.ltp || avg);
    const side = String(pos.side || (pos.direction === 'SHORT' ? 'SELL' : 'BUY') || (Number(pos.quantity) > 0 ? 'BUY' : 'SELL')).toUpperCase();
    const qty = Math.abs(Number(pos.quantity || pos.qty || 0));
    const fx = getForexSpec(symU);
    const mult = Number(pos.multiplier || (fx && fx.multiplier) || 1.0);
    if (matchPane && avg > 0 && qty > 0) {
      return (side === 'BUY' ? (ltp - avg) : (avg - ltp)) * qty * mult;
    }
    return Number(pos.m2m !== undefined ? pos.m2m : ((side === 'BUY' ? (ltp - avg) : (avg - ltp)) * qty * mult));
  }

  function sumSymbolOpenPnl(sym) {
    const symU = String(sym || '').trim().toUpperCase();
    if (!symU || !cachedPositions.length) return { hasOpen: false, pnl: 0 };
    const matching = cachedPositions.filter(p => String(p.symbol || p.trading_symbol || p.trdSym || '').trim().toUpperCase() === symU);
    if (!matching.length) return { hasOpen: false, pnl: 0 };
    const total = matching.reduce((acc, p) => acc + computeLivePosM2m(p), 0);
    return { hasOpen: true, pnl: total };
  }

  function updateActivePanePnlBadges() {
    // 1. Update each pane header badge (especially right beside symbol name on Mobile & split panes)
    panes.forEach(p => {
      const badge = $(`${getPanePrefix(p)}-pos-pnl`);
      if (!badge) return;
      if (!isAuthenticated) {
        badge.classList.add('hidden');
        return;
      }
      const { hasOpen, pnl } = sumSymbolOpenPnl(p.sym);
      if (!hasOpen) {
        badge.classList.add('hidden');
      } else {
        const cs = curSym(p.sym);
        const sign = pnl >= 0 ? '+' : '-';
        badge.textContent = `${sign}${cs}${Math.abs(pnl).toFixed(2)}`;
        badge.className = `pane-pos-pnl ${pnl >= 0 ? 'pos' : 'neg'}`;
      }
    });

    // 2. Update top-toolbar Exness active-symbol individual P&L pill (just left of layout icon)
    const wrap = $('active-pos-pnl-wrap');
    const valEl = $('active-pos-pnl-val');
    if (!wrap || !valEl) return;
    if (!isAuthenticated) {
      wrap.classList.add('hidden');
      return;
    }
    const ap = getActivePane();
    const { hasOpen, pnl } = sumSymbolOpenPnl(ap.sym);
    if (!hasOpen) {
      wrap.classList.add('hidden');
    } else {
      const cs = curSym(ap.sym);
      const sign = pnl >= 0 ? '+' : '-';
      const curSuffix = cs === '$' ? ' USD' : ' INR';
      valEl.textContent = `${sign}${cs}${Math.abs(pnl).toFixed(2)}${curSuffix}`;
      wrap.className = `ex-active-pnl ${pnl >= 0 ? 'pos' : 'neg'}`;
    }
  }

  function syncTradeButtonsForActivePane() {
    const pane = getActivePane();
    const isIdx = isIndexSpotSymbol(pane.sym, pane.token);

    ['btn-order-sell', 'btn-order-buy', 'm-btn-sell', 'm-btn-buy'].forEach(id => {
      const btn = $(id);
      if (!btn) return;
      btn.disabled = isIdx;
      btn.classList.toggle('is-index-disabled', isIdx);
      btn.title = isIdx ? 'Index spot cannot be bought or sold directly — choose an Option (CE/PE) or Stock' : '';
    });

    ['op-btn-drag-buy', 'op-btn-drag-sell', 'm-btn-drag-buy', 'm-btn-drag-sell'].forEach(id => {
      const btn = $(id);
      if (btn) btn.disabled = isIdx;
    });

    const notice = $('op-index-notice');
    if (notice) notice.classList.toggle('hidden', !isIdx);

    if (isIdx) {
      if ($('lbl-sell-action')) $('lbl-sell-action').textContent = 'Index';
      if ($('lbl-buy-action')) $('lbl-buy-action').textContent = 'Chart Only';
      if ($('m-sell-caption')) $('m-sell-caption').textContent = 'Index';
      if ($('m-buy-caption')) $('m-buy-caption').textContent = 'Chart';
    } else {
      const isPend = !instantExecution && selectedOrderType === 'PENDING';
      if ($('lbl-sell-action')) $('lbl-sell-action').textContent = isPend ? 'Sell Pending' : 'Sell';
      if ($('lbl-buy-action')) $('lbl-buy-action').textContent = isPend ? 'Buy Pending' : 'Buy';
      if ($('m-sell-caption')) $('m-sell-caption').textContent = isPend ? 'Sell Pend' : 'Sell';
      if ($('m-buy-caption')) $('m-buy-caption').textContent = isPend ? 'Buy Pend' : 'Buy';
    }
  }

  async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (ownerToken) {
      headers['X-Owner-Token'] = ownerToken;
      headers['Authorization'] = `Bearer ${ownerToken}`;
    }
    const res = await fetch(path, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers,
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && !path.startsWith('/api/auth/')) {
        if (typeof window._handleLogoutFn === 'function' && isAuthenticated) {
          window._handleLogoutFn('Session ended. Please sign in again.');
        }
      }
      throw new Error(data.detail || `HTTP ${res.status}`);
    }
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
        fontFamily: "'DM Sans', 'Trebuchet MS', -apple-system, Roboto, sans-serif",
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
      localization: {
        timeFormatter: formatChartCrosshairTime,
      },
      timeScale: {
        borderColor: '#202735',
        timeVisible: true,
        secondsVisible: pane.tf.includes('s'),
        rightOffset: 6,
        tickMarkFormatter: formatChartTickMark,
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
      if (isIndexSpotSymbol(sym, pane.token)) {
        menu.classList.add('hidden');
        toast('Index spot cannot be bought or sold directly — choose an Option (CE/PE) or Stock');
        return;
      }
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

  // --- Draggable Entry / SL / TP Price Lines Directly on Chart Canvas (TradingView-style) ---
  function attachPriceLineDrag(dragEls, handleEl, lineEl, pane, rule, fieldKey, labelPrefix, decs, pos = null) {
    let dragging = false;
    const cs = curSym(pane.sym);
    const entryP = Number((pos && (pos.average_price || pos.avg_price)) || rule.entry_price || 0);
    const qty = Math.abs(Number((pos && pos.quantity) || rule.quantity || 1));
    const fx = getForexSpec(pane.sym);
    const mult = Number((pos && pos.multiplier) || (fx && fx.multiplier) || 1);
    const sideSign = String((pos && pos.side) || rule.side || 'BUY').toUpperCase() === 'BUY' ? 1 : -1;

    const getClientY = ev => {
      if (ev.touches && ev.touches[0]) return ev.touches[0].clientY;
      if (ev.changedTouches && ev.changedTouches[0]) return ev.changedTouches[0].clientY;
      return ev.clientY;
    };

    const formatPillText = (pVal) => {
      let pnlPart = '';
      if (entryP > 0 && Number.isFinite(pVal)) {
        const pnl = (pVal - entryP) * qty * mult * sideSign;
        pnlPart = ` (${pnl >= 0 ? '+' : '-'}${cs}${Math.abs(pnl).toFixed(2)})`;
      }
      return `${labelPrefix} ${cs}${pVal.toFixed(decs)}${pnlPart}`;
    };

    function onStart(ev) {
      if (dragging) return;
      if (ev.button !== undefined && ev.button !== 0 && ev.type === 'mousedown') return;
      ev.preventDefault();
      ev.stopPropagation();
      dragging = true;
      _isDraggingTradeLine = true;
      lineEl.classList.add('is-dragging');
      document.body.style.cursor = 'ns-resize';
      if (pane.chart) {
        try { pane.chart.applyOptions({ handleScroll: false, handleScale: false }); } catch (_) {}
      }
      window.addEventListener('pointermove', onMove, { capture: true, passive: false });
      window.addEventListener('pointerup', onEnd, true);
      window.addEventListener('pointercancel', onEnd, true);
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onEnd, true);
      window.addEventListener('touchmove', onMove, { capture: true, passive: false });
      window.addEventListener('touchend', onEnd, true);
    }

    function onMove(ev) {
      if (!dragging || !pane.candleSeries || !pane.canvasWrap) return;
      if (ev.cancelable) ev.preventDefault();
      const wrapRect = pane.canvasWrap.getBoundingClientRect();
      const y = Math.max(8, Math.min(wrapRect.height - 20, getClientY(ev) - wrapRect.top));
      const newPrice = pane.candleSeries.coordinateToPrice(y);
      if (newPrice !== null && Number.isFinite(newPrice) && newPrice > 0) {
        const rounded = Number(newPrice.toFixed(decs));
        lineEl.style.top = `${y}px`;
        lineEl.dataset.dragPrice = String(rounded);
        handleEl.textContent = formatPillText(rounded);
      }
    }

    async function onEnd() {
      if (!dragging) return;
      dragging = false;
      lineEl.classList.remove('is-dragging');
      document.body.style.cursor = '';
      if (pane.chart) {
        try { pane.chart.applyOptions({ handleScroll: true, handleScale: true }); } catch (_) {}
      }
      window.removeEventListener('pointermove', onMove, { capture: true });
      window.removeEventListener('pointerup', onEnd, true);
      window.removeEventListener('pointercancel', onEnd, true);
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onEnd, true);
      window.removeEventListener('touchmove', onMove, { capture: true });
      window.removeEventListener('touchend', onEnd, true);

      const finalP = Number(lineEl.dataset.dragPrice || 0);
      try {
        if (finalP > 0) {
          rule[fieldKey] = finalP;
          handleEl.textContent = formatPillText(finalP);
          await api(`/api/sltp/${rule.id}?market=${encodeURIComponent(currentMarketMode)}`, {
            method: 'PATCH',
            body: JSON.stringify({ [fieldKey]: finalP }),
          });
          toast(`✅ Updated ${labelPrefix} to ${cs}${finalP.toFixed(decs)}`);
        }
      } catch (err) {
        toast(`❌ ${err.message}`);
      } finally {
        _isDraggingTradeLine = false;
        renderPaneTradeLines(pane, true);
      }
    }

    (Array.isArray(dragEls) ? dragEls : [dragEls]).filter(Boolean).forEach(el => {
      el.addEventListener('pointerdown', onStart);
      el.addEventListener('mousedown', onStart);
      el.addEventListener('touchstart', onStart, { passive: false });
    });
  }

  function renderPaneTradeLines(pane, force = false) {
    if (!pane || (_isDraggingTradeLine && !force)) return;
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

    function createLineEl(cls, priceVal, draggableLine = false) {
      const y = pane.candleSeries.priceToCoordinate(Number(priceVal));
      if (y === null || !Number.isFinite(y) || y < 2 || y > wrapH - 2) return null;
      const el = document.createElement('div');
      el.className = `trade-price-line ${cls}`;
      el.style.top = `${y}px`;
      el.innerHTML = draggableLine
        ? '<div class="tpl-hit-bar" title="Drag up/down"></div><div class="tpl-line"></div>'
        : '<div class="tpl-line"></div>';
      return el;
    }

    // 1. Entry Price Line for open position
    if (pos) {
      const avg = Number(pos.average_price || pos.avg_price || 0);
      const side = String(pos.side || (pos.direction === 'SHORT' ? 'SELL' : 'BUY')).toUpperCase();
      const qtyDisp = pos.lots && isForexSym(pane.sym) ? `${pos.lots} lot` : `${Math.abs(Number(pos.quantity || 0))}`;
      const m2m = Number(pos.m2m || 0);
      const entryLine = createLineEl('tpl-entry', avg, false);
      if (entryLine) {
        const bg = document.createElement('div');
        bg.className = 'tpl-badge-group';
        const tag = document.createElement('span');
        tag.className = 'tpl-drag-handle';
        tag.textContent = `${side} ${qtyDisp} (${m2m >= 0 ? '+' : ''}${cs}${m2m.toFixed(2)})`;
        bg.appendChild(tag);

        const existingRule = rules[0] || null;
        const hasTp = existingRule && existingRule.tp_price !== null && existingRule.tp_price !== undefined && Number(existingRule.tp_price) > 0;
        const hasSl = existingRule && existingRule.sl_price !== null && existingRule.sl_price !== undefined && Number(existingRule.sl_price) > 0;

        async function saveQuickLevel(kind, targetPrice = null) {
          const ref = Number(pane.lastLtp || avg);
          const recentBars = (pane.candles || []).slice(-30);
          let span = 0;
          if (recentBars.length) {
            const hi = Math.max(...recentBars.map(b => Number(b.high || b.close || 0)));
            const lo = Math.min(...recentBars.map(b => Number(b.low || b.close || 0)));
            if (hi > lo) span = (hi - lo) * 0.28;
          }
          const delta = Math.max(span || (ref * 0.003), decs >= 4 ? 0.0008 : (decs === 3 ? 0.05 : 0.8));
          const defSl = Number((side === 'BUY' ? ref - delta : ref + delta).toFixed(decs));
          const defTp = Number((side === 'BUY' ? ref + delta * 1.25 : ref - delta * 1.25).toFixed(decs));
          const val = targetPrice !== null ? Number(targetPrice.toFixed(decs)) : null;
          try {
            if (existingRule) {
              const patch = {};
              if (kind === 'tp') patch.tp_price = val || defTp;
              else if (kind === 'sl') patch.sl_price = val || defSl;
              else {
                if (!hasTp) patch.tp_price = defTp;
                if (!hasSl) patch.sl_price = defSl;
              }
              await api(`/api/sltp/${existingRule.id}?market=${encodeURIComponent(currentMarketMode)}`, {
                method: 'PATCH',
                body: JSON.stringify(patch),
              });
            } else {
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
                  sl_price: kind === 'tp' ? null : (kind === 'sl' && val ? val : defSl),
                  tp_price: kind === 'sl' ? null : (kind === 'tp' && val ? val : defTp),
                }),
              });
            }
            toast('✅ SL/TP line active on chart — grab line or badge to drag!');
            await fetchPositionsAndOrders();
          } catch (err) {
            toast(`❌ ${err.message}`);
          }
        }

        function attachEntryDragSpawn(btnEl, kind, labelText) {
          let dragActive = false;
          let moved = false;
          let startY = 0;
          let previewEl = null;

          const getY = ev => (ev.touches && ev.touches[0] ? ev.touches[0].clientY : (ev.changedTouches && ev.changedTouches[0] ? ev.changedTouches[0].clientY : ev.clientY));

          function startDrag(ev) {
            if (dragActive) return;
            if (ev.button !== undefined && ev.button !== 0 && ev.type === 'mousedown') return;
            ev.preventDefault();
            ev.stopPropagation();
            dragActive = true;
            moved = false;
            startY = getY(ev);
            _isDraggingTradeLine = true;
            if (pane.chart) {
              try { pane.chart.applyOptions({ handleScroll: false, handleScale: false }); } catch (_) {}
            }
            window.addEventListener('pointermove', moveDrag, { passive: false });
            window.addEventListener('pointerup', endDrag);
            window.addEventListener('mousemove', moveDrag);
            window.addEventListener('mouseup', endDrag);
            window.addEventListener('touchmove', moveDrag, { passive: false });
            window.addEventListener('touchend', endDrag);
          }

          function moveDrag(ev) {
            if (!dragActive || !pane.canvasWrap || !pane.candleSeries) return;
            const cy = getY(ev);
            if (Math.abs(cy - startY) >= 5) moved = true;
            if (!moved) return;
            if (ev.cancelable) ev.preventDefault();
            const wrapRect = pane.canvasWrap.getBoundingClientRect();
            const y = Math.max(8, Math.min(wrapRect.height - 20, cy - wrapRect.top));
            const pr = pane.candleSeries.coordinateToPrice(y);
            if (!pr || !Number.isFinite(pr) || pr <= 0) return;
            const rounded = Number(pr.toFixed(decs));
            if (!previewEl) {
              previewEl = document.createElement('div');
              previewEl.className = `trade-price-line ${kind === 'tp' ? 'tpl-tp' : 'tpl-sl'} is-dragging`;
              previewEl.innerHTML = `<div class="tpl-line"></div><div class="tpl-badge-group"><span class="tpl-drag-handle">${labelText}</span></div>`;
              overlay.appendChild(previewEl);
            }
            previewEl.style.top = `${y}px`;
            previewEl.dataset.dragPrice = String(rounded);
            const hSpan = previewEl.querySelector('.tpl-drag-handle');
            if (hSpan) hSpan.textContent = `${labelText} ${cs}${rounded.toFixed(decs)}`;
          }

          async function endDrag() {
            if (!dragActive) return;
            dragActive = false;
            _isDraggingTradeLine = false;
            if (pane.chart) {
              try { pane.chart.applyOptions({ handleScroll: true, handleScale: true }); } catch (_) {}
            }
            window.removeEventListener('pointermove', moveDrag);
            window.removeEventListener('pointerup', endDrag);
            window.removeEventListener('mousemove', moveDrag);
            window.removeEventListener('mouseup', endDrag);
            window.removeEventListener('touchmove', moveDrag);
            window.removeEventListener('touchend', endDrag);

            const dropped = previewEl ? Number(previewEl.dataset.dragPrice || 0) : 0;
            if (previewEl) { previewEl.remove(); previewEl = null; }
            if (moved && dropped > 0) {
              await saveQuickLevel(kind, dropped);
            } else {
              await saveQuickLevel(kind, null);
            }
          }

          btnEl.addEventListener('pointerdown', startDrag);
          btnEl.addEventListener('mousedown', startDrag);
          btnEl.addEventListener('touchstart', startDrag, { passive: false });
        }

        if (!hasTp) {
          const tpChip = document.createElement('button');
          tpChip.type = 'button';
          tpChip.className = 'tpl-action-chip tpl-drag-quick tp-chip';
          tpChip.textContent = '+TP ↕';
          tpChip.title = 'Click or drag up/down directly onto chart to set Take Profit';
          attachEntryDragSpawn(tpChip, 'tp', 'TP');
          bg.appendChild(tpChip);
        }
        if (!hasSl) {
          const slChip = document.createElement('button');
          slChip.type = 'button';
          slChip.className = 'tpl-action-chip tpl-drag-quick sl-chip';
          slChip.textContent = '+SL ↕';
          slChip.title = 'Click or drag up/down directly onto chart to set Stop Loss';
          attachEntryDragSpawn(slChip, 'sl', 'SL');
          bg.appendChild(slChip);
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
    const qtyForRule = Math.abs(Number((pos && pos.quantity) || (rules[0] && rules[0].quantity) || 1));
    const entryForRule = Number((pos && (pos.average_price || pos.avg_price)) || (rules[0] && rules[0].entry_price) || 0);
    const fxSpec = getForexSpec(pane.sym);
    const multRule = Number((pos && pos.multiplier) || (fxSpec && fxSpec.multiplier) || 1);

    rules.forEach(rule => {
      const rSign = String((pos && pos.side) || rule.side || 'BUY').toUpperCase() === 'BUY' ? 1 : -1;
      if (rule.tp_price !== null && rule.tp_price !== undefined && Number(rule.tp_price) > 0) {
        const tpP = Number(rule.tp_price);
        const tpLine = createLineEl('tpl-tp', tpP, true);
        if (tpLine) {
          const bg = document.createElement('div');
          bg.className = 'tpl-badge-group';
          const handle = document.createElement('span');
          handle.className = 'tpl-drag-handle';
          const projTp = entryForRule > 0 ? (tpP - entryForRule) * qtyForRule * multRule * rSign : null;
          const tpSuffix = projTp !== null && Number.isFinite(projTp) ? ` (${projTp >= 0 ? '+' : '-'}${cs}${Math.abs(projTp).toFixed(2)})` : '';
          handle.textContent = `TP ${cs}${tpP.toFixed(decs)}${tpSuffix}`;
          handle.title = 'Drag up/down to adjust Take Profit';
          attachPriceLineDrag([handle, tpLine.querySelector('.tpl-hit-bar')], handle, tpLine, pane, rule, 'tp_price', 'TP', decs, pos);
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
        const slLine = createLineEl('tpl-sl', slP, true);
        if (slLine) {
          const bg = document.createElement('div');
          bg.className = 'tpl-badge-group';
          const handle = document.createElement('span');
          handle.className = 'tpl-drag-handle';
          const projSl = entryForRule > 0 ? (slP - entryForRule) * qtyForRule * multRule * rSign : null;
          const slSuffix = projSl !== null && Number.isFinite(projSl) ? ` (${projSl >= 0 ? '+' : '-'}${cs}${Math.abs(projSl).toFixed(2)})` : '';
          handle.textContent = `SL ${cs}${slP.toFixed(decs)}${slSuffix}`;
          handle.title = 'Drag up/down to adjust Stop Loss';
          attachPriceLineDrag([handle, slLine.querySelector('.tpl-hit-bar')], handle, slLine, pane, rule, 'sl_price', 'SL', decs, pos);
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

    // 3. Pending Orders (Limit / Stop) rendered on chart with drag-to-modify & 1-click cancel
    const pendingForPane = cachedOrders.filter(
      o => o.status === 'pending' && String(o.symbol || '').trim().toUpperCase() === symUpper
    );
    pendingForPane.forEach(po => {
      const poPrice = Number(po.trigger_price || po.price || 0);
      if (!(poPrice > 0)) return;
      const pendLine = createLineEl('tpl-pending', poPrice, true);
      if (!pendLine) return;
      const pSide = String(po.side || 'BUY').toUpperCase();
      const pKind = String(po.order_type || 'L').toUpperCase().startsWith('SL') ? 'STOP' : 'LIMIT';
      const qtyTxt = po.lots && isForexSym(pane.sym) ? `${po.lots} lot` : `${po.quantity || 1}`;

      const bg = document.createElement('div');
      bg.className = 'tpl-badge-group';
      const handle = document.createElement('span');
      handle.className = 'tpl-drag-handle';
      handle.textContent = `${pSide} ${pKind} ${qtyTxt} @ ${cs}${poPrice.toFixed(decs)}`;
      handle.title = 'Drag up/down to modify Pending order price (auto-flips Limit/Stop across LTP)';

      // Vertical drag to PATCH /api/orders/{id}
      let pDrag = false;
      const getY = ev => (ev.touches && ev.touches[0] ? ev.touches[0].clientY : (ev.changedTouches && ev.changedTouches[0] ? ev.changedTouches[0].clientY : ev.clientY));
      function pStart(ev) {
        if (pDrag) return;
        if (ev.button !== undefined && ev.button !== 0 && ev.type === 'mousedown') return;
        ev.preventDefault();
        ev.stopPropagation();
        pDrag = true;
        _isDraggingTradeLine = true;
        pendLine.classList.add('is-dragging');
        if (pane.chart) try { pane.chart.applyOptions({ handleScroll: false, handleScale: false }); } catch (_) {}
        window.addEventListener('pointermove', pMove, { passive: false });
        window.addEventListener('pointerup', pEnd, true);
        window.addEventListener('mousemove', pMove, true);
        window.addEventListener('mouseup', pEnd, true);
        window.addEventListener('touchmove', pMove, { capture: true, passive: false });
        window.addEventListener('touchend', pEnd, true);
      }
      function pMove(ev) {
        if (!pDrag || !pane.candleSeries || !pane.canvasWrap) return;
        if (ev.cancelable) ev.preventDefault();
        const rect = pane.canvasWrap.getBoundingClientRect();
        const y = Math.max(8, Math.min(rect.height - 20, getY(ev) - rect.top));
        const np = pane.candleSeries.coordinateToPrice(y);
        if (np !== null && Number.isFinite(np) && np > 0) {
          const r = Number(np.toFixed(decs));
          pendLine.style.top = `${y}px`;
          pendLine.dataset.dragPrice = String(r);
          const liveLtp = Number(pane.lastLtp || r);
          const nextKind = (pSide === 'BUY' ? r > liveLtp : r < liveLtp) ? 'STOP' : 'LIMIT';
          handle.textContent = `${pSide} ${nextKind} ${qtyTxt} @ ${cs}${r.toFixed(decs)}`;
        }
      }
      async function pEnd() {
        if (!pDrag) return;
        pDrag = false;
        pendLine.classList.remove('is-dragging');
        if (pane.chart) try { pane.chart.applyOptions({ handleScroll: true, handleScale: true }); } catch (_) {}
        window.removeEventListener('pointermove', pMove, true);
        window.removeEventListener('pointerup', pEnd, true);
        window.removeEventListener('mousemove', pMove, true);
        window.removeEventListener('mouseup', pEnd, true);
        window.removeEventListener('touchmove', pMove, { capture: true });
        window.removeEventListener('touchend', pEnd, true);
        const fp = Number(pendLine.dataset.dragPrice || 0);
        try {
          if (fp > 0) {
            const patchRes = await api(`/api/orders/${po.id}?market=${encodeURIComponent(currentMarketMode)}`, {
              method: 'PATCH',
              body: JSON.stringify({ price: fp, trigger_price: fp }),
            });
            const updKind = String(patchRes.order_type || '').startsWith('SL') ? 'STOP' : 'LIMIT';
            toast(`✅ ${pSide} ${updKind} moved to ${cs}${fp.toFixed(decs)}`);
          }
        } catch (err) {
          toast(`❌ Order update failed: ${err.message}`);
        } finally {
          _isDraggingTradeLine = false;
          if (fp > 0) fetchPositionsAndOrders();
          else renderPaneTradeLines(pane, true);
        }
      }
      [handle, pendLine.querySelector('.tpl-hit-bar')].filter(Boolean).forEach(el => {
        el.addEventListener('pointerdown', pStart);
        el.addEventListener('mousedown', pStart);
        el.addEventListener('touchstart', pStart, { passive: false });
      });

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'tpl-action-chip close-x';
      cancelBtn.textContent = '✕';
      cancelBtn.title = 'Cancel pending order';
      cancelBtn.addEventListener('click', async e => {
        e.stopPropagation();
        try {
          await api(`/api/orders/${po.id}/cancel?market=${encodeURIComponent(currentMarketMode)}`, { method: 'POST' });
          toast('✅ Pending order cancelled');
          fetchPositionsAndOrders();
        } catch (err) {
          toast(`❌ ${err.message}`);
        }
      });

      bg.appendChild(handle);
      bg.appendChild(cancelBtn);
      pendLine.appendChild(bg);
      overlay.appendChild(pendLine);
    });
  }

  function renderAllPaneTradeLines() {
    if (_isDraggingTradeLine) return;
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
    if (pane.idx === activePaneIdx) {
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

    if (pane.idx === activePaneIdx) {
      updateOrderFormPrices(ltp);
    }
    updateActivePanePnlBadges();
  }

  const _candleClientCache = new Map();

  function renderCandlesIntoPane(pane, data, reqId) {
    if (!pane || reqId !== pane._reqId) return;
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

    if (pane.idx === activePaneIdx) {
      const topSym = $('chart-active-sym');
      const topSeg = $('chart-active-seg');
      const opSym = $('op-sym-name');
      const opIcon = $('op-sym-icon');
      if (topSym) topSym.textContent = pane.sym;
      if (topSeg) topSeg.textContent = segLabel;
      if (opSym) opSym.textContent = pane.sym;
      if (opIcon) opIcon.innerHTML = getInstrumentIconHtml(pane.sym, 20);
      if (typeof updateLotDisplayFn === 'function') updateLotDisplayFn();
      syncTradeButtonsForActivePane();
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

    requestAnimationFrame(() => {
      if (!pane.chart || reqId !== pane._reqId) return;
      resizePaneChart(pane);
      try {
        pane.chart.priceScale('right').applyOptions({ autoScale: true });
        pane.chart.timeScale().fitContent();
        renderPaneTradeLines(pane);
      } catch (_) {}
    });

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
  }

  async function loadCandles(pane) {
    try {
      if (!pane) return;
      if (pane._abortCtrl) {
        try { pane._abortCtrl.abort(); } catch (_) {}
      }
      pane._abortCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      pane._reqId = (pane._reqId || 0) + 1;
      const reqId = pane._reqId;

      if (!pane.chart || !pane.candleSeries) {
        initChartPane(pane);
      }

      const tokenEnc = encodeURIComponent(pane.token || '');
      const symEnc = encodeURIComponent(pane.sym);
      const reqDays = Math.max(1, Math.min(Number(pane.rangeDays || 5), 365));
      const cacheKey = `${String(pane.sym || '').toUpperCase()}|${pane.tf}|${reqDays}`;
      const cached = _candleClientCache.get(cacheKey);
      if (cached && (Date.now() - cached.ts) < 3500) {
        renderCandlesIntoPane(pane, cached.data, reqId);
        return;
      }

      const url = `/api/chart/candles?symbol=${symEnc}&token=${tokenEnc}&interval=${encodeURIComponent(pane.tf)}&days=${reqDays}`;
      const data = await api(url, pane._abortCtrl ? { signal: pane._abortCtrl.signal } : {});
      if (reqId !== pane._reqId) return;
      if (data && data.ok && data.candles && data.candles.length) {
        _candleClientCache.set(cacheKey, { ts: Date.now(), data });
        if (_candleClientCache.size > 36) {
          const oldestKey = _candleClientCache.keys().next().value;
          _candleClientCache.delete(oldestKey);
        }
      }
      renderCandlesIntoPane(pane, data, reqId);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
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

  function getPriceTickStep(sym, ltp = 0) {
    const decs = getSymbolDecimals(sym);
    if (decs >= 4) return 0.0005;
    if (decs === 3) return 0.05;
    return Number(ltp || panes[0]?.lastLtp || 0) > 10000 ? 1.0 : 0.1;
  }

  function getNearestLimitPrice(sym, side, ltp) {
    const ref = Number(ltp || panes[0]?.lastLtp || 0);
    if (!(ref > 0)) return 0;
    const fx = getForexSpec(sym);
    const decs = fx ? fx.decimals : 2;
    const spread = fx ? fx.spread : ((ref * 0.0005) + 0.05);
    const offset = Math.max(spread * 0.75, getPriceTickStep(sym, ref));
    const raw = String(side || 'BUY').toUpperCase() === 'BUY'
      ? Math.max(decs >= 4 ? 0.0001 : 0.05, ref - offset)
      : ref + offset;
    return Number(raw.toFixed(decs));
  }

  function classifyPendingOrder(side, openPrice, ltp) {
    const s = String(side || 'BUY').toUpperCase();
    const p = Number(openPrice || 0);
    const cur = Number(ltp || 0);
    if (s === 'BUY') {
      if (cur > 0 && p > cur) {
        return { orderType: 'SL-M', kind: 'STOP', label: 'BUY STOP (SL-M)', shortLabel: 'Buy Stop', css: 'stop' };
      }
      return { orderType: 'L', kind: 'LIMIT', label: 'BUY LIMIT (L)', shortLabel: 'Buy Limit', css: 'limit' };
    }
    if (cur > 0 && p < cur) {
      return { orderType: 'SL-M', kind: 'STOP', label: 'SELL STOP (SL-M)', shortLabel: 'Sell Stop', css: 'stop' };
    }
    return { orderType: 'L', kind: 'LIMIT', label: 'SELL LIMIT (L)', shortLabel: 'Sell Limit', css: 'limit' };
  }

  function computeAuto2RSltp(pane, side, entryPrice) {
    const candles = (pane && pane.candles) || [];
    const entry = Number(entryPrice || 0);
    if (!candles.length || !(entry > 0)) return null;

    const sym = pane.sym || 'NIFTY';
    const decs = getSymbolDecimals(sym);
    const tick = getPriceTickStep(sym, entry);
    const prevCandle = candles.length >= 2 ? candles[candles.length - 2] : candles[0];
    const s = String(side || 'BUY').toUpperCase();
    let candSl = s === 'BUY' ? Number(prevCandle.low) : Number(prevCandle.high);
    let fallbackUsed = false;

    if (s === 'BUY' && !(candSl > 0 && candSl < entry)) {
      const earlier = candles.slice(-6, -1).reverse().find(c => Number(c.low) > 0 && Number(c.low) < entry);
      if (earlier) {
        candSl = Number(earlier.low);
      } else {
        const barSpan = Math.abs(Number(prevCandle.high || 0) - Number(prevCandle.low || 0));
        candSl = Math.max(decs >= 4 ? 0.0001 : 0.05, entry - Math.max(barSpan, tick * 4));
        fallbackUsed = true;
      }
    } else if (s === 'SELL' && !(candSl > entry)) {
      const earlier = candles.slice(-6, -1).reverse().find(c => Number(c.high) > entry);
      if (earlier) {
        candSl = Number(earlier.high);
      } else {
        const barSpan = Math.abs(Number(prevCandle.high || 0) - Number(prevCandle.low || 0));
        candSl = entry + Math.max(barSpan, tick * 4);
        fallbackUsed = true;
      }
    }

    const minStep = Math.pow(10, -decs);
    let sl = Number(candSl.toFixed(decs));
    if (Math.abs(entry - sl) < minStep) {
      sl = Number((s === 'BUY' ? Math.max(minStep, entry - minStep) : entry + minStep).toFixed(decs));
    }
    const risk = Math.abs(entry - sl);
    let tpRaw = s === 'BUY' ? entry + (2 * risk) : entry - (2 * risk);
    if (tpRaw <= 0) tpRaw = minStep;
    const tp = Number(tpRaw.toFixed(decs));
    return {
      sl,
      tp,
      risk: Number(risk.toFixed(decs)),
      prevLow: Number(prevCandle.low),
      prevHigh: Number(prevCandle.high),
      tf: pane.tf || '1m',
      fallbackUsed,
    };
  }

  function updateOrderFormPrices(ltp) {
    const activePane = getActivePane();
    const sym = activePane.sym;
    syncTradeButtonsForActivePane();
    if (!ltp) return;
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

    const limitInput = $('input-limit-price');
    if (limitInput && (!limitInput.value || limitInput.dataset.manual !== 'true')) {
      const nearest = getNearestLimitPrice(sym, 'BUY', ltp);
      limitInput.value = nearest.toFixed(decs);
    }
    const kindEl = $('op-pending-kind');
    if (kindEl && limitInput) {
      const val = parseFloat(limitInput.value) || ltp;
      const cls = classifyPendingOrder('BUY', val, ltp);
      kindEl.textContent = val === ltp ? 'Nearest Limit' : (cls.kind === 'STOP' ? 'Buy Stop / Sell Limit' : 'Buy Limit / Sell Stop');
      kindEl.className = `field-sub op-kind-pill ${cls.css}`;
    }

    const mSell = $('m-sell-price');
    const mBuy = $('m-buy-price');
    const mSpread = $('m-spread-val');
    const mMargin = $('m-margin-val');
    if (mSell) mSell.textContent = bidPrice.toFixed(decs);
    if (mBuy) mBuy.textContent = askPrice.toFixed(decs);
    if (mSpread) mSpread.textContent = spread.toFixed(decs);
    if (mMargin) mMargin.textContent = fmtMoney(estMargin, 2, sym);

    const owModal = $('order-window-modal');
    if (owModal && !owModal.classList.contains('hidden')) {
      const cs = curSym(sym);
      if ($('ow-ltp-val')) $('ow-ltp-val').textContent = `${cs}${ltp.toFixed(decs)}`;
      if ($('ow-spread-val')) $('ow-spread-val').textContent = spread.toFixed(decs);
    }
  }

  function setupOrderPanelInteractions() {
    let owSide = 'BUY';
    let owMode = 'MKT';

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

    // Helper: Execute unified Market or Pending Order (L / SL-M) + SL/TP
    async function executeUnifiedOrder({ side, orderMode, openPrice = null, slPrice = null, tpPrice = null, autoSltp = false, pane = null }) {
      const targetPane = pane || panes[activePaneIdx] || panes[0];
      const sym = targetPane.sym;
      const fx = getForexSpec(sym);
      const isFx = Boolean(fx) || currentMarketMode === 'forex';
      const lotSize = fx ? fx.qty_per_lot : getIndexLotSize(sym);
      const qty = Math.max(1, Math.round(selectedLots * lotSize));
      const meta = symbolMeta[String(sym || '').trim().toUpperCase()] || {};
      const isFo = Boolean(
        !isFx && (
          targetPane.isOption ||
          isOptionSymbol(sym) ||
          /\bFUT\b/i.test(sym) ||
          String(meta.segment || '').toUpperCase().includes('_FO')
        )
      );
      const seg = isFx ? 'forex' : (isFo ? 'nse_fo' : 'nse_cm');
      const ltp = Number(targetPane.lastLtp || 0);
      const decs = fx ? fx.decimals : 2;
      const cs = curSym(sym);

      let effType = 'MKT';
      let priceVal = null;
      let trigVal = null;

      if (orderMode === 'PENDING') {
        const effOpen = Number(openPrice || getNearestLimitPrice(sym, side, ltp));
        if (!(effOpen > 0)) {
          toast('❌ Order failed: Enter a valid pending price');
          return false;
        }
        const cls = classifyPendingOrder(side, effOpen, ltp);
        effType = cls.orderType;
        if (effType === 'SL-M') {
          trigVal = Number(effOpen.toFixed(decs));
        } else {
          priceVal = Number(effOpen.toFixed(decs));
        }
      }

      const cleanSl = slPrice && Number(slPrice) > 0 ? Number(Number(slPrice).toFixed(decs)) : null;
      const cleanTp = tpPrice && Number(tpPrice) > 0 ? Number(Number(tpPrice).toFixed(decs)) : null;

      const payload = {
        symbol: sym,
        exchange_segment: seg,
        side,
        lots: selectedLots,
        lot_size: lotSize,
        product: selectedProduct,
        order_type: effType,
        price: priceVal,
        trigger_price: trigVal,
        validity: 'DAY',
        user_confirmed: true,
        sl_price: cleanSl,
        tp_price: cleanTp,
        auto_sltp: Boolean(autoSltp),
      };

      const qtyLabel = isFx ? `${selectedLots} Lot(s) ${sym}` : (lotSize === 1 ? `${qty} share${qty > 1 ? 's' : ''}` : `${selectedLots} Lot(s) (${qty} qty)`);
      const typeTag = effType === 'MKT' ? 'Market' : (effType === 'SL-M' ? `${side} Stop @ ${cs}${(trigVal || 0).toFixed(decs)}` : `${side} Limit @ ${cs}${(priceVal || 0).toFixed(decs)}`);

      try {
        toast(`Submitting ${typeTag} (${qtyLabel})...`);
        const res = await api(`/api/orders?market=${encodeURIComponent(currentMarketMode)}`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });

        if (res.ok) {
          toast(`✅ ${res.message || `${typeTag} order placed!`}`);
          fetchPositionsAndOrders();
          return true;
        }
        toast(`❌ Order failed: ${res.detail || 'Rejection'}`);
        return false;
      } catch (err) {
        toast(`❌ Order failed: ${err.message}`);
        return false;
      }
    }

    // 2. Interactive Drag-and-Place Pending Order directly on Chart Canvas
    function stopChartPendingDrag(silent = false) {
      if (typeof _chartDragCancelFn === 'function') {
        const fn = _chartDragCancelFn;
        _chartDragCancelFn = null;
        fn(silent);
      }
    }

    function startChartPendingDrag(side, opts = {}) {
      stopChartPendingDrag(true);
      const pane = panes[activePaneIdx] || panes[0];
      if (isIndexSpotSymbol(pane.sym, pane.token)) {
        toast('Index spot cannot be bought or sold directly — choose an Option (CE/PE) or Stock');
        return;
      }
      const overlay = $(`p${pane.idx + 1}-trade-overlay`);
      if (!pane || !pane.canvasWrap || !pane.candleSeries || !overlay || !pane.candles.length) {
        toast('❌ Chart must finish loading before dragging an order');
        return;
      }

      const sym = pane.sym;
      const decs = getSymbolDecimals(sym);
      const cs = curSym(sym);
      const ltp = Number(pane.lastLtp || pane.candles[pane.candles.length - 1]?.close || 0);
      let currentPrice = Number(opts.initialPrice || getNearestLimitPrice(sym, side, ltp) || ltp);

      _isDraggingTradeLine = true;
      if (pane.chart) {
        try { pane.chart.applyOptions({ handleScroll: false, handleScale: false }); } catch (_) {}
      }

      const banner = document.createElement('div');
      banner.className = 'chart-drag-banner';
      banner.innerHTML = `<span>🎯 ${side}: Drag &amp; release on chart (Above = ${side === 'BUY' ? 'STOP' : 'LIMIT'} · Below = ${side === 'BUY' ? 'LIMIT' : 'STOP'})</span><button type="button" id="btn-cancel-chart-drag">Cancel</button>`;
      pane.canvasWrap.appendChild(banner);

      const draftLine = document.createElement('div');
      draftLine.className = 'trade-price-line tpl-pending-draft is-dragging';
      draftLine.innerHTML = '<div class="tpl-hit-bar"></div><div class="tpl-line"></div><div class="tpl-badge-group"><span class="tpl-drag-handle"></span></div>';
      overlay.appendChild(draftLine);

      const handleSpan = draftLine.querySelector('.tpl-drag-handle');
      const getClientY = ev => (ev.touches && ev.touches[0] ? ev.touches[0].clientY : (ev.changedTouches && ev.changedTouches[0] ? ev.changedTouches[0].clientY : ev.clientY));

      function renderDraftAtPrice(pVal) {
        const yRaw = pane.candleSeries.priceToCoordinate(pVal);
        const h = pane.canvasWrap.clientHeight || 280;
        const y = yRaw !== null && Number.isFinite(yRaw) ? Math.max(8, Math.min(h - 20, yRaw)) : h * 0.5;
        draftLine.style.top = `${y}px`;
        const liveLtp = Number(pane.lastLtp || ltp || pVal);
        const cls = classifyPendingOrder(side, pVal, liveLtp);
        draftLine.classList.toggle('is-stop', cls.kind === 'STOP');
        draftLine.classList.toggle('is-sell-limit', side === 'SELL' && cls.kind === 'LIMIT');
        if (handleSpan) handleSpan.textContent = `🎯 ${cls.label} @ ${cs}${pVal.toFixed(decs)}`;
      }
      renderDraftAtPrice(currentPrice);

      function updateFromClientY(clientY) {
        const rect = pane.canvasWrap.getBoundingClientRect();
        const y = Math.max(8, Math.min(rect.height - 20, clientY - rect.top));
        const pr = pane.candleSeries.coordinateToPrice(y);
        if (pr !== null && Number.isFinite(pr) && pr > 0) {
          currentPrice = Number(pr.toFixed(decs));
          draftLine.style.top = `${y}px`;
          const liveLtp = Number(pane.lastLtp || ltp || currentPrice);
          const cls = classifyPendingOrder(side, currentPrice, liveLtp);
          draftLine.classList.toggle('is-stop', cls.kind === 'STOP');
          draftLine.classList.toggle('is-sell-limit', side === 'SELL' && cls.kind === 'LIMIT');
          if (handleSpan) handleSpan.textContent = `🎯 ${cls.label} @ ${cs}${currentPrice.toFixed(decs)}`;
        }
      }

      let pointerEngaged = false;
      let finished = false;

      function cleanup(silent = false) {
        if (finished) return;
        finished = true;
        _isDraggingTradeLine = false;
        if (pane.chart) {
          try { pane.chart.applyOptions({ handleScroll: true, handleScale: true }); } catch (_) {}
        }
        pane.canvasWrap.removeEventListener('pointerdown', onDown, true);
        pane.canvasWrap.removeEventListener('mousedown', onDown, true);
        pane.canvasWrap.removeEventListener('touchstart', onDown, true);
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('touchmove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('mouseup', onUp, true);
        window.removeEventListener('touchend', onUp, true);
        window.removeEventListener('keydown', onKey);
        if (banner.parentNode) banner.remove();
        if (draftLine.parentNode) draftLine.remove();
        renderPaneTradeLines(pane, true);
        if (!silent) toast('Cancelled drag-to-place order');
      }
      _chartDragCancelFn = cleanup;

      function onDown(ev) {
        if (ev.target && ev.target.closest && ev.target.closest('#btn-cancel-chart-drag')) return;
        if (ev.button !== undefined && ev.button !== 0 && ev.type === 'mousedown') return;
        pointerEngaged = true;
        if (ev.cancelable) ev.preventDefault();
        ev.stopPropagation();
        updateFromClientY(getClientY(ev));
      }

      function onMove(ev) {
        const cy = getClientY(ev);
        if (!Number.isFinite(cy)) return;
        const rect = pane.canvasWrap.getBoundingClientRect();
        if (pointerEngaged || (cy >= rect.top && cy <= rect.bottom)) {
          if (pointerEngaged && ev.cancelable) ev.preventDefault();
          updateFromClientY(cy);
        }
      }

      async function onUp(ev) {
        if (!pointerEngaged) return;
        if (ev && ev.target && ev.target.closest && ev.target.closest('#btn-cancel-chart-drag')) return;
        const cy = getClientY(ev);
        if (Number.isFinite(cy)) updateFromClientY(cy);
        const dropPrice = currentPrice;
        cleanup(true);
        await executeUnifiedOrder({
          side,
          orderMode: 'PENDING',
          openPrice: dropPrice,
          slPrice: opts.slPrice || null,
          tpPrice: opts.tpPrice || null,
          autoSltp: Boolean(opts.autoSltp),
          pane,
        });
      }

      function onKey(ev) {
        if (ev.key === 'Escape') cleanup(false);
      }

      const cancelBtn = banner.querySelector('#btn-cancel-chart-drag');
      if (cancelBtn) cancelBtn.addEventListener('click', e => { e.stopPropagation(); cleanup(false); });

      pane.canvasWrap.addEventListener('pointerdown', onDown, true);
      pane.canvasWrap.addEventListener('mousedown', onDown, true);
      pane.canvasWrap.addEventListener('touchstart', onDown, { capture: true, passive: false });
      window.addEventListener('pointermove', onMove, { capture: true, passive: false });
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('touchmove', onMove, { capture: true, passive: false });
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('mouseup', onUp, true);
      window.addEventListener('touchend', onUp, true);
      window.addEventListener('keydown', onKey);
    }

    // 3. Synchronized Instant Toggle & Order Mode (Mobile + Desktop)
    const opInstantToggle = $('op-instant-toggle');
    const mInstantToggle = $('m-instant-toggle');
    const opTypeTabs = $('op-type-tabs');
    const opSltpCard = $('op-sltp-card');
    const opHint = $('op-instant-hint');
    const mPendControls = $('m-pending-controls');
    const mModeMkt = $('m-mode-mkt');
    const mModePend = $('m-mode-pend');
    const opChkSl = $('op-chk-sl');
    const opChkTp = $('op-chk-tp');
    const opSlInput = $('op-sl-input');
    const opTpInput = $('op-tp-input');

    function setOrderMode(mode) {
      const m = mode === 'PENDING' || mode === 'L' || mode === 'SL' ? 'PENDING' : 'MKT';
      selectedOrderType = instantExecution ? 'MKT' : m;

      document.querySelectorAll('.op-type-tab').forEach(t => {
        const tMode = t.dataset.type === 'MKT' ? 'MKT' : 'PENDING';
        t.classList.toggle('active', tMode === selectedOrderType);
      });
      if (mModeMkt) mModeMkt.classList.toggle('active', selectedOrderType === 'MKT');
      if (mModePend) mModePend.classList.toggle('active', selectedOrderType === 'PENDING');

      const fLimit = $('field-limit-price');
      if (fLimit) fLimit.classList.toggle('hidden', instantExecution || selectedOrderType !== 'PENDING');

      const isPend = !instantExecution && selectedOrderType === 'PENDING';
      if ($('lbl-sell-action')) $('lbl-sell-action').textContent = isPend ? 'Sell Pending' : 'Sell';
      if ($('lbl-buy-action')) $('lbl-buy-action').textContent = isPend ? 'Buy Pending' : 'Buy';
      if ($('m-sell-caption')) $('m-sell-caption').textContent = isPend ? 'Sell Pend' : 'Sell';
      if ($('m-buy-caption')) $('m-buy-caption').textContent = isPend ? 'Buy Pend' : 'Buy';
      if (panes[0].lastLtp) updateOrderFormPrices(panes[0].lastLtp);
    }

    function setInstantExecution(enabled) {
      instantExecution = Boolean(enabled);
      if (opInstantToggle) opInstantToggle.checked = instantExecution;
      if (mInstantToggle) mInstantToggle.checked = instantExecution;
      if (opTypeTabs) opTypeTabs.classList.toggle('hidden', instantExecution);
      if (opSltpCard) opSltpCard.classList.toggle('hidden', instantExecution);
      if (mPendControls) mPendControls.classList.toggle('hidden', instantExecution);
      if (opHint) opHint.textContent = instantExecution ? '1-click Market fill' : 'Market / Pending + SL/TP';
      if (instantExecution) stopChartPendingDrag(true);
      setOrderMode(instantExecution ? 'MKT' : selectedOrderType);
    }

    if (opInstantToggle) opInstantToggle.addEventListener('change', () => setInstantExecution(opInstantToggle.checked));
    if (mInstantToggle) mInstantToggle.addEventListener('change', () => setInstantExecution(mInstantToggle.checked));

    document.querySelectorAll('.op-type-tab').forEach(tab => {
      tab.addEventListener('click', () => setOrderMode(tab.dataset.type === 'MKT' ? 'MKT' : 'PENDING'));
    });
    if (mModeMkt) mModeMkt.addEventListener('click', () => setOrderMode('MKT'));
    if (mModePend) mModePend.addEventListener('click', () => setOrderMode('PENDING'));

    // Separate SL & TP toggles in Desktop Panel
    if (opChkSl && opSlInput) {
      opChkSl.addEventListener('change', () => { opSlInput.disabled = !opChkSl.checked; });
    }
    if (opChkTp && opTpInput) {
      opChkTp.addEventListener('change', () => { opTpInput.disabled = !opChkTp.checked; });
    }
    if ($('op-btn-auto-2r')) {
      $('op-btn-auto-2r').addEventListener('click', () => {
        const pane = panes[activePaneIdx] || panes[0];
        const ltp = Number(pane.lastLtp || 0);
        const entry = selectedOrderType === 'PENDING' ? (parseFloat($('input-limit-price')?.value) || ltp) : ltp;
        const auto = computeAuto2RSltp(pane, 'BUY', entry);
        if (!auto) { toast('Load chart candles first to compute Auto 2R'); return; }
        const decs = getSymbolDecimals(pane.sym);
        if (opChkSl && opSlInput) { opChkSl.checked = true; opSlInput.disabled = false; opSlInput.value = auto.sl.toFixed(decs); }
        if (opChkTp && opTpInput) { opChkTp.checked = true; opTpInput.disabled = false; opTpInput.value = auto.tp.toFixed(decs); }
        toast(`⚡ Auto SL (${auto.tf} prev low: ${auto.sl.toFixed(decs)}) · 2R TP: ${auto.tp.toFixed(decs)}`);
      });
    }

    // Drag-to-Place triggers from Desktop Panel & Mobile Dock
    function readPanelSltp() {
      const sl = opChkSl && opChkSl.checked ? parseFloat(opSlInput?.value || '') : null;
      const tp = opChkTp && opChkTp.checked ? parseFloat(opTpInput?.value || '') : null;
      return { slPrice: sl > 0 ? sl : null, tpPrice: tp > 0 ? tp : null };
    }
    if ($('op-btn-drag-buy')) $('op-btn-drag-buy').addEventListener('click', () => startChartPendingDrag('BUY', readPanelSltp()));
    if ($('op-btn-drag-sell')) $('op-btn-drag-sell').addEventListener('click', () => startChartPendingDrag('SELL', readPanelSltp()));
    if ($('m-btn-drag-buy')) $('m-btn-drag-buy').addEventListener('click', () => startChartPendingDrag('BUY', {}));
    if ($('m-btn-drag-sell')) $('m-btn-drag-sell').addEventListener('click', () => startChartPendingDrag('SELL', {}));

    // 4. Lots Stepper (Desktop Panel, Mobile Dock & Order Window synced)
    const inputLots = $('input-lots');
    const btnLotsMinus = $('btn-lots-minus');
    const btnLotsPlus = $('btn-lots-plus');
    const unitsSub = $('op-units-sub');
    const owLotsInput = $('ow-lots-input');

    function updateLotDisplay() {
      const ap = getActivePane();
      const sym = ap.sym;
      const fx = getForexSpec(sym);
      const isFx = Boolean(fx) || currentMarketMode === 'forex';
      if (inputLots) {
        inputLots.step = isFx ? '0.01' : '1';
        inputLots.min = isFx ? '0.01' : '1';
      }
      if (owLotsInput) {
        owLotsInput.step = isFx ? '0.01' : '1';
        owLotsInput.min = isFx ? '0.01' : '1';
      }
      if (isFx) {
        const parsed = parseFloat(inputLots ? inputLots.value : selectedLots);
        selectedLots = Number.isFinite(parsed) && parsed >= 0.01 ? Number(parsed.toFixed(2)) : 0.01;
      } else {
        selectedLots = Math.max(1, parseInt(inputLots ? inputLots.value : selectedLots) || 1);
      }
      if (inputLots) inputLots.value = selectedLots;
      if (owLotsInput) owLotsInput.value = selectedLots;

      const labelTxt = (() => {
        if (fx) {
          const effUnits = (selectedLots * Number(fx.lot_units || 1)).toFixed(fx.lot_units < 10 ? 2 : 0);
          return `${selectedLots} lot (Leverage 1:${fx.leverage}, ${effUnits} units)`;
        }
        const lotSize = getIndexLotSize(sym);
        const units = selectedLots * lotSize;
        return lotSize === 1 ? `${units} share${units > 1 ? 's' : ''}` : `${units} units (${selectedLots} Lot × ${lotSize})`;
      })();
      if (unitsSub) unitsSub.textContent = labelTxt;
      if ($('ow-units-sub')) $('ow-units-sub').textContent = labelTxt;
      if ($('m-lots-val')) $('m-lots-val').textContent = selectedLots;
      if (ap.lastLtp) updateOrderFormPrices(ap.lastLtp);
      else syncTradeButtonsForActivePane();
    }
    updateLotDisplayFn = updateLotDisplay;

    function adjustLots(deltaSign) {
      const ap = getActivePane();
      const isFx = isForexSym(ap.sym) || currentMarketMode === 'forex';
      const step = isFx ? 0.05 : 1;
      const minV = isFx ? 0.01 : 1;
      const next = Math.max(minV, Number((selectedLots + (deltaSign * step)).toFixed(2)));
      if (inputLots) inputLots.value = next;
      updateLotDisplay();
    }

    if (btnLotsMinus && btnLotsPlus && inputLots) {
      btnLotsMinus.addEventListener('click', () => adjustLots(-1));
      btnLotsPlus.addEventListener('click', () => adjustLots(1));
      inputLots.addEventListener('change', updateLotDisplay);
    }
    if ($('m-lots-minus')) $('m-lots-minus').addEventListener('click', () => adjustLots(-1));
    if ($('m-lots-plus')) $('m-lots-plus').addEventListener('click', () => adjustLots(1));

    // Desktop Pending Open Price stepper
    const btnPriceMinus = $('btn-price-minus');
    const btnPricePlus = $('btn-price-plus');
    const inputPrice = $('input-limit-price');
    if (btnPriceMinus && btnPricePlus && inputPrice) {
      const bump = sign => {
        const ap = getActivePane();
        const decs = getSymbolDecimals(ap.sym);
        const step = getPriceTickStep(ap.sym);
        const cur = parseFloat(inputPrice.value) || (ap.lastLtp || 40);
        inputPrice.value = Math.max(0.0001, cur + (sign * step)).toFixed(decs);
        inputPrice.dataset.manual = 'true';
        if (ap.lastLtp) updateOrderFormPrices(ap.lastLtp);
      };
      btnPriceMinus.addEventListener('click', () => bump(-1));
      btnPricePlus.addEventListener('click', () => bump(1));
      inputPrice.addEventListener('input', () => {
        inputPrice.dataset.manual = 'true';
        const ap = getActivePane();
        if (ap.lastLtp) updateOrderFormPrices(ap.lastLtp);
      });
    }

    // 5. Order Placement Window (Opened when Instant = OFF & Buy/Sell Clicked on Mobile or Desktop)
    const owModal = $('order-window-modal');
    const owPendingSec = $('ow-pending-section');
    const owPendingInput = $('ow-pending-price');
    const owPendingKind = $('ow-pending-kind');
    const owChkSl = $('ow-chk-sl');
    const owChkTp = $('ow-chk-tp');
    const owInputSl = $('ow-input-sl');
    const owInputTp = $('ow-input-tp');
    const owRrSummary = $('ow-rr-summary');

    function refreshOrderWindowSummary() {
      const pane = panes[activePaneIdx] || panes[0];
      const sym = pane.sym;
      const fx = getForexSpec(sym);
      const decs = fx ? fx.decimals : 2;
      const cs = curSym(sym);
      const ltp = Number(pane.lastLtp || 0);
      const spread = fx ? fx.spread : ((ltp * 0.0005) + 0.05);
      const marketExecPrice = owSide === 'BUY' ? (ltp + spread / 2) : Math.max(decs >= 4 ? 0.0001 : 0.05, ltp - spread / 2);
      const openP = owMode === 'PENDING' ? (parseFloat(owPendingInput?.value || '') || getNearestLimitPrice(sym, owSide, ltp)) : marketExecPrice;

      if (owPendingKind && owMode === 'PENDING') {
        const cls = classifyPendingOrder(owSide, openP, ltp);
        owPendingKind.textContent = cls.label;
        owPendingKind.className = `ow-kind-badge ${cls.css}`;
      }

      const slVal = owChkSl && owChkSl.checked ? parseFloat(owInputSl?.value || '') : 0;
      const tpVal = owChkTp && owChkTp.checked ? parseFloat(owInputTp?.value || '') : 0;
      const mult = fx ? Number(fx.multiplier || 1) : 1;
      const qty = fx ? Math.max(1, Math.round(selectedLots * fx.qty_per_lot)) : (selectedLots * getIndexLotSize(sym));
      const sign = owSide === 'BUY' ? 1 : -1;

      if ($('ow-sl-risk-txt')) {
        if (owChkSl?.checked && slVal > 0 && openP > 0) {
          const pnl = (slVal - openP) * qty * mult * sign;
          $('ow-sl-risk-txt').textContent = `${pnl >= 0 ? '+' : '-'}${cs}${Math.abs(pnl).toFixed(2)}`;
        } else {
          $('ow-sl-risk-txt').textContent = 'Off';
        }
      }
      if ($('ow-tp-reward-txt')) {
        if (owChkTp?.checked && tpVal > 0 && openP > 0) {
          const pnl = (tpVal - openP) * qty * mult * sign;
          $('ow-tp-reward-txt').textContent = `${pnl >= 0 ? '+' : '-'}${cs}${Math.abs(pnl).toFixed(2)}`;
        } else {
          $('ow-tp-reward-txt').textContent = 'Off';
        }
      }

      const btnConf = $('ow-btn-confirm');
      const confTitle = $('ow-confirm-title');
      const confSub = $('ow-confirm-sub');
      if (btnConf) btnConf.className = `ow-btn-confirm ${owSide.toLowerCase()}`;
      if (confTitle) {
        if (owMode === 'PENDING') {
          const cls = classifyPendingOrder(owSide, openP, ltp);
          confTitle.textContent = `Confirm ${cls.shortLabel}`;
        } else {
          confTitle.textContent = `Confirm ${owSide === 'BUY' ? 'Buy' : 'Sell'} Market`;
        }
      }
      if (confSub) {
        confSub.textContent = `${selectedLots} Lot${selectedLots !== 1 ? 's' : ''} @ ${cs}${openP.toFixed(decs)}`;
      }
    }

    function setOrderWindowMode(mode) {
      owMode = mode === 'PENDING' ? 'PENDING' : 'MKT';
      if ($('ow-tab-market')) $('ow-tab-market').classList.toggle('active', owMode === 'MKT');
      if ($('ow-tab-pending')) $('ow-tab-pending').classList.toggle('active', owMode === 'PENDING');
      if (owPendingSec) owPendingSec.classList.toggle('hidden', owMode !== 'PENDING');
      if (owMode === 'PENDING' && owPendingInput && !owPendingInput.dataset.manual) {
        const pane = panes[activePaneIdx] || panes[0];
        const decs = getSymbolDecimals(pane.sym);
        owPendingInput.value = getNearestLimitPrice(pane.sym, owSide, Number(pane.lastLtp || 0)).toFixed(decs);
      }
      refreshOrderWindowSummary();
    }

    function openOrderWindow(side) {
      if (!owModal) {
        executeUnifiedOrder({ side, orderMode: selectedOrderType });
        return;
      }
      closeAllOverlays('order-window-modal');
      owSide = side;
      const pane = panes[activePaneIdx] || panes[0];
      const sym = pane.sym;
      const decs = getSymbolDecimals(sym);
      const cs = curSym(sym);
      const ltp = Number(pane.lastLtp || 0);
      const fx = getForexSpec(sym);
      const spread = fx ? fx.spread : ((ltp * 0.0005) + 0.05);

      if ($('ow-side-pill')) {
        $('ow-side-pill').textContent = side;
        $('ow-side-pill').className = `ow-side-pill ${side.toLowerCase()}`;
      }
      if ($('ow-title')) $('ow-title').textContent = `${sym} Order Ticket`;
      if ($('ow-ltp-val')) $('ow-ltp-val').textContent = `${cs}${ltp.toFixed(decs)}`;
      if ($('ow-spread-val')) $('ow-spread-val').textContent = spread.toFixed(decs);

      if (owPendingInput) {
        delete owPendingInput.dataset.manual;
        owPendingInput.value = getNearestLimitPrice(sym, side, ltp).toFixed(decs);
      }
      if (owRrSummary) owRrSummary.classList.add('hidden');

      // Mirror Desktop panel SL/TP if checked
      if (owChkSl && owInputSl) {
        const hasDesktopSl = Boolean(opChkSl && opChkSl.checked && parseFloat(opSlInput?.value) > 0);
        owChkSl.checked = hasDesktopSl;
        owInputSl.disabled = !hasDesktopSl;
        owInputSl.value = hasDesktopSl ? opSlInput.value : '';
      }
      if (owChkTp && owInputTp) {
        const hasDesktopTp = Boolean(opChkTp && opChkTp.checked && parseFloat(opTpInput?.value) > 0);
        owChkTp.checked = hasDesktopTp;
        owInputTp.disabled = !hasDesktopTp;
        owInputTp.value = hasDesktopTp ? opTpInput.value : '';
      }

      updateLotDisplay();
      setOrderWindowMode(selectedOrderType === 'PENDING' ? 'PENDING' : 'MKT');
      owModal.classList.remove('hidden');
    }

    if ($('ow-tab-market')) $('ow-tab-market').addEventListener('click', () => setOrderWindowMode('MKT'));
    if ($('ow-tab-pending')) $('ow-tab-pending').addEventListener('click', () => setOrderWindowMode('PENDING'));
    if ($('btn-close-order-window')) $('btn-close-order-window').addEventListener('click', () => owModal && owModal.classList.add('hidden'));
    if ($('ow-btn-cancel')) $('ow-btn-cancel').addEventListener('click', () => owModal && owModal.classList.add('hidden'));
    if (owModal) {
      owModal.addEventListener('click', e => { if (e.target === owModal) owModal.classList.add('hidden'); });
    }

    if ($('ow-price-minus') && $('ow-price-plus') && owPendingInput) {
      const bumpOwPrice = sign => {
        const pane = panes[activePaneIdx] || panes[0];
        const decs = getSymbolDecimals(pane.sym);
        const step = getPriceTickStep(pane.sym);
        const cur = parseFloat(owPendingInput.value) || Number(pane.lastLtp || 1);
        owPendingInput.value = Math.max(0.0001, cur + (sign * step)).toFixed(decs);
        owPendingInput.dataset.manual = 'true';
        refreshOrderWindowSummary();
      };
      $('ow-price-minus').addEventListener('click', () => bumpOwPrice(-1));
      $('ow-price-plus').addEventListener('click', () => bumpOwPrice(1));
      owPendingInput.addEventListener('input', () => {
        owPendingInput.dataset.manual = 'true';
        refreshOrderWindowSummary();
      });
    }

    if ($('ow-lots-minus')) $('ow-lots-minus').addEventListener('click', () => { adjustLots(-1); refreshOrderWindowSummary(); });
    if ($('ow-lots-plus')) $('ow-lots-plus').addEventListener('click', () => { adjustLots(1); refreshOrderWindowSummary(); });
    if (owLotsInput) {
      owLotsInput.addEventListener('change', () => {
        if (inputLots) inputLots.value = owLotsInput.value;
        updateLotDisplay();
        refreshOrderWindowSummary();
      });
    }

    if (owChkSl && owInputSl) {
      owChkSl.addEventListener('change', () => {
        owInputSl.disabled = !owChkSl.checked;
        if (owChkSl.checked && !owInputSl.value) {
          const pane = panes[activePaneIdx] || panes[0];
          const decs = getSymbolDecimals(pane.sym);
          const ltp = Number(pane.lastLtp || 0);
          const entry = owMode === 'PENDING' ? (parseFloat(owPendingInput?.value) || ltp) : ltp;
          const auto = computeAuto2RSltp(pane, owSide, entry);
          if (auto) owInputSl.value = auto.sl.toFixed(decs);
        }
        refreshOrderWindowSummary();
      });
      owInputSl.addEventListener('input', refreshOrderWindowSummary);
    }

    if (owChkTp && owInputTp) {
      owChkTp.addEventListener('change', () => {
        owInputTp.disabled = !owChkTp.checked;
        if (owChkTp.checked && !owInputTp.value) {
          const pane = panes[activePaneIdx] || panes[0];
          const decs = getSymbolDecimals(pane.sym);
          const ltp = Number(pane.lastLtp || 0);
          const entry = owMode === 'PENDING' ? (parseFloat(owPendingInput?.value) || ltp) : ltp;
          const auto = computeAuto2RSltp(pane, owSide, entry);
          if (auto) owInputTp.value = auto.tp.toFixed(decs);
        }
        refreshOrderWindowSummary();
      });
      owInputTp.addEventListener('input', refreshOrderWindowSummary);
    }

    // ⚡ Auto Button: places SL at prev candle Low (BUY) / High (SELL) of current active TF & Target = 2x risk
    if ($('ow-btn-auto-2r')) {
      $('ow-btn-auto-2r').addEventListener('click', () => {
        const pane = panes[activePaneIdx] || panes[0];
        const sym = pane.sym;
        const decs = getSymbolDecimals(sym);
        const cs = curSym(sym);
        const ltp = Number(pane.lastLtp || 0);
        const fx = getForexSpec(sym);
        const spread = fx ? fx.spread : ((ltp * 0.0005) + 0.05);
        const mktEntry = owSide === 'BUY' ? (ltp + spread / 2) : Math.max(decs >= 4 ? 0.0001 : 0.05, ltp - spread / 2);
        const entry = owMode === 'PENDING' ? (parseFloat(owPendingInput?.value || '') || mktEntry) : mktEntry;

        const auto = computeAuto2RSltp(pane, owSide, entry);
        if (!auto) {
          toast('❌ Need loaded candles on active timeframe for Auto SL/TP');
          return;
        }
        if (owChkSl && owInputSl) {
          owChkSl.checked = true;
          owInputSl.disabled = false;
          owInputSl.value = auto.sl.toFixed(decs);
        }
        if (owChkTp && owInputTp) {
          owChkTp.checked = true;
          owInputTp.disabled = false;
          owInputTp.value = auto.tp.toFixed(decs);
        }
        if (opChkSl && opSlInput) { opChkSl.checked = true; opSlInput.disabled = false; opSlInput.value = auto.sl.toFixed(decs); }
        if (opChkTp && opTpInput) { opChkTp.checked = true; opTpInput.disabled = false; opTpInput.value = auto.tp.toFixed(decs); }

        if (owRrSummary) {
          owRrSummary.classList.remove('hidden');
          if ($('ow-rr-sl')) $('ow-rr-sl').textContent = `${cs}${auto.sl.toFixed(decs)}`;
          if ($('ow-rr-risk')) $('ow-rr-risk').textContent = `${cs}${auto.risk.toFixed(decs)}`;
          if ($('ow-rr-tp')) $('ow-rr-tp').textContent = `${cs}${auto.tp.toFixed(decs)}`;
        }
        refreshOrderWindowSummary();
        toast(`⚡ Auto (${auto.tf} prev ${owSide === 'BUY' ? 'low' : 'high'}): SL ${cs}${auto.sl.toFixed(decs)}, TP ${cs}${auto.tp.toFixed(decs)} (2R)`);
      });
    }

    if ($('ow-btn-drag-chart')) {
      $('ow-btn-drag-chart').addEventListener('click', () => {
        const slVal = owChkSl?.checked ? parseFloat(owInputSl?.value || '') : null;
        const tpVal = owChkTp?.checked ? parseFloat(owInputTp?.value || '') : null;
        const initP = parseFloat(owPendingInput?.value || '') || null;
        if (owModal) owModal.classList.add('hidden');
        startChartPendingDrag(owSide, {
          initialPrice: initP,
          slPrice: slVal > 0 ? slVal : null,
          tpPrice: tpVal > 0 ? tpVal : null,
          autoSltp: Boolean(owRrSummary && !owRrSummary.classList.contains('hidden')),
        });
      });
    }

    if ($('ow-btn-confirm')) {
      $('ow-btn-confirm').addEventListener('click', async () => {
        const openP = owMode === 'PENDING' ? parseFloat(owPendingInput?.value || '') : null;
        const slVal = owChkSl?.checked ? parseFloat(owInputSl?.value || '') : null;
        const tpVal = owChkTp?.checked ? parseFloat(owInputTp?.value || '') : null;
        const autoUsed = Boolean(owRrSummary && !owRrSummary.classList.contains('hidden'));
        const ok = await executeUnifiedOrder({
          side: owSide,
          orderMode: owMode,
          openPrice: openP,
          slPrice: slVal > 0 ? slVal : null,
          tpPrice: tpVal > 0 ? tpVal : null,
          autoSltp: autoUsed,
        });
        if (ok && owModal) owModal.classList.add('hidden');
      });
    }

    // Unified Buy/Sell button click: Index Spot guard -> Instant ON -> 1-click Market fill | Instant OFF -> Order Placement Window
    function handleTradeButtonClick(side) {
      const ap = getActivePane();
      if (isIndexSpotSymbol(ap.sym, ap.token)) {
        toast('Index spot cannot be bought or sold directly — choose an Option (CE/PE) or Stock');
        return;
      }
      if (instantExecution) {
        executeUnifiedOrder({ side, orderMode: 'MKT' });
      } else {
        openOrderWindow(side);
      }
    }

    if ($('m-btn-buy')) $('m-btn-buy').addEventListener('click', () => handleTradeButtonClick('BUY'));
    if ($('m-btn-sell')) $('m-btn-sell').addEventListener('click', () => handleTradeButtonClick('SELL'));
    if ($('btn-order-sell')) $('btn-order-sell').addEventListener('click', () => handleTradeButtonClick('SELL'));
    if ($('btn-order-buy')) $('btn-order-buy').addEventListener('click', () => handleTradeButtonClick('BUY'));

    // Initialize Instant toggle UI cleanly
    setInstantExecution(true);

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
        <span class="tab-icon">${getInstrumentIconHtml(tab.symbol, 16)}</span>
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
    const tf = pane.tf || '1m';
    document.querySelectorAll('.ex-tf-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tf === tf);
    });
    document.querySelectorAll('.tf-opt').forEach(b => {
      b.classList.toggle('active', b.dataset.tf === tf);
    });
    if ($('tf-picker-label')) {
      $('tf-picker-label').textContent = tf === '1d' ? '1D' : tf;
    }
    const rangeDaysMap = { '1d': 5, '5d': 7, '1m': 30, '3m': 90, '6m': 180, '1y': 365 };
    document.querySelectorAll('.range-btn').forEach(b => {
      b.classList.toggle('active', (rangeDaysMap[b.dataset.range] || 5) === (pane.rangeDays || 5));
    });
  }

  function selectPane(idx) {
    if (idx < 0 || idx >= panes.length) return;
    activePaneIdx = idx;
    document.querySelectorAll('.chart-pane').forEach((el, i) => {
      el.classList.toggle('active', i === idx);
    });
    const p = panes[idx];
    if (!p) return;

    const meta = symbolMeta[String(p.sym || '').trim().toUpperCase()] || {};
    const segUpper = String(meta.segment || '').toUpperCase();
    const isFx = isForexSym(p.sym) || segUpper === 'FOREX';
    const isOpt = !isFx && (p.isOption || isOptionSymbol(p.sym));
    const isFo = !isFx && Boolean(isOpt || /\bFUT\b/i.test(p.sym) || segUpper.includes('_FO'));
    const segLabel = isFx ? 'FOREX' : (isFo ? 'NSE F&O' : (isIndexSpotSymbol(p.sym, p.token) ? 'NSE INDEX' : 'NSE EQ'));

    if ($('chart-active-sym')) $('chart-active-sym').textContent = p.sym;
    if ($('chart-active-seg')) $('chart-active-seg').textContent = segLabel;
    if ($('op-sym-name')) $('op-sym-name').textContent = p.sym;
    if ($('op-sym-icon')) $('op-sym-icon').innerHTML = getInstrumentIconHtml(p.sym, 20);

    if (p.activeBar) {
      updatePaneHeaderQuote(p, p.activeBar.open, p.activeBar.high, p.activeBar.low, p.activeBar.close);
    } else if (p.candles && p.candles.length) {
      const lb = p.candles[p.candles.length - 1];
      updatePaneHeaderQuote(p, lb.open, lb.high, lb.low, lb.close);
    }

    syncToolbarForPane(p);
    if (typeof updateLotDisplayFn === 'function') updateLotDisplayFn();
    syncTradeButtonsForActivePane();
    if (p.lastLtp) updateOrderFormPrices(p.lastLtp);
    updateActivePanePnlBadges();
  }

  function ensureSecondaryPaneSymbols(reset = false) {
    const isFxMode = currentMarketMode === 'forex';
    const p1Upper = String(panes[0]?.sym || '').toUpperCase();

    const wantFx1 = isFxMode ? (normFxSym(p1Upper) === 'BTCUSD' ? 'XAUUSD' : 'BTCUSD') : 'BANKNIFTY';
    const tok1 = isFxMode ? `FOREX|${wantFx1}` : 'NSE_INDEX|Nifty Bank';
    const wantFx2 = isFxMode ? (normFxSym(p1Upper) === 'ETHUSD' ? 'EURUSD' : 'ETHUSD') : 'SENSEX';
    const tok2 = isFxMode ? `FOREX|${wantFx2}` : 'BSE_INDEX|SENSEX';

    if (reset || !panes[1]._userPicked || (isFxMode && !isForexSym(panes[1].sym)) || (!isFxMode && isForexSym(panes[1].sym))) {
      panes[1].sym = wantFx1;
      panes[1].token = tok1;
      panes[1].isOption = false;
      panes[1].lastLtp = null;
      panes[1].prevClose = null;
      if (!isFxMode && reset) panes[1]._userPicked = false;
      if ($('p2-sym')) $('p2-sym').textContent = panes[1].sym;
      if ($('p2-tf')) $('p2-tf').textContent = panes[1].tf;
      const s2 = $('pane-2')?.querySelector('.pane-seg');
      if (s2) s2.textContent = isFxMode ? 'FOREX' : 'NSE INDEX';
    }

    if (reset || !panes[2]._userPicked || (isFxMode && !isForexSym(panes[2].sym)) || (!isFxMode && isForexSym(panes[2].sym))) {
      panes[2].sym = wantFx2;
      panes[2].token = tok2;
      panes[2].isOption = false;
      panes[2].lastLtp = null;
      panes[2].prevClose = null;
      if (!isFxMode && reset) panes[2]._userPicked = false;
      if ($('p3-sym')) $('p3-sym').textContent = panes[2].sym;
      if ($('p3-tf')) $('p3-tf').textContent = panes[2].tf;
      const s3 = $('pane-3')?.querySelector('.pane-seg');
      if (s3) s3.textContent = isFxMode ? 'FOREX' : 'NSE INDEX';
    }
  }

  function openSymbolInPane(idx, cleanSym, token = '', lotSize = 0, segment = '') {
    const p = panes[idx];
    if (!p) return;
    if (lotSize || segment) registerSymbolMeta(cleanSym, { lotSize, segment });

    const segUpper = String(segment || '').toUpperCase();
    const isFx = isForexSym(cleanSym) || segUpper === 'FOREX';
    const isOpt = !isFx && isOptionSymbol(cleanSym);
    const isFo = !isFx && Boolean(isOpt || /\bFUT\b/i.test(cleanSym) || segUpper.includes('_FO'));
    const segLabel = isFx ? 'FOREX' : (isFo ? 'NSE F&O' : (isIndexSpotSymbol(cleanSym, token, segment) ? 'NSE INDEX' : 'NSE EQ'));

    p.sym = cleanSym;
    p.token = token || (isFx ? `FOREX|${normFxSym(cleanSym)}` : '');
    p.isOption = !isFx && (isOpt || segUpper === 'NSE_FO' || /\bFUT\b/i.test(cleanSym));
    p.lastLtp = null;
    p.prevClose = null;
    p._userPicked = true;
    clearPaneChartData(p);

    if (p.chart) {
      try { p.chart.priceScale('right').applyOptions({ autoScale: true }); } catch (_) {}
    }

    const pref = getPanePrefix(p);
    if ($(`${pref}-sym`)) $(`${pref}-sym`).textContent = p.sym;
    if ($(`${pref}-tf`)) $(`${pref}-tf`).textContent = p.tf;
    const pEl = $(p.id);
    const segBadge = pEl ? pEl.querySelector('.pane-seg') : null;
    if (segBadge) segBadge.textContent = segLabel;
    if ($(`${pref}-ltp`)) $(`${pref}-ltp`).textContent = '—';
    if ($(`${pref}-chg`)) {
      $(`${pref}-chg`).textContent = '—';
      $(`${pref}-chg`).className = 'pane-chg pos';
    }
    updatePaneHeaderQuote(p, 0, 0, 0, 0);

    selectPane(idx);

    const reqSym = p.sym;
    api(`/api/chart/live-quote?symbol=${encodeURIComponent(p.sym)}&token=${encodeURIComponent(p.token || '')}`)
      .then(q => {
        if (p.sym !== reqSym) return;
        if (q && q.ok && q.ltp && !q.is_fallback) {
          p.lastLtp = Number(q.ltp);
          if (q.prev_close) p.prevClose = Number(q.prev_close);
          updatePaneQuote(p, q);
        }
      })
      .catch(() => {});

    loadCandles(p);
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
    if ($('op-chk-sl')) $('op-chk-sl').checked = false;
    if ($('op-chk-tp')) $('op-chk-tp').checked = false;
    if ($('op-sl-input')) { $('op-sl-input').value = ''; $('op-sl-input').disabled = true; }
    if ($('op-tp-input')) { $('op-tp-input').value = ''; $('op-tp-input').disabled = true; }

    const opSym = $('op-sym-name');
    if (opSym) opSym.textContent = selected.symbol;
    const opIcon = $('op-sym-icon');
    if (opIcon) opIcon.innerHTML = getInstrumentIconHtml(selected.symbol, 20);

    syncToolbarForPane(panes[0]);

    if (!panes[0].chart) {
      initChartPane(panes[0]);
    }

    if (typeof updateLotDisplayFn === 'function') {
      updateLotDisplayFn();
    }
    syncTradeButtonsForActivePane();
    updateActivePanePnlBadges();

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

    // If multi-chart mode is active and user selected Pane 2 (or 3), load straight into that active pane!
    const effLay = window.innerWidth <= 768 ? Math.min(2, activeLayout) : activeLayout;
    if (effLay > 1 && activePaneIdx > 0 && activePaneIdx < effLay) {
      openSymbolInPane(activePaneIdx, cleanSym, token, lotSize, segment);
      return;
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
          <div style="display:flex;align-items:center;gap:9px;min-width:0;flex:1;">
            ${getInstrumentIconHtml(r.symbol, 22)}
            <div class="item-main">
              <b>${escapeHtml(r.symbol)}</b>
              ${hasSubName ? `<div class="ex-search-row-sub">${escapeHtml(r.name)}</div>` : ''}
            </div>
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

    function toggleWatchDrawer(forceOpen = null) {
      if (!leftPanel) return;
      if (forceOpen === true) leftPanel.classList.remove('collapsed');
      else if (forceOpen === false) leftPanel.classList.add('collapsed');
      else leftPanel.classList.toggle('collapsed');
      const isExpanded = !leftPanel.classList.contains('collapsed');
      if (railBtnInst) railBtnInst.classList.toggle('active', isExpanded);
      setTimeout(() => {
        panes.forEach(p => { if (p.chart) { resizePaneChart(p); renderPaneTradeLines(p); } });
      }, 240);
    }

    if (btnCollapse && leftPanel) {
      btnCollapse.addEventListener('click', () => toggleWatchDrawer(false));
    }

    if (railBtnInst && leftPanel) {
      railBtnInst.classList.toggle('active', !leftPanel.classList.contains('collapsed'));
      railBtnInst.addEventListener('click', () => toggleWatchDrawer());
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
                  <div style="display:flex;align-items:center;gap:9px;min-width:0;flex:1;">
                    ${getInstrumentIconHtml(r.symbol, 22)}
                    <div style="display:flex;flex-direction:column;min-width:0;flex:1;">
                      <b>${escapeHtml(r.symbol)}</b>
                      ${hasSubName ? `<span class="ex-search-row-sub">${escapeHtml(r.name)}</span>` : ''}
                    </div>
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
            ${getInstrumentIconHtml(inst.symbol, 22)}
            <div class="td-sym-text">
              <span class="sym-main">${escapeHtml(inst.symbol)}</span>
              <span class="sym-sub">${escapeHtml(inst.name)}</span>
            </div>
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

    const toggleDockBtn = $('btn-toggle-dock');
    const bottomPanel = $('ex-bottom-panel');

    function refitPanesAfterDockChange() {
      setTimeout(() => {
        panes.forEach(p => { if (p.chart) { resizePaneChart(p); renderPaneTradeLines(p); } });
      }, 220);
    }

    function setDockMinimized(minState) {
      if (!bottomPanel) return;
      bottomPanel.classList.toggle('minimized', Boolean(minState));
      if (toggleDockBtn) toggleDockBtn.textContent = bottomPanel.classList.contains('minimized') ? '+' : '−';
      refitPanesAfterDockChange();
    }

    function switchDockTab(tab, autoExpand = false) {
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
      if (autoExpand && bottomPanel && bottomPanel.classList.contains('minimized')) {
        setDockMinimized(false);
      }
    }

    if (btnOpen) btnOpen.addEventListener('click', () => switchDockTab('open', true));
    if (btnPending) btnPending.addEventListener('click', () => switchDockTab('pending', true));
    if (btnClosed) btnClosed.addEventListener('click', () => switchDockTab('closed', true));
    if (btnHistory) btnHistory.addEventListener('click', () => switchDockTab('history', true));

    // Toggle minimize (Default minimized '+' for max chart size; click '+' to expand, '−' to collapse)
    if (toggleDockBtn && bottomPanel) {
      toggleDockBtn.textContent = bottomPanel.classList.contains('minimized') ? '+' : '−';
      toggleDockBtn.addEventListener('click', () => {
        setDockMinimized(!bottomPanel.classList.contains('minimized'));
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
      cachedFunds = fundsData || {};
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
          closedTbody.innerHTML = '<tr><td colspan="10" class="empty-row">No closed positions recorded.</td></tr>';
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
            tr.className = 'closed-row-clickable';
            tr.title = 'Click anywhere on row to inspect FIFO fills, Fill IDs & Order IDs';
            tr.innerHTML = `
              <td><span class="closed-expand-chev">▸</span><b>${escapeHtml(sym)}</b></td>
              <td>${escapeHtml(cp.product || 'NRML')}</td>
              <td><span class="side-badge ${side.toLowerCase()}">${side}</span></td>
              <td>${qty}</td>
              <td>${pc}${avgBuy.toFixed(decs)}</td>
              <td>${pc}${avgSell.toFixed(decs)}</td>
              <td style="color: ${grossPnl >= 0 ? 'var(--bull)' : 'var(--bear)'}; font-weight:700;">
                ${grossPnl >= 0 ? '+' : ''}${pc}${grossPnl.toFixed(2)}
              </td>
              <td class="text-dim">${pc}${cpCharges.toFixed(2)}</td>
              <td>${escapeHtml(closedTime)}</td>
              <td class="col-frozen-pnl" style="color: ${isPos ? 'var(--bull)' : 'var(--bear)'}; font-weight:800;">
                ${isPos ? '+' : ''}${pc}${netPnl.toFixed(2)}
              </td>
            `;

            const detailTr = document.createElement('tr');
            detailTr.className = 'matches-details-row hidden';
            detailTr.id = `matches-row-${idx}`;
            const matches = cp.matches || [];
            let matchesHtml = '<div class="matches-nested-wrap"><h4>FIFO Execution Fills &amp; Traceability:</h4>';
            if (!matches.length) {
              matchesHtml += '<p style="color:var(--text-dim);font-size:11px;margin:0;">Single lot match executed directly.</p>';
            } else {
              matchesHtml += '<table style="width:100%;font-size:11px;border-collapse:collapse;"><thead><tr style="color:var(--text-dim);text-align:left;"><th>Fill ID (In ➔ Out)</th><th>Order ID (In ➔ Out)</th><th>Matched Qty</th><th>Buy Price</th><th>Sell Price</th><th>Gross P&amp;L</th><th>Matched At</th></tr></thead><tbody>';
              matches.forEach(m => {
                const mPnl = Number(m.gross_pnl || 0);
                const fillPair = `${escapeHtml(m.entry_fill_id || '—')} ➔ ${escapeHtml(m.exit_fill_id || '—')}`;
                const ordPair = `${escapeHtml(m.entry_order_id || '—')} ➔ ${escapeHtml(m.exit_order_id || '—')}`;
                matchesHtml += `<tr><td style="font-family:var(--font-mono);font-size:10.5px;">${fillPair}</td><td style="font-family:var(--font-mono);font-size:10.5px;">${ordPair}</td><td>${m.quantity}</td><td>${pc}${Number(m.buy_price).toFixed(decs)}</td><td>${pc}${Number(m.sell_price).toFixed(decs)}</td><td style="color:${mPnl >= 0 ? 'var(--bull)' : 'var(--bear)'};font-weight:700;">${mPnl >= 0 ? '+' : ''}${pc}${mPnl.toFixed(2)}</td><td>${m.matched_at ? m.matched_at.split('T')[1]?.slice(0, 8) || m.matched_at : 'Today'}</td></tr>`;
              });
              matchesHtml += '</tbody></table>';
            }
            matchesHtml += '</div>';
            detailTr.innerHTML = `<td colspan="10">${matchesHtml}</td>`;

            tr.addEventListener('click', () => {
              const isHidden = detailTr.classList.contains('hidden');
              detailTr.classList.toggle('hidden', !isHidden);
              const chev = tr.querySelector('.closed-expand-chev');
              if (chev) chev.textContent = isHidden ? '▾' : '▸';
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
      updateActivePanePnlBadges();

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
      if (currentMarketMode === 'forex') {
        toast('Option Chain is only available in Indian markets.');
        return;
      }
      closeAllOverlays('option-chain-modal');
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
    const ocRailBtn = $('rail-btn-option-chain');
    const ocModal = $('option-chain-modal');
    if (ocHeaderBtn) ocHeaderBtn.classList.toggle('hidden', clean === 'forex');
    if (ocRailBtn) ocRailBtn.classList.toggle('hidden', clean === 'forex');
    if (clean === 'forex' && ocModal) ocModal.classList.add('hidden');
    if ($('menu-wallet-section')) {
      $('menu-wallet-section').classList.toggle('hidden', !isAuthenticated || (isAdminUser && clean === 'indian'));
    }

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

    ensureSecondaryPaneSymbols(true);
    if (activeLayout >= 2 && panes[1].chart) loadCandles(panes[1]);
    if (activeLayout === 3 && panes[2].chart) loadCandles(panes[2]);
    syncTradeButtonsForActivePane();
    updateActivePanePnlBadges();

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
    const menuKotakBadge = $('menu-kotak-status-badge');
    const mKotakBadge = $('m-acc-badge-kotak');
    const modalKotakBanner = $('kotak-modal-status-banner');
    const modalKotakTxt = $('kotak-modal-status-text');
    const btnKotakDisc = $('btn-kotak-disconnect');

    document.body.classList.toggle('auth-locked', !(adminActive || isAuthenticated));

    // Strictly hide API token & Kotak Admin controls from non-admin users
    document.querySelectorAll('.admin-only-ctrl').forEach(el => {
      el.classList.toggle('hidden', !adminActive);
    });

    const walletSec = $('menu-wallet-section');
    if (walletSec) walletSec.classList.toggle('hidden', !(isAuthenticated && (!adminActive || currentMarketMode === 'forex')));
    if (adminActive) {
      const kText = kotakConnected ? '🟢 Kotak Neo: Authenticated (Live)' : '🔴 Kotak Neo: Not Authenticated';
      if (menuKotakBadge) {
        menuKotakBadge.textContent = kText;
        menuKotakBadge.className = `kotak-auth-pill admin-only-ctrl ${kotakConnected ? 'connected' : ''}`;
      }
      if (mKotakBadge) {
        mKotakBadge.textContent = kotakConnected ? 'Kotak: Authenticated' : 'Kotak: Not Auth';
        mKotakBadge.className = `m-acc-badge kotak-auth admin-only-ctrl ${kotakConnected ? 'connected' : ''}`;
      }
      if (modalKotakBanner) {
        modalKotakBanner.className = `kotak-status-banner ${kotakConnected ? 'connected' : 'disconnected'}`;
      }
      if (modalKotakTxt) modalKotakTxt.textContent = kText;
      if (btnKotakDisc) btnKotakDisc.classList.toggle('hidden', !kotakConnected);
    }

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
        closeAllOverlays('modal-market-choice');
        if (mktModal) mktModal.classList.remove('hidden');
      });
    }
  }

  function setupAdminModals() {
    const kotakModal = $('modal-kotak-connect');
    const btnOpenKotak = $('btn-open-owner-login');
    const btnCloseKotak = $('btn-close-kotak-modal');
    const btnCancelKotak = $('btn-cancel-kotak');
    const btnKotakDisc = $('btn-kotak-disconnect');
    const kotakForm = $('kotak-connect-form');
    const kotakErr = $('kotak-connect-error');

    async function openKotakModal() {
      if (!isAdminUser) {
        toast('Live Kotak Neo connection is restricted to Terminal Admin.');
        return;
      }
      closeAllOverlays('modal-kotak-connect');
      if (kotakErr) kotakErr.classList.add('hidden');
      if ($('input-kotak-totp')) $('input-kotak-totp').value = '';
      if ($('input-kotak-mpin-login')) $('input-kotak-mpin-login').value = '';
      if (kotakModal) kotakModal.classList.remove('hidden');
      try {
        const st = await api('/api/auth/session-status');
        const connected = Boolean(st && (st.broker_authenticated ?? st.kotak_connected));
        if (currentUser) currentUser.kotak_connected = connected;
        updateAuthModeUI(true, (currentUser && currentUser.username) || '', connected);
      } catch (_) {}
      const totpIn = $('input-kotak-totp');
      if (totpIn) setTimeout(() => totpIn.focus(), 80);
    }

    if (btnOpenKotak) btnOpenKotak.addEventListener('click', openKotakModal);
    if (btnCloseKotak) btnCloseKotak.addEventListener('click', () => kotakModal && kotakModal.classList.add('hidden'));
    if (btnCancelKotak) btnCancelKotak.addEventListener('click', () => kotakModal && kotakModal.classList.add('hidden'));
    if (btnKotakDisc) {
      btnKotakDisc.addEventListener('click', async () => {
        try {
          await api('/api/auth/logout', { method: 'POST', body: '{}' });
          if (currentUser) currentUser.kotak_connected = false;
          updateAuthModeUI(true, (currentUser && currentUser.username) || '', false);
          toast('Kotak Neo live session disconnected.');
          fetchPositionsAndOrders();
        } catch (err) {
          toast(`❌ ${err.message}`);
        }
      });
    }

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
      closeAllOverlays('modal-admin-analytics');
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
    const formForgot = $('auth-forgot-form');
    const signinErr = $('signin-error-msg');
    const signupErr = $('signup-error-msg');
    const forgotErr = $('forgot-error-msg');

    const accBtn = $('ex-account-btn');
    const accMenu = $('ex-account-menu');
    const btnLogout = $('btn-logout');
    const sessionTimerText = $('session-timer-text');

    let signupStage = 'details'; // 'details' | 'otp'
    let forgotStage = 'email';   // 'email' | 'otp'
    let resendCountdownTimer = null;
    const PENDING_OTP_KEY = 'neo_pending_otp_v1';

    function savePendingOtpState(data) {
      try {
        sessionStorage.setItem(PENDING_OTP_KEY, JSON.stringify({
          mode: data.mode,
          email: data.email || '',
          username: data.username || '',
          name: data.name || '',
          otpDraft: data.otpDraft || '',
          expiresAt: data.expiresAt || (Date.now() + 600000),
          resendUntil: data.resendUntil || (Date.now() + 30000),
        }));
      } catch (_) {}
    }

    function loadPendingOtpState() {
      try {
        const raw = sessionStorage.getItem(PENDING_OTP_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !parsed.email || !parsed.expiresAt || Date.now() >= Number(parsed.expiresAt)) {
          sessionStorage.removeItem(PENDING_OTP_KEY);
          return null;
        }
        return parsed;
      } catch (_) {
        return null;
      }
    }

    function updatePendingOtpDraft(draft) {
      const cur = loadPendingOtpState();
      if (!cur) return;
      savePendingOtpState({ ...cur, otpDraft: String(draft || '').slice(0, 6) });
    }

    function clearPendingOtpState() {
      try { sessionStorage.removeItem(PENDING_OTP_KEY); } catch (_) {}
    }

    const TRUSTED_DOMAINS = new Set([
      'gmail.com', 'googlemail.com',
      'outlook.com', 'outlook.in', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'live.in', 'msn.com',
      'yahoo.com', 'yahoo.in', 'yahoo.co.in', 'yahoo.co.uk', 'ymail.com', 'rocketmail.com',
      'icloud.com', 'me.com', 'mac.com',
      'proton.me', 'protonmail.com', 'pm.me',
      'tuta.io', 'tutanota.com', 'tuta.com',
      'zoho.com', 'zohomail.com', 'zohomail.in',
      'rediffmail.com', 'aol.com', 'gmx.com', 'gmx.net', 'mail.com', 'fastmail.com', 'hey.com',
    ]);
    const DISPOSABLE_DOMAINS = new Set([
      'mailinator.com', 'yopmail.com', 'yopmail.fr', 'tempmail.com', 'temp-mail.org', 'temp-mail.io',
      '10minutemail.com', '10minutemail.net', 'guerrillamail.com', 'guerrillamail.info', 'guerrillamailblock.com',
      'sharklasers.com', 'grr.la', 'trashmail.com', 'throwawaymail.com', 'maildrop.cc', 'getnada.com',
      'mohmal.com', 'dispostable.com', 'fakeinbox.com', 'mintemail.com', 'mailnesia.com', 'emailondeck.com',
      'mytemp.email', 'tempmailo.com', 'burnermail.io', 'inboxkitten.com', 'dropmail.me', 'harakirimail.com',
      'tmpmail.org', 'tmpmail.net', 'mailcatch.com', 'spambog.com', 'mail.tm', 'moakt.com',
      'trader.local', 'localhost', 'example.com', 'example.org', 'example.net', 'test.com', 'fake.com',
    ]);
    const TYPO_MAP = {
      'gmal.com': 'gmail.com', 'gmial.com': 'gmail.com', 'gamil.com': 'gmail.com',
      'gnail.com': 'gmail.com', 'gmail.con': 'gmail.com', 'yaho.com': 'yahoo.com',
      'yahooo.com': 'yahoo.com', 'hotmal.com': 'hotmail.com', 'outlok.com': 'outlook.com',
    };

    function validateTrustedEmailClient(raw) {
      const email = String(raw || '').trim().toLowerCase();
      if (!email || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@([a-z0-9-]+\.)+[a-z]{2,24}$/.test(email) || email.includes('..')) {
        return 'Please enter a valid email address (e.g. name@gmail.com).';
      }
      const dom = email.split('@')[1] || '';
      if (TYPO_MAP[dom]) return `Did you mean @${TYPO_MAP[dom]}? Please check your email domain.`;
      if (DISPOSABLE_DOMAINS.has(dom)) return 'Disposable or test emails are not allowed. Use a real trusted email (Gmail, Outlook, Yahoo, iCloud, Proton, Zoho).';
      const isEdu = ['.edu', '.edu.in', '.ac.in', '.ac.uk', '.edu.au'].some(s => dom.endsWith(s) && dom.length > s.length + 1);
      if (!TRUSTED_DOMAINS.has(dom) && !isEdu) {
        return 'Untrusted email domain. Only trusted providers (Gmail, Outlook, Yahoo, iCloud, Proton, Zoho, Rediffmail, .edu) are allowed.';
      }
      return '';
    }

    function setResendTimer(btn, sec = 30) {
      if (!btn) return;
      clearInterval(resendCountdownTimer);
      let left = Math.max(0, Math.ceil(Number(sec || 0)));
      if (left <= 0) {
        btn.disabled = false;
        btn.textContent = 'Resend Code';
        return;
      }
      btn.disabled = true;
      btn.textContent = `Resend in ${left}s`;
      resendCountdownTimer = setInterval(() => {
        left -= 1;
        if (left <= 0) {
          clearInterval(resendCountdownTimer);
          btn.disabled = false;
          btn.textContent = 'Resend Code';
        } else {
          btn.textContent = `Resend in ${left}s`;
        }
      }, 1000);
    }

    function setSignupStage(stage, preserveOtp = false) {
      signupStage = stage === 'otp' ? 'otp' : 'details';
      const isOtp = signupStage === 'otp';
      if ($('signup-details-wrap')) $('signup-details-wrap').classList.toggle('hidden', isOtp);
      if ($('signup-otp-step')) $('signup-otp-step').classList.toggle('hidden', !isOtp);
      if (signupErr) signupErr.classList.add('hidden');
      const btn = $('btn-signup-submit');
      if (btn) {
        btn.innerHTML = isOtp
          ? '<span>Verify &amp; Create Account</span><span class="btn-arrow">&rarr;</span>'
          : '<span>Send Verification Code</span><span class="btn-arrow">&rarr;</span>';
      }
      if (isOtp && $('signup-otp-input')) {
        if (!preserveOtp) $('signup-otp-input').value = '';
        setTimeout(() => $('signup-otp-input')?.focus(), 60);
      }
    }

    function setForgotStage(stage, preserveOtp = false) {
      forgotStage = stage === 'otp' ? 'otp' : 'email';
      const isOtp = forgotStage === 'otp';
      if ($('forgot-email-group')) $('forgot-email-group').classList.toggle('hidden', isOtp);
      if ($('forgot-otp-step')) $('forgot-otp-step').classList.toggle('hidden', !isOtp);
      if (forgotErr) forgotErr.classList.add('hidden');
      const btn = $('btn-forgot-submit');
      if (btn) {
        btn.innerHTML = isOtp
          ? '<span>Reset Password</span><span class="btn-arrow">&rarr;</span>'
          : '<span>Send Reset Code</span><span class="btn-arrow">&rarr;</span>';
      }
      if (isOtp && $('forgot-otp-input')) {
        if (!preserveOtp) $('forgot-otp-input').value = '';
        setTimeout(() => $('forgot-otp-input')?.focus(), 60);
      }
    }

    function switchAuthTab(mode, resetStages = true) {
      if (signinErr) signinErr.classList.add('hidden');
      if (signupErr) signupErr.classList.add('hidden');
      if (forgotErr) forgotErr.classList.add('hidden');
      const isSignup = mode === 'signup';
      const isForgot = mode === 'forgot';
      if (tabSignin) tabSignin.classList.toggle('active', !isSignup);
      if (tabSignup) tabSignup.classList.toggle('active', isSignup);
      if (formSignin) formSignin.classList.toggle('hidden', isSignup || isForgot);
      if (formSignup) formSignup.classList.toggle('hidden', !isSignup);
      if (formForgot) formForgot.classList.toggle('hidden', !isForgot);
      if (resetStages) {
        if (isSignup) setSignupStage('details');
        if (isForgot) setForgotStage('email');
      }
    }

    function restorePendingOtpUI() {
      const saved = loadPendingOtpState();
      if (!saved) return false;
      const remSec = Math.max(0, Math.ceil((Number(saved.resendUntil || 0) - Date.now()) / 1000));
      if (saved.mode === 'forgot') {
        if ($('forgot-email')) $('forgot-email').value = saved.email || '';
        if ($('forgot-otp-target')) $('forgot-otp-target').textContent = `Reset code sent to ${saved.email}`;
        if ($('forgot-otp-input')) $('forgot-otp-input').value = saved.otpDraft || '';
        switchAuthTab('forgot', false);
        setForgotStage('otp', true);
        if (remSec > 0) setResendTimer($('btn-resend-forgot-otp'), remSec);
        return true;
      }
      if (saved.mode === 'signup') {
        if ($('signup-email')) $('signup-email').value = saved.email || '';
        if ($('signup-userid')) $('signup-userid').value = saved.username || '';
        if ($('signup-otp-target')) $('signup-otp-target').textContent = `Code sent to ${saved.email}`;
        if ($('signup-otp-input')) $('signup-otp-input').value = saved.otpDraft || '';
        switchAuthTab('signup', false);
        setSignupStage('otp', true);
        if (remSec > 0) setResendTimer($('btn-resend-signup-otp'), remSec);
        return true;
      }
      return false;
    }

    if (tabSignin) tabSignin.addEventListener('click', () => { clearPendingOtpState(); switchAuthTab('signin'); });
    if (tabSignup) tabSignup.addEventListener('click', () => { clearPendingOtpState(); switchAuthTab('signup'); });
    if ($('btn-open-forgot')) $('btn-open-forgot').addEventListener('click', () => { clearPendingOtpState(); switchAuthTab('forgot'); });
    if ($('btn-back-to-signin')) $('btn-back-to-signin').addEventListener('click', () => { clearPendingOtpState(); switchAuthTab('signin'); });
    if ($('btn-edit-signup-email')) $('btn-edit-signup-email').addEventListener('click', () => { clearPendingOtpState(); setSignupStage('details'); });
    if ($('btn-edit-forgot-email')) $('btn-edit-forgot-email').addEventListener('click', () => { clearPendingOtpState(); setForgotStage('email'); });
    if ($('signup-otp-input')) $('signup-otp-input').addEventListener('input', e => updatePendingOtpDraft(e.target.value));
    if ($('forgot-otp-input')) $('forgot-otp-input').addEventListener('input', e => updatePendingOtpDraft(e.target.value));

    if (accBtn && accMenu) {
      accBtn.addEventListener('click', e => {
        e.stopPropagation();
        const willOpen = accMenu.classList.contains('hidden');
        closeAllOverlays(willOpen ? 'ex-account-menu' : null);
        accMenu.classList.toggle('hidden', !willOpen);
      });
      document.addEventListener('click', () => {
        accMenu.classList.add('hidden');
      });
    }

    async function handleLogout(msg = 'Signed out. Please sign in to continue.') {
      await api('/api/auth/owner-logout', { method: 'POST', body: '{}' }).catch(() => ({}));
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
      cachedPnlSummary = {};
      activeSltpRules = [];
      updateActivePanePnlBadges();
      closeAllOverlays('modal-gatekeeper');
      if (typeof window._switchMobileTabFn === 'function') {
        window._switchMobileTabFn('chart', true);
      } else {
        document.body.classList.remove('mobile-view-active');
        document.querySelectorAll('.mobile-screen-view').forEach(v => v.classList.add('hidden'));
      }
      if ($('open-positions-tbody')) $('open-positions-tbody').innerHTML = '<tr><td colspan="8" class="empty-row">Sign in required.</td></tr>';
      if ($('pending-orders-tbody')) $('pending-orders-tbody').innerHTML = '<tr><td colspan="8" class="empty-row">Sign in required.</td></tr>';
      if ($('closed-trades-tbody')) $('closed-trades-tbody').innerHTML = '<tr><td colspan="10" class="empty-row">Sign in required.</td></tr>';
      if ($('trade-history-tbody')) $('trade-history-tbody').innerHTML = '<tr><td colspan="10" class="empty-row">Sign in required.</td></tr>';
      if ($('m-orders-list')) $('m-orders-list').innerHTML = '';
      if ($('ex-acc-balance')) $('ex-acc-balance').textContent = '—';
      if ($('m-acc-balance')) $('m-acc-balance').textContent = '—';
      if ($('m-trade-pill-bal')) $('m-trade-pill-bal').textContent = '—';
      if ($('f-equity')) $('f-equity').textContent = '—';
      if ($('f-free-margin')) $('f-free-margin').textContent = '—';
      if ($('f-margin-used')) $('f-margin-used').textContent = '—';
      if ($('f-realized-pnl')) $('f-realized-pnl').textContent = '—';
      if ($('signin-password')) $('signin-password').value = '';
      if ($('signup-password')) $('signup-password').value = '';
      updateAuthModeUI(false, '');
      renderAllPaneTradeLines(true);
      if (gateModal) {
        clearPendingOtpState();
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
      const kotakUp = Boolean(res.broker_authenticated ?? res.kotak_connected);
      isAuthenticated = true;
      isAdminUser = Boolean(res.is_admin);
      isOwner = isAdminUser;
      currentUser = {
        username: res.username,
        is_admin: isAdminUser,
        market_mode: res.market_mode || '',
        kotak_connected: kotakUp,
      };
      recordUserActivity();
      clearPendingOtpState();
      closeAllOverlays();
      if (gateModal) gateModal.classList.add('hidden');

      if (!isAdminUser && !res.market_mode) {
        updateAuthModeUI(false, res.username, false);
        const mktModal = $('modal-market-choice');
        if (mktModal) mktModal.classList.remove('hidden');
      } else {
        const effMode = res.market_mode || 'indian';
        applyMarketModeUI(effMode, true);
        updateAuthModeUI(isAdminUser, res.username, kotakUp);
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

    if ($('btn-resend-signup-otp')) {
      $('btn-resend-signup-otp').addEventListener('click', async () => {
        const email = ($('signup-email')?.value || loadPendingOtpState()?.email || '').trim().toLowerCase();
        if (!email) return;
        try {
          await api('/api/auth/resend-otp', {
            method: 'POST',
            body: JSON.stringify({ email, purpose: 'signup' }),
          });
          const cur = loadPendingOtpState() || {};
          savePendingOtpState({ ...cur, mode: 'signup', email, username: cur.username || ($('signup-userid')?.value || '').trim(), expiresAt: Date.now() + 600000, resendUntil: Date.now() + 30000 });
          setResendTimer($('btn-resend-signup-otp'), 30);
          toast(`✅ New 6-digit code sent to ${email}. Check in SPAM if still not received.`);
        } catch (err) {
          if (signupErr) {
            signupErr.textContent = err.message;
            signupErr.classList.remove('hidden');
          }
        }
      });
    }

    if ($('btn-resend-forgot-otp')) {
      $('btn-resend-forgot-otp').addEventListener('click', async () => {
        const email = ($('forgot-email')?.value || loadPendingOtpState()?.email || '').trim().toLowerCase();
        if (!email) return;
        try {
          await api('/api/auth/resend-otp', {
            method: 'POST',
            body: JSON.stringify({ email, purpose: 'reset' }),
          });
          const cur = loadPendingOtpState() || {};
          savePendingOtpState({ ...cur, mode: 'forgot', email, expiresAt: Date.now() + 600000, resendUntil: Date.now() + 30000 });
          setResendTimer($('btn-resend-forgot-otp'), 30);
          toast(`✅ New reset code sent to ${email}. Check in SPAM if still not received.`);
        } catch (err) {
          if (forgotErr) {
            forgotErr.textContent = err.message;
            forgotErr.classList.remove('hidden');
          }
        }
      });
    }

    if (formSignup) {
      formSignup.addEventListener('submit', async e => {
        e.preventDefault();
        if (signupErr) signupErr.classList.add('hidden');
        const saved = loadPendingOtpState();
        const uid = (($('signup-userid')?.value || '') || (saved?.mode === 'signup' ? saved.username : '') || '').trim();
        const pwd = $('signup-password')?.value || '';
        const email = (($('signup-email')?.value || '') || (saved?.mode === 'signup' ? saved.email : '') || '').trim().toLowerCase();
        const otp = ($('signup-otp-input')?.value || '').trim();
        const btn = $('btn-signup-submit');

        try {
          if (signupStage === 'details') {
            const emailErr = validateTrustedEmailClient(email);
            if (emailErr) throw new Error(emailErr);
            if (!uid || uid.length < 3) throw new Error('Choose a valid User ID (minimum 3 characters).');
            if (!pwd || pwd.length < 4) throw new Error('Password must be at least 4 characters.');
            if (btn) { btn.disabled = true; btn.textContent = 'Sending Verification Code...'; }
            const res = await api('/api/auth/request-signup-otp', {
              method: 'POST',
              body: JSON.stringify({ username: uid, password: pwd, email }),
            });
            const finalEmail = res.email || email;
            savePendingOtpState({ mode: 'signup', email: finalEmail, username: res.username || uid, otpDraft: '', expiresAt: Date.now() + 600000, resendUntil: Date.now() + 30000 });
            if ($('signup-otp-target')) $('signup-otp-target').textContent = `Code sent to ${finalEmail}`;
            setSignupStage('otp');
            setResendTimer($('btn-resend-signup-otp'), 30);
            toast(`📧 6-digit verification code sent to ${finalEmail}. Check in SPAM if still not received.`);
          } else {
            if (!/^\d{6}$/.test(otp)) throw new Error('Enter the 6-digit verification code from your email.');
            if (btn) { btn.disabled = true; btn.textContent = 'Verifying Email...'; }
            const res = await api('/api/auth/signup', {
              method: 'POST',
              body: JSON.stringify({ username: uid, password: pwd, email, otp }),
            });
            if (res && res.ok) {
              clearPendingOtpState();
              if ($('signup-password')) $('signup-password').value = '';
              if ($('signup-otp-input')) $('signup-otp-input').value = '';
              onAuthenticatedSuccess(res);
              toast('✅ Email verified & account created! Choose Forex or Indian markets.');
            }
          }
        } catch (err) {
          if (signupErr) {
            signupErr.textContent = err.message;
            signupErr.classList.remove('hidden');
          }
        } finally {
          if (btn) {
            btn.disabled = false;
            btn.innerHTML = signupStage === 'otp'
              ? '<span>Verify &amp; Create Account</span><span class="btn-arrow">&rarr;</span>'
              : '<span>Send Verification Code</span><span class="btn-arrow">&rarr;</span>';
          }
        }
      });
    }

    if (formForgot) {
      formForgot.addEventListener('submit', async e => {
        e.preventDefault();
        if (forgotErr) forgotErr.classList.add('hidden');
        const saved = loadPendingOtpState();
        const email = (($('forgot-email')?.value || '') || (saved?.mode === 'forgot' ? saved.email : '') || '').trim().toLowerCase();
        const otp = ($('forgot-otp-input')?.value || '').trim();
        const newPw = $('forgot-newpass')?.value || '';
        const btn = $('btn-forgot-submit');

        try {
          if (forgotStage === 'email') {
            const emailErr = validateTrustedEmailClient(email);
            if (emailErr) throw new Error(emailErr);
            if (btn) { btn.disabled = true; btn.textContent = 'Sending Reset Code...'; }
            await api('/api/auth/forgot-password', {
              method: 'POST',
              body: JSON.stringify({ email }),
            });
            savePendingOtpState({ mode: 'forgot', email, otpDraft: '', expiresAt: Date.now() + 600000, resendUntil: Date.now() + 30000 });
            if ($('forgot-otp-target')) $('forgot-otp-target').textContent = `Reset code sent to ${email}`;
            setForgotStage('otp');
            setResendTimer($('btn-resend-forgot-otp'), 30);
            toast(`📧 Reset code sent to ${email}. Check in SPAM if still not received.`);
          } else {
            if (!/^\d{6}$/.test(otp)) throw new Error('Enter the 6-digit reset code from your email.');
            if (!newPw || newPw.length < 4) throw new Error('New password must be at least 4 characters.');
            if (btn) { btn.disabled = true; btn.textContent = 'Resetting Password...'; }
            await api('/api/auth/reset-password', {
              method: 'POST',
              body: JSON.stringify({ email, otp, new_password: newPw }),
            });
            clearPendingOtpState();
            if ($('forgot-otp-input')) $('forgot-otp-input').value = '';
            if ($('forgot-newpass')) $('forgot-newpass').value = '';
            switchAuthTab('signin');
            toast('✅ Password reset! Sign in with your new password.');
          }
        } catch (err) {
          if (forgotErr) {
            forgotErr.textContent = err.message;
            forgotErr.classList.remove('hidden');
          }
        } finally {
          if (btn) {
            btn.disabled = false;
            btn.innerHTML = forgotStage === 'otp'
              ? '<span>Reset Password</span><span class="btn-arrow">&rarr;</span>'
              : '<span>Send Reset Code</span><span class="btn-arrow">&rarr;</span>';
          }
        }
      });
    }

    async function checkSession() {
      try {
        const st = await api('/api/auth/session-status');
        if (st && st.authenticated) {
          const kotakUp = Boolean(st.broker_authenticated ?? st.kotak_connected);
          isAuthenticated = true;
          isAdminUser = Boolean(st.is_admin);
          isOwner = isAdminUser;
          currentUser = { ...st, kotak_connected: kotakUp };
          if (gateModal) gateModal.classList.add('hidden');

          if (!isAdminUser && !st.market_mode) {
            updateAuthModeUI(false, st.username, false);
            const mktModal = $('modal-market-choice');
            if (mktModal) mktModal.classList.remove('hidden');
          } else {
            const effMode = st.market_mode || 'indian';
            applyMarketModeUI(effMode, true);
            updateAuthModeUI(isAdminUser, st.username, kotakUp);
            fetchPositionsAndOrders();
          }
        } else {
          isAuthenticated = false;
          isAdminUser = false;
          isOwner = false;
          currentUser = null;
          updateAuthModeUI(false, '');
          if (gateModal) {
            if (!restorePendingOtpUI()) {
              switchAuthTab('signin');
            }
            gateModal.classList.remove('hidden');
          }
        }
      } catch (e) {
        updateAuthModeUI(false, '');
        if (gateModal) {
          restorePendingOtpUI();
          gateModal.classList.remove('hidden');
        }
      }
    }

    async function lightweightSyncSession() {
      ownerToken = localStorage.getItem('neo_owner_token') || '';
      try {
        const st = await api('/api/auth/session-status');
        if (!st || !st.authenticated) {
          if (isAuthenticated) handleLogout('Session signed out. Please sign in to continue.');
          // Never call checkSession()/switchAuthTab('signin') when already unauthenticated —
          // switching browser <-> Gmail to read an OTP must keep the active OTP view intact!
          return;
        }
        if (!isAuthenticated || !currentUser || currentUser.username !== st.username) {
          checkSession();
          return;
        }
        const kotakUp = Boolean(st.broker_authenticated ?? st.kotak_connected);
        if (currentUser.kotak_connected !== kotakUp) {
          currentUser.kotak_connected = kotakUp;
          updateAuthModeUI(isAdminUser, st.username, kotakUp);
          fetchPositionsAndOrders();
        }
      } catch (_) {}
    }

    // Cross-tab & cross-page session synchronization (/ <-> /chart)
    window.addEventListener('storage', (ev) => {
      if (ev.key === 'neo_owner_token') lightweightSyncSession();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') lightweightSyncSession();
    });

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
      closeAllOverlays('modal-setup-guide');
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

  // --- Paper Wallet Deposit / Withdraw Modal (Desktop & Mobile) ---
  function setupPaperWalletModal() {
    const modal = $('modal-paper-wallet');
    const tabDep = $('wallet-tab-deposit');
    const tabWdr = $('wallet-tab-withdraw');
    const amtInput = $('wallet-amount-input');
    const lblEl = $('wallet-amount-label');
    const hintEl = $('wallet-mode-hint');
    const chipsEl = $('wallet-quick-chips');
    const errEl = $('wallet-error-msg');
    const btnWithdrawAll = $('btn-wallet-withdraw-all');
    const btnSubmit = $('btn-wallet-submit');
    const curBalEl = $('wallet-cur-balance');
    const freeMarEl = $('wallet-free-margin');
    const mktPill = $('wallet-market-pill');

    let walletMode = 'deposit';

    function renderChips() {
      if (!chipsEl) return;
      const isFx = currentMarketMode === 'forex';
      const cs = isFx ? '$' : '₹';
      const vals = isFx ? [500, 1000, 5000, 10000] : [10000, 50000, 100000, 500000];
      chipsEl.innerHTML = '';
      vals.forEach(v => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'wallet-chip-btn';
        b.textContent = `${walletMode === 'deposit' ? '+' : '−'}${cs}${v.toLocaleString('en-IN')}`;
        b.addEventListener('click', () => {
          if (amtInput) {
            amtInput.value = String(v);
            amtInput.focus();
          }
        });
        chipsEl.appendChild(b);
      });
    }

    function syncWalletHeaderStats() {
      const isFx = currentMarketMode === 'forex';
      if (mktPill) mktPill.textContent = isFx ? 'FOREX · USD' : 'INDIAN · INR';
      const rawBal = cachedFunds && cachedFunds.balance !== undefined
        ? Number(cachedFunds.balance)
        : (cachedFunds && cachedFunds.total_equity !== undefined ? Number(cachedFunds.total_equity) : 0);
      const rawAvail = cachedFunds && cachedFunds.available_margin !== undefined
        ? Number(cachedFunds.available_margin)
        : rawBal;
      if (curBalEl) curBalEl.textContent = fmtMoney(Math.max(0, rawBal));
      if (freeMarEl) freeMarEl.textContent = fmtMoney(Math.max(0, rawAvail));
      if (btnWithdrawAll) btnWithdrawAll.textContent = `Withdraw All (${fmtMoney(0)})`;
    }

    function setWalletMode(mode) {
      walletMode = mode === 'withdraw' ? 'withdraw' : 'deposit';
      const isW = walletMode === 'withdraw';
      if (tabDep) tabDep.classList.toggle('active', !isW);
      if (tabWdr) tabWdr.classList.toggle('active', isW);
      if (btnWithdrawAll) btnWithdrawAll.classList.toggle('hidden', !isW);
      if (btnSubmit) {
        btnSubmit.classList.toggle('is-withdraw', isW);
        btnSubmit.textContent = isW ? '➖ Withdraw Funds' : '➕ Deposit Funds';
      }
      if (lblEl) {
        lblEl.textContent = isW
          ? 'Amount to Withdraw (Subtracts down to 0)'
          : 'Amount to Deposit (Virtual Paper Funds)';
      }
      if (hintEl) {
        hintEl.textContent = isW
          ? 'Enter any amount — subtracts from your paper balance down to 0, or tap Withdraw All.'
          : 'Add any virtual amount to your active paper account balance.';
      }
      if (errEl) errEl.classList.add('hidden');
      renderChips();
    }

    function openWalletModal(initialMode = 'deposit') {
      if (!isAuthenticated) {
        const gm = $('modal-gatekeeper');
        if (gm) gm.classList.remove('hidden');
        return;
      }
      if (isAdminUser && currentMarketMode === 'indian') {
        toast('💡 Admin Indian mode uses Kotak Neo live funds. Switch to Forex to manage virtual paper funds.');
        return;
      }
      closeAllOverlays('modal-paper-wallet');
      syncWalletHeaderStats();
      setWalletMode(initialMode);
      if (amtInput) amtInput.value = '';
      if (modal) modal.classList.remove('hidden');
      setTimeout(() => amtInput?.focus(), 60);
    }

    async function submitWalletAdjust(action, amountVal) {
      if (errEl) errEl.classList.add('hidden');
      try {
        if (btnSubmit) btnSubmit.disabled = true;
        if (btnWithdrawAll) btnWithdrawAll.disabled = true;
        const res = await api('/api/paper-wallet/adjust', {
          method: 'POST',
          body: JSON.stringify({
            action,
            amount: amountVal || 0,
            market: currentMarketMode,
          }),
        });
        cachedFunds = res || cachedFunds;
        syncWalletHeaderStats();
        const avail = Number(res.available_margin !== undefined ? res.available_margin : res.balance || 0);
        const eq = Number(res.total_equity !== undefined ? res.total_equity : res.balance || 0);
        if ($('ex-acc-balance')) $('ex-acc-balance').textContent = fmtMoney(avail);
        if ($('f-equity')) $('f-equity').textContent = fmtMoney(eq);
        if ($('f-free-margin')) $('f-free-margin').textContent = fmtMoney(avail);
        if (typeof updateMobileOrdersFn === 'function') updateMobileOrdersFn();
        if (modal) modal.classList.add('hidden');
        fetchPositionsAndOrders();
        const label = action === 'withdraw_all'
          ? `✅ Withdrew all paper funds — balance is now ${fmtMoney(0)}`
          : (action === 'withdraw'
            ? `✅ Withdrew funds — remaining balance ${fmtMoney(Number(res.balance || 0))}`
            : `✅ Deposited ${fmtMoney(amountVal)} — new balance ${fmtMoney(Number(res.balance || 0))}`);
        toast(label);
      } catch (e) {
        if (errEl) {
          errEl.textContent = e.message;
          errEl.classList.remove('hidden');
        }
      } finally {
        if (btnSubmit) btnSubmit.disabled = false;
        if (btnWithdrawAll) btnWithdrawAll.disabled = false;
      }
    }

    window._openPaperWalletFn = openWalletModal;
    if ($('btn-menu-deposit-funds')) $('btn-menu-deposit-funds').addEventListener('click', () => openWalletModal('deposit'));
    if ($('btn-menu-withdraw-funds')) $('btn-menu-withdraw-funds').addEventListener('click', () => openWalletModal('withdraw'));
    if ($('btn-close-wallet-modal')) $('btn-close-wallet-modal').addEventListener('click', () => modal && modal.classList.add('hidden'));
    if (modal) modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });
    if (tabDep) tabDep.addEventListener('click', () => setWalletMode('deposit'));
    if (tabWdr) tabWdr.addEventListener('click', () => setWalletMode('withdraw'));
    if (btnWithdrawAll) {
      btnWithdrawAll.addEventListener('click', () => submitWalletAdjust('withdraw_all', 0));
    }
    if (btnSubmit) {
      btnSubmit.addEventListener('click', () => {
        const val = parseFloat(amtInput?.value || '');
        if (!Number.isFinite(val) || val <= 0) {
          if (errEl) {
            errEl.textContent = 'Enter an amount greater than 0.';
            errEl.classList.remove('hidden');
          }
          return;
        }
        submitWalletAdjust(walletMode, val);
      });
    }
  }

  // --- Educational Purpose & Regulatory Laws Disclaimer Modal ---
  function setupLegalModal() {
    const modal = $('modal-legal-disclaimer');
    const closeBtn = $('btn-close-legal');
    const ackBtn = $('btn-legal-ack');
    const openGuideBtn = $('btn-legal-open-guide');

    function openLegal(e) {
      if (e) e.stopPropagation();
      closeAllOverlays('modal-legal-disclaimer');
      if (modal) modal.classList.remove('hidden');
    }
    function closeLegal() {
      if (modal) modal.classList.add('hidden');
    }

    window._openLegalModalFn = openLegal;
    if ($('btn-legal-disclaimer')) $('btn-legal-disclaimer').addEventListener('click', openLegal);
    if ($('btn-menu-legal')) $('btn-menu-legal').addEventListener('click', openLegal);
    if ($('btn-gatekeeper-legal')) $('btn-gatekeeper-legal').addEventListener('click', openLegal);
    if (closeBtn) closeBtn.addEventListener('click', closeLegal);
    if (ackBtn) ackBtn.addEventListener('click', closeLegal);
    if (modal) modal.addEventListener('click', e => { if (e.target === modal) closeLegal(); });
    if (openGuideBtn) {
      openGuideBtn.addEventListener('click', () => {
        closeAllOverlays('modal-setup-guide');
        if ($('modal-setup-guide')) $('modal-setup-guide').classList.remove('hidden');
      });
    }
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
      if (window.innerWidth <= 768 && activeLayout > 2 && typeof window._applyChartLayoutFn === 'function') {
        window._applyChartLayoutFn(2);
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

    // Active pane selection (in 2 or 3 chart split layout — captures clicks & taps even on canvas!)
    document.querySelectorAll('.chart-pane').forEach((paneEl, idx) => {
      paneEl.addEventListener('pointerdown', () => {
        if (activePaneIdx !== idx) selectPane(idx);
      }, true);
      paneEl.addEventListener('click', () => {
        if (activePaneIdx !== idx) selectPane(idx);
      });
    });

    // Fast Shared Timeframe Switcher (Toolbar Pills + Dropdown Picker)
    function applyTimeframe(tf) {
      if (!tf) return;
      const targetPane = panes[activePaneIdx] || panes[0];
      targetPane.tf = tf;
      if (targetPane.idx === 0 && openTabs[activeTabIndex]) {
        openTabs[activeTabIndex].interval = tf;
        saveActiveTabSession(openTabs[activeTabIndex]);
      }
      if ($(`${getPanePrefix(targetPane)}-tf`)) {
        $(`${getPanePrefix(targetPane)}-tf`).textContent = tf;
      }
      syncToolbarForPane(targetPane);
      if (typeof window._updateCountdownsFn === 'function') window._updateCountdownsFn();
      loadCandles(targetPane);
    }

    document.querySelectorAll('.ex-tf-btn').forEach(tfBtn => {
      tfBtn.addEventListener('click', () => applyTimeframe(tfBtn.dataset.tf));
    });

    const tfPickerBtn = $('btn-tf-picker');
    const tfDropMenu = $('tf-dropdown-menu');
    if (tfPickerBtn && tfDropMenu) {
      tfPickerBtn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        const isHidden = tfDropMenu.classList.contains('hidden');
        if (isHidden) {
          const rect = tfPickerBtn.getBoundingClientRect();
          tfDropMenu.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 190)}px`;
          tfDropMenu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 135))}px`;
          tfDropMenu.classList.remove('hidden');
        } else {
          tfDropMenu.classList.add('hidden');
        }
      });
      tfDropMenu.querySelectorAll('.tf-opt').forEach(opt => {
        opt.addEventListener('click', e => {
          e.stopPropagation();
          applyTimeframe(opt.dataset.tf);
          tfDropMenu.classList.add('hidden');
        });
      });
      document.addEventListener('click', e => {
        if (!tfDropMenu.contains(e.target) && e.target !== tfPickerBtn && !tfPickerBtn.contains(e.target)) {
          tfDropMenu.classList.add('hidden');
        }
      });
    }

    // Timezone Toggle Button (UTC+5:30 IST default <-> UTC+0)
    const tzBtn = $('btn-tz-toggle');
    if (tzBtn) {
      updateTzBadgeUI();
      tzBtn.addEventListener('click', () => {
        activeTimeZone = activeTimeZone === 'Asia/Kolkata' ? 'UTC' : 'Asia/Kolkata';
        localStorage.setItem('neo_chart_tz', activeTimeZone);
        refreshAllPaneTimezones();
        toast(`Chart X-Axis Timezone: ${activeTimeZone === 'Asia/Kolkata' ? 'UTC+5:30 (IST)' : 'UTC+0 (GMT)'}`);
      });
    }

    // Close active chart individual position button beside Running P&L pill
    const closeActivePosBtn = $('btn-close-active-pos');
    if (closeActivePosBtn) {
      closeActivePosBtn.addEventListener('click', async e => {
        e.stopPropagation();
        const ap = getActivePane();
        if (!ap || !ap.sym) return;
        try {
          toast(`Exiting ${ap.sym} position...`);
          const res = await api(`/api/positions/${encodeURIComponent(ap.sym)}/exit?market=${encodeURIComponent(currentMarketMode)}`, {
            method: 'POST',
            body: JSON.stringify({ percentage: 100 }),
          });
          if (res.ok) {
            toast(`✅ Closed ${ap.sym}`);
            fetchPositionsAndOrders();
          }
        } catch (err) {
          toast(`❌ ${err.message}`);
        }
      });
    }

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
          syncToolbarForPane(targetPane);
          if (targetPane.idx === 0 && openTabs[activeTabIndex]) {
            openTabs[activeTabIndex].interval = '1d';
          }
        }
        loadCandles(targetPane);
      });
    });

    // Layout Toggle Button (Icon-Only Exness Grid Cycle: 1->2->3 Desktop | 1->2 Mobile)
    const lBtn = $('layout-toggle-btn');
    const lDrop = $('layout-dropdown');
    const lLbl = $('current-layout-label');
    const lIconSvg = $('layout-icon-svg');
    const stage = $('chart-stage');

    function getLayoutIconSvg(lay) {
      const mobile = window.innerWidth <= 768;
      if (lay === 2) {
        return mobile
          ? '<svg viewBox="0 0 18 18" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="14" height="6" rx="1.3"/><rect x="2" y="10" width="14" height="6" rx="1.3"/></svg>'
          : '<svg viewBox="0 0 18 18" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="6" height="14" rx="1.3"/><rect x="10" y="2" width="6" height="14" rx="1.3"/></svg>';
      }
      if (lay === 3) {
        return '<svg viewBox="0 0 18 18" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="6" height="14" rx="1.2"/><rect x="10" y="2" width="6" height="6" rx="1.2"/><rect x="10" y="10" width="6" height="6" rx="1.2"/></svg>';
      }
      return '<svg viewBox="0 0 18 18" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.2" y="2.2" width="13.6" height="13.6" rx="2"/></svg>';
    }

    function applyLayout(lay) {
      if (window.innerWidth <= 768 && lay > 2) lay = 2;
      activeLayout = lay;
      if (stage) stage.className = `ex-chart-stage layout-${lay}`;
      if (lLbl) lLbl.textContent = `${lay} CHART${lay > 1 ? 'S' : ''}`;
      if (lIconSvg) lIconSvg.innerHTML = getLayoutIconSvg(lay);

      document.querySelectorAll('.layout-opt').forEach(opt => {
        opt.classList.toggle('active', parseInt(opt.dataset.layout) === lay);
      });

      if (lay === 1) {
        selectPane(0);
      } else {
        ensureSecondaryPaneSymbols(false);
        if (activePaneIdx >= lay) selectPane(0);
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
    window._applyChartLayoutFn = applyLayout;
    if (lIconSvg) lIconSvg.innerHTML = getLayoutIconSvg(activeLayout);

    if (lBtn) {
      lBtn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        const maxLay = window.innerWidth <= 768 ? 2 : 3;
        const nextLayout = (activeLayout % maxLay) + 1;
        applyLayout(nextLayout);
      });
    }

    if (lDrop) {
      document.querySelectorAll('.layout-opt').forEach(opt => {
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          let lay = parseInt(opt.dataset.layout) || 1;
          if (window.innerWidth <= 768 && lay > 2) lay = 2;
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
        closeAllOverlays('token-modal');
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
      closeAllOverlays('modal-api-keys');
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
          closeAllOverlays('modal-guest-profile');
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

    function switchMobileTab(tabKey, force = false) {
      if (!isAuthenticated && tabKey !== 'chart' && !force) {
        if ($('modal-gatekeeper')) $('modal-gatekeeper').classList.remove('hidden');
        return;
      }
      closeAllOverlays(!isAuthenticated ? 'modal-gatekeeper' : null);
      navItems.forEach(item => {
        item.classList.toggle('active', item.dataset.tab === tabKey);
      });

      if (tabKey === 'chart') {
        document.body.classList.remove('mobile-view-active');
        Object.values(views).forEach(v => v && v.classList.add('hidden'));

        // Trigger chart canvas resize and fit for all visible panes (max 2 on mobile)
        const effLayout = (window.innerWidth <= 768 && activeLayout > 2) ? 2 : activeLayout;
        const visibleCount = effLayout === 3 ? 3 : (effLayout === 2 ? 2 : 1);
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

    window._switchMobileTabFn = switchMobileTab;
    navItems.forEach(item => {
      item.addEventListener('click', () => switchMobileTab(item.dataset.tab));
    });

    // Accounts screen Trade button
    const mTradeBtn = $('m-action-trade');
    if (mTradeBtn) mTradeBtn.addEventListener('click', () => switchMobileTab('chart'));

    const mDepositBtn = $('m-action-deposit');
    if (mDepositBtn) {
      mDepositBtn.addEventListener('click', () => {
        if (typeof window._openPaperWalletFn === 'function') {
          window._openPaperWalletFn('deposit');
        }
      });
    }

    const mWithdrawBtn = $('m-action-withdraw');
    if (mWithdrawBtn) {
      mWithdrawBtn.addEventListener('click', () => {
        if (typeof window._openPaperWalletFn === 'function') {
          window._openPaperWalletFn('withdraw');
        }
      });
    }

    const mAccCog = $('m-btn-acc-settings');
    if (mAccCog) {
      mAccCog.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isAdminUser && typeof window._openKotakConnectFn === 'function') {
          window._openKotakConnectFn();
        } else {
          closeAllOverlays('modal-market-choice');
          const mktModal = $('modal-market-choice');
          if (mktModal) mktModal.classList.remove('hidden');
        }
      });
    }

    // Performance screen Start Trading button
    const mPerfTrade = $('m-btn-perf-trade');
    if (mPerfTrade) mPerfTrade.addEventListener('click', () => switchMobileTab('chart'));

    // Modals triggers from mobile (single active overlay — never stack!)
    const mBtnGuide = $('m-btn-open-guide');
    if (mBtnGuide) {
      mBtnGuide.addEventListener('click', () => {
        if (isAdminUser && typeof window._openKotakConnectFn === 'function') {
          window._openKotakConnectFn();
        } else if (guideModal) {
          closeAllOverlays('modal-setup-guide');
          guideModal.classList.remove('hidden');
        }
      });
    }

    const mBtnKeys = $('m-btn-open-keys');
    const mBtnProfKeys = $('m-btn-profile-keys');
    const mProfCog = $('m-profile-cog');
    if (mBtnKeys) mBtnKeys.addEventListener('click', openMobileKeys);
    if (mBtnProfKeys) mBtnProfKeys.addEventListener('click', openMobileKeys);
    if (mProfCog) mProfCog.addEventListener('click', openMobileKeys);

    const mRowPaper = $('m-row-paper-profile');
    if (mRowPaper && paperModal) {
      mRowPaper.addEventListener('click', () => {
        closeAllOverlays('modal-guest-profile');
        paperModal.classList.remove('hidden');
      });
    }

    const mRowSwitchMkt = $('m-row-switch-market');
    if (mRowSwitchMkt) {
      mRowSwitchMkt.addEventListener('click', () => {
        closeAllOverlays('modal-market-choice');
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

    const mRowLocal = $('m-row-run-local');
    if (mRowLocal && guideModal) {
      mRowLocal.addEventListener('click', () => {
        closeAllOverlays('modal-setup-guide');
        guideModal.classList.remove('hidden');
      });
    }

    const mRowLegal = $('m-row-legal');
    if (mRowLegal) {
      mRowLegal.addEventListener('click', () => {
        if (typeof window._openLegalModalFn === 'function') window._openLegalModalFn();
      });
    }

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
                <div class="m-qc-icon">${getInstrumentIconHtml('XAUUSD', 32)}</div>
                <div class="m-qc-price" id="qc-xau-ltp">Live Gold</div>
                <div class="m-qc-chg pos">24/7 Spot</div>
              </div>
              <div class="m-quick-card" data-sym="BTCUSD">
                <div class="m-qc-title">BTC / USD</div>
                <div class="m-qc-icon">${getInstrumentIconHtml('BTCUSD', 32)}</div>
                <div class="m-qc-price" id="qc-btc-ltp">Live BTC</div>
                <div class="m-qc-chg pos">24/7 Crypto</div>
              </div>
              <div class="m-quick-card" data-sym="EURUSD">
                <div class="m-qc-title">EUR / USD</div>
                <div class="m-qc-icon">${getInstrumentIconHtml('EURUSD', 32)}</div>
                <div class="m-qc-price" id="qc-eur-ltp">Major FX</div>
                <div class="m-qc-chg pos">1:200 Lev</div>
              </div>
              <div class="m-quick-card" data-sym="USTEC">
                <div class="m-qc-title">USTEC 100</div>
                <div class="m-qc-icon">${getInstrumentIconHtml('USTEC', 32)}</div>
                <div class="m-qc-price" id="qc-ndx-ltp">Nasdaq CFD</div>
                <div class="m-qc-chg pos">Index</div>
              </div>
            `
            : `
              <div class="m-quick-card" data-sym="NIFTY">
                <div class="m-qc-title">NIFTY 50</div>
                <div class="m-qc-icon">${getInstrumentIconHtml('NIFTY', 32)}</div>
                <div class="m-qc-price" id="qc-nifty-ltp">NIFTY</div>
                <div class="m-qc-chg pos">Index</div>
              </div>
              <div class="m-quick-card" data-sym="BANKNIFTY">
                <div class="m-qc-title">BANK NIFTY</div>
                <div class="m-qc-icon">${getInstrumentIconHtml('BANKNIFTY', 32)}</div>
                <div class="m-qc-price" id="qc-bank-ltp">BANK</div>
                <div class="m-qc-chg pos">Index</div>
              </div>
              <div class="m-quick-card" data-sym="SENSEX">
                <div class="m-qc-title">SENSEX</div>
                <div class="m-qc-icon">${getInstrumentIconHtml('SENSEX', 32)}</div>
                <div class="m-qc-price" id="qc-sensex-ltp">BSE</div>
                <div class="m-qc-chg pos">Index</div>
              </div>
              <div class="m-quick-card" data-sym="RELIANCE">
                <div class="m-qc-title">RELIANCE</div>
                <div class="m-qc-icon">${getInstrumentIconHtml('RELIANCE', 32)}</div>
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
                  <span class="m-card-icon">${getInstrumentIconHtml(sym, 22)}</span>
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
                  <span class="m-card-icon">${getInstrumentIconHtml(o.symbol, 22)}</span>
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
                  <span class="m-card-icon">${getInstrumentIconHtml(sym, 22)}</span>
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
                <span class="m-card-expand-toggle" data-idx="${idx}">Details ▾</span>
              </div>
              <div class="m-card-fifo-drawer hidden" id="m-fifo-drawer-${idx}">
                ${matches.length ? matches.map(m => `
                  <div class="m-fifo-item">
                    <span>${m.quantity} qty @ ${pc}${Number(m.buy_price).toFixed(decs)} ➔ ${pc}${Number(m.sell_price).toFixed(decs)}${(m.entry_fill_id || m.entry_order_id) ? `<br><small style="color:var(--text-dim);font-family:var(--font-mono);">Fill #${escapeHtml(m.entry_fill_id || '—')}➔#${escapeHtml(m.exit_fill_id || '—')} · Ord ${escapeHtml(m.entry_order_id || '—')}</small>` : ''}</span>
                    <span style="color:${Number(m.gross_pnl||0)>=0?'var(--bull)':'var(--bear)'};font-weight:700;">
                      ${Number(m.gross_pnl||0)>=0?'+':''}${pc}${Number(m.gross_pnl||0).toFixed(2)}
                    </span>
                  </div>
                `).join('') : '<div class="m-fifo-item">Single execution lot closed</div>'}
              </div>
            `;

            const toggleBtn = card.querySelector('.m-card-expand-toggle');
            const drawer = card.querySelector(`#m-fifo-drawer-${idx}`);
            if (drawer) {
              card.addEventListener('click', (e) => {
                if (e.target && e.target.closest && e.target.closest('button, a')) return;
                const isHidden = drawer.classList.contains('hidden');
                drawer.classList.toggle('hidden', !isHidden);
                if (toggleBtn) toggleBtn.textContent = isHidden ? 'Details ▴' : 'Details ▾';
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
                  <span class="m-card-icon">${getInstrumentIconHtml(sym, 22)}</span>
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
        const icon = getInstrumentIconHtml(it.symbol, 32);
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
      const kBadgeEl = $('m-acc-badge-kotak');
      const kConnected = Boolean(currentUser && currentUser.kotak_connected);

      if (accIdEl) accIdEl.textContent = `@${uname.toUpperCase()}`;
      if (badgeEl) badgeEl.textContent = currentMarketMode === 'forex' ? 'Forex Paper' : (isAdminUser && kConnected ? 'Kotak Live' : 'Indian Paper');
      if (kBadgeEl) {
        kBadgeEl.classList.toggle('hidden', !isAdminUser);
        if (isAdminUser) {
          kBadgeEl.textContent = kConnected ? 'Kotak: Authenticated' : 'Kotak: Not Auth';
          kBadgeEl.className = `m-acc-badge kotak-auth admin-only-ctrl ${kConnected ? 'connected' : ''}`;
        }
      }
      if (desktopBal && accBalEl) {
        const txt = desktopBal.textContent || '—';
        accBalEl.textContent = txt;
        const isMsg = !/^\s*[+-]?[$₹][\d,.]+/.test(txt) && txt !== '—';
        accBalEl.classList.toggle('is-status-msg', isMsg);
      }
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

  // --- Live Candle Bar Close Countdown Timer (per active TF) ---
  const TF_SECONDS_MAP = {
    '5s': 5, '15s': 15, '1m': 60, '3m': 180, '5m': 300,
    '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400,
  };

  function formatCountdownClock(sec) {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const p2 = n => (n < 10 ? `0${n}` : `${n}`);
    return h > 0 ? `${p2(h)}:${p2(m)}:${p2(r)}` : `${p2(m)}:${p2(r)}`;
  }

  function updatePaneCountdowns() {
    const visibleCount = activeLayout === 3 ? 3 : (activeLayout === 2 ? 2 : 1);
    const nowSec = Math.floor(Date.now() / 1000);
    panes.forEach((p, idx) => {
      const pref = `p${idx + 1}`;
      const box = $(`${pref}-cd-box`);
      const tfEl = $(`${pref}-cd-tf`);
      const timeEl = $(`${pref}-cd-time`);
      const fillEl = $(`${pref}-cd-fill`);
      if (!box || !tfEl || !timeEl || !fillEl) return;
      if (idx >= visibleCount) return;

      const tf = String(p.tf || '1m').toLowerCase();
      const stepSec = TF_SECONDS_MAP[tf] || 60;
      tfEl.textContent = tf === '1d' ? '1D' : tf;

      let rem = stepSec - (nowSec % stepSec);
      let span = stepSec;

      if (tf === '1d' && !isForexSym(p.sym)) {
        const istSec = nowSec + 19800;
        const istDaySec = istSec % 86400;
        const wd = new Date(istSec * 1000).getUTCDay(); // IST weekday (1=Mon..5=Fri)
        const isOpenDay = wd >= 1 && wd <= 5;
        if (isOpenDay && istDaySec >= 33300 && istDaySec < 55800) {
          span = 22500;
          rem = 55800 - istDaySec;
        } else {
          timeEl.textContent = 'Closed';
          fillEl.style.width = '100%';
          box.classList.remove('urgent');
          return;
        }
      } else if (p.activeBar && p.activeBar.time > 0 && nowSec >= p.activeBar.time && nowSec < p.activeBar.time + stepSec) {
        rem = (p.activeBar.time + stepSec) - nowSec;
      }

      const pct = Math.max(0, Math.min(100, ((span - rem) / span) * 100));
      timeEl.textContent = formatCountdownClock(rem);
      fillEl.style.width = `${pct.toFixed(1)}%`;
      box.classList.toggle('urgent', span <= 3600 && rem <= 5);
    });
  }
  window._updateCountdownsFn = updatePaneCountdowns;

  // --- Bootloader ---
  window.addEventListener('DOMContentLoaded', () => {
    // Prevent page pinch / double-tap zoom while leaving single-finger + / - taps instant
    ['gesturestart', 'gesturechange', 'gestureend'].forEach(evt => {
      document.addEventListener(evt, e => e.preventDefault(), { passive: false });
    });
    document.addEventListener('touchstart', e => {
      if (e.touches && e.touches.length > 1 && !(e.target && e.target.closest && e.target.closest('.chart-canvas-view'))) {
        if (e.cancelable) e.preventDefault();
      }
    }, { passive: false });

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
    setupPaperWalletModal();
    setupLegalModal();
    setupIndicatorsMenu();
    setupTokenModal();
    setupKeysModal();
    setupGuestProfileModal();
    setupMobileFlow();
    syncTradeButtonsForActivePane();
    updateTzBadgeUI();
    updatePaneCountdowns();

    loadCandles(panes[0]);
    startQuotesPolling();

    // Regular position & candle close countdown refresh
    setInterval(fetchPositionsAndOrders, 4000);
    setInterval(updatePaneCountdowns, 500);
  });
})();
