(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const cloudDemoMode = location.hostname.endsWith('.vercel.app') || new URLSearchParams(location.search).get('cloud') === 'demo';
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
    pipMarker: null,
    toastTimer: null,
    lastBridgeNote: '',
    demoOrders: [],
  };

  async function api(path, options = {}) {
    if (cloudDemoMode) return demoApi(path, options);
    const response = await fetch(path, {
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    let data = {};
    try { data = await response.json(); } catch (_) { data = {}; }
    if (!response.ok) {
      const detail = typeof data.detail === 'string' ? data.detail : `Request failed (${response.status})`;
      throw new Error(detail);
    }
    return data;
  }

  async function demoApi(path, options = {}) {
    const method = options.method || 'GET';
    if (path === '/api/health') return { ok: true, service: 'neo-pip-cloud-demo', lan_access_enabled: false };
    if (path === '/api/status') return { live_trading_enabled: false, broker_authenticated: false, mode: 'simulation', selected_symbol: null, extension_bridge_configured: false };
    if (path.startsWith('/api/orders') && method === 'GET') return state.demoOrders;
    if (path === '/api/orders' && method === 'POST') {
      const body = JSON.parse(options.body || '{}');
      const item = { ...body, id: `DEMO-${state.demoOrders.length + 1}`, quantity: body.lots * body.lot_size, status: 'simulated', mode: 'simulation', created_at: new Date().toISOString(), broker_order_id: null };
      state.demoOrders.unshift(item);
      return { ok: true, status: 'simulated', message: 'Demo order recorded in this browser only. No broker request was sent.' };
    }
    if (path === '/api/instruments/search') return { instruments: [] };
    if (path === '/api/options/expiries') return { expiries: [], nearest_expiry: null };
    if (path === '/api/options/chain') return { rows: [], underlying: '', expiry: null, lot_size: 1 };
    if (path === '/api/instruments/quote') throw new Error('Live quotes are unavailable in this simulation-only cloud demo.');
    throw new Error('This feature is unavailable in the simulation-only cloud demo.');
  }

  function toast(message, duration = 3200) {
    const element = $('toast');
    element.textContent = message;
    element.classList.add('visible');
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => element.classList.remove('visible'), duration);
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
      toast(error.message || 'Could not unlock local network access.', 5000);
    }
  }

  function formatTime(value) {
    try { return new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)); }
    catch (_) { return '--:--'; }
  }

  function segmentLabel(segment) {
    return ({ nse_fo: 'NSE F&O', bse_fo: 'BSE F&O', nse_cm: 'NSE CASH', bse_cm: 'BSE CASH', mcx_fo: 'MCX' })[segment] || String(segment || 'NSE F&O').toUpperCase();
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
    pill.querySelector('span').textContent = cloudDemoMode ? 'CLOUD DEMO' : modeLabel();
    if (cloudDemoMode) {
      $('connect-btn').classList.add('hidden');
      $('cloud-demo-banner').classList.remove('hidden');
      $('bridge-note').textContent = 'Demo mode: Kotak search, live quotes, option-chain data and broker connectivity are disabled on this hosted page.';
    }
    $('connect-btn').title = state.authenticated ? 'Disconnect Kotak Neo' : 'Connect Kotak Neo';
    $('connect-btn').setAttribute('aria-label', state.authenticated ? 'Disconnect Kotak Neo' : 'Connect Kotak Neo');
    $('connection-footer').textContent = state.authenticated
      ? `Kotak API active${state.kotakEgressIp ? ` · ${state.kotakEgressIp}` : ''}`
      : (state.liveTradingEnabled
        ? (state.kotakEgressIp ? `API session needs login · last IP ${state.kotakEgressIp}` : 'Live gate enabled · not authenticated')
        : 'Local simulation mode');
    $('connect-btn').style.color = state.authenticated ? '#34782f' : '';
  }

  function renderSymbol(symbol, segment, source, timestamp) {
    state.currentSymbol = String(symbol || 'NIFTY').toUpperCase();
    state.exchangeSegment = segment || state.exchangeSegment || 'nse_fo';
    state.symbolSource = source || 'manual';
    $('symbol-input').value = state.currentSymbol;
    $('exchange-select').value = state.exchangeSegment;
    $('exchange-chip').textContent = segmentLabel(state.exchangeSegment);
    $('symbol-subtitle').textContent = source === 'chrome extension' ? `Synced from Kotak Neo · ${timestamp ? formatTime(timestamp) : 'just now'}` : (source === 'manual override' ? 'Manual symbol override' : 'Select a symbol on Kotak Neo or enter one above');
    const connectedSource = source === 'chrome extension';
    $('source-indicator').classList.toggle('linked', connectedSource);
    $('source-indicator').innerHTML = `<i></i>${connectedSource ? 'Linked' : (source === 'manual override' ? 'Manual override' : 'Manual')}`;
    $('bridge-note').textContent = connectedSource
      ? 'Symbol bridge is active. Confirm the instrument and exchange before every order.'
      : (state.lastBridgeNote || 'Open your Kotak Neo trading tab and select a symbol. The companion extension can sync it here.');
    state.selectedInstrument = null;
    state.currentLtp = null;
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
    $('source-indicator').innerHTML = '<i></i> Kotak';
    $('bridge-note').textContent = 'Selected from Kotak instrument search. Verify the contract and quantity before ordering.';
    $('instrument-results').classList.add('hidden');
    refreshQuote();
  }

  async function searchInstruments() {
    const query = $('instrument-search').value.trim();
    if (query.length < 2) { toast('Enter at least 2 characters to search.'); return; }
    const button = $('search-instruments');
    button.disabled = true; button.textContent = 'Searching…';
    try {
      const data = await api('/api/instruments/search', { method: 'POST', body: JSON.stringify({ query, exchange_segment: $('exchange-select').value }) });
      const results = $('instrument-results');
      results.replaceChildren();
      if (!data.instruments.length) {
        const empty = document.createElement('div'); empty.className = 'instrument-result-empty'; empty.textContent = cloudDemoMode ? 'Instrument search is disabled in the cloud demo.' : 'No matching Kotak instruments'; results.appendChild(empty);
      }
      for (const instrument of data.instruments) {
        const option = document.createElement('button'); option.type = 'button'; option.className = 'instrument-result'; option.setAttribute('role', 'option');
        const name = document.createElement('strong'); name.textContent = instrument.trading_symbol;
        const meta = document.createElement('span'); meta.textContent = `${instrument.symbol_name || segmentLabel(instrument.exchange_segment)} · lot ${instrument.lot_size}${instrument.expiry ? ` · ${instrument.expiry}` : ''}${instrument.option_type ? ` · ${instrument.option_type}` : ''}`;
        option.append(name, meta); option.addEventListener('click', () => renderInstrument(instrument)); results.appendChild(option);
      }
      results.classList.remove('hidden');
    } catch (error) { toast(error.message, 5000); }
    finally { button.disabled = false; button.textContent = 'Search'; }
  }

  async function refreshQuote() {
    if (!state.selectedInstrument) return;
    const instrument = state.selectedInstrument;
    try {
      const quote = await api('/api/instruments/quote', { method: 'POST', body: JSON.stringify({ instrument_token: instrument.instrument_token, exchange_segment: instrument.exchange_segment }) });
      if (state.selectedInstrument !== instrument) return;
      state.currentLtp = quote.ltp;
      state.lastQuoteTimestamp = quote.updated_at;
      $('live-price').classList.remove('price-unavailable');
      $('live-price').textContent = `₹${quote.ltp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · LTP`;
      updateQuantity();
    } catch (_) {
      if (state.selectedInstrument !== instrument) return;
      $('live-price').classList.add('price-unavailable');
      $('live-price').innerHTML = '<span class="dot-pulse"></span> Price unavailable';
    }
  }

  async function loadOptionChain() {
    const underlying = $('chain-underlying').value;
    const expiry = $('chain-expiry').value || null;
    $('chain-status').textContent = 'Loading Kotak option chain…';
    $('chain-rows').replaceChildren();
    try {
      const data = await api('/api/options/chain', { method: 'POST', body: JSON.stringify({ underlying, expiry }) });
      const body = $('chain-rows');
      $('chain-status').textContent = data.rows.length
        ? `${data.underlying} · ${data.expiry || expiry || 'nearest expiry'} · lot ${data.lot_size} · select an LTP or OI cell`
        : (cloudDemoMode ? 'Option-chain data requires your local Kotak connection; it is disabled in this cloud demo.' : 'No option contracts returned for this expiry.');
      for (const row of data.rows) {
        const tr = document.createElement('tr');
        const addCell = (side, field, value, label) => {
          const td = document.createElement('td');
          if (!side) { td.className = 'strike'; td.textContent = row.strike; tr.appendChild(td); return; }
          const button = document.createElement('button'); button.type = 'button';
          button.textContent = value == null ? '—' : (field === 'ltp' ? Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : Number(value).toLocaleString('en-IN'));
          button.disabled = !side.symbol || !side.instrument_token;
          button.title = button.disabled ? 'Contract unavailable' : `Select ${side.symbol} (${label})`;
          button.addEventListener('click', () => renderInstrument({
            trading_symbol: side.symbol, symbol_name: `${underlying} ${row.strike} ${label}`,
            instrument_token: side.instrument_token, exchange_segment: side.exchange_segment,
            lot_size: data.lot_size, defaultProduct: 'NRML',
          }));
          td.appendChild(button); tr.appendChild(td);
        };
        addCell(row.call, 'oi', row.call?.oi, 'CALL');
        addCell(row.call, 'ltp', row.call?.ltp, 'CALL');
        addCell(null, null, null, null);
        addCell(row.put, 'ltp', row.put?.ltp, 'PUT');
        addCell(row.put, 'oi', row.put?.oi, 'PUT');
        body.appendChild(tr);
      }
    } catch (error) { $('chain-status').textContent = error.message; }
  }

  async function loadChainExpiries() {
    const underlying = $('chain-underlying').value;
    if (cloudDemoMode) {
      $('chain-expiry').replaceChildren();
      $('chain-status').textContent = 'Connect to Kotak in the local app to load real expiries and contracts.';
      $('chain-rows').replaceChildren();
      return;
    }
    $('chain-status').textContent = 'Loading expiries…';
    try {
      const data = await api('/api/options/expiries', { method: 'POST', body: JSON.stringify({ underlying }) });
      const select = $('chain-expiry'); select.replaceChildren();
      for (const expiry of data.expiries) {
        const option = document.createElement('option'); option.value = expiry;
        option.textContent = expiry === data.nearest_expiry ? `${expiry} · nearest` : expiry;
        select.appendChild(option);
      }
      if (!data.expiries.length) { $('chain-status').textContent = 'Kotak returned no upcoming expiries.'; return; }
      select.value = data.nearest_expiry;
      await loadOptionChain();
    } catch (error) { $('chain-status').textContent = error.message; }
  }

  function getLots() {
    const value = Number.parseInt($('lots-input').value, 10);
    return Number.isFinite(value) && value > 0 ? Math.min(value, 1000) : 1;
  }

  function getLotSize() {
    const value = Number.parseInt($('lot-size-input').value, 10);
    return Number.isFinite(value) && value > 0 ? Math.min(value, 100000) : 1;
  }

  function money(value) {
    if (!Number.isFinite(value)) return '—';
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(value);
  }

  function updateQuantity() {
    const quantity = getLots() * getLotSize();
    $('quantity-value').innerHTML = `${quantity.toLocaleString('en-IN')} <small>units</small>`;
    const price = Number.parseFloat($('price-input').value);
    const type = $('type-select').value;
    if (type === 'L' && Number.isFinite(price) && price > 0) {
      $('estimate-value').textContent = money(quantity * price);
      $('estimate-value').style.color = '#24251f';
      $('estimate-value').nextElementSibling.textContent = 'Limit-price estimate';
    } else if (Number.isFinite(state.currentLtp) && state.currentLtp > 0) {
      $('estimate-value').textContent = money(quantity * state.currentLtp);
      $('estimate-value').style.color = '#24251f';
      $('estimate-value').nextElementSibling.textContent = 'Indicative value at LTP';
    } else {
      $('estimate-value').textContent = '—';
      $('estimate-value').style.color = '';
      $('estimate-value').nextElementSibling.textContent = 'Price unavailable';
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
      validity: 'DAY',
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
    if (state.submitting) { toast('An order submission is still in progress.'); return; }
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
      if (Number.isFinite(state.currentLtp)) addReviewRow('Indicative LTP', `${money(state.currentLtp)} · ${formatTime(state.lastQuoteTimestamp)}`);
      if (order.price !== null) addReviewRow('Limit price', money(order.price));
      if (order.trigger_price !== null) addReviewRow('Trigger price', money(order.trigger_price));
      const live = state.mode === 'live' && state.authenticated;
      const warning = $('review-mode-warning');
      warning.classList.toggle('live', live);
      warning.textContent = live
        ? 'LIVE ORDER: confirming sends this request to Kotak Neo. Once sent, it cannot be recalled from this review dialog. Verify the broker order book after submission.'
        : 'SIMULATION ONLY: confirming records a test order in this app. No order is sent to Kotak Neo.';
      $('confirm-check').checked = false;
      $('confirm-order').disabled = true;
      $('confirm-order').classList.toggle('danger', live && side === 'SELL');
      $('confirm-order').textContent = live ? `Place live ${side}` : `Simulate ${side}`;
      $('review-modal').classList.remove('hidden');
      $('confirm-check').focus();
    } catch (error) {
      toast(error.message);
    }
  }

  async function confirmOrder() {
    if (!state.pendingOrder || !$('confirm-check').checked) return;
    const btn = $('confirm-order');
    state.submitting = true;
    $('place-buy').disabled = true; $('place-sell').disabled = true;
    btn.disabled = true;
    btn.textContent = 'Submitting…';
    const orderSnapshot = { ...state.pendingOrder, user_confirmed: true };
    $('review-modal').classList.add('hidden');
    try {
      const result = await api('/api/orders', { method: 'POST', body: JSON.stringify(orderSnapshot) });
      toast(result.message || 'Order recorded.');
      state.pendingOrder = null;
      await loadOrders();
    } catch (error) {
      toast(error.message, 5500);
      // Do not retry a live order after a transport error. Backend warns user to reconcile via broker order book.
      if (state.mode === 'live' && state.authenticated) toast(`Check Kotak order book before retrying. ${error.message}`, 6500);
    } finally {
      state.submitting = false;
      $('place-buy').disabled = false; $('place-sell').disabled = false;
      btn.textContent = state.mode === 'live' && state.authenticated ? `Place live ${orderSnapshot.side}` : `Simulate ${orderSnapshot.side}`;
      btn.disabled = !$('confirm-check').checked;
    }
  }

  function renderOrders(orders) {
    state.orderCount = orders.length;
    $('order-count').textContent = `${orders.length} ORDER${orders.length === 1 ? '' : 'S'}`;
    const list = $('orders-list');
    if (!orders.length) {
      list.innerHTML = '<div class="empty-state"><span class="empty-glyph">↗</span><div><strong>Nothing here yet</strong><p>Orders and simulation events will appear here.</p></div></div>';
      return;
    }
    list.replaceChildren();
    for (const item of orders.slice(0, 8)) {
      const row = document.createElement('div'); row.className = 'order-item';
      const side = document.createElement('div'); side.className = `order-side-dot ${item.side}`; side.textContent = item.side === 'BUY' ? '↗' : '↘';
      const main = document.createElement('div'); main.className = 'order-item-main';
      const title = document.createElement('strong'); title.textContent = item.symbol;
      const meta = document.createElement('span');
      meta.textContent = item.status === 'rejected' && item.message
        ? `${item.quantity} units · ${item.product} · REJECTED: ${item.message} · ${formatTime(item.created_at)}`
        : `${item.quantity} units · ${item.product} · ${formatTime(item.created_at)}`;
      main.append(title, meta);
      const status = document.createElement('div'); status.className = 'order-item-status';
      const tag = document.createElement('span'); tag.className = `status-tag ${item.status}`; tag.textContent = item.mode === 'simulation' ? 'SIMULATED' : item.status;
      const id = document.createElement('small'); id.textContent = item.broker_order_id ? `#${item.broker_order_id}` : `#${item.id}`;
      status.append(tag, id); row.append(side, main, status); list.appendChild(row);
    }
  }

  async function loadOrders() {
    try { renderOrders(await api('/api/orders?limit=20')); }
    catch (_) { /* health indicator surfaces backend errors */ }
  }

  async function refreshStatus() {
    try {
      const data = await api('/api/status');
      state.liveTradingEnabled = !!data.live_trading_enabled;
      state.authenticated = !!data.broker_authenticated;
      state.kotakEgressIp = data.kotak_egress_ip || null;
      state.kotakSessionIp = data.kotak_session_ip || null;
      state.mode = data.mode || 'simulation';
      updateModeUI();
      if (data.selected_symbol && data.selected_symbol.updated_at && data.selected_symbol.updated_at !== state.remoteSymbolTimestamp) {
        state.remoteSymbolTimestamp = data.selected_symbol.updated_at;
        if ($('review-modal').classList.contains('hidden')) {
          renderSymbol(data.selected_symbol.symbol, data.selected_symbol.exchange_segment, data.selected_symbol.source, data.selected_symbol.updated_at);
        }
      }
      if (!data.extension_bridge_configured) state.lastBridgeNote = 'Optional browser sync is off. BRIDGE_TOKEN is only needed if you want the extension to copy the selected symbol from a Kotak chart. Search and option-chain selection do not use the bridge.';
      else if (!data.selected_symbol?.updated_at) state.lastBridgeNote = 'Browser symbol sync is ready. Select a contract on Kotak Neo to send it here; this is separate from Kotak API login and quotes.';
      if (!state.selectedInstrument && !$('bridge-note').textContent.startsWith('Symbol bridge is active')) $('bridge-note').textContent = state.lastBridgeNote;
    } catch (error) {
      $('connection-footer').textContent = 'Backend offline · run start script';
      $('bridge-note').textContent = 'Backend is not reachable. Start the local service using the included start script.';
    }
  }

  function openConnect() {
    if (state.authenticated) {
      api('/api/auth/logout', { method: 'POST', body: '{}' }).then(() => { state.authenticated = false; state.kotakEgressIp = null; state.kotakSessionIp = null; state.mode = 'simulation'; updateModeUI(); toast('Kotak Neo session disconnected.'); }).catch(e => toast(e.message));
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
    if (!/^\d{6}$/.test(totp)) { toast('Enter the current 6-digit authenticator code.'); return; }
    if (!/^\d{4,8}$/.test(mpin)) { toast('Enter your MPIN.'); return; }
    const button = $('submit-connect'); button.disabled = true; button.textContent = 'Authenticating…';
    try {
      const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ totp, mpin }) });
      $('connect-modal').classList.add('hidden');
      state.authenticated = !!result.broker_authenticated; state.mode = result.mode || 'simulation';
      state.kotakEgressIp = result.kotak_egress_ip || null;
      state.kotakSessionIp = result.kotak_egress_ip || null;
      updateModeUI(); toast(result.message || 'Connected.');
    } catch (error) { toast(error.message, 5000); }
    finally { $('mpin-input').value = ''; button.disabled = false; button.textContent = 'Authenticate'; }
  }

  async function openPip() {
    // The PiP document is a separate document; clone the complete UI and boot an independent app instance.
    if (document.body.dataset.pipWindow === 'true') { window.close(); return; }
    if (state.pipWindow && !state.pipWindow.closed) { state.pipWindow.close(); return; }
    if ('documentPictureInPicture' in window && window.documentPictureInPicture?.requestWindow) {
      try {
        const pip = await window.documentPictureInPicture.requestWindow({ width: 410, height: 790 });
        state.pipWindow = pip;
        const base = pip.document.createElement('base'); base.href = location.origin + '/'; pip.document.head.appendChild(base);
        const cssLinks = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
        for (const link of cssLinks) {
          const clone = pip.document.createElement('link'); clone.rel = 'stylesheet'; clone.href = link.href; pip.document.head.appendChild(clone);
        }
        const viewport = pip.document.createElement('meta'); viewport.name = 'viewport'; viewport.content = 'width=device-width, initial-scale=1'; pip.document.head.appendChild(viewport);
        const theme = pip.document.createElement('meta'); theme.name = 'theme-color'; theme.content = '#f4f4f0'; pip.document.head.appendChild(theme);
        pip.document.title = 'Neo PIP — Trading Ticket';
        pip.document.body.innerHTML = document.body.innerHTML;
        pip.document.querySelectorAll('script').forEach(script => script.remove());
        pip.document.body.classList.add('pip-mode');
        pip.document.body.dataset.pipWindow = 'true';
        const script = pip.document.createElement('script');
        script.src = new URL('/static/app.js', location.origin).href;
        script.async = false;
        pip.document.body.appendChild(script);
        $('pip-btn').querySelector('span').textContent = 'PiP open'; $('pip-btn').title = 'Close the floating trading window';
        pip.addEventListener('pagehide', () => {
          state.pipWindow = null;
          $('pip-btn').querySelector('span').textContent = 'Pop out'; $('pip-btn').title = 'Open picture-in-picture window';
        }, { once: true });
        toast('Floating trading window opened. Keep this local service running.');
      } catch (error) {
        toast(`Picture-in-picture could not open: ${error.message}`);
      }
    } else {
      const child = window.open('/', 'neo-pip-window', 'popup=yes,width=430,height=790,resizable=yes,scrollbars=yes');
      if (!child) toast('Browser blocked the popup. Allow popups for this local page.');
      else toast('Opened a compact window. Always-on-top requires Chrome Document Picture-in-Picture support.');
    }
  }


  $('buy-btn').addEventListener('click', () => setSide('BUY'));
  $('sell-btn').addEventListener('click', () => setSide('SELL'));
  $('place-buy').addEventListener('click', () => openReview('BUY'));
  $('place-sell').addEventListener('click', () => openReview('SELL'));
  $('lots-minus').addEventListener('click', () => { $('lots-input').value = Math.max(1, getLots() - 1); updateQuantity(); });
  $('lots-plus').addEventListener('click', () => { $('lots-input').value = Math.min(1000, getLots() + 1); updateQuantity(); });
  ['lots-input', 'lot-size-input', 'price-input'].forEach(id => $(id).addEventListener('input', updateQuantity));
  $('type-select').addEventListener('change', updateOrderTypeFields);
  $('exchange-select').addEventListener('change', () => { state.exchangeSegment = $('exchange-select').value; $('exchange-chip').textContent = segmentLabel(state.exchangeSegment); });
  $('search-instruments').addEventListener('click', searchInstruments);
  $('instrument-search').addEventListener('keydown', e => { if (e.key === 'Enter') searchInstruments(); });
  $('option-chain-toggle').addEventListener('click', () => {
    const panel = $('option-chain-panel');
    const open = panel.classList.toggle('hidden') === false;
    $('option-chain-toggle').setAttribute('aria-expanded', String(open));
    $('option-chain-toggle').textContent = open ? 'Close option chain' : 'Open option chain';
    if (open) loadChainExpiries();
  });
  $('chain-underlying').addEventListener('change', loadChainExpiries);
  $('chain-expiry').addEventListener('change', loadOptionChain);
  $('chain-refresh').addEventListener('click', loadOptionChain);
  $('apply-symbol').addEventListener('click', () => {
    try {
      const symbol = $('symbol-input').value.trim().toUpperCase();
      if (!symbol || !/^[A-Z0-9][A-Z0-9 .&_/-]{0,63}$/.test(symbol)) throw new Error('Enter a valid trading symbol.');
      renderSymbol(symbol, $('exchange-select').value, 'manual override', null);
      toast('Manual symbol applied. Verify the exact broker trading symbol.');
    } catch (error) { toast(error.message); }
  });
  $('symbol-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('apply-symbol').click(); });
  $('symbol-input').addEventListener('input', () => {
    if (!state.selectedInstrument) return;
    state.selectedInstrument = null; state.currentLtp = null;
    $('live-price').innerHTML = '<span class="dot-pulse"></span> Price unavailable';
    updateQuantity();
  });
  $('close-review').addEventListener('click', () => $('review-modal').classList.add('hidden'));
  $('cancel-review').addEventListener('click', () => $('review-modal').classList.add('hidden'));
  $('confirm-check').addEventListener('change', () => { $('confirm-order').disabled = !$('confirm-check').checked; });
  $('confirm-order').addEventListener('click', confirmOrder);
  $('connect-btn').addEventListener('click', openConnect);
  $('close-connect').addEventListener('click', () => $('connect-modal').classList.add('hidden'));
  $('cancel-connect').addEventListener('click', () => $('connect-modal').classList.add('hidden'));
  $('submit-connect').addEventListener('click', submitConnect);
  $('pip-btn').addEventListener('click', () => { if (document.body.dataset.pipWindow === 'true') window.close(); else openPip(); });
  $('refresh-orders').addEventListener('click', loadOrders);
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); openReview(state.side); }
    if (e.key === 'Escape') { $('review-modal').classList.add('hidden'); $('connect-modal').classList.add('hidden'); }
  });

  updateOrderTypeFields(); setSide('BUY');
  $('exchange-select').value = 'bse_fo';
  $('exchange-chip').textContent = segmentLabel('bse_fo');
  $('product-select').value = 'CNC';
  renderSymbol('NIFTY', 'bse_fo', 'manual', null);
  requestLanAccess().then(() => { refreshStatus(); loadOrders(); });
  setInterval(refreshStatus, 900);
  setInterval(loadOrders, 5000);
  setInterval(refreshQuote, 3000);
})();
