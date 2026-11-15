(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = { underlying: [], options: [], localDatasetId: null, localDataset: null, report: null, runId: null, strategyId: null, shareToken: null, shared: false, registry: null, tradeFilter: '', metricFilter: '', comparisonFilter: '', sortKey: 'score', sortDirection: -1 };
  const strategyNames = {
    orb: 'Opening range breakout', ema_vwap: 'EMA and VWAP momentum',
    supertrend_rsi: 'Supertrend and RSI', adx_breakout: 'ADX trend breakout',
    volatility_expansion: 'Volatility expansion'
  };

  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }
  function money(value, sign = false) {
    if (value == null || value === 'unbounded' || !Number.isFinite(Number(value))) return value === 'unbounded' ? '∞' : 'N/A';
    const number = Number(value);
    const amount = Math.abs(number).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${sign && number > 0 ? '+' : number < 0 ? '−' : ''}₹${amount}`;
  }
  function numeric(value, digits = 2) {
    if (value == null || !Number.isFinite(Number(value))) return value === 'unbounded' ? '∞' : 'N/A';
    return Number(value).toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
  }
  function localTime(value) {
    if (!value) return 'N/A';
    const date = new Date(Number(value) * 1000);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('en-IN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(date);
  }
  function showNotice(message, kind = 'info') {
    const error = $('research-error'); const notice = $('research-notice');
    error.classList.add('hidden'); notice.classList.add('hidden');
    if (kind === 'error') { error.textContent = message; error.classList.remove('hidden'); }
    else { notice.textContent = message; notice.classList.remove('hidden'); }
  }
  function setState(message, loading = false) {
    const el = $('run-state'); el.textContent = message; el.classList.toggle('is-loading', loading);
  }
  const CSV_NUMERIC_FIELDS = new Set(['open', 'high', 'low', 'close', 'volume', 'strike', 'strike_price', 'lot_size', 'bid', 'ask', 'bid_open', 'ask_open', 'bid_close', 'ask_close', 'delta', 'theta', 'vega', 'gamma', 'iv', 'iv_rank', 'iv_percentile', 'open_interest']);
  async function api(path, options = {}) {
    const token = localStorage.getItem('neo_owner_token');
    const headers = { ...(options.headers || {}) };
    if (token) { headers.Authorization = `Bearer ${token}`; headers['X-Owner-Token'] = token; }
    if (options.body && typeof options.body === 'string') headers['Content-Type'] = 'application/json';
    const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', ...options, headers });
    let data = {};
    try { data = await response.json(); } catch (_) { /* static or empty response */ }
    if (!response.ok) throw new Error(data.detail || `Request failed (${response.status})`);
    return data;
  }

  function parseCSV(text) {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
    if (lines.length < 2) throw new Error('CSV needs a header and at least one candle row.');
    const parseLine = (line) => {
      const cells = []; let value = ''; let quoted = false;
      for (let i = 0; i < line.length; i += 1) {
        const char = line[i];
        if (char === '"' && line[i + 1] === '"' && quoted) { value += '"'; i += 1; }
        else if (char === '"') quoted = !quoted;
        else if (char === ',' && !quoted) { cells.push(value); value = ''; }
        else value += char;
      }
      cells.push(value); return cells;
    };
    const headers = parseLine(lines[0]).map((x) => x.trim().toLowerCase().replace(/[\s-]+/g, '_'));
    const rows = [];
    for (const line of lines.slice(1)) {
      const cells = parseLine(line); const row = {};
      headers.forEach((header, i) => {
        const raw = String(cells[i] ?? '').trim(); if (!header || raw === '') return;
        row[header] = CSV_NUMERIC_FIELDS.has(header) && Number.isFinite(Number(raw)) ? Number(raw) : raw;
      });
      if (Object.keys(row).length) rows.push(row);
    }
    if (!headers.some((x) => ['time', 'timestamp', 'datetime'].includes(x))) throw new Error('CSV must contain a time, timestamp, or datetime column.');
    for (const field of ['open', 'high', 'low', 'close']) if (!headers.includes(field)) throw new Error(`CSV is missing the ${field} column.`);
    return rows;
  }

  async function readFile(input, statusId, kind) {
    const file = input.files && input.files[0]; if (!file) return;
    state.localDatasetId = null; state.localDataset = null;
    $('local-dataset-status').textContent = 'Using manually selected CSV files.';
    const status = $(statusId); status.classList.remove('is-error', 'is-ready'); status.textContent = `Reading ${file.name}…`;
    if (file.size > 200 * 1024 * 1024) { status.textContent = 'File exceeds 200 MB. Use the saved local data loader or split the historical range.'; status.classList.add('is-error'); return; }
    try {
      const rows = parseCSV(await file.text());
      if (rows.length > (kind === 'underlying' ? 1000000 : 2000000)) throw new Error('This file exceeds the 1,000,000 underlying or 2,000,000 option row limit.');
      state[kind] = rows;
      status.classList.add('is-ready'); status.textContent = `${file.name} · ${rows.length.toLocaleString()} rows · ${rows[0].time || rows[0].timestamp || rows[0].datetime} to ${rows[rows.length - 1].time || rows[rows.length - 1].timestamp || rows[rows.length - 1].datetime}`;
    } catch (error) {
      state[kind] = []; status.classList.add('is-error'); status.textContent = error.message;
    }
  }

  async function discoverLocalDataset() {
    const status = $('local-dataset-status');
    try {
      const result = await api('/api/research/local-datasets');
      const dataset = (result.datasets || []).find((item) => item.id === 'banknifty_1m');
      if (!dataset) {
        status.textContent = 'No saved Bank Nifty export was found on the connected backend. Choose both CSV files below to import them.';
        return;
      }
      state.localDatasetId = dataset.id; state.localDataset = dataset;
      state.underlying = []; state.options = [];
      $('underlying').value = 'BANKNIFTY'; $('underlying-symbol').value = 'BANKNIFTY';
      $('data-source').value = 'Upstox local Bank Nifty export';
      $('underlying-file-status').classList.remove('is-error'); $('underlying-file-status').classList.add('is-ready');
      $('underlying-file-status').textContent = `${dataset.underlying_file} · ${numeric(dataset.underlying_rows, 0)} rows · ${dataset.index_range?.[0] || 'N/A'} to ${dataset.index_range?.[1] || 'N/A'}`;
      $('options-file-status').classList.remove('is-error'); $('options-file-status').classList.add('is-ready');
      $('options-file-status').textContent = `${dataset.options_file} · ${numeric(dataset.option_rows, 0)} rows · ${numeric(dataset.option_contracts, 0)} contracts with candles`;
      status.textContent = `Automatically selected ${dataset.label}. The backend reads these files directly, so the CSV rows are not copied through the browser.`;
      $('validate-local-dataset').disabled = false;
    } catch (error) {
      status.textContent = error.message.toLowerCase().includes('unauthorized') || error.message.toLowerCase().includes('sign in')
        ? 'Sign in to the local terminal to discover saved CSV files.' : error.message;
      $('validate-local-dataset').disabled = true;
    }
  }

  async function validateLocalDataset() {
    if (!state.localDatasetId) return;
    const button = $('validate-local-dataset'); button.disabled = true; button.classList.add('is-loading');
    $('local-validation-output').textContent = 'Checking columns, OHLC values and duplicate candles…';
    try {
      const result = await api(`/api/research/local-datasets/${encodeURIComponent(state.localDatasetId)}/validate`, { method: 'POST' });
      const underlying = result.underlying || {}; const options = result.options || {};
      const clean = [underlying, options].every((item) => Number(item.invalid_ohlc || 0) === 0 && Number(item.duplicate_bars || 0) === 0);
      $('local-validation-output').textContent = `${clean ? 'Validation passed' : 'Review required'} · ${result.validation_engine} · underlying ${numeric(underlying.valid_rows, 0)} valid of ${numeric(underlying.rows, 0)} · options ${numeric(options.valid_rows, 0)} valid of ${numeric(options.rows, 0)} · ${numeric(Number(underlying.invalid_ohlc || 0) + Number(options.invalid_ohlc || 0), 0)} invalid OHLC · ${numeric(Number(underlying.duplicate_bars || 0) + Number(options.duplicate_bars || 0), 0)} duplicate bars`;
      $('local-validation-output').classList.toggle('is-error', !clean);
    } catch (error) {
      $('local-validation-output').textContent = error.message; $('local-validation-output').classList.add('is-error');
    } finally { button.disabled = false; button.classList.remove('is-loading'); }
  }

  function updateDatasetUploadButton() {
    const underlyingFile = $('underlying-file').files?.[0];
    const optionsFile = $('options-file').files?.[0];
    const pairSelected = Boolean(underlyingFile && optionsFile);
    const underLimit = pairSelected && underlyingFile.size <= 200 * 1024 * 1024 && optionsFile.size <= 200 * 1024 * 1024;
    const uploadButton = $('upload-local-dataset');
    const browserButton = $('load-browser-csvs');
    if (uploadButton) uploadButton.disabled = !underLimit || uploadButton.classList.contains('is-loading');
    if (browserButton) browserButton.disabled = !underLimit || browserButton.classList.contains('is-loading');
  }

  function selectedCsvChanged(inputId, statusId, kind) {
    const input = $(inputId); const file = input.files?.[0]; const status = $(statusId);
    state[kind] = []; state.localDatasetId = null; state.localDataset = null;
    status.classList.remove('is-error', 'is-ready');
    if (!file) { status.textContent = `No ${kind} file selected`; updateDatasetUploadButton(); return; }
    if (file.size > 200 * 1024 * 1024) {
      status.classList.add('is-error'); status.textContent = `${file.name} exceeds the 200 MB upload limit.`;
    } else {
      status.textContent = `${file.name} · ${numeric(file.size, 0)} bytes selected. Choose an upload action below.`;
    }
    updateDatasetUploadButton();
  }

  async function loadSelectedCsvsInBrowser() {
    const underlyingFile = $('underlying-file').files?.[0]; const optionsFile = $('options-file').files?.[0];
    if (!underlyingFile || !optionsFile) { showNotice('Choose both CSV files before loading them in the browser.', 'error'); return; }
    const button = $('load-browser-csvs'); button.disabled = true; button.classList.add('is-loading');
    try {
      await Promise.all([
        readFile($('underlying-file'), 'underlying-file-status', 'underlying'),
        readFile($('options-file'), 'options-file-status', 'options'),
      ]);
      if (state.underlying.length && state.options.length) showNotice('Both CSV files are loaded in this browser for one backtest. Upload them to reuse the dataset on the backend.');
    } finally {
      button.classList.remove('is-loading'); updateDatasetUploadButton();
    }
  }

  async function uploadSelectedDataset() {
    const underlyingFile = $('underlying-file').files?.[0];
    const optionsFile = $('options-file').files?.[0];
    if (!underlyingFile || !optionsFile) { showNotice('Choose both the underlying and option CSV files first.', 'error'); return; }
    const runtime = window.NEO_PIP_CONFIG || {};
    if (runtime.hosted && !runtime.backendUrl) {
      showNotice('Direct upload is not configured. Set NEO_PIP_BACKEND_URL in the Vercel Production build and redeploy.', 'error');
      return;
    }
    const token = localStorage.getItem('neo_owner_token');
    if (!token) { showNotice('Sign in as the owner before importing files to the shared backend.', 'error'); return; }
    const apiBase = runtime.hosted ? runtime.backendUrl : location.origin;
    const button = $('upload-local-dataset');
    button.disabled = true; button.classList.add('is-loading');
    $('local-validation-output').classList.remove('is-error');
    try {
      for (const [kind, file, statusId] of [
        ['underlying', underlyingFile, 'underlying-file-status'],
        ['options', optionsFile, 'options-file-status'],
      ]) {
        $(statusId).classList.remove('is-error', 'is-ready');
        $(statusId).textContent = `Uploading ${file.name} to the connected backend…`;
        const target = new URL(`/api/research/local-datasets/banknifty_1m/upload?kind=${kind}`, apiBase);
        const response = await fetch(target, {
          method: 'POST',
          mode: runtime.hosted ? 'cors' : 'same-origin',
          credentials: 'omit',
          cache: 'no-store',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/csv' },
          body: file,
        });
        let data = {};
        try { data = await response.json(); } catch (_) { /* backend may return a proxy error */ }
        if (!response.ok) throw new Error(data.detail || `Upload failed (${response.status}).`);
        $(statusId).classList.add('is-ready');
        $(statusId).textContent = `${data.file_name} · ${numeric(data.rows, 0)} verified rows · ${numeric(data.bytes, 0)} bytes · ${data.validation_engine}`;
      }
      state.underlying = []; state.options = []; state.localDatasetId = null;
      await discoverLocalDataset();
      showNotice('Both files are on the connected backend and ready for research.');
    } catch (error) {
      $('local-validation-output').classList.add('is-error');
      $('local-validation-output').textContent = error.message;
      showNotice(error.message, 'error');
    } finally {
      button.classList.remove('is-loading');
      updateDatasetUploadButton();
    }
  }

  function settingsFromForm() {
    const benchmark = {
      win_rate: Number($('benchmark-win-rate').value), profit_factor: Number($('benchmark-pf').value),
      max_drawdown: Number($('benchmark-max-dd').value), sharpe: Number($('benchmark-sharpe').value),
      trade_count: Number($('benchmark-trades').value)
    };
    return {
      underlying_symbol: ['NIFTY', 'BANKNIFTY', 'SENSEX'].includes($('underlying').value) ? $('underlying').value : $('underlying-symbol').value.trim().toUpperCase(),
      timeframe_minutes: Number($('timeframe').value), expiry_mode: $('expiry-mode').value,
      strike_selection: $('strike-selection').value, target_delta: Number($('target-delta').value),
      entry_start_time: $('entry-start-time').value, entry_end_time: $('entry-end-time').value, square_off_time: $('square-off-time').value,
      initial_capital: Number($('capital').value), risk_pct_per_trade: Number($('risk-pct').value),
      max_lots: Number($('max-lots').value), stop_atr_multiple: Number($('stop-atr').value),
      target_r: Number($('target-r').value), trail_after_r: Number($('trail-r').value),
      max_daily_loss_pct: Number($('daily-loss-pct').value), max_drawdown_pct: Number($('max-drawdown-pct').value),
      opening_range_minutes: Number($('opening-range-minutes').value), volume_multiple: Number($('volume-multiple').value),
      fast_ema: Number($('fast-ema').value), slow_ema: Number($('slow-ema').value),
      supertrend_period: Number($('supertrend-period').value), supertrend_multiplier: Number($('supertrend-multiplier').value),
      rsi_period: Number($('rsi-period').value), adx_period: Number($('adx-period').value), adx_threshold: Number($('adx-threshold').value),
      breakout_lookback: Number($('breakout-lookback').value), bollinger_period: Number($('bollinger-period').value),
      squeeze_lookback: Number($('squeeze-lookback').value), atr_expansion_multiple: Number($('atr-expansion-multiple').value),
      benchmark_overrides: benchmark,
      data_source: `User supplied label (not independently verified): ${$('data-source').value || 'Historical candle upload'}`,
      max_consecutive_losses: 3, loss_streak_window_seconds: 1800
    };
  }

  async function runBacktest() {
    if (!state.localDatasetId && (!state.underlying.length || !state.options.length)) { showNotice('Load both underlying and option candle files before running a backtest.', 'error'); return; }
    const strategies = [...document.querySelectorAll('#strategy-selectors input:checked')].map((input) => input.value);
    if (!strategies.length) { showNotice('Select at least one strategy.', 'error'); return; }
    const button = $('run-backtest'); button.disabled = true; button.classList.add('is-loading'); setState('Calculating', true);
    $('research-error').classList.add('hidden'); $('research-notice').classList.add('hidden');
    try {
      const requestBody = { strategies, settings: settingsFromForm(), data_source: $('data-source').value };
      if (state.localDatasetId) requestBody.dataset_id = state.localDatasetId;
      else { requestBody.underlying_candles = state.underlying; requestBody.option_candles = state.options; }
      const result = await api('/api/research/backtests/run', { method: 'POST', body: JSON.stringify(requestBody) });
      state.runId = result.run_id; state.report = result.report; state.shared = false;
      state.strategyId = result.report.strategies[0]?.strategy_id || null;
      renderReport(); await loadSavedRuns();
      history.replaceState({}, '', `/research/results/${result.run_id}`);
      setState('Saved privately'); showNotice(`Run ${result.run_id} saved. Review the out of sample results and data coverage before using any strategy.`);
    } catch (error) {
      setState('Run failed'); showNotice(error.message, 'error');
      if (error.message.toLowerCase().includes('sign in') || error.message.toLowerCase().includes('unauthorized')) showNotice('Sign in to the terminal first, then return to research.', 'error');
    } finally { button.disabled = false; button.classList.remove('is-loading'); }
  }

  async function loadSavedRuns() {
    try {
      const result = await api('/api/research/backtests?limit=50');
      const select = $('saved-runs'); const selected = String(state.runId || '');
      select.innerHTML = '<option value="">Select a saved run</option>';
      for (const run of result.runs || []) {
        const option = document.createElement('option'); option.value = String(run.id);
        option.textContent = `Run ${run.id} · ${new Date(run.created_at).toLocaleDateString('en-IN')} · ${run.strategy_count} strategies`;
        select.append(option);
      }
      select.value = selected;
    } catch (_) { /* private history is unavailable until the user signs in */ }
  }

  async function openSavedRun(id) {
    if (!id) return;
    try {
      const result = await api(`/api/research/backtests/${encodeURIComponent(id)}`);
      state.runId = Number(id); state.report = result.run.report; state.strategyId = result.run.report.strategies[0]?.strategy_id || null; state.shared = false;
      renderReport(); history.replaceState({}, '', `/research/results/${id}`); setState('Saved privately');
    } catch (error) { showNotice(error.message, 'error'); }
  }

  function selectedStrategy() {
    return (state.report?.strategies || []).find((item) => item.strategy_id === state.strategyId) || state.report?.strategies?.[0] || null;
  }

  function renderSummary(result) {
    const summary = result.summary || {};
    const metrics = result.metrics || [];
    const pick = (id) => metrics.find((item) => item.id === id)?.value;
    const cells = [
      ['Net profit', money(summary.net_pnl, true), summary.net_pnl], ['Win rate', `${numeric(pick('win_rate'))}%`, pick('win_rate')],
      ['Profit factor', numeric(pick('profit_factor'), 3), pick('profit_factor')], ['Expectancy', money(pick('expectancy'), true), pick('expectancy')],
      ['Max drawdown', `${numeric(result.drawdown?.max_drawdown_pct)}%`, -Number(result.drawdown?.max_drawdown_pct || 0)],
      ['Realized win/loss', numeric(pick('risk_reward'), 3), pick('risk_reward')], ['Sharpe', numeric(pick('sharpe'), 3), pick('sharpe')],
      ['Sortino', numeric(pick('sortino'), 3), pick('sortino')], ['Recovery factor', numeric(pick('recovery_factor'), 3), pick('recovery_factor')],
      ['Return on capital', `${numeric(pick('return_on_capital'))}%`, pick('return_on_capital')],
      ['Closed trades', numeric(summary.total_trades, 0), summary.total_trades], ['Max loss streak', numeric(summary.maximum_consecutive_losses, 0), -Number(summary.maximum_consecutive_losses || 0)]
    ];
    $('summary-cards').innerHTML = cells.map(([name, value, score]) => `<div class="summary-card"><span>${escapeHTML(name)}</span><strong class="${Number(score) > 0 ? 'positive' : Number(score) < 0 ? 'negative' : ''}">${escapeHTML(value)}</strong></div>`).join('');
  }

  function svgLineChart(container, points, valueFn, color, baseline = null) {
    if (!points || points.length < 2) { container.innerHTML = '<p class="muted">Not enough marks to draw this chart.</p>'; return; }
    const sampled = points.length > 180 ? points.filter((_, i) => i % Math.ceil(points.length / 180) === 0).concat(points.at(-1)) : points;
    const values = sampled.map(valueFn).filter(Number.isFinite);
    if (values.length < 2) { container.innerHTML = '<p class="muted">Not enough valid marks to draw this chart.</p>'; return; }
    const min = Math.min(...values, baseline ?? Infinity); const max = Math.max(...values, baseline ?? -Infinity);
    const span = Math.max(1e-9, max - min); const width = 800; const height = 240; const left = 24; const right = 18; const top = 18; const bottom = 24;
    const xy = values.map((value, i) => `${left + i / Math.max(1, values.length - 1) * (width - left - right)},${top + (max - value) / span * (height - top - bottom)}`);
    let baselineSvg = '';
    if (baseline != null) { const y = top + (max - baseline) / span * (height - top - bottom); baselineSvg = `<line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" stroke="#555" stroke-dasharray="5 6"/>`; }
    container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><line x1="${left}" y1="${height - bottom}" x2="${width - right}" y2="${height - bottom}" stroke="#313131"/>${baselineSvg}<polyline fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" points="${xy.join(' ')}"/></svg>`;
  }

  function scatterChart(container, observations, xField, xLabel) {
    const points = (observations || []).filter((item) => Number.isFinite(Number(item[xField])) && Number.isFinite(Number(item.realized_net_pnl)));
    if (!points.length) { container.innerHTML = '<p class="muted">Not enough valid trade excursions to draw this chart.</p>'; return; }
    const sampled = points.length > 400 ? points.filter((_, index) => index % Math.ceil(points.length / 400) === 0) : points;
    const maxX = Math.max(1, ...sampled.map((item) => Number(item[xField])));
    const minY = Math.min(0, ...sampled.map((item) => Number(item.realized_net_pnl)));
    const maxY = Math.max(0, ...sampled.map((item) => Number(item.realized_net_pnl)));
    const width = 800; const height = 260; const left = 64; const right = 18; const top = 18; const bottom = 42;
    const scaleY = (value) => top + (maxY - value) / Math.max(1, maxY - minY) * (height - top - bottom);
    const zeroY = scaleY(0);
    const circles = sampled.map((item) => {
      const x = left + Number(item[xField]) / maxX * (width - left - right);
      const y = scaleY(Number(item.realized_net_pnl));
      const color = Number(item.realized_net_pnl) >= 0 ? '#73dbb1' : '#fb7777';
      return `<circle cx="${x}" cy="${y}" r="3.4" fill="${color}" fill-opacity=".72"/>`;
    }).join('');
    container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><line x1="${left}" y1="${zeroY}" x2="${width - right}" y2="${zeroY}" stroke="#555" stroke-dasharray="5 6"/><line x1="${left}" y1="${top}" x2="${left}" y2="${height - bottom}" stroke="#555"/>${circles}<text x="${width / 2}" y="${height - 8}" text-anchor="middle" fill="#b5b7ba" font-size="13">${escapeHTML(xLabel)} (INR)</text><text x="16" y="${height / 2}" transform="rotate(-90 16 ${height / 2})" text-anchor="middle" fill="#b5b7ba" font-size="13">Realized net P&amp;L (INR)</text></svg>`;
  }

  function renderDistribution(container, rows, emptyMessage = 'No observations in this sample.') {
    const valid = (rows || []).filter((row) => Number.isFinite(Number(row.count)) && Number(row.count) > 0);
    if (!valid.length) { container.innerHTML = `<p class="muted">${escapeHTML(emptyMessage)}</p>`; return; }
    const maximum = Math.max(...valid.map((row) => Number(row.count)));
    container.innerHTML = valid.map((row) => `<div class="distribution-row"><span>${escapeHTML(row.label)}</span><span class="distribution-track"><span class="distribution-fill ${row.negative ? 'is-negative' : ''}" style="width:${Math.max(2, Number(row.count) / maximum * 100)}%"></span></span><strong>${numeric(row.count, 0)}</strong></div>`).join('');
  }

  function renderCharts(result) {
    const curve = result.equity_curve || [];
    svgLineChart($('equity-chart'), curve, (point) => Number(point.equity), '#73dbb1', Number(result.summary?.allocated_capital || 0));
    const drawdowns = []; let peak = Number(result.summary?.allocated_capital || 0);
    for (const point of curve) { peak = Math.max(peak, Number(point.equity)); drawdowns.push({ time: point.time, dd: peak ? (Number(point.equity) - peak) / peak * 100 : 0 }); }
    svgLineChart($('drawdown-chart'), drawdowns, (point) => Number(point.dd), '#fb7777', 0);
    const dates = result.data_quality || {};
    $('equity-range').textContent = `${dates.session_count || 0} sessions · ${dates.data_range_start || 'No start date'} to ${dates.data_range_end || 'No end date'}`;
    $('drawdown-caption').textContent = `Maximum observed drawdown ${numeric(result.drawdown?.max_drawdown_pct)}% · The plotted path uses the supplied option candle marks.`;
  }

  function renderComparison() {
    const definitions = state.report?.metric_registry?.core || [];
    const rows = (state.report?.strategies || []).map((result) => {
      const oos = result.validation?.out_of_sample || {};
      const values = Object.fromEntries((oos.metrics || []).map((metric) => [metric.id, metric.value]));
      const rank = (state.report?.comparison || []).find((x) => x.strategy_id === result.strategy_id) || {};
      return { strategy_id: result.strategy_id, name: result.strategy?.name || strategyNames[result.strategy_id] || result.strategy_id,
        values, score: rank.score, status: rank.status || oos.validation?.status || 'not ranked' };
    });
    const query = state.comparisonFilter.toLowerCase();
    const visibleRows = rows.filter((row) => !query || `${row.name} ${row.status} ${row.strategy_id}`.toLowerCase().includes(query));
    visibleRows.sort((a, b) => {
      const x = state.sortKey === 'name' || state.sortKey === 'score' ? a[state.sortKey] : a.values[state.sortKey];
      const y = state.sortKey === 'name' || state.sortKey === 'score' ? b[state.sortKey] : b.values[state.sortKey];
      if (typeof x === 'string') return x.localeCompare(String(y)) * state.sortDirection;
      return ((Number(x ?? -Infinity)) - (Number(y ?? -Infinity))) * state.sortDirection;
    });
    $('comparison-table').querySelector('thead').innerHTML = `<tr><th data-key="name">Strategy</th>${definitions.map((metric) => `<th data-key="${escapeHTML(metric.id)}" title="${escapeHTML(metric.definition)} ${escapeHTML(metric.formula)}">${escapeHTML(metric.name)}</th>`).join('')}<th data-key="score">Screen score</th></tr>`;
    $('comparison-table').querySelector('tbody').innerHTML = visibleRows.map((row) => `<tr><td><button class="text-button" type="button" data-open-strategy="${escapeHTML(row.strategy_id)}">${escapeHTML(row.name)}</button></td>${definitions.map((metric) => {
      const value = row.values[metric.id];
      const formatted = value == null ? 'N/A' : metric.unit === '%' ? `${numeric(value)}%` : metric.unit === 'INR per trade' ? money(value, true) : numeric(value, 3);
      return `<td>${escapeHTML(formatted)}</td>`;
    }).join('')}<td>${row.score == null ? 'N/A' : numeric(row.score, 4)} <span class="muted">${escapeHTML(row.status)}</span></td></tr>`).join('') || `<tr><td colspan="${definitions.length + 2}">${query ? 'No strategies match this search.' : 'No strategy results are available.'}</td></tr>`;
    $('comparison-table').querySelectorAll('[data-open-strategy]').forEach((button) => button.addEventListener('click', () => selectStrategy(button.dataset.openStrategy)));
    $('comparison-table').querySelectorAll('th[data-key]').forEach((th) => th.addEventListener('click', () => { if (state.sortKey === th.dataset.key) state.sortDirection *= -1; else { state.sortKey = th.dataset.key; state.sortDirection = -1; } renderComparison(); }));
  }

  function renderCoreMetrics(result) {
    const query = state.metricFilter.toLowerCase();
    const metrics = (result.metrics || []).filter((metric) => !query || `${metric.name} ${metric.definition} ${metric.formula}`.toLowerCase().includes(query));
    $('core-metrics').innerHTML = metrics.map((metric) => {
      const value = metric.id === 'max_drawdown' ? `${numeric(metric.value)}% · ${money(metric.value_inr)}` :
        metric.unit === 'INR per trade' ? money(metric.value, true) : metric.unit === '%' ? `${numeric(metric.value)}%` : numeric(metric.value, 3);
      const statusClass = metric.status?.includes('meets') || metric.status?.includes('within') ? 'good' : metric.status?.includes('below') || metric.status?.includes('above') ? 'bad' : 'na';
      return `<article class="metric-card"><div class="metric-heading"><h4>${escapeHTML(metric.name)}</h4><span class="metric-status ${statusClass}">${escapeHTML(metric.status || 'unavailable')}</span></div><strong>${escapeHTML(value)}</strong><p>${escapeHTML(metric.definition)} ${escapeHTML(metric.formula)}${metric.benchmark == null ? '' : ` Benchmark ${escapeHTML(metric.benchmark)} ${escapeHTML(metric.unit)}.`}${metric.interpretation ? ` ${escapeHTML(metric.interpretation)}` : ''}${metric.unavailable_reason ? ` ${escapeHTML(metric.unavailable_reason)}` : ''}</p></article>`;
    }).join('') || '<p class="muted">No metrics match this search.</p>';
  }

  function renderTrades(result) {
    const trades = result.trades || []; const query = state.tradeFilter.toLowerCase();
    const filtered = trades.filter((trade) => `${trade.symbol} ${trade.exit_reason} ${trade.option_type}`.toLowerCase().includes(query));
    const display = filtered.slice(0, 500);
    $('trade-count').textContent = `${filtered.length.toLocaleString('en-IN')} matching trades${filtered.length > display.length ? ` · showing ${display.length} rows` : ''}`;
    $('trade-table').querySelector('tbody').innerHTML = display.map((trade) => `<tr><td>${escapeHTML(localTime(trade.entry_time))}</td><td>${escapeHTML(localTime(trade.exit_time))}</td><td>${escapeHTML(trade.symbol)}</td><td>${escapeHTML(trade.option_type)}</td><td>${numeric(trade.strike, 0)}</td><td>${escapeHTML(trade.expiry || 'N/A')}</td><td>${numeric(trade.dte_calendar, 0)}</td><td>${numeric(trade.quantity, 0)}</td><td>${numeric(trade.entry_price, 2)}</td><td>${numeric(trade.exit_price, 2)}</td><td>${numeric(trade.delta_entry, 4)}</td><td>${numeric(trade.theta_entry, 4)}</td><td>${numeric(trade.vega_entry, 4)}</td><td>${numeric(trade.gamma_entry, 4)}</td><td>${numeric(trade.iv_entry, 4)}</td><td>${money(trade.gross_pnl, true)}</td><td>${money(trade.charges)}</td><td class="${Number(trade.net_pnl) >= 0 ? 'positive' : 'negative'}">${money(trade.net_pnl, true)}</td><td>${money(trade.slippage_cost)}</td><td>${money(trade.mfe_inr)}</td><td>${money(trade.mae_inr)}</td><td>${escapeHTML(trade.exit_reason)}</td></tr>`).join('') || '<tr><td colspan="22">No closed trades in this result.</td></tr>';
  }

  function detailRows(container, rows) {
    container.innerHTML = rows.map(([label, value, help]) => `<div class="detail-row"><span>${escapeHTML(label)}</span><strong>${escapeHTML(value)}</strong>${help ? `<small>${escapeHTML(help)}</small>` : ''}</div>`).join('');
  }
  function renderRisk(result) {
    const summary = result.summary || {}; const dd = result.drawdown || {}; const tails = result.tail_risk || {}; const exec = result.execution_metrics || {};
    detailRows($('risk-details'), [
      ['Maximum drawdown', `${money(dd.max_drawdown_inr)} · ${numeric(dd.max_drawdown_pct)}%`], ['Current drawdown', `${money(dd.current_drawdown_inr)} · ${numeric(dd.current_drawdown_pct)}%`],
      ['Average drawdown', money(dd.average_drawdown_inr)], ['Longest underwater period', dd.longest_underwater_seconds == null ? 'N/A' : `${numeric(dd.longest_underwater_seconds / 86400)} days`],
      ['Longest recovery', dd.time_to_recovery_seconds == null ? 'No completed recovery in sample' : `${numeric(dd.time_to_recovery_seconds / 86400)} days`],
      ['Maximum losing streak', `${numeric(summary.maximum_consecutive_losses, 0)} trades`], ['Maximum winning streak', `${numeric(summary.maximum_consecutive_wins, 0)} trades`],
      ['Average losing streak', `${numeric(summary.average_losing_streak)} trades`], ['Average winning streak', `${numeric(summary.average_winning_streak)} trades`],
      ['Losing streak frequency', summary.losing_streak_frequency_per_session == null ? 'N/A' : `${numeric(summary.losing_streak_frequency_per_session, 4)} per session`],
      ['Expectancy as allocated capital', summary.expectancy_pct_of_allocated_capital == null ? 'N/A' : `${numeric(summary.expectancy_pct_of_allocated_capital, 5)}% per trade`],
      ['Expectancy in R', summary.expectancy_r == null ? 'N/A' : `${numeric(summary.expectancy_r, 4)}R per trade`],
      ['Worst streak capital loss', money(summary.worst_streak_capital_lost)], ['Return on peak premium deployed', summary.return_on_peak_premium_deployed_pct == null ? 'N/A' : `${numeric(summary.return_on_peak_premium_deployed_pct)}%`],
      ['Average capital utilization', summary.average_capital_utilization_pct == null ? 'N/A' : `${numeric(summary.average_capital_utilization_pct)}%`],
      ['Annualized return', summary.annualized_return_pct == null ? summary.annualized_return_reason || 'N/A' : `${numeric(summary.annualized_return_pct)}%`]
    ]);
    detailRows($('tail-risk'), [
      ['Worst trade', money((result.trades || []).reduce((worst, trade) => Math.min(worst, Number(trade.net_pnl) || 0), 0))],
      ['Worst day', money(Math.min(...(result.daily || []).map((x) => Number(x.net_pnl)).concat([0])))],
      ['Worst month', money(Object.values(result.monthly || {}).reduce((worst, month) => Math.min(worst, Number(month.net_pnl) || 0), 0))],
      ['Extreme loss threshold', money(tails.extreme_loss_threshold_inr)], ['Extreme loss frequency', tails.extreme_loss_frequency_pct == null ? 'N/A' : `${numeric(tails.extreme_loss_frequency_pct)}%`],
      ['95% VaR', tails.var_95_inr == null ? tails['95_reason'] || 'N/A' : money(tails.var_95_inr)],
      ['95% expected shortfall', tails.expected_shortfall_95_inr == null ? 'N/A' : money(tails.expected_shortfall_95_inr)],
      ['99% VaR', tails.var_99_inr == null ? tails['99_reason'] || 'N/A' : money(tails.var_99_inr)],
      ['99% expected shortfall', tails.expected_shortfall_99_inr == null ? 'N/A' : money(tails.expected_shortfall_99_inr)],
      ['Monte Carlo', tails.monte_carlo?.available ? `Median DD ${numeric(tails.monte_carlo.median_max_drawdown_pct)}% · 95th ${numeric(tails.monte_carlo.p95_max_drawdown_pct)}%` : tails.monte_carlo?.reason || 'N/A'],
      ['Risk of ruin', tails.risk_of_ruin?.reason || 'N/A'], ['Gap and liquidity stress', tails.gap_and_liquidity_stress?.reason || 'N/A']
    ]);
    const streakCounts = new Map();
    for (const streak of result.losing_streaks || []) streakCounts.set(Number(streak.length), (streakCounts.get(Number(streak.length)) || 0) + 1);
    renderDistribution($('streak-distribution'), [...streakCounts.entries()].sort((a, b) => a[0] - b[0]).map(([length, count]) => ({ label: `${length} loss${length === 1 ? '' : 'es'}`, count, negative: true })), 'No completed losing streaks.');
    const rValues = (result.r_multiples || []).filter((value) => value != null && Number.isFinite(Number(value))).map(Number);
    const rBuckets = [
      { label: '≤ −1R', test: (value) => value <= -1 }, { label: '(−1, 0)R', test: (value) => value > -1 && value < 0 },
      { label: '0–1R', test: (value) => value >= 0 && value < 1 }, { label: '1–2R', test: (value) => value >= 1 && value < 2 },
      { label: '2–5R', test: (value) => value >= 2 && value < 5 }, { label: '> 5R', test: (value) => value >= 5 }
    ];
    renderDistribution($('r-distribution'), rBuckets.map((bucket) => ({ label: bucket.label, count: rValues.filter(bucket.test).length, negative: bucket.label.startsWith('≤') || bucket.label.startsWith('(') })), 'No realized R-multiples.');
    const opts = result.options_metrics || {};
    const registry = state.report?.metric_registry || {};
    const explanation = (group, id) => {
      const item = (registry[group] || []).find((metric) => metric.id === id);
      return item ? `${item.definition} Formula: ${item.formula} Interpretation: ${item.interpretation || item.data_quality_status || ''}` : '';
    };
    const optionRows = Object.entries(opts).filter(([key, value]) => !['pnl_by_delta_bucket', 'pnl_by_iv_regime', 'pnl_by_iv_change', 'pnl_by_iv_percentile_bucket', 'pnl_by_dte', 'holding_duration_theta', 'iv_rank_history'].includes(key) && value && typeof value === 'object').map(([key, value]) => {
      const meta = (registry.options || []).find((metric) => metric.id === key);
      const detail = value.definition || meta?.definition || '';
      const formula = meta?.formula ? ` Formula: ${meta.formula}` : '';
      return [key.replaceAll('_', ' ').toUpperCase(), value.value == null ? value.unavailable_reason || value.reason || 'N/A' : `Entry ${numeric(value.entry_mean ?? value.value, 4)} · Exit ${numeric(value.exit_mean, 4)} ${value.unit || ''}`, `${detail}${formula}`];
    });
    optionRows.push(['Capital required at entry', money(summary.capital_required_peak_premium), explanation('option_analytics', 'capital_deployed')]);
    optionRows.push(['Average premium deployed', money(summary.capital_required_average_premium), explanation('option_analytics', 'capital_deployed')]);
    optionRows.push(['Total premium paid', money(summary.total_premium_paid), explanation('option_analytics', 'capital_deployed')]);
    optionRows.push(['Available capital at end', money(summary.available_capital_at_end), explanation('option_analytics', 'capital_deployed')]);
    optionRows.push(['Planned target/stop', `${numeric(summary.planned_risk_reward, 3)} : 1`, 'Configured target distance divided by initial stop distance. Realized win/loss ratio is shown separately.']);
    const formatGroups = (groups) => Object.entries(groups || {}).map(([key, value]) => `${key}: ${numeric(value.trades, 0)} trades · net ${money(value.net_pnl, true)} · win ${numeric(value.win_rate_pct)}% · PF ${numeric(value.profit_factor, 3)} · expectancy ${money(value.expectancy, true)} · W/L ${numeric(value.risk_reward, 3)}`).join(' | ') || 'N/A';
    optionRows.push(['CE and PE performance', formatGroups(result.by_option_type || {}), 'Net win rate, profit factor, expectancy, realized average win/loss ratio, and trade count grouped by option side.']);
    optionRows.push(['1DTE / expiry session performance', formatGroups(result.by_day_type || {}), 'The strategy groups trades using supplied contract-expiry and observed-session dates.']);
    optionRows.push(['Performance by entry hour', formatGroups(result.by_time_of_day || {}), 'Net trade statistics grouped by entry hour in Asia/Kolkata.']);
    optionRows.push(['Performance by calendar DTE', formatGroups(result.by_dte || {}), explanation('option_analytics', 'dte_performance')]);
    const greekDte = Object.entries(result.greeks_by_dte || {}).flatMap(([greek, groups]) => Object.entries(groups || {}).map(([dte, value]) => `${greek} ${dte}: ${numeric(value.trades, 0)} trades · ${numeric(value.entry_mean, 4)} → ${numeric(value.exit_mean, 4)} · net ${money(value.net_pnl, true)}`));
    optionRows.push(['Greeks by trading-session DTE', greekDte.join(' | ') || 'Unavailable without contract Greeks and session expiry data', explanation('option_analytics', 'gamma_expiry')]);
    const ivHistory = opts.iv_rank_history || [];
    optionRows.push(['Contract IV rank observations', ivHistory.length ? `${numeric(ivHistory.length, 0)} entry observations · latest ${numeric(ivHistory.at(-1)?.iv_rank)}%` : opts.iv_rank_status?.unavailable_reason || 'N/A without a contract IV series']);
    optionRows.push(['P&L by delta bucket', opts.pnl_by_delta_bucket?.status === 'unavailable' ? opts.pnl_by_delta_bucket.unavailable_reason : Object.entries(opts.pnl_by_delta_bucket || {}).map(([key, value]) => `${key}: ${money(value.net_pnl)}`).join(' · ') || 'N/A', explanation('option_analytics', 'delta_exposure')]);
    optionRows.push(['P&L by IV regime', opts.pnl_by_iv_regime?.status === 'unavailable' ? opts.pnl_by_iv_regime.unavailable_reason : Object.entries(opts.pnl_by_iv_regime || {}).map(([key, value]) => `${key}: ${money(value.net_pnl)}`).join(' · ') || 'N/A', explanation('option_analytics', 'vega_volatility')]);
    optionRows.push(['P&L by IV change', opts.pnl_by_iv_change?.status === 'unavailable' ? opts.pnl_by_iv_change.unavailable_reason : Object.entries(opts.pnl_by_iv_change || {}).map(([key, value]) => `${key}: ${money(value.net_pnl)}`).join(' · ') || 'N/A', explanation('option_analytics', 'vega_volatility')]);
    optionRows.push(['P&L by IV percentile', opts.pnl_by_iv_percentile_bucket?.status === 'unavailable' ? opts.pnl_by_iv_percentile_bucket.unavailable_reason : Object.entries(opts.pnl_by_iv_percentile_bucket || {}).map(([key, value]) => `${key}: ${money(value.net_pnl)}`).join(' · ') || 'N/A', explanation('option_analytics', 'iv_rank_percentile')]);
    optionRows.push(['P&L by DTE', Object.entries(opts.pnl_by_dte || {}).map(([key, value]) => `${key}: ${money(value.net_pnl)}`).join(' · ') || 'Unavailable without an observed expiry session', explanation('option_analytics', 'dte_performance')]);
    optionRows.push(['Theta and holding time', Object.entries(opts.holding_duration_theta || {}).map(([key, value]) => `${key}: ${money(value.net_pnl)}`).join(' · ') || 'Unavailable without theta observations', explanation('option_analytics', 'theta_exposure')]);
    optionRows.push(['Greeks by side', Object.entries(result.greeks_by_option_type || {}).map(([side, greeks]) => `${side}: ${Object.entries(greeks).map(([name, values]) => `${name} ${numeric(values.entry_mean, 4)} → ${numeric(values.exit_mean, 4)}`).join(', ')}`).join(' · ') || 'N/A', explanation('option_analytics', 'gamma_expiry')]);
    detailRows($('options-details'), optionRows);
    const executionRows = [
      ['Signal count', numeric(exec.signal_count, 0), 'Number of closed-bar entries signaled by this strategy before contract filters.'], ['Simulated fill rate', exec.simulated_fill_rate_pct == null ? 'N/A' : `${numeric(exec.simulated_fill_rate_pct)}% · ${exec.fill_rate_status}`, explanation('execution', 'fill_rate')],
      ['Rejected orders', exec.rejected_orders?.reason || numeric(exec.rejected_orders?.value, 0), explanation('execution_analytics', 'rejected_and_partial_orders')], ['Partial fills', exec.partial_fills?.reason || numeric(exec.partial_fills?.value, 0), explanation('execution_analytics', 'rejected_and_partial_orders')],
      ['Signal to fill delay', exec.average_signal_to_fill_seconds == null ? 'N/A' : `${numeric(exec.average_signal_to_fill_seconds)} seconds · ${exec.latency_status}`, explanation('execution', 'latency')],
      ['Average entry spread', exec.average_entry_spread == null ? 'Unavailable without bid and ask' : numeric(exec.average_entry_spread), explanation('execution_analytics', 'entry_exit_spread')],
      ['Average exit spread', exec.average_exit_spread == null ? 'Unavailable without bid and ask' : numeric(exec.average_exit_spread), explanation('execution_analytics', 'entry_exit_spread')],
      ['Slippage cost', exec.slippage_cost_inr == null ? exec.slippage_status : money(exec.slippage_cost_inr), explanation('execution', 'slippage')],
      ['Entry slippage adverse cost', exec.entry_slippage_adverse_cost_inr == null ? 'N/A without entry quotes' : money(exec.entry_slippage_adverse_cost_inr), explanation('execution', 'slippage')],
      ['Exit slippage adverse cost', exec.exit_slippage_adverse_cost_inr == null ? 'N/A without exit quotes' : money(exec.exit_slippage_adverse_cost_inr), explanation('execution', 'slippage')],
      ['Slippage sensitivity', Object.entries(result.slippage_stress || {}).map(([key, item]) => `${key}: ${money(item.net_pnl)}`).join(' · ') || 'N/A', 'Scenario only: additional round-turn cost applied to option premium notional; not observed fill slippage.'],
      ['Transaction cost sensitivity', Object.entries(result.transaction_cost_stress || {}).map(([key, item]) => `${key}: ${money(item.net_pnl)}`).join(' · ') || 'N/A', 'Scenario only: current modeled statutory charges scaled up or down.'],
      ['Slippage by time (average/trade)', Object.entries(exec.slippage_by_time_of_day || {}).map(([key, item]) => `${key}: ${money(item.average)}`).join(' · ') || 'Unavailable without quote observations', explanation('execution_analytics', 'slippage_time_liquidity')],
      ['Slippage by liquidity (average/trade)', Object.entries(exec.slippage_by_liquidity || {}).map(([key, item]) => `${key}: ${money(item.average)}`).join(' · ') || 'Unavailable without quote observations', explanation('execution_analytics', 'slippage_time_liquidity')],
      ['Exit reason counts', Object.entries(exec.exit_reason_counts || {}).map(([key, value]) => `${key}: ${numeric(value, 0)}`).join(' · ') || 'N/A', explanation('execution_analytics', 'exit_reason_frequency')],
      ['Average holding time', exec.average_holding_minutes == null ? 'N/A' : `${numeric(exec.average_holding_minutes)} minutes`, explanation('execution_analytics', 'holding_duration')],
      ['Average MFE', money(exec.average_mfe_inr), explanation('execution', 'mfe_mae')], ['Average MAE', money(exec.average_mae_inr), explanation('execution', 'mfe_mae')],
      ['Profit capture', exec.profit_capture_ratio_pct == null ? 'N/A' : `${numeric(exec.profit_capture_ratio_pct)}%`, explanation('execution_analytics', 'profit_capture')],
      ['Transaction cost per trade', exec.transaction_cost_per_trade == null ? 'N/A' : money(exec.transaction_cost_per_trade), explanation('execution_analytics', 'transaction_costs')],
      ['Total transaction costs', money(exec.total_transaction_cost), explanation('execution_analytics', 'transaction_costs')], ['Net to gross profit', numeric(exec.net_to_gross_profit_ratio, 4), explanation('execution_analytics', 'net_to_gross')],
      ['Skipped signals', numeric(exec.skipped_signals, 0), 'Eligible strategy signals skipped because a contract, option candle, risk limit, or position constraint prevented an entry.']
    ];
    detailRows($('execution-details'), executionRows);
    scatterChart($('mfe-chart'), exec.mfe_mae_scatter, 'mfe_inr', 'Maximum favorable excursion');
    scatterChart($('mae-chart'), exec.mfe_mae_scatter, 'mae_inr', 'Maximum adverse excursion');
  }

  function renderValidation(result) {
    const validation = result.validation || {};
    if (validation.in_sample && validation.out_of_sample) {
      const output = ['<table><thead><tr><th>Measure</th><th>In sample</th><th>Out of sample</th></tr></thead><tbody>'];
      const makeSummary = (part) => part.summary || {};
      const inS = validation.in_sample; const outS = validation.out_of_sample;
      for (const [label, id] of [['Net P&L', 'net_pnl'], ['Closed trades', 'total_trades'], ['Return on capital', 'return_on_capital_pct'], ['Win rate', 'win_rate_pct'], ['Profit factor', 'profit_factor'], ['Expectancy', 'expectancy'], ['Max drawdown', 'max_drawdown_pct']]) {
        const metric = (part) => part.metrics?.find((x) => x.id === ({ win_rate: 'win_rate', profit_factor: 'profit_factor', expectancy: 'expectancy', max_drawdown_pct: 'max_drawdown' }[id] || ''));
        let a = makeSummary(inS)[id]; let b = makeSummary(outS)[id];
        if (id === 'win_rate' || id === 'profit_factor' || id === 'expectancy') { a = metric(inS)?.value; b = metric(outS)?.value; }
        if (id === 'max_drawdown_pct') { a = inS.drawdown?.max_drawdown_pct; b = outS.drawdown?.max_drawdown_pct; }
        const format = (value) => id.includes('pnl') || id === 'expectancy' ? money(value, true) : id.includes('pct') || id === 'win_rate' ? `${numeric(value)}%` : numeric(value, 3);
        output.push(`<tr><td>${escapeHTML(label)}</td><td>${escapeHTML(format(a))}</td><td>${escapeHTML(format(b))}</td></tr>`);
      }
      output.push(`<tr><td>Validation method</td><td colspan="2">${escapeHTML(validation.method)} · ${escapeHTML(validation.status || '')}</td></tr></tbody></table>`);
      $('validation-details').innerHTML = output.join('');
    } else $('validation-details').innerHTML = `<p class="muted">${escapeHTML(validation.reason || validation.status || 'Out of sample split is unavailable.')}</p>`;
    const oos = validation.out_of_sample || {};
    const oosCapital = Number(oos.summary?.allocated_capital || result.summary?.allocated_capital || 0);
    const oosCurve = oos.equity_curve || [];
    svgLineChart($('oos-equity-chart'), oosCurve, (point) => Number(point.equity), '#73dbb1', oosCapital);
    const oosDrawdowns = []; let oosPeak = oosCapital;
    for (const point of oosCurve) {
      oosPeak = Math.max(oosPeak, Number(point.equity));
      oosDrawdowns.push({ time: point.time, drawdown_pct: oosPeak ? (Number(point.equity) - oosPeak) / oosPeak * 100 : 0 });
    }
    svgLineChart($('oos-drawdown-chart'), oosDrawdowns, (point) => Number(point.drawdown_pct), '#fb7777', 0);
    const monthly = result.monthly || {};
    $('monthly-results').innerHTML = `<table><thead><tr><th>Month</th><th>Trades</th><th>Net P&amp;L</th><th>Monthly return</th><th>Win rate</th><th>Profit factor</th><th>Expectancy</th><th>W/L ratio</th></tr></thead><tbody>${Object.entries(monthly).map(([month, value]) => `<tr><td>${escapeHTML(month)}</td><td>${numeric(value.trades, 0)}</td><td>${money(value.net_pnl, true)}</td><td>${numeric(value.monthly_return_pct)}%</td><td>${numeric(value.win_rate_pct)}%</td><td>${numeric(value.profit_factor, 3)}</td><td>${money(value.expectancy, true)}</td><td>${numeric(value.risk_reward, 3)}</td></tr>`).join('') || '<tr><td colspan="8">No monthly trades.</td></tr>'}</tbody></table>`;
    const monthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const years = [...new Set(Object.keys(monthly).map((key) => key.slice(0, 4)))].sort();
    $('monthly-heatmap').innerHTML = years.length ? `<table><thead><tr><th>Year</th>${monthLabels.map((month) => `<th>${month}</th>`).join('')}</tr></thead><tbody>${years.map((year) => `<tr><th>${escapeHTML(year)}</th>${monthLabels.map((_, index) => {
      const key = `${year}-${String(index + 1).padStart(2, '0')}`; const item = monthly[key];
      if (!item || item.monthly_return_pct == null) return '<td class="heat-empty">—</td>';
      const value = Number(item.monthly_return_pct); const tone = value >= 0 ? 'heat-positive' : 'heat-negative';
      return `<td class="${tone}" title="${escapeHTML(key)} · ${numeric(value)}% return">${numeric(value)}%</td>`;
    }).join('')}</tr>`).join('')}</tbody></table>` : '<p class="muted">Monthly heatmap is unavailable until closed trades span a month.</p>';
    const expiry = result.by_expiry || {};
    $('expiry-results').innerHTML = `<table><thead><tr><th>Expiry</th><th>Trades</th><th>Net P&amp;L</th><th>Win rate</th><th>Profit factor</th><th>Expectancy</th><th>W/L ratio</th><th>Max DD</th></tr></thead><tbody>${Object.entries(expiry).map(([date, item]) => `<tr><td>${escapeHTML(date)}</td><td>${numeric(item.trades, 0)}</td><td>${money(item.net_pnl, true)}</td><td>${numeric(item.win_rate_pct)}%</td><td>${numeric(item.profit_factor, 3)}</td><td>${money(item.expectancy, true)}</td><td>${numeric(item.risk_reward, 3)}</td><td>${numeric(item.max_drawdown_pct)}%</td></tr>`).join('') || '<tr><td colspan="8">No contract expiry trades.</td></tr>'}</tbody></table>`;
    const daily = result.daily || [];
    $('daily-results').innerHTML = `<table><thead><tr><th>Date</th><th>Trades</th><th>Net P&amp;L</th><th>Daily return</th><th>Equity</th></tr></thead><tbody>${daily.slice(-100).map((item) => `<tr><td>${escapeHTML(item.date)}</td><td>${numeric(item.trades, 0)}</td><td>${money(item.net_pnl, true)}</td><td>${numeric(item.return_pct, 4)}%</td><td>${money(item.equity)}</td></tr>`).join('') || '<tr><td colspan="5">No daily sessions.</td></tr>'}</tbody></table>`;
    $('rolling-risk').innerHTML = `<p class="chart-caption">20-session rolling Sharpe: ${(result.rolling_sharpe || []).slice(-20).map((item) => `${escapeHTML(item.date)} ${numeric(item.value, 3)}`).join(' · ') || 'N/A'}<br>20-session rolling Sortino: ${(result.rolling_sortino || []).slice(-20).map((item) => `${escapeHTML(item.date)} ${numeric(item.value, 3)}`).join(' · ') || 'N/A'}<br>20-trade rolling expectancy: ${(result.rolling_expectancy || []).slice(-20).map((item) => `${escapeHTML(localTime(item.time))} ${money(item.expectancy, true)}`).join(' · ') || 'N/A'}<br>20-trade rolling profit factor: ${(result.rolling_profit_factor || []).slice(-20).map((item) => `${escapeHTML(localTime(item.time))} ${numeric(item.profit_factor, 3)}`).join(' · ') || 'N/A'}</p>`;
    $('assumption-list').innerHTML = (state.report.assumptions || []).map((x) => `<li>${escapeHTML(x)}</li>`).join('');
    const data = result.data_quality || {};
    $('assumption-list').insertAdjacentHTML('beforeend', `<li>Coverage: ${numeric(data.valid_underlying_bars, 0)} valid underlying bars, ${numeric(data.option_rows, 0)} option bars, ${numeric(data.session_count, 0)} sessions. Source label: ${escapeHTML(data.source || 'unavailable')}.</li><li>${escapeHTML(data.fill_assumption || 'Fills use historical candle assumptions.')}</li>`);
    renderOptimization(result);
  }

  function renderOptimization(result) {
    const opt = result.optimization;
    if (!opt) { $('optimization-details').innerHTML = '<p class="muted">No optimization run is attached yet.</p>'; return; }
    if (opt.status !== 'evaluated') { $('optimization-details').innerHTML = `<p class="muted">${escapeHTML(opt.reason || opt.status || 'Optimization unavailable.')}</p>`; return; }
    const parameters = Object.entries(opt.selected_parameters || {}).map(([key, value]) => `${key}: ${value}`).join(' · ');
    const folds = (opt.walk_forward?.folds || []).map((fold) => `<tr><td>${numeric(fold.fold, 0)}</td><td>${escapeHTML(fold.status)}</td><td>${numeric(fold.train_sessions, 0)}</td><td>${numeric(fold.test_sessions, 0)}</td><td>${escapeHTML(JSON.stringify(fold.parameters || {}))}</td><td>${money(fold.test?.expectancy, true)}</td><td>${numeric(fold.test?.profit_factor, 3)}</td></tr>`).join('');
    const candidates = (opt.top_candidates || []).slice(0, 20).map((candidate) => `<tr><td>${numeric(candidate.training_score, 5)}</td><td>${escapeHTML(JSON.stringify(candidate.parameters))}</td><td>${numeric(candidate.training?.trades, 0)}</td><td>${money(candidate.training?.expectancy, true)}</td><td>${numeric(candidate.training?.profit_factor, 3)}</td><td>${numeric(candidate.training?.max_drawdown_pct)}%</td></tr>`).join('');
    $('optimization-details').innerHTML = `<p><strong>Selected parameters:</strong> ${escapeHTML(parameters || 'N/A')}</p><p class="muted">${escapeHTML(opt.sample_periods?.method || '')} · ${numeric(opt.candidate_count, 0)} combinations evaluated · Validation score ${numeric(opt.validation_score, 5)} · Holdout score ${numeric(opt.holdout_score, 5)}</p><div class="table-wrap"><table><thead><tr><th>Period</th><th>Sessions</th><th>Trades</th><th>Expectancy</th><th>Profit factor</th><th>Max DD</th></tr></thead><tbody><tr><td>Training</td><td>${numeric(opt.sample_periods?.training_sessions, 0)}</td><td>${numeric(opt.selected_training_metrics?.trades, 0)}</td><td>${money(opt.selected_training_metrics?.expectancy, true)}</td><td>${numeric(opt.selected_training_metrics?.profit_factor, 3)}</td><td>${numeric(opt.selected_training_metrics?.max_drawdown_pct)}%</td></tr><tr><td>Validation</td><td>${numeric(opt.sample_periods?.validation_sessions, 0)}</td><td>${numeric(opt.validation?.trades, 0)}</td><td>${money(opt.validation?.expectancy, true)}</td><td>${numeric(opt.validation?.profit_factor, 3)}</td><td>${numeric(opt.validation?.max_drawdown_pct)}%</td></tr><tr><td>Untouched holdout</td><td>${numeric(opt.sample_periods?.untouched_holdout_sessions, 0)}</td><td>${numeric(opt.holdout?.trades, 0)}</td><td>${money(opt.holdout?.expectancy, true)}</td><td>${numeric(opt.holdout?.profit_factor, 3)}</td><td>${numeric(opt.holdout?.max_drawdown_pct)}%</td></tr></tbody></table></div><h4>Expanding walk-forward folds</h4><div class="table-wrap"><table><thead><tr><th>Fold</th><th>Status</th><th>Train sessions</th><th>Test sessions</th><th>Parameters</th><th>Test expectancy</th><th>Test PF</th></tr></thead><tbody>${folds || '<tr><td colspan="7">Insufficient history for walk-forward folds.</td></tr>'}</tbody></table></div><h4>Top training candidates</h4><div class="table-wrap"><table><thead><tr><th>Train score</th><th>Parameters</th><th>Trades</th><th>Expectancy</th><th>Profit factor</th><th>Max DD</th></tr></thead><tbody>${candidates || '<tr><td colspan="6">No candidate met the configured training sample.</td></tr>'}</tbody></table></div><ul>${(opt.warnings || []).map((warning) => `<li>${escapeHTML(warning)}</li>`).join('')}</ul>`;
  }

  async function optimizeSelectedStrategy() {
    if (!state.runId || !state.strategyId) { showNotice('Save a backtest first.', 'error'); return; }
    if (!state.localDatasetId && (!state.underlying.length || !state.options.length)) { showNotice('Reload the original CSV files on /research to run optimization for this saved result.', 'error'); return; }
    const button = $('run-optimization'); button.disabled = true; button.classList.add('is-loading');
    try {
      const requestBody = {
        strategy_id: state.strategyId, method: $('optimization-method').value,
        budget: Number($('optimization-budget').value), minimum_trades: Number($('optimization-min-trades').value)
      };
      if (state.localDatasetId) requestBody.dataset_id = state.localDatasetId;
      else { requestBody.underlying_candles = state.underlying; requestBody.option_candles = state.options; }
      const response = await api(`/api/research/backtests/${state.runId}/optimize`, { method: 'POST', body: JSON.stringify({
        ...requestBody
      }) });
      const strategy = selectedStrategy(); strategy.optimization = response.optimization;
      renderOptimization(strategy); showNotice(`Optimization saved for ${strategy.strategy.name}. Review validation and holdout results before using the selected parameters.`);
    } catch (error) { showNotice(error.message, 'error'); }
    finally { button.disabled = false; button.classList.remove('is-loading'); }
  }

  function renderReport() {
    if (!state.report) return;
    $('empty-results').classList.add('hidden'); $('results-panel').classList.remove('hidden');
    $('data-panel').classList.toggle('hidden', state.shared || Boolean(state.runId && location.pathname.startsWith('/research/results/')));
    $('share-result').classList.toggle('hidden', state.shared);
    $('export-csv').classList.remove('hidden');
    $('export-xlsx').classList.remove('hidden');
    $('export-pdf').classList.remove('hidden');
    $('result-meta').textContent = `Run ${state.runId || 'shared'} · ${state.report.strategy_count} strategies · source label is user supplied and unverified`;
    const select = $('strategy-view'); const old = state.strategyId;
    select.innerHTML = (state.report.strategies || []).map((item) => `<option value="${escapeHTML(item.strategy_id)}">${escapeHTML(item.strategy.name)}</option>`).join('');
    select.value = (state.report.strategies || []).some((x) => x.strategy_id === old) ? old : state.report.strategies?.[0]?.strategy_id || '';
    state.strategyId = select.value; renderSelectedStrategy(); renderComparison();
  }

  function renderSelectedStrategy() {
    const result = selectedStrategy(); if (!result) return;
    $('core-metrics-title').textContent = `${result.strategy.name} metrics`;
    renderSummary(result); renderCharts(result); renderCoreMetrics(result); renderTrades(result); renderRisk(result); renderValidation(result);
  }

  function selectStrategy(id) {
    state.strategyId = id; $('strategy-view').value = id; renderSelectedStrategy();
    document.querySelector('[data-panel="overview"]').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function createShare() {
    if (!state.runId || state.shared) return;
    try {
      const result = await api(`/api/research/backtests/${state.runId}/share`, { method: 'POST', body: JSON.stringify({ expires_days: 90, strategy_id: state.strategyId }) });
      const link = new URL(result.share_url, location.origin);
      if (link.origin !== location.origin) throw new Error('The generated share destination was outside this app.');
      try { await navigator.clipboard.writeText(link.href); } catch (_) { /* the link remains visible below */ }
      const notice = $('research-notice'); notice.classList.remove('hidden'); notice.textContent = '';
      notice.append(document.createTextNode(`Read only link expires ${new Date(result.expires_at).toLocaleDateString('en-IN')}. Anyone with this link can view the run. `));
      const anchor = document.createElement('a'); anchor.href = link.href; anchor.textContent = 'Open share link'; notice.append(anchor);
    } catch (error) { showNotice(`Could not create share link: ${error.message}`, 'error'); }
  }

  function exportCSV() {
    if (!state.runId) return;
    const path = state.shared ? `/api/research/shared/${encodeURIComponent(state.shareToken)}/trades.csv` : `/api/research/backtests/${state.runId}/trades.csv?strategy_id=${encodeURIComponent(state.strategyId || '')}`;
    downloadFile(path, `neo_pip_research_${state.runId}_${state.strategyId}_trades.csv`);
  }

  async function downloadFile(path, filename) {
    try {
      const token = localStorage.getItem('neo_owner_token');
      const headers = token ? { Authorization: `Bearer ${token}`, 'X-Owner-Token': token } : {};
      const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', headers });
      if (!response.ok) {
        let detail = `Download failed (${response.status})`;
        try { detail = (await response.json()).detail || detail; } catch (_) { /* binary response */ }
        throw new Error(detail);
      }
      const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
      anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
    } catch (error) { showNotice(error.message, 'error'); }
  }

  function exportXlsx() {
    if (!state.runId) return;
    const path = state.shared ? `/api/research/shared/${encodeURIComponent(state.shareToken)}/report.xlsx` : `/api/research/backtests/${state.runId}/report.xlsx?strategy_id=${encodeURIComponent(state.strategyId || '')}`;
    downloadFile(path, `neo_pip_research_${state.runId}_${state.strategyId}.xlsx`);
  }

  function exportPDF() {
    if (!state.runId) return;
    const path = state.shared ? `/api/research/shared/${encodeURIComponent(state.shareToken)}/report.pdf` : `/api/research/backtests/${state.runId}/report.pdf?strategy_id=${encodeURIComponent(state.strategyId || '')}`;
    downloadFile(path, `neo_pip_research_${state.runId}_${state.strategyId}.pdf`);
  }

  function updateExpectancy() {
    const win = Math.max(0, Math.min(100, Number($('calc-win').value) || 0)) / 100;
    const averageWin = Math.max(0, Number($('calc-win-amount').value) || 0);
    const averageLoss = Math.max(0, Number($('calc-loss-amount').value) || 0);
    const cost = Math.max(0, Number($('calc-cost').value) || 0);
    const count = Math.max(1, Number($('calc-count').value) || 1);
    const capital = Math.max(1, Number($('calc-capital').value) || 1);
    const expectancy = win * averageWin - (1 - win) * averageLoss - cost;
    const breakeven = averageWin + averageLoss > 0 ? (averageLoss + cost) / (averageWin + averageLoss) * 100 : null;
    const rr = averageLoss > 0 ? averageWin / averageLoss : null;
    $('expectancy-output').innerHTML = [
      ['Expected per trade', money(expectancy, true)], ['Expected over selected trades', money(expectancy * count, true)],
      ['Break even win rate', breakeven == null ? 'N/A' : `${numeric(breakeven)}%`], ['Risk reward', rr == null ? 'N/A' : `${numeric(rr, 3)} to 1`],
      ['Expected return on capital', `${numeric(expectancy * count / capital * 100)}%`], ['Cost treatment', 'Costs deducted once']
    ].map(([label, value]) => `<div class="expectancy-value"><span>${escapeHTML(label)}</span><strong>${escapeHTML(value)}</strong></div>`).join('');
    const winRates = [20, 30, 40, 50, 60, 70, 80]; const ratios = [0.5, 1, 1.5, 2, 2.25, 3, 4];
    $('expectancy-heatmap').innerHTML = `<table><thead><tr><th>Win/loss ratio ↓ · Win rate →</th>${winRates.map((rate) => `<th>${rate}%</th>`).join('')}</tr></thead><tbody>${ratios.map((ratio) => `<tr><th>${numeric(ratio, 2)} : 1</th>${winRates.map((rate) => {
      const expected = (rate / 100) * (ratio * averageLoss) - (1 - rate / 100) * averageLoss - cost;
      return `<td class="${expected >= 0 ? 'heat-positive' : 'heat-negative'}" title="${rate}% win rate and ${ratio}:1 win/loss ratio">${money(expected, true)}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table>`;
  }

  async function loadPageRun() {
    const sharedMatch = location.pathname.match(/^\/results\/([^/]+)(?:\/([a-z0-9_-]+))?$/i);
    const privateMatch = location.pathname.match(/^\/research\/results\/(\d+)$/);
    if (sharedMatch) {
      state.shared = true; state.shareToken = sharedMatch[1]; setState('Read only share');
      try { const result = await fetch(`/api/research/shared/${encodeURIComponent(sharedMatch[1])}`, { cache: 'no-store' }); const data = await result.json(); if (!result.ok) throw new Error(data.detail || 'Shared result could not be loaded.'); state.runId = data.run.id; state.report = data.run.report; state.strategyId = sharedMatch[2] || data.run.strategy_id || state.report.strategies[0]?.strategy_id; renderReport(); }
      catch (error) { $('empty-results').classList.remove('hidden'); showNotice(error.message, 'error'); }
    } else if (privateMatch) {
      state.runId = Number(privateMatch[1]); await openSavedRun(String(state.runId));
    }
  }

  $('underlying-file').addEventListener('change', () => selectedCsvChanged('underlying-file', 'underlying-file-status', 'underlying'));
  $('options-file').addEventListener('change', () => selectedCsvChanged('options-file', 'options-file-status', 'options'));
  $('validate-local-dataset').addEventListener('click', validateLocalDataset);
  $('reload-local-dataset').addEventListener('click', discoverLocalDataset);
  $('upload-local-dataset').addEventListener('click', uploadSelectedDataset);
  $('load-browser-csvs').addEventListener('click', loadSelectedCsvsInBrowser);
  $('underlying').addEventListener('change', (event) => { if (['NIFTY', 'BANKNIFTY', 'SENSEX'].includes(event.target.value)) $('underlying-symbol').value = event.target.value; });
  $('run-backtest').addEventListener('click', runBacktest);
  $('saved-runs').addEventListener('change', (event) => openSavedRun(event.target.value));
  $('strategy-view').addEventListener('change', (event) => { state.strategyId = event.target.value; renderSelectedStrategy(); });
  $('share-result').addEventListener('click', createShare);
  $('run-optimization').addEventListener('click', optimizeSelectedStrategy);
  $('export-csv').addEventListener('click', exportCSV);
  $('export-xlsx').addEventListener('click', exportXlsx);
  $('export-pdf').addEventListener('click', exportPDF);
  $('print-report').addEventListener('click', () => window.print());
  $('metric-search').addEventListener('input', (event) => { state.metricFilter = event.target.value; const result = selectedStrategy(); if (result) renderCoreMetrics(result); });
  $('trade-search').addEventListener('input', (event) => { state.tradeFilter = event.target.value; const result = selectedStrategy(); if (result) renderTrades(result); });
  $('comparison-search').addEventListener('input', (event) => { state.comparisonFilter = event.target.value; renderComparison(); });
  $('comparison-table').querySelectorAll('th[data-key]').forEach((th) => th.addEventListener('click', () => { if (state.sortKey === th.dataset.key) state.sortDirection *= -1; else { state.sortKey = th.dataset.key; state.sortDirection = -1; } renderComparison(); }));
  document.querySelectorAll('.section-tab').forEach((tab) => tab.addEventListener('click', () => {
    document.querySelectorAll('.section-tab').forEach((item) => { const active = item === tab; item.classList.toggle('active', active); item.setAttribute('aria-selected', String(active)); });
    document.querySelectorAll('[data-panel]').forEach((panel) => panel.classList.toggle('hidden', panel.dataset.panel !== tab.dataset.view));
  }));
  ['calc-win', 'calc-win-amount', 'calc-loss-amount', 'calc-cost', 'calc-count', 'calc-capital'].forEach((id) => $(id).addEventListener('input', updateExpectancy));
  if (location.pathname.startsWith('/results/') || location.pathname.startsWith('/research/results/')) {
    $('data-panel').classList.add('hidden'); $('share-result').classList.add('hidden');
  }
  updateExpectancy(); loadSavedRuns(); loadPageRun();
  if (location.pathname.startsWith('/research')) discoverLocalDataset();
})();
