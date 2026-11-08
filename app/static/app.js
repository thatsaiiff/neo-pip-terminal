(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const explicitDemo = new URLSearchParams(location.search).get('cloud') === 'demo';
  let cloudDemoMode = explicitDemo;

  const state = {
    side: 'BUY',
    mode: 'simulation',
    liveTradingEnabled: false,
    authenticated: false,
    kotakEgressIp: null,
    kotakSessionIp: null,
    currentSymbol: 'NIFTY',
    exchangeSegment: 'nse_fo',
    selectedInstrument: null,
    currentLtp: null,
    lastQuoteTimestamp: null,
    quoteTimer: null,
    searchTimer: null,
    symbolSource: 'manual',
    remoteSymbolTimestamp: null,
    pendingOrder: null,
    submitting: false,
    orderCount: 0,
    pipWindow: null,
    toastTimer: null,
    lastBridgeNote: '',
    demoOrders: [],
    demoAudit: [
      { id: 1, created_at: new Date().toISOString(), event_type: 'service_started', detail: { mode: 'simulation', note: 'Local trading terminal ready' } }
    ],
    activityTab: 'orders',
    ordersTab: 'all',
    positionsTab: 'open',
    lastOrders: [],
    scalperMode: false,
    autoSltp: true,
    slPercent: 5,
    tpPercent: 10,
    availableFunds: null,
    activeSltpRules: [],
    demoSltpRules: [],
  };

  function money(value, showSign = false) {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    const num = Number(value);
    const formatted = Math.abs(num).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (showSign) {
      if (num > 0) return `+₹${formatted}`;
      if (num < 0) return `-₹${formatted}`;
    }
    return `${num < 0 ? '-' : ''}₹${formatted}`;
  }

  function formatTime(value) {
    try {
      return new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
    } catch (_) {
      return '--:--';
    }
  }

  const AVAILABLE_EXCHANGES = [
    { value: 'all', label: 'ALL', orderLabel: 'ALL (All Exchanges)' },
    { value: 'nse_fo', label: 'NSE F&O', orderLabel: 'NSE Futures & Options' },
    { value: 'bse_fo', label: 'BSE F&O', orderLabel: 'BSE Futures & Options' },
    { value: 'nse_cm', label: 'NSE CASH', orderLabel: 'NSE Cash' },
    { value: 'bse_cm', label: 'BSE CASH', orderLabel: 'BSE Cash' },
    { value: 'mcx_fo', label: 'MCX', orderLabel: 'MCX Futures' }
  ];

  function segmentLabel(segment) {
    return ({
      all: 'ALL',
      nse_fo: 'NSE F&O',
      bse_fo: 'BSE F&O',
      nse_cm: 'NSE CASH',
      bse_cm: 'BSE CASH',
      mcx_fo: 'MCX'
    })[segment] || String(segment || 'NSE F&O').toUpperCase();
  }

  function updateExchangeChip(segment) {
    state.searchSegment = segment || state.searchSegment || 'nse_fo';
    const labelEl = $('exchange-chip-label') || $('exchange-chip');
    if (labelEl) {
      labelEl.textContent = segmentLabel(state.searchSegment);
    }
    const chip = $('exchange-chip');
    if (chip) {
      chip.classList.toggle('active-all', state.searchSegment === 'all');
      chip.setAttribute('title', `Exchange: ${segmentLabel(state.searchSegment)} (Click to cycle)`);
    }
    if ($('exchange-select') && $('exchange-select').value !== state.searchSegment) {
      $('exchange-select').value = state.searchSegment;
    }
  }

  function cycleExchangeSegment() {
    const current = state.searchSegment || 'nse_fo';
    const currentIndex = AVAILABLE_EXCHANGES.findIndex(e => e.value === current);
    const nextIndex = (currentIndex + 1) % AVAILABLE_EXCHANGES.length;
    const next = AVAILABLE_EXCHANGES[nextIndex];
    state.searchSegment = next.value;
    if (next.value !== 'all') {
      state.exchangeSegment = next.value;
    }
    updateExchangeChip(next.value);
    toast(`Exchange: ${next.label}${next.value === 'all' ? ' (Search all exchanges)' : ''}`, 'info', 1500);
  }

  function cleanErrorMessage(raw) {
    if (!raw) return 'An error occurred';
    const text = typeof raw === 'string' ? raw : (raw.message || String(raw));
    if (text.includes('5203') || text.toLowerCase().includes('no data')) {
      return 'No records returned from Kotak Neo.';
    }
    const match = text.match(/['"](?:errMsg|emsg|message|detail)['"]\s*:\s*['"]([^'"]+)['"]/i);
    if (match && match[1]) {
      return match[1];
    }
    return text.replace(/\{'stCode':.*?\}/g, '').trim() || text;
  }

  function toast(message, type = 'info', duration = 3500) {
    const element = $('toast');
    const msgEl = $('toast-message');
    if (!element) return;
    if (msgEl) msgEl.textContent = cleanErrorMessage(message);
    else element.textContent = cleanErrorMessage(message);

    element.className = 'toast visible';
    if (type && type !== 'info') {
      element.classList.add(`toast-${type}`);
    }
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      element.classList.remove('visible');
    }, duration);
  }

  async function api(path, options = {}) {
    if (cloudDemoMode) return demoApi(path, options);
    const apiBase = (window.__API_BASE__ || localStorage.getItem('neo_api_url') || '').replace(/\/$/, '');
    const url = apiBase ? `${apiBase}${path}` : path;
    const response = await fetch(url, {
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    let data = {};
    try { data = await response.json(); } catch (_) { data = {}; }
    if (!response.ok) {
      const detail = typeof data.detail === 'string' ? data.detail : `Request failed (${response.status})`;
      if (response.status === 404 && path.startsWith('/api/')) {
        throw new Error('Local API route not found (404). Restart the backend service.');
      }
      throw new Error(detail);
    }
    return data;
  }

  async function demoApi(path, options = {}) {
    const method = options.method || 'GET';
    if (path === '/api/health') return { ok: true, service: 'neo-pip-cloud-demo', lan_access_enabled: false };
    if (path === '/api/status') return { live_trading_enabled: false, broker_authenticated: false, mode: 'simulation', selected_symbol: null, extension_bridge_configured: false };
    if (path.startsWith('/api/orders') && method === 'GET') return state.demoOrders;
    if (path.startsWith('/api/positions')) return { positions: [], total_today_pnl: 0, total_realized_pnl: 0, total_unrealized_pnl: 0, total_mtm: 0, total_position_pnl: 0, open_count: 0, closed_count: 0, all_count: 0, pnl_complete: true };
    if (path.startsWith('/api/audit')) return state.demoAudit;
    if (path === '/api/indices/quotes') {
      return {
        indices: [
          { name: 'NIFTY', ltp: 24180.80, change: 142.30, change_percent: 0.59 },
          { name: 'BANK NIFTY', ltp: 51220.45, change: -85.10, change_percent: -0.17 },
          { name: 'SENSEX', ltp: 79840.10, change: 420.50, change_percent: 0.53 }
        ]
      };
    }
    if (path === '/api/orders' && method === 'POST') {
      const body = JSON.parse(options.body || '{}');
      const item = {
        ...body,
        id: `DEMO-${state.demoOrders.length + 1}`,
        quantity: body.lots * body.lot_size,
        status: 'simulated',
        mode: 'simulation',
        created_at: new Date().toISOString(),
        broker_order_id: null
      };
      state.demoOrders.unshift(item);
      state.demoAudit.unshift({
        id: state.demoAudit.length + 1,
        created_at: new Date().toISOString(),
        event_type: 'simulation_order',
        detail: { symbol: body.symbol, side: body.side, quantity: body.lots * body.lot_size }
      });
      return { ok: true, status: 'simulated', message: 'Demo order recorded locally. No broker request was sent.' };
    }
    if (path === '/api/limits') {
      return { available_cash: 100000.0, collateral: 0.0, margin_used: 0.0, total_margin: 100000.0 };
    }
    if (path === '/api/sltp' && method === 'GET') {
      return state.demoSltpRules || [];
    }
    if (path === '/api/sltp' && method === 'POST') {
      const b = JSON.parse(options.body || '{}');
      const rule = { id: (state.demoSltpRules || []).length + 1, ...b, status: 'active', created_at: new Date().toISOString() };
      state.demoSltpRules = state.demoSltpRules || [];
      state.demoSltpRules.push(rule);
      return { ok: true, rule_id: rule.id, message: `Software SL/TP active for ${b.symbol}` };
    }
    if (path.startsWith('/api/sltp/') && method === 'DELETE') {
      const id = parseInt(path.split('/').pop());
      state.demoSltpRules = (state.demoSltpRules || []).filter(r => r.id !== id);
      return { ok: true, rule_id: id, message: 'SL/TP rule cancelled' };
    }
    if (path === '/api/sltp/check') {
      return { ok: true, triggered_count: 0, triggered: [] };
    }
    if (path === '/api/positions/exit-all') {
      state.demoSltpRules = [];
      return { ok: true, cancelled_orders: 0, closed_positions: 1, errors: [], message: 'Exit All simulated: 0 orders cancelled, 1 position closed.' };
    }
    if (path.startsWith('/api/chart/candles')) {
      const urlParams = new URLSearchParams(path.split('?')[1] || '');
      const sym = urlParams.get('symbol') || 'NIFTY';
      const tf = urlParams.get('interval') || '5s';
      return { ok: true, symbol: sym, interval: tf, date: '2026-11-06', candles: [] };
    }
    if (path === '/api/instruments/search') return { instruments: [] };
    if (path === '/api/options/expiries') return { expiries: [], nearest_expiry: null };
    if (path === '/api/options/chain') return { rows: [], underlying: '', expiry: null, lot_size: 1 };
    if (path === '/api/instruments/quote') throw new Error('Live quotes are unavailable in this simulation-only cloud demo.');
    throw new Error('This feature is unavailable in the simulation-only cloud demo.');
  }

  async function requestLanAccess() {
    try {
      const health = await api('/api/health');
      if (!health.lan_access_enabled) return;
      const key = window.prompt('Enter the local network access key shown in your .env file:');
      if (key === null) return;
      await api('/api/lan/access', { method: 'POST', body: JSON.stringify({ token: key }) });
      window.location.reload();
    } catch (error) {
      toast(error.message || 'Could not unlock local network access.', 'error', 5000);
    }
  }

  function modeLabel() {
    if (state.mode === 'live' && state.authenticated) return 'LIVE CONNECTED';
    return 'SIMULATION';
  }

  function updateModeUI() {
    const pill = $('mode-pill');
    const live = state.mode === 'live' && state.authenticated;
    pill.classList.toggle('live', live);
    pill.classList.toggle('simulation', !live);
    pill.querySelector('.mode-text').textContent = cloudDemoMode ? 'CLOUD DEMO' : modeLabel();

    const ipPill = $('ip-pill');
    if (ipPill) {
      if (state.authenticated && state.kotakEgressIp) {
        ipPill.classList.remove('hidden');
        $('ip-text').textContent = state.kotakEgressIp;
      } else {
        ipPill.classList.add('hidden');
      }
    }

    if (cloudDemoMode) {
      $('cloud-demo-banner').classList.remove('hidden');
      $('bridge-note').textContent = 'Demo preview: Link your live cloud backend to activate live broker trading and live market data.';
    } else {
      $('cloud-demo-banner').classList.add('hidden');
    }
    $('connect-btn').classList.remove('hidden');

    $('connect-btn').title = state.authenticated ? 'Disconnect Kotak Neo' : 'Connect Kotak Neo';
    $('connect-btn').setAttribute('aria-label', state.authenticated ? 'Disconnect Kotak Neo' : 'Connect Kotak Neo');
    $('connection-footer').textContent = state.authenticated
      ? `Kotak API active · IP ${state.kotakEgressIp || 'verified'}`
      : (state.liveTradingEnabled
        ? (state.kotakEgressIp ? `API session needs login · last IP ${state.kotakEgressIp}` : 'Live gate enabled · not authenticated')
        : 'Local simulation mode');
    $('connect-btn').style.color = state.authenticated ? '#1b732d' : '';
  }

  function renderSymbol(symbol, segment, source, timestamp) {
    state.currentSymbol = String(symbol || 'NIFTY').toUpperCase();
    state.exchangeSegment = segment || state.exchangeSegment || 'nse_fo';
    state.searchSegment = state.exchangeSegment;
    state.symbolSource = source || 'manual';
    $('symbol-input').value = state.currentSymbol;
    updateExchangeChip(state.exchangeSegment);
    $('symbol-subtitle').textContent = source === 'chrome extension'
      ? `Synced from Kotak Neo · ${timestamp ? formatTime(timestamp) : 'just now'}`
      : (source === 'manual override' ? 'Manual symbol override' : 'Select a symbol on Kotak Neo or enter one above');

    const connectedSource = source === 'chrome extension';
    $('source-indicator').classList.toggle('linked', connectedSource);
    $('source-indicator').innerHTML = `<i class="source-dot"></i> ${connectedSource ? 'Linked' : (source === 'manual override' ? 'Manual override' : 'Manual')}`;
    $('bridge-note').textContent = connectedSource
      ? 'Symbol bridge is active. Confirm the instrument and exchange before placing your order.'
      : (state.lastBridgeNote || 'Open your Kotak Neo trading tab and select a symbol. The companion extension will automatically sync it here.');

    state.selectedInstrument = null;
    state.currentLtp = null;
    $('live-price').className = 'price-unavailable';
    $('live-price').innerHTML = '<span class="dot-pulse"></span> Price unavailable';
    updateQuantity();
    updateTradingViewSymbol(state.currentSymbol);
  }

  function renderInstrument(instrument) {
    state.selectedInstrument = instrument;
    state.currentSymbol = instrument.trading_symbol;
    state.exchangeSegment = instrument.exchange_segment;
    state.searchSegment = instrument.exchange_segment;
    $('symbol-input').value = instrument.trading_symbol;
    updateExchangeChip(instrument.exchange_segment);
    $('lot-size-input').value = instrument.lot_size;
    $('product-select').value = instrument.defaultProduct || 'CNC';
    $('type-select').value = 'MKT';
    updateOrderTypeFields();
    $('symbol-subtitle').textContent = `${instrument.symbol_name || instrument.trading_symbol} · Kotak instrument`;
    $('source-indicator').classList.add('linked');
    $('source-indicator').innerHTML = '<i class="source-dot"></i> Kotak';
    $('bridge-note').textContent = 'Selected from Kotak instrument search. Verify the contract and quantity before ordering.';
    $('instrument-results').classList.add('hidden');
    updateTradingViewSymbol(instrument.trading_symbol);
    refreshQuote();
  }

  async function searchInstruments() {
    const query = $('instrument-search').value.trim();
    if (query.length < 2) {
      toast('Enter at least 2 characters to search.', 'warning');
      return;
    }
    const button = $('search-instruments');
    button.disabled = true;
    button.textContent = 'Searching…';
    const segment = state.searchSegment || $('exchange-select').value || 'all';
    try {
      const data = await api('/api/instruments/search', {
        method: 'POST',
        body: JSON.stringify({ query, exchange_segment: segment })
      });
      const results = $('instrument-results');
      results.replaceChildren();
      if (!data.instruments || !data.instruments.length) {
        const empty = document.createElement('div');
        empty.className = 'instrument-result-empty';
        empty.textContent = cloudDemoMode ? 'Instrument search is disabled in the cloud demo.' : `No matching Kotak instruments found (${segmentLabel(segment)})`;
        results.appendChild(empty);
      } else {
        for (const instrument of data.instruments) {
          const option = document.createElement('button');
          option.type = 'button';
          option.className = 'instrument-result';
          option.setAttribute('role', 'option');

          const topRow = document.createElement('div');
          topRow.style.cssText = 'display: flex; justify-content: space-between; align-items: center; width: 100%;';

          const name = document.createElement('strong');
          name.textContent = instrument.trading_symbol;

          const segBadge = document.createElement('span');
          segBadge.textContent = segmentLabel(instrument.exchange_segment);
          segBadge.style.cssText = 'font: 600 9px var(--font-mono); padding: 1px 6px; border-radius: 3px; background: var(--bg-surface-subtle); border: 1px solid var(--border-light); color: var(--ink-secondary); margin-left: 6px; letter-spacing: 0.04em;';

          topRow.append(name, segBadge);

          const meta = document.createElement('span');
          meta.textContent = `${instrument.symbol_name || ''} · lot ${instrument.lot_size}${instrument.expiry ? ` · ${instrument.expiry}` : ''}${instrument.option_type ? ` · ${instrument.option_type}` : ''}`;
          option.append(topRow, meta);
          option.addEventListener('click', () => renderInstrument(instrument));
          results.appendChild(option);
        }
      }
      results.classList.remove('hidden');
    } catch (error) {
      toast(error.message, 'error', 5000);
    } finally {
      button.disabled = false;
      button.textContent = 'Search';
    }
  }

  async function refreshQuote() {
    if (!state.selectedInstrument) return;
    const instrument = state.selectedInstrument;
    try {
      const quote = await api('/api/instruments/quote', {
        method: 'POST',
        body: JSON.stringify({ instrument_token: instrument.instrument_token, exchange_segment: instrument.exchange_segment })
      });
      if (state.selectedInstrument !== instrument) return;
      state.currentLtp = quote.ltp;
      state.lastQuoteTimestamp = quote.updated_at;
      $('live-price').className = '';
      $('live-price').textContent = `₹${Number(quote.ltp).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · LTP`;
      updateQuantity();
      calculateAndPrefillSltp(false);
      updateLiveChartTick(quote.ltp);

      if (instrument.trading_symbol) {
        api('/api/sltp/check', {
          method: 'POST',
          body: JSON.stringify({ symbol: instrument.trading_symbol, ltp: quote.ltp })
        }).then(res => {
          if (res && res.triggered_count > 0) {
            res.triggered.forEach(t => {
              toast(`🛡️ OCO Triggered: ${t.trigger_type} hit at ₹${t.trigger_ltp}! Market exit order placed.`, 'warning', 6000);
            });
            loadPositions();
            loadOrders();
            loadSltpRules();
          }
        }).catch(() => {});
      }
    } catch (_) {
      if (state.selectedInstrument !== instrument) return;
      $('live-price').className = 'price-unavailable';
      $('live-price').innerHTML = '<span class="dot-pulse"></span> Price unavailable';
    }
  }

  let optionChainInterval = null;
  let isOptionChainFetching = false;

  function centerAtmRow(smooth = true) {
    const wrap = document.querySelector('.chain-table-wrap');
    let atmRow = document.querySelector('#chain-rows tr.atm-row');
    if (wrap) {
      if (!atmRow) {
        const allRows = document.querySelectorAll('#chain-rows tr');
        if (allRows.length > 0) {
          atmRow = allRows[Math.floor(allRows.length / 2)];
        }
      }
      if (atmRow) {
        const wrapRect = wrap.getBoundingClientRect();
        const rowRect = atmRow.getBoundingClientRect();
        const currentScroll = wrap.scrollTop;
        const rowOffsetInWrap = (rowRect.top - wrapRect.top) + currentScroll;
        const targetScroll = rowOffsetInWrap - (wrap.clientHeight / 2) + (rowRect.height / 2);
        wrap.scrollTo({
          top: Math.max(0, targetScroll),
          behavior: smooth ? 'smooth' : 'auto'
        });
      }
    }
  }

  async function loadOptionChain(isBackgroundRefresh = false) {
    if (isOptionChainFetching) return;
    const underlying = $('chain-underlying').value;
    const expiry = $('chain-expiry').value || null;
    const wrap = document.querySelector('.chain-table-wrap');
    const savedScrollTop = wrap ? wrap.scrollTop : 0;

    if (!isBackgroundRefresh) {
      $('chain-status').textContent = 'Loading Kotak option chain…';
    }

    isOptionChainFetching = true;
    try {
      const data = await api('/api/options/chain', {
        method: 'POST',
        body: JSON.stringify({ underlying, expiry })
      });

      const body = $('chain-rows');
      $('chain-status').textContent = data.rows && data.rows.length
        ? `${data.underlying} · ${data.expiry || expiry || 'nearest expiry'} · lot ${data.lot_size}${data.atm_strike ? ` · ATM ${data.atm_strike}` : ''} · 1s live quotes`
        : (cloudDemoMode ? 'Option-chain data requires a local Kotak connection.' : 'No option contracts returned for this expiry.');

      const atmStrike = data.atm_strike ? Number(data.atm_strike) : null;
      const existingRows = body.querySelectorAll('tr');
      const rowsData = data.rows || [];

      // In-place fast update for background 1-second refresh to avoid jump & flicker
      if (isBackgroundRefresh && existingRows.length === rowsData.length && existingRows.length > 0) {
        rowsData.forEach((row, i) => {
          const tr = existingRows[i];
          const strike = Number(row.strike);
          const isAtm = atmStrike !== null && strike === atmStrike;
          tr.classList.toggle('atm-row', isAtm);

          const callOiBtn = tr.cells[0]?.querySelector('button');
          if (callOiBtn && row.call) {
            callOiBtn.textContent = row.call.oi == null ? '—' : Number(row.call.oi).toLocaleString('en-IN');
          }
          if (tr.cells[0]) {
            tr.cells[0].classList.toggle('itm-call', isCallItm);
            tr.cells[0].classList.toggle('otm-call', !isCallItm);
          }

          const callLtpBtn = tr.cells[1]?.querySelector('button');
          if (callLtpBtn && row.call) {
            callLtpBtn.textContent = row.call.ltp == null ? '—' : Number(row.call.ltp).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          }
          if (tr.cells[1]) {
            tr.cells[1].classList.toggle('itm-call', isCallItm);
            tr.cells[1].classList.toggle('otm-call', !isCallItm);
          }

          const strikeCell = tr.cells[2];
          if (strikeCell) {
            if (isAtm && !strikeCell.querySelector('.atm-badge')) {
              strikeCell.innerHTML = `<span class="strike-num">${row.strike}</span><span class="atm-badge">ATM</span>`;
            } else if (!isAtm && strikeCell.querySelector('.atm-badge')) {
              strikeCell.textContent = row.strike;
            }
          }

          const putLtpBtn = tr.cells[3]?.querySelector('button');
          if (putLtpBtn && row.put) {
            putLtpBtn.textContent = row.put.ltp == null ? '—' : Number(row.put.ltp).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          }
          if (tr.cells[3]) {
            tr.cells[3].classList.toggle('itm-put', isPutItm);
            tr.cells[3].classList.toggle('otm-put', !isPutItm);
          }

          const putOiBtn = tr.cells[4]?.querySelector('button');
          if (putOiBtn && row.put) {
            putOiBtn.textContent = row.put.oi == null ? '—' : Number(row.put.oi).toLocaleString('en-IN');
          }
          if (tr.cells[4]) {
            tr.cells[4].classList.toggle('itm-put', isPutItm);
            tr.cells[4].classList.toggle('otm-put', !isPutItm);
          }
        });
      } else {
        body.replaceChildren();

        for (const row of rowsData) {
          const strike = Number(row.strike);
          const isAtm = atmStrike !== null && strike === atmStrike;
          const isCallItm = atmStrike !== null && strike < atmStrike;
          const isPutItm = atmStrike !== null && strike > atmStrike;

          const tr = document.createElement('tr');
          if (isAtm) tr.classList.add('atm-row');

          const addCell = (side, field, value, label, isItm) => {
            const td = document.createElement('td');
            if (!side) {
              td.className = 'strike th-strike';
              if (isAtm) {
                td.innerHTML = `<span class="strike-num">${row.strike}</span><span class="atm-badge">ATM</span>`;
              } else {
                td.textContent = row.strike;
              }
              tr.appendChild(td);
              return;
            }

            td.classList.add(label === 'CALL' ? 'call-cell' : 'put-cell');
            td.classList.add(isItm ? (label === 'CALL' ? 'itm-call' : 'itm-put') : (label === 'CALL' ? 'otm-call' : 'otm-put'));

            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = value == null ? '—' : (field === 'ltp' ? Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : Number(value).toLocaleString('en-IN'));
            button.disabled = !side.symbol || !side.instrument_token;
            button.title = button.disabled ? 'Contract unavailable' : `Select ${side.symbol} (${label})`;
            button.addEventListener('click', () => renderInstrument({
              trading_symbol: side.symbol,
              symbol_name: `${underlying} ${row.strike} ${label}`,
              instrument_token: side.instrument_token,
              exchange_segment: side.exchange_segment,
              lot_size: data.lot_size,
              defaultProduct: 'NRML',
            }));
            td.appendChild(button);
            tr.appendChild(td);
          };

          addCell(row.call, 'oi', row.call?.oi, 'CALL', isCallItm);
          addCell(row.call, 'ltp', row.call?.ltp, 'CALL', isCallItm);
          addCell(null, null, null, null, false);
          addCell(row.put, 'ltp', row.put?.ltp, 'PUT', isPutItm);
          addCell(row.put, 'oi', row.put?.oi, 'PUT', isPutItm);
          body.appendChild(tr);
        }

        if (wrap && isBackgroundRefresh) {
          wrap.scrollTop = savedScrollTop;
        } else {
          setTimeout(() => centerAtmRow(false), 60);
        }
      }
    } catch (error) {
      if (!isBackgroundRefresh) {
        $('chain-status').textContent = cleanErrorMessage(error.message);
      }
    } finally {
      isOptionChainFetching = false;
    }
  }

  function startOptionChainPolling() {
    stopOptionChainPolling();
    optionChainInterval = setInterval(() => {
      const panel = $('option-chain-panel');
      if (panel && !panel.classList.contains('hidden')) {
        loadOptionChain(true);
      } else {
        stopOptionChainPolling();
      }
    }, 1000);
  }

  function stopOptionChainPolling() {
    if (optionChainInterval) {
      clearInterval(optionChainInterval);
      optionChainInterval = null;
    }
  }

  async function loadChainExpiries() {
    const underlying = $('chain-underlying').value;
    if (cloudDemoMode) {
      $('chain-expiry').replaceChildren();
      $('chain-status').textContent = 'Connect to Kotak in the local app to load real expiries and contracts.';
      $('chain-rows').replaceChildren();
      return;
    }
    $('chain-status').textContent = 'Loading upcoming expiries…';
    try {
      const data = await api('/api/options/expiries', {
        method: 'POST',
        body: JSON.stringify({ underlying })
      });
      const select = $('chain-expiry');
      select.replaceChildren();
      for (const expiry of data.expiries) {
        const option = document.createElement('option');
        option.value = expiry;
        option.textContent = expiry === data.nearest_expiry ? `${expiry} · nearest` : expiry;
        select.appendChild(option);
      }
      if (!data.expiries.length) {
        $('chain-status').textContent = 'Kotak returned no upcoming expiries.';
        return;
      }
      select.value = data.nearest_expiry;
      await loadOptionChain();
    } catch (error) {
      $('chain-status').textContent = cleanErrorMessage(error.message);
    }
  }

  function getLots() {
    const value = Number.parseInt($('lots-input').value, 10);
    return Number.isFinite(value) && value > 0 ? Math.min(value, 1000) : 1;
  }

  function getLotSize() {
    const value = Number.parseInt($('lot-size-input').value, 10);
    return Number.isFinite(value) && value > 0 ? Math.min(value, 100000) : 1;
  }

  function updateQuantity() {
    const quantity = getLots() * getLotSize();
    $('quantity-value').innerHTML = `${quantity.toLocaleString('en-IN')} <small>units</small>`;
    const price = Number.parseFloat($('price-input').value);
    const type = $('type-select').value;
    const estVal = $('estimate-value');
    const estCap = estVal.nextElementSibling;

    if (type === 'L' && Number.isFinite(price) && price > 0) {
      estVal.textContent = money(quantity * price);
      estVal.style.color = 'var(--ink-primary)';
      estCap.textContent = 'Limit-price estimate';
    } else if (Number.isFinite(state.currentLtp) && state.currentLtp > 0) {
      estVal.textContent = money(quantity * state.currentLtp);
      estVal.style.color = 'var(--ink-primary)';
      estCap.textContent = 'Indicative value at LTP';
    } else {
      estVal.textContent = '—';
      estVal.style.color = '';
      estCap.textContent = 'Price unavailable';
    }
  }

  function updateOrderTypeFields() {
    const type = $('type-select').value;
    $('price-field').classList.toggle('hidden', !(type === 'L' || type === 'SL'));
    $('trigger-field').classList.toggle('hidden', !(type === 'SL' || type === 'SL-M'));
    $('price-input').required = type === 'L' || type === 'SL';
    $('trigger-input').required = type === 'SL' || type === 'SL-M';
    updateQuantity();
  }

  function setSide(side) {
    state.side = side;
    $('buy-btn').classList.toggle('active', side === 'BUY');
    $('sell-btn').classList.toggle('active', side === 'SELL');
  }

  function calculateAndPrefillSltp(force = false) {
    const ltp = state.currentLtp;
    if (!ltp || ltp <= 0) return;
    const side = state.side || 'BUY';
    const slPct = state.slPercent || 5;
    const tpPct = state.tpPercent || 10;

    let slPrice, tpPrice;
    if (side === 'BUY') {
      slPrice = Math.max(0.05, ltp * (1 - slPct / 100));
      tpPrice = ltp * (1 + tpPct / 100);
    } else {
      slPrice = ltp * (1 + slPct / 100);
      tpPrice = Math.max(0.05, ltp * (1 - tpPct / 100));
    }

    const slInput = $('sltp-sl-input');
    const tpInput = $('sltp-tp-input');
    const slBadge = $('sl-badge');
    const tpBadge = $('tp-badge');

    if (slBadge) slBadge.textContent = `${side === 'BUY' ? '-' : '+'}${slPct}%`;
    if (tpBadge) tpBadge.textContent = `${side === 'BUY' ? '+' : '-'}${tpPct}%`;

    if (slInput && (force || !slInput.value || slInput.dataset.autoPrefilled !== 'false')) {
      slInput.value = slPrice.toFixed(2);
      slInput.dataset.autoPrefilled = 'true';
    }
    if (tpInput && (force || !tpInput.value || tpInput.dataset.autoPrefilled !== 'false')) {
      tpInput.value = tpPrice.toFixed(2);
      tpInput.dataset.autoPrefilled = 'true';
    }
  }

  // --- Lightweight Charts (Upstox-Powered 5s Scalper Chart Engine) ---
  let tvChart = null;
  let tvCandleSeries = null;
  let tvVolumeSeries = null;
  let currentChartInterval = '5s';
  let active5sCandle = null;
  let chartLastCandleTime = null;

  function initLightweightChart() {
    const container = $('tv-chart-canvas-wrap');
    if (!container || !window.LightweightCharts) return;
    if (tvChart) return;

    tvChart = window.LightweightCharts.createChart(container, {
      width: container.clientWidth || 360,
      height: 340,
      layout: {
        background: { type: 'solid', color: '#ffffff' },
        textColor: '#334155',
        fontFamily: "'DM Mono', monospace, -apple-system, sans-serif",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#f8fafc' },
        horzLines: { color: '#f8fafc' },
      },
      crosshair: {
        mode: window.LightweightCharts.CrosshairMode.Normal,
      },
      rightPriceScale: {
        borderColor: '#e2e8f0',
        scaleMargins: { top: 0.1, bottom: 0.22 },
      },
      timeScale: {
        borderColor: '#e2e8f0',
        timeVisible: true,
        secondsVisible: true,
      },
    });

    tvCandleSeries = tvChart.addCandlestickSeries({
      upColor: '#16a34a',
      downColor: '#dc2626',
      borderVisible: false,
      wickUpColor: '#16a34a',
      wickDownColor: '#dc2626',
    });

    tvVolumeSeries = tvChart.addHistogramSeries({
      color: '#cbd5e1',
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    tvChart.subscribeCrosshairMove(param => {
      if (!param || !param.time || !param.seriesData) return;
      const c = param.seriesData.get(tvCandleSeries);
      const v = param.seriesData.get(tvVolumeSeries);
      if (c) {
        if ($('leg-o')) $('leg-o').textContent = Number(c.open).toLocaleString('en-IN', { minimumFractionDigits: 2 });
        if ($('leg-h')) $('leg-h').textContent = Number(c.high).toLocaleString('en-IN', { minimumFractionDigits: 2 });
        if ($('leg-l')) $('leg-l').textContent = Number(c.low).toLocaleString('en-IN', { minimumFractionDigits: 2 });
        if ($('leg-c')) $('leg-c').textContent = Number(c.close).toLocaleString('en-IN', { minimumFractionDigits: 2 });
      }
      if (v && $('leg-v')) {
        $('leg-v').textContent = Number(v.value).toLocaleString('en-IN');
      }
    });

    window.addEventListener('resize', () => {
      if (tvChart && container) {
        tvChart.applyOptions({ width: container.clientWidth });
      }
    });
  }

  async function loadChartCandles(symbol, interval) {
    initLightweightChart();
    if (!tvChart || !tvCandleSeries) return;

    const sym = symbol || state.currentSymbol || 'NIFTY';
    const tf = interval || currentChartInterval || '5s';
    currentChartInterval = tf;

    const statusEl = $('tv-chart-status');
    if (statusEl) statusEl.textContent = `Fetching ${tf} candles…`;

    try {
      const data = await api(`/api/chart/candles?symbol=${encodeURIComponent(sym)}&interval=${encodeURIComponent(tf)}`);
      if (!data.candles || !data.candles.length) {
        if (statusEl) statusEl.textContent = 'No candle data available';
        return;
      }

      const candles = data.candles.map(c => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));

      const volumes = data.candles.map(c => ({
        time: c.time,
        value: c.volume || 100,
        color: c.close >= c.open ? 'rgba(22, 163, 74, 0.25)' : 'rgba(220, 38, 38, 0.25)',
      }));

      tvCandleSeries.setData(candles);
      if (tvVolumeSeries) tvVolumeSeries.setData(volumes);

      tvChart.timeScale().fitContent();

      const last = candles[candles.length - 1];
      if (last) {
        chartLastCandleTime = last.time;
        active5sCandle = { ...last };
        if ($('leg-o')) $('leg-o').textContent = Number(last.open).toLocaleString('en-IN', { minimumFractionDigits: 2 });
        if ($('leg-h')) $('leg-h').textContent = Number(last.high).toLocaleString('en-IN', { minimumFractionDigits: 2 });
        if ($('leg-l')) $('leg-l').textContent = Number(last.low).toLocaleString('en-IN', { minimumFractionDigits: 2 });
        if ($('leg-c')) $('leg-c').textContent = Number(last.close).toLocaleString('en-IN', { minimumFractionDigits: 2 });
      }

      if (statusEl) statusEl.textContent = `${data.date || 'Live'} · ${data.candles.length} ${tf} bars`;
    } catch (err) {
      if (statusEl) statusEl.textContent = cleanErrorMessage(err.message);
    }
  }

  function updateLiveChartTick(ltp) {
    if (!tvCandleSeries || !ltp || ltp <= 0) return;
    const nowSec = Math.floor(Date.now() / 1000);
    const intervalSec = currentChartInterval === '15s' ? 15 : (currentChartInterval === '1m' ? 60 : (currentChartInterval === '5m' ? 300 : (currentChartInterval === '15m' ? 900 : 5)));
    const bucketTime = Math.floor(nowSec / intervalSec) * intervalSec;

    if (!active5sCandle || bucketTime > active5sCandle.time) {
      active5sCandle = {
        time: bucketTime,
        open: ltp,
        high: ltp,
        low: ltp,
        close: ltp,
      };
    } else {
      active5sCandle.high = Math.max(active5sCandle.high, ltp);
      active5sCandle.low = Math.min(active5sCandle.low, ltp);
      active5sCandle.close = ltp;
    }

    try {
      tvCandleSeries.update(active5sCandle);
      if ($('leg-c')) $('leg-c').textContent = Number(ltp).toLocaleString('en-IN', { minimumFractionDigits: 2 });
      if ($('leg-h')) $('leg-h').textContent = Number(active5sCandle.high).toLocaleString('en-IN', { minimumFractionDigits: 2 });
      if ($('leg-l')) $('leg-l').textContent = Number(active5sCandle.low).toLocaleString('en-IN', { minimumFractionDigits: 2 });
    } catch (_) {}
  }

  function updateTradingViewSymbol(symbol) {
    const sym = String(symbol || 'NIFTY').toUpperCase().trim();
    let tvSymbol = 'NSE:NIFTY';
    if (sym.startsWith('BANKNIFTY')) tvSymbol = 'NSE:BANKNIFTY';
    else if (sym.startsWith('FINNIFTY')) tvSymbol = 'NSE:FINNIFTY';
    else if (sym.startsWith('MIDCPNIFTY')) tvSymbol = 'NSE:MIDCPNIFTY';
    else if (sym.startsWith('SENSEX')) tvSymbol = 'BSE:SENSEX';
    else if (sym.startsWith('BANKEX')) tvSymbol = 'BSE:BANKEX';
    else if (sym.includes('NIFTY')) tvSymbol = 'NSE:NIFTY';
    else {
      const match = sym.match(/^[A-Z]+/);
      const base = match ? match[0] : sym;
      const seg = state.exchangeSegment || 'nse_fo';
      const prefix = seg.includes('bse') ? 'BSE:' : 'NSE:';
      tvSymbol = `${prefix}${base}`;
    }

    const label = $('tv-chart-symbol-label');
    if (label) label.textContent = tvSymbol;

    const panel = $('tv-chart-panel');
    if (panel && !panel.classList.contains('hidden')) {
      loadChartCandles(sym, currentChartInterval);
    }
  }

  async function refreshLimits() {
    try {
      const data = await api('/api/limits');
      const funds = Number(data.available_cash ?? data.total_margin ?? 0);
      state.availableFunds = funds;
      const pill = $('scalper-funds-pill');
      if (pill) {
        pill.textContent = `Funds: ${money(funds)}`;
        pill.classList.toggle('low-funds', funds <= 0);
      }
    } catch (_) {}
  }

  async function loadSltpRules() {
    try {
      const data = await api('/api/sltp');
      state.activeSltpRules = Array.isArray(data) ? data : (data.rules || []);
    } catch (_) {
      state.activeSltpRules = [];
    }
  }

  async function executeScalperBuy() {
    if (state.submitting) {
      toast('An order submission is still in progress.', 'warning');
      return;
    }
    try {
      await refreshLimits();
      const lotSize = getLotSize();
      let lots = getLots();
      const ltp = state.currentLtp || 100;
      const funds = state.availableFunds;
      if (funds && funds > 0) {
        const requiredMargin = lots * lotSize * ltp;
        if (requiredMargin > funds) {
          const maxAffordableLots = Math.max(1, Math.floor(funds / (lotSize * ltp)));
          if (maxAffordableLots < lots) {
            toast(`⚡ Scalper Mode: Auto-adjusted lots from ${lots} to ${maxAffordableLots} (Max affordable with ${money(funds)} funds)`, 'warning', 4500);
            lots = maxAffordableLots;
            $('lots-input').value = lots;
            updateQuantity();
          }
        }
      }

      const order = snapshotOrder('BUY');
      order.user_confirmed = true;
      order.order_type = 'MKT';

      state.submitting = true;
      $('place-buy').disabled = true;
      const buyText = $('place-buy').querySelector('span');
      if (buyText) buyText.textContent = '⚡ BUYING...';

      toast(`⚡ Scalper 1-Click: Submitting BUY order for ${order.lots} lots (${order.lots * order.lot_size} units) ${order.symbol} at Market...`, 'info', 2500);

      const result = await api('/api/orders', {
        method: 'POST',
        body: JSON.stringify(order)
      });

      toast(`⚡ Order Executed: ${order.symbol} BUY ${order.lots} lots filled!`, 'success', 4500);
      await loadOrders();
      await loadPositions();
      await loadSltpRules();
    } catch (err) {
      toast(cleanErrorMessage(err.message), 'error', 6000);
    } finally {
      state.submitting = false;
      $('place-buy').disabled = false;
      const buyText = $('place-buy').querySelector('span');
      if (buyText) buyText.textContent = 'Place BUY';
    }
  }

  function snapshotOrder(side) {
    const symbol = $('symbol-input').value.trim().toUpperCase();
    const type = $('type-select').value;
    const lots = getLots();
    const lotSize = getLotSize();
    const rawPrice = $('price-input').value.trim() ? Number.parseFloat($('price-input').value) : null;
    const rawTrigger = $('trigger-input').value.trim() ? Number.parseFloat($('trigger-input').value) : null;
    const price = (type === 'L' || type === 'SL') ? rawPrice : null;
    const trigger = (type === 'SL' || type === 'SL-M') ? rawTrigger : null;
    const validity = $('validity-select') ? $('validity-select').value : 'DAY';

    const autoSltp = $('sltp-toggle') ? $('sltp-toggle').checked : false;
    const rawSl = $('sltp-sl-input')?.value.trim();
    const rawTp = $('sltp-tp-input')?.value.trim();
    const slPrice = autoSltp && rawSl ? Number.parseFloat(rawSl) : null;
    const tpPrice = autoSltp && rawTp ? Number.parseFloat(rawTp) : null;

    if (!symbol) throw new Error('Enter a trading symbol before reviewing an order.');
    if (!/^[A-Z0-9][A-Z0-9 .&_/-]{0,63}$/.test(symbol)) throw new Error('Symbol contains unsupported characters.');
    if (!Number.isInteger(lots) || lots < 1 || lots > 1000) throw new Error('Lots must be between 1 and 1,000.');
    if (!Number.isInteger(lotSize) || lotSize < 1 || lotSize > 100000) throw new Error('Lot size must be between 1 and 100,000.');
    if ((type === 'L' || type === 'SL') && (!Number.isFinite(price) || price <= 0)) throw new Error('Enter a valid limit price.');
    if ((type === 'SL' || type === 'SL-M') && (!Number.isFinite(trigger) || trigger <= 0)) throw new Error('Enter a valid trigger price.');

    let segment = $('exchange-select').value;
    if (segment === 'all') {
      segment = state.selectedInstrument ? state.selectedInstrument.exchange_segment : 'nse_fo';
      $('exchange-select').value = segment;
      state.exchangeSegment = segment;
      updateExchangeChip(segment);
    }

    return {
      symbol,
      side,
      lots,
      lot_size: lotSize,
      exchange_segment: segment,
      product: $('product-select').value,
      order_type: type,
      price,
      trigger_price: trigger,
      validity,
      auto_sltp: autoSltp,
      sl_price: slPrice,
      tp_price: tpPrice,
      user_confirmed: false,
    };
  }

  function addReviewRow(label, value) {
    const row = document.createElement('div');
    row.className = 'review-row';
    const left = document.createElement('span');
    left.textContent = label;
    const right = document.createElement('strong');
    right.textContent = value;
    row.append(left, right);
    $('review-details').appendChild(row);
  }

  function openReview(side) {
    if (state.submitting) {
      toast('An order submission is still in progress.', 'warning');
      return;
    }
    try {
      state.pendingOrder = snapshotOrder(side);
      $('review-title').innerHTML = `${side === 'BUY' ? 'Review BUY' : 'Review SELL'}<span class="title-dot">.</span>`;
      $('review-details').replaceChildren();
      const order = state.pendingOrder;

      addReviewRow('Instrument', order.symbol);
      addReviewRow('Exchange', segmentLabel(order.exchange_segment));
      addReviewRow('Transaction', order.side);
      addReviewRow('Quantity', `${order.lots} lot${order.lots === 1 ? '' : 's'} × ${order.lot_size} = ${order.lots * order.lot_size} units`);
      addReviewRow('Product', order.product);
      addReviewRow('Order type', order.order_type);
      addReviewRow('Validity', order.validity);
      if (Number.isFinite(state.currentLtp)) addReviewRow('Indicative LTP', `${money(state.currentLtp)} · ${formatTime(state.lastQuoteTimestamp)}`);
      if (order.price !== null) addReviewRow('Limit price', money(order.price));
      if (order.trigger_price !== null) addReviewRow('Trigger price', money(order.trigger_price));
      if (order.auto_sltp) {
        if (order.sl_price !== null) addReviewRow('🛡️ Auto Stop Loss (SL)', money(order.sl_price));
        if (order.tp_price !== null) addReviewRow('🎯 Auto Take Profit (TP)', money(order.tp_price));
      }

      const live = state.mode === 'live' && state.authenticated;
      const warning = $('review-mode-warning');
      warning.classList.toggle('live', live);
      warning.textContent = live
        ? 'LIVE ORDER: Confirming sends this order directly to Kotak Neo. Once placed, verify status in the order book.'
        : 'SIMULATION ONLY: Confirming logs a test simulated order. No order reaches Kotak Neo.';

      $('confirm-check').checked = false;
      $('confirm-order').disabled = true;
      $('confirm-order').classList.toggle('danger', live && side === 'SELL');
      $('confirm-order').textContent = live ? `Place live ${side}` : `Simulate ${side}`;
      $('review-modal').classList.remove('hidden');
      if (window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
        $('confirm-check').focus();
      }
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function confirmOrder() {
    if (!state.pendingOrder || !$('confirm-check').checked) return;
    const btn = $('confirm-order');
    state.submitting = true;
    $('place-buy').disabled = true;
    $('place-sell').disabled = true;
    btn.disabled = true;
    btn.textContent = 'Submitting…';
    const orderSnapshot = { ...state.pendingOrder, user_confirmed: true };
    $('review-modal').classList.add('hidden');

    try {
      const result = await api('/api/orders', { method: 'POST', body: JSON.stringify(orderSnapshot) });
      toast(result.message || 'Order placed successfully.', 'success');
      state.pendingOrder = null;
      await loadOrders();
    } catch (error) {
      const msg = cleanErrorMessage(error.message);
      toast(msg, 'error', 6000);
      if (state.mode === 'live' && state.authenticated) {
        setTimeout(() => toast('Please check Kotak Neo order book before retrying.', 'warning', 7000), 2000);
      }
    } finally {
      state.submitting = false;
      $('place-buy').disabled = false;
      $('place-sell').disabled = false;
      btn.textContent = state.mode === 'live' && state.authenticated ? `Place live ${orderSnapshot.side}` : `Simulate ${orderSnapshot.side}`;
      btn.disabled = !$('confirm-check').checked;
    }
  }

  function renderOrders(orders) {
    state.lastOrders = orders || [];
    state.orderCount = orders.length;
    $('order-count').textContent = `${orders.length} ORDER${orders.length === 1 ? '' : 'S'}`;
    const list = $('orders-list');

    const completedOrders = [];
    const failedOrders = [];
    const pendingOrders = [];

    for (const item of orders) {
      const st = String(item.status || '').toLowerCase();
      if (['completed', 'complete', 'traded', 'filled', 'simulated'].includes(st)) {
        completedOrders.push(item);
      } else if (['rejected', 'cancelled', 'failed'].includes(st) || st.includes('reject') || st.includes('cancel') || st.includes('fail')) {
        failedOrders.push(item);
      } else {
        pendingOrders.push(item);
      }
    }

    if ($('orders-all-count')) $('orders-all-count').textContent = orders.length;
    if ($('orders-completed-count')) $('orders-completed-count').textContent = completedOrders.length;
    if ($('orders-failed-count')) $('orders-failed-count').textContent = failedOrders.length;

    let displayList = [];
    if (state.ordersTab === 'completed') {
      displayList = completedOrders;
    } else if (state.ordersTab === 'failed') {
      displayList = failedOrders;
    } else {
      displayList = orders;
    }

    if (!displayList.length) {
      const emptyNote = state.ordersTab === 'completed'
        ? 'No completed orders yet today.'
        : (state.ordersTab === 'failed' ? 'No failed or rejected orders.' : 'Nothing here yet. Orders and executions will appear here.');
      list.innerHTML = `<div class="empty-state"><span class="empty-glyph">↗</span><div><strong>Nothing here yet</strong><p>${emptyNote}</p></div></div>`;
      return;
    }

    list.replaceChildren();

    const createOrderRow = (item) => {
      const row = document.createElement('div');
      row.className = 'order-item';
      const side = document.createElement('div');
      side.className = `order-side-dot ${item.side}`;
      side.textContent = item.side === 'BUY' ? '↗' : '↘';

      const main = document.createElement('div');
      main.className = 'order-item-main';
      const title = document.createElement('strong');
      title.textContent = item.symbol;
      const meta = document.createElement('span');
      meta.textContent = (item.status === 'rejected' || String(item.status).toLowerCase().includes('reject')) && item.message
        ? `${item.quantity} units · ${item.product} · REJECTED: ${cleanErrorMessage(item.message)} · ${formatTime(item.created_at)}`
        : `${item.quantity} units · ${item.product} · ${formatTime(item.created_at)}`;
      main.append(title, meta);

      const status = document.createElement('div');
      status.className = 'order-item-status';
      const tag = document.createElement('span');
      const stLower = String(item.status).toLowerCase();
      const badgeCls = ['completed', 'traded', 'filled', 'simulated'].includes(stLower) ? 'completed' : (['rejected', 'cancelled', 'failed'].includes(stLower) || stLower.includes('reject') || stLower.includes('fail') ? 'failed' : 'pending');
      tag.className = `order-badge ${badgeCls}`;
      tag.textContent = item.mode === 'simulation' ? 'SIMULATED' : String(item.status).toUpperCase();
      const id = document.createElement('small');
      id.textContent = item.broker_order_id ? `#${item.broker_order_id}` : `#${item.id}`;
      status.append(tag, id);

      if (item.cancel_allowed && item.broker_order_id) {
        const cancel = document.createElement('button');
        cancel.className = 'cancel-order-button';
        cancel.textContent = 'Cancel';
        cancel.type = 'button';
        cancel.addEventListener('click', async () => {
          if (!window.confirm(`Cancel pending ${item.side} order ${item.symbol} (#${item.broker_order_id})?`)) return;
          cancel.disabled = true;
          try {
            const result = await api(`/api/orders/${encodeURIComponent(item.broker_order_id)}/cancel`, { method: 'POST', body: '{}' });
            toast(result.message, 'success');
            await loadOrders();
          } catch (error) {
            toast(error.message, 'error', 5500);
            await loadOrders();
          }
        });
        status.append(cancel);
      }
      row.append(side, main, status);
      return row;
    };

    if (state.ordersTab === 'all' && completedOrders.length > 0 && failedOrders.length > 0) {
      if (pendingOrders.length > 0) {
        const hPending = document.createElement('div');
        hPending.className = 'order-section-divider';
        hPending.textContent = `Pending (${pendingOrders.length})`;
        list.appendChild(hPending);
        pendingOrders.forEach(o => list.appendChild(createOrderRow(o)));
      }

      const hCompleted = document.createElement('div');
      hCompleted.className = 'order-section-divider';
      hCompleted.textContent = `Completed (${completedOrders.length})`;
      list.appendChild(hCompleted);
      completedOrders.forEach(o => list.appendChild(createOrderRow(o)));

      const hFailed = document.createElement('div');
      hFailed.className = 'order-section-divider';
      hFailed.textContent = `Failed / Rejected (${failedOrders.length})`;
      list.appendChild(hFailed);
      failedOrders.forEach(o => list.appendChild(createOrderRow(o)));
    } else {
      for (const item of displayList) {
        list.appendChild(createOrderRow(item));
      }
    }
  }

  function setOrdersFilter(filter) {
    state.ordersTab = filter;
    if ($('orders-filter-all')) $('orders-filter-all').classList.toggle('active', filter === 'all');
    if ($('orders-filter-completed')) $('orders-filter-completed').classList.toggle('active', filter === 'completed');
    if ($('orders-filter-failed')) $('orders-filter-failed').classList.toggle('active', filter === 'failed');
    if (state.lastOrders && state.lastOrders.length) {
      renderOrders(state.lastOrders);
    } else {
      loadOrders();
    }
  }

  async function loadOrders() {
    if (cloudDemoMode) {
      renderOrders(state.demoOrders);
      return;
    }
    try {
      const orders = await api('/api/orders?limit=50');
      renderOrders(orders);
    } catch (error) {
      $('orders-list').innerHTML = '';
      const note = document.createElement('div');
      note.className = 'positions-note';
      note.textContent = cleanErrorMessage(error.message);
      $('orders-list').append(note);
    }
  }

  function setActivityTab(tab) {
    state.activityTab = tab;
    const isOrders = tab === 'orders';
    const isPositions = tab === 'positions';
    const isAudit = tab === 'audit';

    $('orders-panel').classList.toggle('hidden', !isOrders);
    $('positions-panel').classList.toggle('hidden', !isPositions);
    $('audit-panel').classList.toggle('hidden', !isAudit);

    $('orders-tab').classList.toggle('active', isOrders);
    $('positions-tab').classList.toggle('active', isPositions);
    $('audit-tab').classList.toggle('active', isAudit);

    $('orders-tab').setAttribute('aria-selected', String(isOrders));
    $('positions-tab').setAttribute('aria-selected', String(isPositions));
    $('audit-tab').setAttribute('aria-selected', String(isAudit));

    $('activity-title').textContent = isOrders ? 'Orders' : (isPositions ? 'Positions & P&L' : 'Audit Log');

    if (isOrders) loadOrders();
    else if (isPositions) loadPositions();
    else if (isAudit) loadAuditLogs();
  }

  async function loadPositions() {
    $('positions-note').textContent = 'Refreshing Kotak positions and quotes…';
    if (cloudDemoMode) {
      $('positions-note').textContent = 'Live positions and current P&L require the local Kotak backend.';
      if ($('today-pnl')) $('today-pnl').textContent = '—';
      if ($('total-net-pnl')) $('total-net-pnl').textContent = '—';
      if ($('header-pnl-value')) $('header-pnl-value').textContent = '—';
      if ($('header-net-pnl-value')) $('header-net-pnl-value').textContent = '—';
      $('total-mtm').textContent = '—';
      $('total-position-pnl').textContent = '—';
      $('positions-list').replaceChildren();
      return;
    }
    try {
      const data = await api(`/api/positions?tab=${state.positionsTab}&closed=${state.positionsTab === 'closed'}`);

      const todayVal = Number(data.total_today_pnl ?? data.total_position_pnl);
      const netVal = Number(data.total_net_pnl ?? data.total_today_pnl ?? data.total_position_pnl);
      const mtmVal = Number(data.total_unrealized_pnl ?? data.total_mtm);
      const posVal = Number(data.total_realized_pnl ?? data.total_position_pnl);

      const todayEl = $('today-pnl');
      const netEl = $('total-net-pnl');
      const mtmEl = $('total-mtm');
      const posEl = $('total-position-pnl');

      if (todayEl) {
        todayEl.textContent = money(data.total_today_pnl ?? data.total_position_pnl, true);
        todayEl.className = `pnl-primary-value ${Number.isFinite(todayVal) ? (todayVal > 0 ? 'pnl-positive' : (todayVal < 0 ? 'pnl-negative' : '')) : ''}`;
      }

      if (netEl) {
        netEl.textContent = money(netVal, true);
        netEl.className = `pnl-primary-value ${Number.isFinite(netVal) ? (netVal > 0 ? 'pnl-positive' : (netVal < 0 ? 'pnl-negative' : '')) : ''}`;
      }

      const headerPnlEl = $('header-pnl-value');
      if (headerPnlEl && Number.isFinite(todayVal)) {
        headerPnlEl.textContent = money(todayVal, true);
        headerPnlEl.className = `header-pnl-value ${todayVal > 0 ? 'positive' : (todayVal < 0 ? 'negative' : '')}`;
      }

      const headerNetPnlEl = $('header-net-pnl-value');
      if (headerNetPnlEl && Number.isFinite(netVal)) {
        headerNetPnlEl.textContent = money(netVal, true);
        headerNetPnlEl.className = `header-pnl-value ${netVal > 0 ? 'positive' : (netVal < 0 ? 'negative' : '')}`;
      }

      if (data.charges) {
        const c = data.charges;
        if ($('charges-card')) $('charges-card').classList.remove('hidden');
        if ($('charge-govt')) $('charge-govt').textContent = money(c.govt_charges);
        if ($('charge-brokerage')) $('charge-brokerage').textContent = money(c.outside_brokerage);
        if ($('charge-outside-orders')) $('charge-outside-orders').textContent = c.outside_completed_orders;
        if ($('charge-total')) $('charge-total').textContent = money(c.total_charges);

        const netCard = $('header-net-pnl');
        if (netCard) {
          netCard.title = `Net P&L: ${money(netVal, true)} | Gross: ${money(todayVal, true)} | Govt Charges: ${money(c.govt_charges)} | Outside Brokerage: ${money(c.outside_brokerage)} (Total Charges: ${money(c.total_charges)}) · Click for breakdown`;
        }
      }

      if (mtmEl) {
        mtmEl.textContent = money(data.total_unrealized_pnl ?? data.total_mtm, true);
        mtmEl.className = Number.isFinite(mtmVal) ? (mtmVal > 0 ? 'pnl-positive' : (mtmVal < 0 ? 'pnl-negative' : '')) : '';
      }

      if (posEl) {
        posEl.textContent = money(data.total_realized_pnl ?? data.total_position_pnl, true);
        posEl.className = Number.isFinite(posVal) ? (posVal > 0 ? 'pnl-positive' : (posVal < 0 ? 'pnl-negative' : '')) : '';
      }

      if ($('pos-open-count')) $('pos-open-count').textContent = data.open_count ?? 0;
      if ($('pos-closed-count')) $('pos-closed-count').textContent = data.closed_count ?? 0;
      if ($('pos-all-count')) $('pos-all-count').textContent = data.all_count ?? 0;

      $('positions-note').textContent = state.positionsTab === 'closed'
        ? `Today’s closed trades · gross realized P&L · ${formatTime(data.updated_at)}`
        : `Overall Today’s P&L · Kotak quotes · ${formatTime(data.updated_at)}`;

      const list = $('positions-list');
      list.replaceChildren();

      const items = data.positions || [];
      if (!items.length) {
        $('positions-note').textContent = `No ${state.positionsTab} positions currently found on Kotak.`;
        list.innerHTML = `<div class="empty-state"><span class="empty-glyph">📊</span><div><strong>No ${state.positionsTab} positions</strong><p>Positions and P&L will appear here.</p></div></div>`;
        return;
      }

      for (const p of items) {
        const row = document.createElement('div');
        row.className = 'position-row';
        const title = document.createElement('div');
        title.className = 'position-title-wrap';

        const sym = document.createElement('strong');
        sym.textContent = p.symbol;

        const badge = document.createElement('span');
        badge.className = `order-badge ${p.closed ? 'completed' : 'pending'}`;
        badge.textContent = p.closed ? 'CLOSED' : `${p.quantity > 0 ? '+' : ''}${p.quantity}`;

        title.append(sym, badge);

        if (!p.closed && Math.abs(p.quantity) > 0) {
          const activeRule = (state.activeSltpRules || []).find(r => r.symbol === p.symbol && r.status === 'active');
          if (activeRule) {
            const sltpTag = document.createElement('span');
            sltpTag.className = 'pos-sltp-tag';
            sltpTag.innerHTML = `🛡️ SL ${money(activeRule.sl_price)} · TP ${money(activeRule.tp_price)} `;
            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'btn-cancel-sltp';
            cancelBtn.textContent = '✕';
            cancelBtn.title = 'Cancel software SL/TP';
            cancelBtn.addEventListener('click', async (e) => {
              e.stopPropagation();
              try {
                await api(`/api/sltp/${activeRule.id}`, { method: 'DELETE' });
                toast(`SL/TP cancelled for ${p.symbol}`, 'info');
                await loadSltpRules();
                await loadPositions();
              } catch (err) {
                toast(cleanErrorMessage(err.message), 'error');
              }
            });
            sltpTag.appendChild(cancelBtn);
            title.appendChild(sltpTag);
          } else {
            const addSltpBtn = document.createElement('button');
            addSltpBtn.type = 'button';
            addSltpBtn.className = 'btn-add-sltp';
            addSltpBtn.textContent = '+ 5% SL / 10% TP';
            addSltpBtn.title = 'Approve & attach 5% SL and 10% TP protection';
            addSltpBtn.addEventListener('click', async (e) => {
              e.stopPropagation();
              try {
                const refPrice = Number(p.ltp || p.avg_buy_price || p.avg_sell_price || 100);
                const isLong = p.quantity > 0;
                const slPrice = isLong ? Math.max(0.05, refPrice * 0.95) : refPrice * 1.05;
                const tpPrice = isLong ? refPrice * 1.10 : Math.max(0.05, refPrice * 0.90);
                await api('/api/sltp', {
                  method: 'POST',
                  body: JSON.stringify({
                    symbol: p.symbol,
                    exchange_segment: p.exchange || 'nse_fo',
                    product: p.product || 'NRML',
                    side: isLong ? 'BUY' : 'SELL',
                    quantity: Math.abs(p.quantity),
                    entry_price: refPrice,
                    sl_price: Number(slPrice.toFixed(2)),
                    tp_price: Number(tpPrice.toFixed(2)),
                  })
                });
                toast(`🛡️ 5% SL (${money(slPrice)}) & 10% TP (${money(tpPrice)}) activated for ${p.symbol}!`, 'success', 4000);
                await loadSltpRules();
                await loadPositions();
              } catch (err) {
                toast(cleanErrorMessage(err.message), 'error');
              }
            });
            title.appendChild(addSltpBtn);
          }

          if (p.ltp && p.symbol) {
            api('/api/sltp/check', {
              method: 'POST',
              body: JSON.stringify({ symbol: p.symbol, ltp: Number(p.ltp) })
            }).then(res => {
              if (res && res.triggered_count > 0) {
                res.triggered.forEach(t => {
                  toast(`🛡️ OCO Triggered: ${t.trigger_type} hit for ${p.symbol} at ₹${t.trigger_ltp}!`, 'warning', 6000);
                });
                loadPositions();
                loadOrders();
              }
            }).catch(() => {});
          }
        }

        const detail = document.createElement('span');
        detail.className = 'position-detail-text';
        if (p.closed) {
          detail.textContent = `${p.product || 'NRML'} · Matched ${p.buy_qty || p.sell_qty || 0} units · Buy Avg ${money(p.avg_buy_price)} · Sell Avg ${money(p.avg_sell_price)}`;
        } else {
          detail.textContent = `${p.product || 'NRML'} · ${p.quantity} units · LTP ${money(p.ltp)}${p.pnl_error ? ` · ${p.pnl_error}` : ''}`;
        }

        const pnl = document.createElement('b');
        const pnlVal = Number(p.closed ? (p.realized_pnl ?? p.position_pnl) : (p.unrealized_pnl ?? p.mtm_pnl ?? p.position_pnl));
        pnl.textContent = money(pnlVal, true);

        if (Number.isFinite(pnlVal)) {
          pnl.className = pnlVal > 0 ? 'pnl-positive' : (pnlVal < 0 ? 'pnl-negative' : '');
        }

        row.append(title, detail, pnl);
        list.append(row);
      }
    } catch (error) {
      $('positions-note').textContent = cleanErrorMessage(error.message);
    }
  }

  function setPositionsTab(tab) {
    state.positionsTab = tab;
    if ($('open-positions-tab')) $('open-positions-tab').classList.toggle('active', tab === 'open');
    if ($('closed-positions-tab')) $('closed-positions-tab').classList.toggle('active', tab === 'closed');
    if ($('all-positions-tab')) $('all-positions-tab').classList.toggle('active', tab === 'all');
    loadPositions();
  }

  async function loadAuditLogs() {
    const list = $('audit-list');
    try {
      const logs = await api('/api/audit?limit=40');
      if (!logs || !logs.length) {
        list.innerHTML = '<div class="empty-state"><span class="empty-glyph">📋</span><div><strong>No audit events</strong><p>Security and order activity will be logged here.</p></div></div>';
        return;
      }
      list.replaceChildren();
      for (const item of logs) {
        const row = document.createElement('div');
        row.className = 'audit-item';

        const header = document.createElement('div');
        header.className = 'audit-header';

        const tag = document.createElement('span');
        const type = item.event_type || 'event';
        tag.className = `audit-tag ${type.includes('login') ? 'login' : (type.includes('order') ? 'order' : (type.includes('cancel') ? 'cancel' : (type.includes('reject') ? 'reject' : '')))}`;
        tag.textContent = type.replace(/_/g, ' ').toUpperCase();

        const time = document.createElement('span');
        time.className = 'audit-time';
        time.textContent = formatTime(item.created_at);
        header.append(tag, time);

        const detail = document.createElement('div');
        detail.className = 'audit-detail';
        const d = item.detail || {};
        if (d.symbol && d.side) {
          detail.textContent = `${d.side} ${d.quantity || ''} units of ${d.symbol}${d.order_id ? ` (Kotak #${d.order_id})` : ''}${d.message ? ` — ${d.message}` : ''}`;
        } else if (d.note) {
          detail.textContent = d.note;
        } else {
          detail.textContent = JSON.stringify(d).replace(/["{}]/g, '').replace(/,/g, ' · ');
        }

        row.append(header, detail);
        list.appendChild(row);
      }
    } catch (error) {
      list.innerHTML = `<div class="positions-note">${cleanErrorMessage(error.message)}</div>`;
    }
  }

  async function loadIndexQuotes() {
    if (cloudDemoMode) {
      const demo = await demoApi('/api/indices/quotes');
      updateIndexUI(demo.indices);
      return;
    }
    try {
      const data = await api('/api/indices/quotes');
      updateIndexUI(data.indices || []);
    } catch (error) {
      ['nifty', 'banknifty', 'sensex'].forEach(key => {
        if ($(`index-${key}`).textContent === '—') {
          const el = $(`index-${key}-change`);
          if (el) el.textContent = 'Quote offline';
        }
      });
    }
  }

  function updateIndexUI(indices) {
    const keys = { 'NIFTY': 'nifty', 'BANK NIFTY': 'banknifty', 'BANKNIFTY': 'banknifty', 'SENSEX': 'sensex' };
    for (const item of indices) {
      const key = keys[item.name];
      if (!key) continue;
      const priceEl = $(`index-${key}`);
      const changeEl = $(`index-${key}-change`);
      if (priceEl && item.ltp != null) {
        priceEl.textContent = Number(item.ltp).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
      if (changeEl) {
        const change = Number(item.change);
        const pct = Number(item.change_percent);
        if (Number.isFinite(change) && Number.isFinite(pct)) {
          const sign = change > 0 ? '+' : (change < 0 ? '-' : '');
          const pctSign = pct > 0 ? '+' : (pct < 0 ? '-' : '');
          changeEl.textContent = `${sign}${Math.abs(change).toFixed(2)} (${pctSign}${Math.abs(pct).toFixed(2)}%)`;
          changeEl.className = `index-change ${change > 0 ? 'positive' : (change < 0 ? 'negative' : '')}`;
        } else if (item.ltp != null) {
          changeEl.textContent = 'Live Kotak quote';
          changeEl.className = 'index-change';
        }
      }
    }
    updateIndexTickerSlide();
  }

  async function refreshStatus() {
    try {
      const data = await api('/api/status');
      state.liveTradingEnabled = !!data.live_trading_enabled;
      state.authenticated = !!data.broker_authenticated;
      state.kotakEgressIp = data.kotak_egress_ip || null;
      state.kotakSessionIp = data.kotak_session_ip || null;
      state.serverEgressIp = data.server_egress_ip || null;
      const modalIp = $('modal-egress-ip');
      if (modalIp) {
        modalIp.textContent = state.kotakEgressIp || state.serverEgressIp || 'Fetching...';
      }
      state.mode = data.mode || 'simulation';
      updateModeUI();

      if (data.selected_symbol && data.selected_symbol.updated_at && data.selected_symbol.updated_at !== state.remoteSymbolTimestamp) {
        state.remoteSymbolTimestamp = data.selected_symbol.updated_at;
        if ($('review-modal').classList.contains('hidden')) {
          renderSymbol(data.selected_symbol.symbol, data.selected_symbol.exchange_segment, data.selected_symbol.source, data.selected_symbol.updated_at);
        }
      }

      if (!data.extension_bridge_configured) {
        state.lastBridgeNote = 'Extension bridge secret not configured. Optional symbol sync is off; search and option-chain work directly.';
      } else if (!data.selected_symbol?.updated_at) {
        state.lastBridgeNote = 'Extension bridge is active. Select any ticker in Kotak Neo to auto-sync it here.';
      }
      if (!state.selectedInstrument && !$('bridge-note').textContent.startsWith('Symbol bridge is active')) {
        $('bridge-note').textContent = state.lastBridgeNote;
      }
    } catch (error) {
      $('connection-footer').textContent = 'Backend offline · check terminal';
      $('bridge-note').textContent = 'Backend service is not reachable. Ensure the local server is running.';
    }
  }

  function openConnect() {
    if (state.authenticated) {
      api('/api/auth/logout', { method: 'POST', body: '{}' })
        .then(() => {
          state.authenticated = false;
          state.kotakEgressIp = null;
          state.kotakSessionIp = null;
          state.mode = 'simulation';
          updateModeUI();
          toast('Kotak Neo session disconnected.', 'info');
        })
        .catch(e => toast(e.message, 'error'));
      return;
    }
    $('totp-input').value = '';
    $('mpin-input').value = '';
    $('connect-modal').classList.remove('hidden');
    if (window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      $('totp-input').focus();
    }
  }

  async function submitConnect() {
    const totp = $('totp-input').value.trim();
    const mpin = $('mpin-input').value.trim();
    if (!/^\d{6}$/.test(totp)) {
      toast('Enter the 6-digit code from your authenticator app.', 'warning');
      return;
    }
    if (!/^\d{4,8}$/.test(mpin)) {
      toast('Enter your Kotak trading MPIN (4–8 digits).', 'warning');
      return;
    }
    const button = $('submit-connect');
    button.disabled = true;
    button.textContent = 'Authenticating…';
    try {
      const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ totp, mpin }) });
      $('connect-modal').classList.add('hidden');
      state.authenticated = !!result.broker_authenticated;
      state.mode = result.mode || 'simulation';
      state.kotakEgressIp = result.kotak_egress_ip || null;
      state.kotakSessionIp = result.kotak_egress_ip || null;
      updateModeUI();
      toast(result.message || 'Connected to Kotak Neo.', 'success');
      loadOrders();
      loadIndexQuotes();
    } catch (error) {
      toast(error.message, 'error', 6000);
    } finally {
      $('mpin-input').value = '';
      button.disabled = false;
      button.textContent = 'Authenticate';
    }
  }

  async function openPip() {
    if (document.body.dataset.pipWindow === 'true') {
      window.close();
      return;
    }
    if (state.pipWindow && !state.pipWindow.closed) {
      state.pipWindow.close();
      return;
    }
    if ('documentPictureInPicture' in window && window.documentPictureInPicture?.requestWindow) {
      try {
        const pip = await window.documentPictureInPicture.requestWindow({ width: 410, height: 790 });
        state.pipWindow = pip;
        const base = pip.document.createElement('base');
        base.href = location.origin + '/';
        pip.document.head.appendChild(base);

        const cssLinks = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
        for (const link of cssLinks) {
          const clone = pip.document.createElement('link');
          clone.rel = 'stylesheet';
          clone.href = link.href;
          pip.document.head.appendChild(clone);
        }

        const viewport = pip.document.createElement('meta');
        viewport.name = 'viewport';
        viewport.content = 'width=device-width, initial-scale=1';
        pip.document.head.appendChild(viewport);

        pip.document.title = 'Neo PIP — Trading Ticket';
        pip.document.body.innerHTML = document.body.innerHTML;
        pip.document.querySelectorAll('script').forEach(script => script.remove());
        pip.document.body.classList.add('pip-mode');
        pip.document.body.dataset.pipWindow = 'true';

        const script = pip.document.createElement('script');
        script.src = new URL('/static/app.js', location.origin).href;
        script.async = false;
        pip.document.body.appendChild(script);

        $('pip-btn').querySelector('span').textContent = 'PiP open';
        $('pip-btn').title = 'Close the floating trading window';
        pip.addEventListener('pagehide', () => {
          state.pipWindow = null;
          $('pip-btn').querySelector('span').textContent = 'Pop out';
          $('pip-btn').title = 'Open picture-in-picture window';
        }, { once: true });

        toast('Floating ticket opened alongside Kotak Neo.', 'success');
      } catch (error) {
        toast(`Could not open Picture-in-Picture: ${error.message}`, 'error');
      }
    } else {
      const child = window.open('/', 'neo-pip-window', 'popup=yes,width=430,height=790,resizable=yes,scrollbars=yes');
      if (!child) toast('Browser blocked popup window. Allow popups for this origin.', 'warning');
      else toast('Opened compact window popup.', 'info');
    }
  }

  // Event Listeners
  $('buy-btn').addEventListener('click', () => {
    setSide('BUY');
    calculateAndPrefillSltp(true);
  });
  $('sell-btn').addEventListener('click', () => {
    setSide('SELL');
    calculateAndPrefillSltp(true);
  });
  $('place-buy').addEventListener('click', () => {
    if (state.scalperMode) {
      executeScalperBuy();
    } else {
      openReview('BUY');
    }
  });
  $('place-sell').addEventListener('click', () => openReview('SELL'));

  if ($('scalper-mode-toggle')) {
    $('scalper-mode-toggle').addEventListener('change', () => {
      state.scalperMode = $('scalper-mode-toggle').checked;
      const orderCard = $('order-card');
      if (orderCard) orderCard.classList.toggle('scalper-active', state.scalperMode);
      const buySub = $('place-buy')?.querySelector('.btn-sub');
      if (buySub) {
        buySub.textContent = state.scalperMode ? '⚡ Instant Market BUY' : 'Review details';
      }
      if (state.scalperMode) {
        if ($('type-select')) {
          $('type-select').value = 'MKT';
          updateOrderTypeFields();
        }
        refreshLimits();
        toast('⚡ Scalper Mode Active: 1-Click Instant Market BUY enabled!', 'warning', 3500);
      } else {
        toast('Scalper Mode disabled. Normal review modal restored.', 'info', 2000);
      }
    });
  }

  if ($('tv-chart-toggle')) {
    $('tv-chart-toggle').addEventListener('click', () => {
      const panel = $('tv-chart-panel');
      const open = panel.classList.toggle('hidden') === false;
      $('tv-chart-toggle').setAttribute('aria-expanded', String(open));
      const arrow = $('tv-chart-toggle').querySelector('.toggle-arrow');
      if (arrow) arrow.textContent = open ? '▴' : '▾';
      if (open) {
        initLightweightChart();
        setTimeout(() => {
          loadChartCandles(state.currentSymbol, currentChartInterval);
        }, 50);
      }
    });
  }

  document.querySelectorAll('.chart-tf-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.chart-tf-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tf = btn.dataset.tf || '5s';
      currentChartInterval = tf;
      const badge = $('tv-chart-tf-badge');
      if (badge) badge.textContent = `${tf.toUpperCase()} ${tf.includes('s') ? 'SCALPER' : 'CANDLES'}`;
      
      const panel = $('tv-chart-panel');
      if (panel && panel.classList.contains('hidden')) {
        $('tv-chart-toggle')?.click();
      } else {
        loadChartCandles(state.currentSymbol, tf);
      }
    });
  });

  if ($('tv-chart-popout')) {
    $('tv-chart-popout').addEventListener('click', (e) => {
      e.stopPropagation();
      const symLabel = $('tv-chart-symbol-label')?.textContent || 'NSE:NIFTY';
      const popoutUrl = `https://in.tradingview.com/chart/?symbol=${encodeURIComponent(symLabel)}`;
      window.open(popoutUrl, '_blank', 'noopener,noreferrer');
    });
  }

  if ($('sltp-toggle')) {
    $('sltp-toggle').addEventListener('change', () => {
      const enabled = $('sltp-toggle').checked;
      state.autoSltp = enabled;
      const wrap = $('sltp-fields-wrap');
      if (wrap) {
        wrap.style.opacity = enabled ? '1' : '0.4';
        wrap.style.pointerEvents = enabled ? 'auto' : 'none';
      }
    });
  }

  document.querySelectorAll('.sltp-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sltp-preset').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.slPercent = parseFloat(btn.dataset.sl) || 5;
      state.tpPercent = parseFloat(btn.dataset.tp) || 10;
      calculateAndPrefillSltp(true);
    });
  });

  if ($('sltp-sl-input')) {
    $('sltp-sl-input').addEventListener('input', () => {
      $('sltp-sl-input').dataset.autoPrefilled = 'false';
    });
  }
  if ($('sltp-tp-input')) {
    $('sltp-tp-input').addEventListener('input', () => {
      $('sltp-tp-input').dataset.autoPrefilled = 'false';
    });
  }

  if ($('btn-exit-all')) {
    $('btn-exit-all').addEventListener('click', async () => {
      const ok = window.confirm('⚠️ PANIC EXIT ALL:\n\nAre you sure you want to cancel ALL open/pending orders and square off ALL running positions at Market?');
      if (!ok) return;
      const btn = $('btn-exit-all');
      btn.disabled = true;
      btn.textContent = 'EXITING...';
      try {
        const res = await api('/api/positions/exit-all', { method: 'POST' });
        toast(res.message || 'Exit All complete.', 'warning', 6000);
        await loadPositions();
        await loadOrders();
        await loadSltpRules();
      } catch (err) {
        toast(`Exit All failed: ${cleanErrorMessage(err.message)}`, 'error', 6000);
      } finally {
        btn.disabled = false;
        btn.textContent = '⚠️ EXIT ALL';
      }
    });
  }

  $('lots-minus').addEventListener('click', () => {
    $('lots-input').value = Math.max(1, getLots() - 1);
    updateQuantity();
  });
  $('lots-plus').addEventListener('click', () => {
    $('lots-input').value = Math.min(1000, getLots() + 1);
    updateQuantity();
  });

  ['lots-input', 'lot-size-input', 'price-input'].forEach(id => $(id).addEventListener('input', updateQuantity));

  $('type-select').addEventListener('change', updateOrderTypeFields);
  $('exchange-select').addEventListener('change', () => {
    state.searchSegment = $('exchange-select').value;
    if (state.searchSegment !== 'all') {
      state.exchangeSegment = state.searchSegment;
    }
    updateExchangeChip(state.searchSegment);
  });
  if ($('exchange-chip')) {
    $('exchange-chip').addEventListener('click', cycleExchangeSegment);
  }

  // Clickable index tiles for quick switching
  const tileHandlers = [
    { id: 'index-tile-nifty', symbol: 'NIFTY', segment: 'nse_fo' },
    { id: 'index-tile-banknifty', symbol: 'BANKNIFTY', segment: 'nse_fo' },
    { id: 'index-tile-sensex', symbol: 'SENSEX', segment: 'bse_fo' },
  ];
  tileHandlers.forEach(({ id, symbol, segment }) => {
    const tile = $(id);
    if (tile) {
      tile.addEventListener('click', () => {
        renderSymbol(symbol, segment, 'quick select', null);
        toast(`Selected ${symbol} (${segmentLabel(segment)})`, 'info');
      });
    }
  });

  $('search-instruments').addEventListener('click', searchInstruments);
  $('instrument-search').addEventListener('keydown', e => { if (e.key === 'Enter') searchInstruments(); });

  $('option-chain-toggle').addEventListener('click', () => {
    const panel = $('option-chain-panel');
    const open = panel.classList.toggle('hidden') === false;
    $('option-chain-toggle').setAttribute('aria-expanded', String(open));
    const span = $('option-chain-toggle').querySelector('span');
    if (span) span.textContent = open ? 'Close option chain' : 'Open option chain';
    if (open) {
      loadChainExpiries();
      startOptionChainPolling();
      setTimeout(() => centerAtmRow(false), 250);
    } else {
      stopOptionChainPolling();
    }
  });

  $('chain-underlying').addEventListener('change', () => {
    loadChainExpiries();
  });
  $('chain-expiry').addEventListener('change', () => {
    loadOptionChain(false);
  });
  $('chain-refresh').addEventListener('click', () => {
    loadOptionChain(false);
  });
  if ($('btn-center-atm')) {
    $('btn-center-atm').addEventListener('click', () => centerAtmRow(true));
  }

  $('apply-symbol').addEventListener('click', () => {
    try {
      const symbol = $('symbol-input').value.trim().toUpperCase();
      if (!symbol || !/^[A-Z0-9][A-Z0-9 .&_/-]{0,63}$/.test(symbol)) {
        throw new Error('Enter a valid trading symbol.');
      }
      renderSymbol(symbol, $('exchange-select').value, 'manual override', null);
      toast(`Symbol set to ${symbol}. Verify exact trading symbol.`, 'info');
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  $('symbol-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('apply-symbol').click(); });
  $('symbol-input').addEventListener('input', () => {
    if (!state.selectedInstrument) return;
    state.selectedInstrument = null;
    state.currentLtp = null;
    $('live-price').className = 'price-unavailable';
    $('live-price').innerHTML = '<span class="dot-pulse"></span> Price unavailable';
    updateQuantity();
  });

  // Modal events
  $('close-review').addEventListener('click', () => $('review-modal').classList.add('hidden'));
  $('cancel-review').addEventListener('click', () => $('review-modal').classList.add('hidden'));
  $('confirm-check').addEventListener('change', () => {
    $('confirm-order').disabled = !$('confirm-check').checked;
  });
  $('confirm-order').addEventListener('click', confirmOrder);

  $('connect-btn').addEventListener('click', openConnect);
  $('close-connect').addEventListener('click', () => $('connect-modal').classList.add('hidden'));
  $('cancel-connect').addEventListener('click', () => $('connect-modal').classList.add('hidden'));
  $('submit-connect').addEventListener('click', submitConnect);
  $('connect-modal').addEventListener('click', e => {
    if (e.target === $('connect-modal')) $('connect-modal').classList.add('hidden');
  });
  $('review-modal').addEventListener('click', e => {
    if (e.target === $('review-modal')) $('review-modal').classList.add('hidden');
  });

  $('pip-btn').addEventListener('click', () => {
    if (document.body.dataset.pipWindow === 'true') window.close();
    else openPip();
  });

  $('refresh-orders').addEventListener('click', () => {
    if (state.activityTab === 'positions') loadPositions();
    else if (state.activityTab === 'audit') loadAuditLogs();
    else loadOrders();
  });

  $('orders-tab').addEventListener('click', () => setActivityTab('orders'));
  $('positions-tab').addEventListener('click', () => setActivityTab('positions'));
  $('audit-tab').addEventListener('click', () => setActivityTab('audit'));

  $('open-positions-tab').addEventListener('click', () => setPositionsTab('open'));
  $('closed-positions-tab').addEventListener('click', () => setPositionsTab('closed'));
  if ($('all-positions-tab')) $('all-positions-tab').addEventListener('click', () => setPositionsTab('all'));

  if ($('orders-filter-all')) $('orders-filter-all').addEventListener('click', () => setOrdersFilter('all'));
  if ($('orders-filter-completed')) $('orders-filter-completed').addEventListener('click', () => setOrdersFilter('completed'));
  if ($('orders-filter-failed')) $('orders-filter-failed').addEventListener('click', () => setOrdersFilter('failed'));

  // Header P&L Click Handlers (direct jump to Positions)
  if ($('header-pnl')) {
    $('header-pnl').addEventListener('click', () => {
      setActivityTab('positions');
      loadPositions();
    });
  }

  if ($('header-net-pnl')) {
    $('header-net-pnl').addEventListener('click', () => {
      setActivityTab('positions');
      loadPositions();
      const netVal = $('header-net-pnl-value')?.textContent || '—';
      const grossVal = $('header-pnl-value')?.textContent || '—';
      const govt = $('charge-govt')?.textContent || '₹0.00';
      const brokk = $('charge-brokerage')?.textContent || '₹0.00';
      toast(`Net P&L: ${netVal} (Gross ${grossVal} - Govt charges ${govt} - Outside brokerage ${brokk})`, 'info', 4500);
    });
  }

  // --- Header P&L Background Poller ---
  let lastPnlPoll = 0;
  async function maybeRefreshPnl() {
    if (!state.authenticated || cloudDemoMode) return;
    const now = Date.now();
    if (now - lastPnlPoll < 4000) return;
    lastPnlPoll = now;
    try {
      const data = await api('/api/positions?tab=open');
      const todayVal = Number(data.total_today_pnl ?? data.total_position_pnl);
      const netVal = Number(data.total_net_pnl ?? data.total_today_pnl ?? data.total_position_pnl);

      const headerPnlEl = $('header-pnl-value');
      if (headerPnlEl && Number.isFinite(todayVal)) {
        headerPnlEl.textContent = money(todayVal, true);
        headerPnlEl.className = `header-pnl-value ${todayVal > 0 ? 'positive' : (todayVal < 0 ? 'negative' : '')}`;
      }

      const headerNetPnlEl = $('header-net-pnl-value');
      if (headerNetPnlEl && Number.isFinite(netVal)) {
        headerNetPnlEl.textContent = money(netVal, true);
        headerNetPnlEl.className = `header-pnl-value ${netVal > 0 ? 'positive' : (netVal < 0 ? 'negative' : '')}`;
      }
    } catch (_) {}
  }

  // --- Index Ticker Sliding (left to right only when overflowing viewport) ---
  let indexSlideInterval = null;
  let indexSlideDir = 1;
  let isIndexHovered = false;

  function updateIndexTickerSlide() {
    const strip = $('index-strip');
    if (!strip) return;

    if (indexSlideInterval) {
      clearInterval(indexSlideInterval);
      indexSlideInterval = null;
    }

    // Only slide if device width causes numbers to be cut off / overflow
    // If all numbers fit on the screen without overflow, keep completely static
    if (strip.scrollWidth <= strip.clientWidth + 4) {
      strip.scrollLeft = 0;
      return;
    }

    indexSlideInterval = setInterval(() => {
      if (isIndexHovered) return;
      const maxScroll = strip.scrollWidth - strip.clientWidth;
      if (maxScroll <= 0) return;

      strip.scrollLeft += indexSlideDir * 0.5;

      if (strip.scrollLeft >= maxScroll - 0.5) {
        indexSlideDir = -1;
      } else if (strip.scrollLeft <= 0.5) {
        indexSlideDir = 1;
      }
    }, 35);
  }

  function setupIndexTickerSlide() {
    const strip = $('index-strip');
    if (!strip) return;

    strip.addEventListener('mouseenter', () => { isIndexHovered = true; });
    strip.addEventListener('mouseleave', () => { isIndexHovered = false; });
    strip.addEventListener('touchstart', () => { isIndexHovered = true; }, { passive: true });
    strip.addEventListener('touchend', () => {
      setTimeout(() => { isIndexHovered = false; }, 2000);
    }, { passive: true });

    window.addEventListener('resize', debounce(updateIndexTickerSlide, 150));
    setTimeout(updateIndexTickerSlide, 600);
  }

  // --- Market Movers (Top 10 Gainers & Losers from Nifty 200) ---
  let activeMoversTab = 'gainers';
  let moversData = { gainers: [], losers: [] };

  async function loadMarketMovers() {
    try {
      const data = await api('/api/market/movers');
      if (data && (data.gainers || data.losers)) {
        moversData = data;
        renderMarketMovers();
      }
    } catch (_) {}
  }

  function renderMarketMovers() {
    const track = $('movers-track');
    if (!track) return;
    track.replaceChildren();

    let items = [];
    if (activeMoversTab === 'gainers') {
      items = (moversData.gainers || []).map(item => ({ ...item, type: 'gainer' }));
    } else if (activeMoversTab === 'losers') {
      items = (moversData.losers || []).map(item => ({ ...item, type: 'loser' }));
    } else {
      items = [
        ...(moversData.gainers || []).map(item => ({ ...item, type: 'gainer' })),
        ...(moversData.losers || []).map(item => ({ ...item, type: 'loser' })),
      ];
    }

    if (!items.length) {
      const empty = document.createElement('span');
      empty.className = 'mover-empty';
      empty.textContent = 'Market movers loading…';
      track.appendChild(empty);
      return;
    }

    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `mover-pill ${item.type}`;
      btn.setAttribute('data-symbol', item.symbol);
      btn.title = `Click to trade ${item.symbol} on NSE Cash`;

      const sym = document.createElement('span');
      sym.className = 'mover-sym';
      sym.textContent = item.symbol;

      const ltp = document.createElement('span');
      ltp.className = 'mover-ltp';
      ltp.textContent = money(item.ltp, false);

      const pct = document.createElement('span');
      pct.className = 'mover-pct';
      const pctVal = Number(item.change_percent || 0);
      pct.textContent = `${pctVal >= 0 ? '+' : ''}${pctVal.toFixed(2)}%`;

      btn.append(sym, ltp, pct);

      btn.addEventListener('click', () => {
        renderSymbol(item.symbol, 'nse_cm', 'market movers');
        toast(`Selected ${item.symbol} (NSE Cash) from market movers`, 'info', 2000);
      });

      track.appendChild(btn);
    }
  }

  function setupMoversControls() {
    const strip = $('movers-strip');
    const toggleBtn = $('toggle-movers-btn');
    const isCollapsed = localStorage.getItem('movers_collapsed') === '1';

    if (isCollapsed && strip) {
      strip.classList.add('collapsed');
      if (toggleBtn) {
        const icon = toggleBtn.querySelector('.toggle-icon');
        const label = toggleBtn.querySelector('.toggle-label');
        if (icon) icon.textContent = '+';
        if (label) label.textContent = 'Show';
      }
    }

    if (toggleBtn && strip) {
      toggleBtn.addEventListener('click', () => {
        const collapsed = strip.classList.toggle('collapsed');
        localStorage.setItem('movers_collapsed', collapsed ? '1' : '0');
        const icon = toggleBtn.querySelector('.toggle-icon');
        const label = toggleBtn.querySelector('.toggle-label');
        if (icon) icon.textContent = collapsed ? '+' : '−';
        if (label) label.textContent = collapsed ? 'Show' : 'Hide';
      });
    }

    const tabs = [
      { id: 'tab-movers-gainers', tab: 'gainers' },
      { id: 'tab-movers-losers', tab: 'losers' },
      { id: 'tab-movers-all', tab: 'all' },
    ];

    tabs.forEach(({ id, tab }) => {
      const btn = $(id);
      if (btn) {
        btn.addEventListener('click', () => {
          activeMoversTab = tab;
          tabs.forEach(t => $(t.id)?.classList.toggle('active', t.tab === tab));
          renderMarketMovers();
        });
      }
    });

    loadMarketMovers();
    setInterval(loadMarketMovers, 10000);
  }

  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      openReview(state.side);
    }
    if (e.key === 'Escape') {
      $('review-modal').classList.add('hidden');
      $('connect-modal').classList.add('hidden');
    }
  });

  // Initial State Setup
  updateOrderTypeFields();
  setSide('BUY');
  $('exchange-select').value = 'nse_fo';
  updateExchangeChip('nse_fo');
  $('product-select').value = 'MIS';
  if ($('validity-select')) $('validity-select').value = 'DAY';
  renderSymbol('NIFTY', 'nse_fo', 'manual', null);
  updateTradingViewSymbol('NIFTY');
  refreshLimits();
  loadSltpRules();

  setupIndexTickerSlide();
  setupMoversControls();

  requestLanAccess().then(() => {
    refreshStatus();
    loadOrders();
    if (state.authenticated) loadPositions();
  });
  loadIndexQuotes();

  // Background Polls
  setInterval(refreshStatus, 900);
  setInterval(loadOrders, 5000);
  setInterval(loadSltpRules, 5000);
  setInterval(loadIndexQuotes, 5000);
  setInterval(() => {
    if (state.activityTab === 'positions') {
      loadPositions();
    } else {
      maybeRefreshPnl();
    }
  }, 4000);
  setInterval(refreshQuote, 3000);
})();
