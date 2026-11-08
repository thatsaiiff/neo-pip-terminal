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

  function segmentLabel(segment) {
    return ({
      nse_fo: 'NSE F&O',
      bse_fo: 'BSE F&O',
      nse_cm: 'NSE CASH',
      bse_cm: 'BSE CASH',
      mcx_fo: 'MCX'
    })[segment] || String(segment || 'NSE F&O').toUpperCase();
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
    state.symbolSource = source || 'manual';
    $('symbol-input').value = state.currentSymbol;
    $('exchange-select').value = state.exchangeSegment;
    $('exchange-chip').textContent = segmentLabel(state.exchangeSegment);
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
  }

  function renderInstrument(instrument) {
    state.selectedInstrument = instrument;
    state.currentSymbol = instrument.trading_symbol;
    state.exchangeSegment = instrument.exchange_segment;
    $('symbol-input').value = instrument.trading_symbol;
    $('exchange-select').value = instrument.exchange_segment;
    $('exchange-chip').textContent = segmentLabel(instrument.exchange_segment);
    $('lot-size-input').value = instrument.lot_size;
    $('product-select').value = instrument.defaultProduct || 'CNC';
    $('type-select').value = 'MKT';
    updateOrderTypeFields();
    $('symbol-subtitle').textContent = `${instrument.symbol_name || instrument.trading_symbol} · Kotak instrument`;
    $('source-indicator').classList.add('linked');
    $('source-indicator').innerHTML = '<i class="source-dot"></i> Kotak';
    $('bridge-note').textContent = 'Selected from Kotak instrument search. Verify the contract and quantity before ordering.';
    $('instrument-results').classList.add('hidden');
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
    try {
      const data = await api('/api/instruments/search', {
        method: 'POST',
        body: JSON.stringify({ query, exchange_segment: $('exchange-select').value })
      });
      const results = $('instrument-results');
      results.replaceChildren();
      if (!data.instruments || !data.instruments.length) {
        const empty = document.createElement('div');
        empty.className = 'instrument-result-empty';
        empty.textContent = cloudDemoMode ? 'Instrument search is disabled in the cloud demo.' : 'No matching Kotak instruments found';
        results.appendChild(empty);
      } else {
        for (const instrument of data.instruments) {
          const option = document.createElement('button');
          option.type = 'button';
          option.className = 'instrument-result';
          option.setAttribute('role', 'option');
          const name = document.createElement('strong');
          name.textContent = instrument.trading_symbol;
          const meta = document.createElement('span');
          meta.textContent = `${instrument.symbol_name || segmentLabel(instrument.exchange_segment)} · lot ${instrument.lot_size}${instrument.expiry ? ` · ${instrument.expiry}` : ''}${instrument.option_type ? ` · ${instrument.option_type}` : ''}`;
          option.append(name, meta);
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
    } catch (_) {
      if (state.selectedInstrument !== instrument) return;
      $('live-price').className = 'price-unavailable';
      $('live-price').innerHTML = '<span class="dot-pulse"></span> Price unavailable';
    }
  }

  async function loadOptionChain() {
    const underlying = $('chain-underlying').value;
    const expiry = $('chain-expiry').value || null;
    $('chain-status').textContent = 'Loading Kotak option chain…';
    $('chain-rows').replaceChildren();
    try {
      const data = await api('/api/options/chain', {
        method: 'POST',
        body: JSON.stringify({ underlying, expiry })
      });
      const body = $('chain-rows');
      $('chain-status').textContent = data.rows && data.rows.length
        ? `${data.underlying} · ${data.expiry || expiry || 'nearest expiry'} · lot ${data.lot_size}${data.atm_strike ? ` · ATM ${data.atm_strike}` : ''} · click any cell to trade`
        : (cloudDemoMode ? 'Option-chain data requires a local Kotak connection.' : 'No option contracts returned for this expiry.');

      for (const row of (data.rows || [])) {
        const tr = document.createElement('tr');
        if (data.atm_strike && Number(row.strike) === Number(data.atm_strike)) tr.classList.add('atm-row');

        const addCell = (side, field, value, label) => {
          const td = document.createElement('td');
          if (!side) {
            td.className = 'strike th-strike';
            td.textContent = row.strike;
            tr.appendChild(td);
            return;
          }
          td.classList.add(label === 'CALL' ? 'call-cell' : 'put-cell');
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

        addCell(row.call, 'oi', row.call?.oi, 'CALL');
        addCell(row.call, 'ltp', row.call?.ltp, 'CALL');
        addCell(null, null, null, null);
        addCell(row.put, 'ltp', row.put?.ltp, 'PUT');
        addCell(row.put, 'oi', row.put?.oi, 'PUT');
        body.appendChild(tr);
      }
    } catch (error) {
      $('chain-status').textContent = cleanErrorMessage(error.message);
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

    if (!symbol) throw new Error('Enter a trading symbol before reviewing an order.');
    if (!/^[A-Z0-9][A-Z0-9 .&_/-]{0,63}$/.test(symbol)) throw new Error('Symbol contains unsupported characters.');
    if (!Number.isInteger(lots) || lots < 1 || lots > 1000) throw new Error('Lots must be between 1 and 1,000.');
    if (!Number.isInteger(lotSize) || lotSize < 1 || lotSize > 100000) throw new Error('Lot size must be between 1 and 100,000.');
    if ((type === 'L' || type === 'SL') && (!Number.isFinite(price) || price <= 0)) throw new Error('Enter a valid limit price.');
    if ((type === 'SL' || type === 'SL-M') && (!Number.isFinite(trigger) || trigger <= 0)) throw new Error('Enter a valid trigger price.');

    return {
      symbol,
      side,
      lots,
      lot_size: lotSize,
      exchange_segment: $('exchange-select').value,
      product: $('product-select').value,
      order_type: type,
      price,
      trigger_price: trigger,
      validity,
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
      $('confirm-check').focus();
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
      $('total-mtm').textContent = '—';
      $('total-position-pnl').textContent = '—';
      $('positions-list').replaceChildren();
      return;
    }
    try {
      const data = await api(`/api/positions?tab=${state.positionsTab}&closed=${state.positionsTab === 'closed'}`);

      const todayVal = Number(data.total_today_pnl ?? data.total_position_pnl);
      const mtmVal = Number(data.total_unrealized_pnl ?? data.total_mtm);
      const posVal = Number(data.total_realized_pnl ?? data.total_position_pnl);

      const todayEl = $('today-pnl');
      const mtmEl = $('total-mtm');
      const posEl = $('total-position-pnl');

      if (todayEl) {
        todayEl.textContent = money(data.total_today_pnl ?? data.total_position_pnl, true);
        todayEl.className = `pnl-primary-value ${Number.isFinite(todayVal) ? (todayVal > 0 ? 'pnl-positive' : (todayVal < 0 ? 'pnl-negative' : '')) : ''}`;
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
    $('totp-input').focus();
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
  $('buy-btn').addEventListener('click', () => setSide('BUY'));
  $('sell-btn').addEventListener('click', () => setSide('SELL'));
  $('place-buy').addEventListener('click', () => openReview('BUY'));
  $('place-sell').addEventListener('click', () => openReview('SELL'));

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
    state.exchangeSegment = $('exchange-select').value;
    $('exchange-chip').textContent = segmentLabel(state.exchangeSegment);
  });

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
    if (open) loadChainExpiries();
  });

  $('chain-underlying').addEventListener('change', loadChainExpiries);
  $('chain-expiry').addEventListener('change', loadOptionChain);
  $('chain-refresh').addEventListener('click', loadOptionChain);

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
  $('exchange-chip').textContent = segmentLabel('nse_fo');
  $('product-select').value = 'MIS';
  if ($('validity-select')) $('validity-select').value = 'DAY';
  renderSymbol('NIFTY', 'nse_fo', 'manual', null);

  requestLanAccess().then(() => {
    refreshStatus();
    loadOrders();
  });
  loadIndexQuotes();

  // Background Polls
  setInterval(refreshStatus, 900);
  setInterval(loadOrders, 5000);
  setInterval(loadIndexQuotes, 5000);
  setInterval(() => {
    if (state.activityTab === 'positions') loadPositions();
  }, 8000);
  setInterval(refreshQuote, 3000);
})();
