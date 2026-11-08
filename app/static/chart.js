// Neo PIP Advanced Pro Chart Engine
// Upstox Feed + Lightweight Charts + EMA 9/21 Cross + Volume Profile (Visible Range)
(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  // Parse URL Parameters
  const urlParams = new URLSearchParams(window.location.search);
  let currentSymbol = (urlParams.get('symbol') || 'NIFTY').toUpperCase().trim();
  let currentToken = urlParams.get('token') || '';
  let currentTf = (urlParams.get('interval') || '5s').toLowerCase();

  // Indicators State
  const state = {
    showEma9: true,
    showEma21: true,
    showVpvr: true,
    showVol: true,
    candles: [],
    volumes: [],
    ema9Data: [],
    ema21Data: [],
    vpvrData: { bins: [], pocPrice: null },
    lastTickPrice: null,
    activeBar: null,
    isOption: false,
    pollTimer: null,
  };

  // Lightweight Charts Instances
  let chart = null;
  let candleSeries = null;
  let volumeSeries = null;
  let ema9Series = null;
  let ema21Series = null;
  let vpvrCanvas = null;
  let vpvrCtx = null;

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

  // --- Technical Indicators Math ---
  function calculateEMA(candles, period) {
    if (!candles || candles.length < period) return [];
    const k = 2 / (period + 1);
    const result = [];
    
    // First SMA
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += candles[i].close;
    }
    let ema = sum / period;
    result.push({ time: candles[period - 1].time, value: round(ema, 2) });

    for (let i = period; i < candles.length; i++) {
      ema = (candles[i].close - ema) * k + ema;
      result.push({ time: candles[i].time, value: round(ema, 2) });
    }
    return result;
  }

  function round(val, dec = 2) {
    return Math.round(val * Math.pow(10, dec)) / Math.pow(10, dec);
  }

  // --- Volume Profile Visible Range (VPVR) Calculation ---
  function computeVPVR(visibleCandles) {
    if (!visibleCandles || visibleCandles.length < 5) return { bins: [], pocPrice: null, maxVol: 0 };
    let minP = Infinity;
    let maxP = -Infinity;
    visibleCandles.forEach(c => {
      if (c.low < minP) minP = c.low;
      if (c.high > maxP) maxP = c.high;
    });

    if (minP >= maxP) return { bins: [], pocPrice: null, maxVol: 0 };

    const binCount = 36;
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

  function drawVPVR() {
    if (!vpvrCanvas || !vpvrCtx || !chart || !state.showVpvr) {
      if (vpvrCtx && vpvrCanvas) vpvrCtx.clearRect(0, 0, vpvrCanvas.width, vpvrCanvas.height);
      return;
    }

    const { bins, pocPrice, maxVol } = state.vpvrData;
    vpvrCtx.clearRect(0, 0, vpvrCanvas.width, vpvrCanvas.height);
    if (!bins.length || maxVol <= 0) return;

    const w = vpvrCanvas.width;
    const maxBarWidth = w * 0.85;

    bins.forEach(b => {
      const yTop = candleSeries.priceToCoordinate(b.priceHigh);
      const yBottom = candleSeries.priceToCoordinate(b.priceLow);
      if (yTop == null || yBottom == null) return;

      const barH = Math.max(2, Math.abs(yBottom - yTop) - 1);
      const y = Math.min(yTop, yBottom);

      const buyRatio = b.buyVol / maxVol;
      const sellRatio = b.sellVol / maxVol;

      const buyW = buyRatio * maxBarWidth;
      const sellW = sellRatio * maxBarWidth;

      // Draw Buy Vol (Green)
      vpvrCtx.fillStyle = 'rgba(16, 185, 129, 0.35)';
      vpvrCtx.fillRect(w - buyW - sellW, y, buyW, barH);

      // Draw Sell Vol (Red)
      vpvrCtx.fillStyle = 'rgba(239, 68, 68, 0.35)';
      vpvrCtx.fillRect(w - sellW, y, sellW, barH);
    });

    // Draw Point of Control (POC Line)
    if (pocPrice != null) {
      const yPoc = candleSeries.priceToCoordinate(pocPrice);
      if (yPoc != null) {
        vpvrCtx.strokeStyle = '#fbbf24';
        vpvrCtx.lineWidth = 1.8;
        vpvrCtx.setLineDash([4, 4]);
        vpvrCtx.beginPath();
        vpvrCtx.moveTo(0, yPoc);
        vpvrCtx.lineTo(w, yPoc);
        vpvrCtx.stroke();
        vpvrCtx.setLineDash([]);

        // POC Label
        vpvrCtx.fillStyle = '#fbbf24';
        vpvrCtx.font = 'bold 9px "DM Mono", monospace';
        vpvrCtx.fillText(`POC: ${pocPrice.toFixed(2)}`, 8, yPoc - 4);
      }
    }
  }

  // --- Initialize Chart Canvas ---
  function initChart() {
    const wrap = $('chart-canvas');
    if (!wrap || !window.LightweightCharts) return;

    vpvrCanvas = $('vpvr-canvas');
    if (vpvrCanvas) {
      vpvrCtx = vpvrCanvas.getContext('2d');
      vpvrCanvas.width = vpvrCanvas.clientWidth || 200;
      vpvrCanvas.height = vpvrCanvas.clientHeight || wrap.clientHeight;
    }

    chart = window.LightweightCharts.createChart(wrap, {
      width: wrap.clientWidth,
      height: wrap.clientHeight,
      layout: {
        background: { type: 'solid', color: '#0f172a' },
        textColor: '#94a3b8',
        fontFamily: "'DM Mono', monospace, -apple-system, sans-serif",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(51, 65, 85, 0.35)' },
        horzLines: { color: 'rgba(51, 65, 85, 0.35)' },
      },
      crosshair: {
        mode: window.LightweightCharts.CrosshairMode.Normal,
      },
      rightPriceScale: {
        borderColor: '#334155',
        scaleMargins: { top: 0.08, bottom: 0.2 },
        autoScale: true,
      },
      timeScale: {
        borderColor: '#334155',
        timeVisible: true,
        secondsVisible: true,
        visible: true,
        fixLeftEdge: true,
        fixRightEdge: true,
      },
    });

    // 1. Candlestick Series
    candleSeries = chart.addCandlestickSeries({
      upColor: '#10b981',
      downColor: '#ef4444',
      borderVisible: false,
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
    });

    // 2. Volume Series
    volumeSeries = chart.addHistogramSeries({
      color: '#475569',
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    // 3. EMA 9 Series (Blue)
    ema9Series = chart.addLineSeries({
      color: '#3b82f6',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'EMA 9',
    });

    // 4. EMA 21 Series (Orange)
    ema21Series = chart.addLineSeries({
      color: '#f59e0b',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'EMA 21',
    });

    // Crosshair Subscriber
    chart.subscribeCrosshairMove(param => {
      if (!param || !param.time || !param.seriesData) return;
      const c = param.seriesData.get(candleSeries);
      const v = param.seriesData.get(volumeSeries);
      const e9 = param.seriesData.get(ema9Series);
      const e21 = param.seriesData.get(ema21Series);

      if (c) {
        if ($('leg-o')) $('leg-o').textContent = Number(c.open).toLocaleString('en-IN', { minimumFractionDigits: 2 });
        if ($('leg-h')) $('leg-h').textContent = Number(c.high).toLocaleString('en-IN', { minimumFractionDigits: 2 });
        if ($('leg-l')) $('leg-l').textContent = Number(c.low).toLocaleString('en-IN', { minimumFractionDigits: 2 });
        if ($('leg-c')) $('leg-c').textContent = Number(c.close).toLocaleString('en-IN', { minimumFractionDigits: 2 });
      }
      if (v && $('leg-v')) $('leg-v').textContent = Number(v.value).toLocaleString('en-IN');
      if (e9 && $('leg-ema9')) $('leg-ema9').textContent = Number(e9.value).toFixed(2);
      if (e21 && $('leg-ema21')) $('leg-ema21').textContent = Number(e21.value).toFixed(2);
    });

    // Visible range subscriber for real-time VPVR recalculation
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      recalculateVisibleVpvr();
    });

    window.addEventListener('resize', () => {
      if (!chart || !wrap) return;
      chart.applyOptions({ width: wrap.clientWidth, height: wrap.clientHeight });
      if (vpvrCanvas) {
        vpvrCanvas.width = 180;
        vpvrCanvas.height = wrap.clientHeight;
        drawVPVR();
      }
    });
  }

  function recalculateVisibleVpvr() {
    if (!chart || !state.candles.length || !state.showVpvr) return;
    const range = chart.timeScale().getVisibleLogicalRange();
    if (!range) return;

    const from = Math.max(0, Math.floor(range.from));
    const to = Math.min(state.candles.length - 1, Math.ceil(range.to));
    const visible = state.candles.slice(from, to + 1);

    state.vpvrData = computeVPVR(visible);
    if ($('leg-poc') && state.vpvrData.pocPrice) {
      $('leg-poc').textContent = state.vpvrData.pocPrice.toFixed(2);
    }
    drawVPVR();
  }

  // --- Load Candles & Update Indicators ---
  async function loadChartData() {
    const statusEl = $('chart-feed-status');
    if (statusEl) statusEl.textContent = `Fetching ${currentTf} data for ${currentSymbol}…`;

    try {
      const url = `/api/chart/candles?symbol=${encodeURIComponent(currentSymbol)}&token=${encodeURIComponent(currentToken)}&interval=${encodeURIComponent(currentTf)}`;
      const data = await api(url);

      if (!data.candles || !data.candles.length) {
        if (statusEl) statusEl.textContent = `No candle data found for ${currentSymbol}`;
        return;
      }

      state.isOption = !!data.is_option;
      const rawCandles = data.candles;

      state.candles = rawCandles.map(c => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume || 100,
      }));

      state.volumes = rawCandles.map(c => ({
        time: c.time,
        value: c.volume || 100,
        color: c.close >= c.open ? 'rgba(16, 185, 129, 0.35)' : 'rgba(239, 68, 68, 0.35)',
      }));

      candleSeries.setData(state.candles);
      volumeSeries.setData(state.showVol ? state.volumes : []);

      // Calculate EMAs
      state.ema9Data = calculateEMA(state.candles, 9);
      state.ema21Data = calculateEMA(state.candles, 21);

      if (ema9Series) ema9Series.setData(state.showEma9 ? state.ema9Data : []);
      if (ema21Series) ema21Series.setData(state.showEma21 ? state.ema21Data : []);

      // Update EMA Cross Badge
      updateEmaCrossBadge();

      chart.timeScale().fitContent();

      const last = state.candles[state.candles.length - 1];
      if (last) {
        state.activeBar = { ...last };
        state.lastTickPrice = last.close;
        updateHeaderQuote(last.close, state.candles[0]?.open || last.open);
      }

      recalculateVisibleVpvr();
      if (statusEl) statusEl.textContent = `⚡ Live Feed Active · ${data.date || 'Today'} · ${state.candles.length} bars`;
    } catch (err) {
      if (statusEl) statusEl.textContent = `Error: ${err.message}`;
    }
  }

  function updateEmaCrossBadge() {
    const badge = $('ema-cross-badge');
    const text = $('ema-cross-text');
    if (!badge || !text || !state.ema9Data.length || !state.ema21Data.length) return;

    const last9 = state.ema9Data[state.ema9Data.length - 1]?.value;
    const last21 = state.ema21Data[state.ema21Data.length - 1]?.value;

    badge.classList.remove('bullish', 'bearish', 'neutral');
    if (last9 > last21) {
      badge.classList.add('bullish');
      text.textContent = `EMA Cross: Bullish (9 > 21)`;
    } else if (last9 < last21) {
      badge.classList.add('bearish');
      text.textContent = `EMA Cross: Bearish (9 < 21)`;
    } else {
      badge.classList.add('neutral');
      text.textContent = `EMA Cross: Neutral`;
    }
  }

  function updateHeaderQuote(ltp, refPrice) {
    const ltpEl = $('chart-ltp');
    const chgEl = $('chart-chg');
    if (ltpEl) ltpEl.textContent = `₹${Number(ltp).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    if (chgEl && refPrice > 0) {
      const diff = ltp - refPrice;
      const pct = (diff / refPrice) * 100;
      const isPos = diff >= 0;
      chgEl.className = `quote-chg ${isPos ? 'pos' : 'neg'}`;
      chgEl.textContent = `${isPos ? '+' : ''}${diff.toFixed(2)} (${isPos ? '+' : ''}${pct.toFixed(2)}%)`;
    }
  }

  // --- Real-Time Tick Update ---
  function pushTick(ltp) {
    if (!candleSeries || !ltp || ltp <= 0) return;
    const nowSec = Math.floor(Date.now() / 1000);
    const intervalSec = currentTf === '15s' ? 15 : (currentTf === '1m' ? 60 : (currentTf === '5m' ? 300 : (currentTf === '15m' ? 900 : 5)));
    const bucketTime = Math.floor(nowSec / intervalSec) * intervalSec;

    if (!state.activeBar || bucketTime > state.activeBar.time) {
      state.activeBar = {
        time: bucketTime,
        open: ltp,
        high: ltp,
        low: ltp,
        close: ltp,
        volume: 10,
      };
    } else {
      state.activeBar.high = Math.max(state.activeBar.high, ltp);
      state.activeBar.low = Math.min(state.activeBar.low, ltp);
      state.activeBar.close = ltp;
      state.activeBar.volume += 10;
    }

    try {
      candleSeries.update(state.activeBar);
      updateHeaderQuote(ltp, state.candles[0]?.open || ltp);
      if ($('leg-c')) $('leg-c').textContent = Number(ltp).toFixed(2);
    } catch (_) {}
  }

  // --- Event Listeners & Wiring ---
  function setupEvents() {
    // 1. Symbol Search
    const symInput = $('chart-symbol-input');
    const symApply = $('chart-symbol-apply');

    const doApplySym = () => {
      const s = symInput.value.trim().toUpperCase();
      if (!s) return;
      currentSymbol = s;
      currentToken = '';
      $('leg-symbol').textContent = s;
      document.querySelectorAll('.sym-chip').forEach(c => c.classList.toggle('active', c.dataset.sym === s));
      loadChartData();
    };

    if (symApply) symApply.addEventListener('click', doApplySym);
    if (symInput) symInput.addEventListener('keydown', e => { if (e.key === 'Enter') doApplySym(); });

    // 2. Symbol Quick Chips
    document.querySelectorAll('.sym-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.sym-chip').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        currentSymbol = btn.dataset.sym;
        currentToken = '';
        if (symInput) symInput.value = currentSymbol;
        $('leg-symbol').textContent = currentSymbol;
        loadChartData();
      });
    });

    // 3. Timeframe Buttons
    document.querySelectorAll('.tf-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentTf = btn.dataset.tf || '5s';
        loadChartData();
      });
    });

    // 4. Indicator Toggles
    const tEma9 = $('toggle-ema9');
    if (tEma9) {
      tEma9.addEventListener('click', () => {
        state.showEma9 = !state.showEma9;
        tEma9.classList.toggle('active', state.showEma9);
        if (ema9Series) ema9Series.setData(state.showEma9 ? state.ema9Data : []);
      });
    }

    const tEma21 = $('toggle-ema21');
    if (tEma21) {
      tEma21.addEventListener('click', () => {
        state.showEma21 = !state.showEma21;
        tEma21.classList.toggle('active', state.showEma21);
        if (ema21Series) ema21Series.setData(state.showEma21 ? state.ema21Data : []);
      });
    }

    const tVpvr = $('toggle-vpvr');
    if (tVpvr) {
      tVpvr.addEventListener('click', () => {
        state.showVpvr = !state.showVpvr;
        tVpvr.classList.toggle('active', state.showVpvr);
        if (state.showVpvr) recalculateVisibleVpvr();
        else if (vpvrCtx && vpvrCanvas) vpvrCtx.clearRect(0, 0, vpvrCanvas.width, vpvrCanvas.height);
      });
    }

    const tVol = $('toggle-vol');
    if (tVol) {
      tVol.addEventListener('click', () => {
        state.showVol = !state.showVol;
        tVol.classList.toggle('active', state.showVol);
        if (volumeSeries) volumeSeries.setData(state.showVol ? state.volumes : []);
      });
    }

    // 5. Scalper 1-Click Buy
    const buyBtn = $('chart-buy-btn');
    if (buyBtn) {
      buyBtn.addEventListener('click', async () => {
        const lots = parseInt($('chart-lots-input')?.value || '1', 10);
        buyBtn.disabled = true;
        buyBtn.textContent = 'Buying…';
        try {
          const res = await api('/api/orders', {
            method: 'POST',
            body: JSON.stringify({
              symbol: currentSymbol,
              exchange_segment: state.isOption ? 'nse_fo' : 'nse_cm',
              product: 'MIS',
              side: 'BUY',
              lots: lots,
              lot_size: state.isOption ? 65 : 1,
              order_type: 'MKT',
              price: 0,
              trigger_price: 0,
              validity: 'DAY',
            })
          });
          toast(`⚡ Order Dispatched: BUY ${lots} lots of ${currentSymbol}`, 3500);
        } catch (err) {
          toast(`Order Failed: ${err.message}`, 4000);
        } finally {
          buyBtn.disabled = false;
          buyBtn.textContent = 'BUY MKT';
        }
      });
    }

    // 6. Panic Exit All
    const exitBtn = $('chart-exit-btn');
    if (exitBtn) {
      exitBtn.addEventListener('click', async () => {
        exitBtn.disabled = true;
        exitBtn.textContent = 'Exiting…';
        try {
          const res = await api('/api/positions/exit-all', { method: 'POST' });
          toast(`🚨 Panic Exit Dispatched: ${res.closed_positions || 0} positions closed!`, 4000);
        } catch (err) {
          toast(`Exit Failed: ${err.message}`, 4000);
        } finally {
          exitBtn.disabled = false;
          exitBtn.textContent = 'EXIT ALL';
        }
      });
    }

    // 7. Upstox Token Dialog
    const tokenBtn = $('chart-token-btn');
    const tokenModal = $('token-modal');
    const closeTokenBtn = $('close-token-modal');
    const saveTokenBtn = $('save-token-submit');

    if (tokenBtn && tokenModal) {
      tokenBtn.addEventListener('click', async () => {
        tokenModal.classList.remove('hidden');
        const stPill = $('token-status-pill');
        try {
          const res = await api('/api/chart/upstox-status');
          if (stPill) {
            stPill.textContent = res.token_configured ? `Status: Active (${res.token_preview})` : 'Status: Token Not Configured';
            stPill.style.color = res.token_configured ? '#34d399' : '#f87171';
          }
        } catch (_) {}
      });
    }

    if (closeTokenBtn && tokenModal) {
      closeTokenBtn.addEventListener('click', () => tokenModal.classList.add('hidden'));
    }

    if (saveTokenBtn) {
      saveTokenBtn.addEventListener('click', async () => {
        const input = $('upstox-token-val');
        const token = input ? input.value.trim() : '';
        try {
          const res = await api('/api/chart/upstox-token', {
            method: 'POST',
            body: JSON.stringify({ token })
          });
          toast(res.message || 'Token saved!', 3000);
          if (tokenModal) tokenModal.classList.add('hidden');
          loadChartData();
        } catch (err) {
          toast(`Error: ${err.message}`, 3500);
        }
      });
    }
  }

  // Initial Boot
  window.addEventListener('DOMContentLoaded', () => {
    $('chart-symbol-input').value = currentSymbol;
    $('leg-symbol').textContent = currentSymbol;
    document.querySelectorAll('.tf-btn').forEach(b => b.classList.toggle('active', b.dataset.tf === currentTf));
    document.querySelectorAll('.sym-chip').forEach(c => c.classList.toggle('active', c.dataset.sym === currentSymbol));

    initChart();
    setupEvents();
    loadChartData();

    // Background Poll for Latest Quote / Intraday Refresh every 3 seconds
    setInterval(async () => {
      try {
        const data = await api('/api/indices/quotes');
        if (data.indices && Array.isArray(data.indices)) {
          const match = data.indices.find(x => x.name === currentSymbol);
          if (match && match.ltp) {
            pushTick(match.ltp);
          }
        }
      } catch (_) {}
    }, 2500);
  });
})();
