// Neo PIP — Trade From Charts (Kotak Neo Dark Engine)
// Multi-Pane Lightweight Charts + Fast Sub-Second Quotes + Scalper Window + VPVR
(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  // Indicators State
  const indicators = {
    showEma9: true,
    showEma21: true,
    showVpvr: true,
    showVol: true,
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
      vpvrCanvas: null,
      vpvrCtx: null,
      vpvrData: { bins: [], pocPrice: null, maxVol: 0 },
      activeBar: null,
      lastLtp: null,
    },
    {
      idx: 1,
      id: 'pane-2',
      sym: 'NIFTY26N0924900CE',
      token: '40020',
      tf: '3m',
      isOption: true,
      candles: [],
      volumes: [],
      chart: null,
      candleSeries: null,
      volSeries: null,
      ema9Series: null,
      ema21Series: null,
      vpvrCanvas: null,
      vpvrCtx: null,
      vpvrData: { bins: [], pocPrice: null, maxVol: 0 },
      activeBar: null,
      lastLtp: null,
    },
    {
      idx: 2,
      id: 'pane-3',
      sym: 'NIFTY26N0924900PE',
      token: '40021',
      tf: '1m',
      isOption: true,
      candles: [],
      volumes: [],
      chart: null,
      candleSeries: null,
      volSeries: null,
      ema9Series: null,
      ema21Series: null,
      vpvrCanvas: null,
      vpvrCtx: null,
      vpvrData: { bins: [], pocPrice: null, maxVol: 0 },
      activeBar: null,
      lastLtp: null,
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

  // --- Technical Math (EMA) ---
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
        scaleMargins: { top: 0.08, bottom: 0.18 },
        autoScale: true,
      },
      timeScale: {
        borderColor: 'rgba(255, 255, 255, 0.08)',
        timeVisible: true,
        secondsVisible: false,
        visible: true,
        fixLeftEdge: false,
        fixRightEdge: false, // CRITICAL: allows smooth right scrolling
        rightOffset: 16,     // CRITICAL: gives 16 bars of empty space on right!
        barSpacing: 9,       // comfortable candle spacing
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

    // 2. Volume Series
    pane.volSeries = pane.chart.addHistogramSeries({
      color: '#334155',
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      scaleMargins: { top: 0.82, bottom: 0 },
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
        value: c.volume || 100,
        color: c.close >= c.open ? 'rgba(8, 153, 129, 0.4)' : 'rgba(242, 54, 69, 0.4)',
      }));

      pane.candleSeries.setData(pane.candles);
      pane.volSeries.setData(indicators.showVol ? pane.volumes : []);

      const ema9 = calculateEMA(pane.candles, 9);
      const ema21 = calculateEMA(pane.candles, 21);
      pane.ema9Series.setData(indicators.showEma9 ? ema9 : []);
      pane.ema21Series.setData(indicators.showEma21 ? ema21 : []);

      // Fit content and restore spacious right margin
      pane.chart.timeScale().applyOptions({
        rightOffset: 16,
        barSpacing: 9,
      });

      const last = pane.candles[pane.candles.length - 1];
      if (last) {
        pane.activeBar = { ...last };
        pane.lastLtp = last.close;
        const first = pane.candles[0];
        updatePaneQuote(pane, last.close, first ? first.open : last.open);
      }

      recalculatePaneVPVR(pane);
    } catch (err) {
      console.warn(`Load pane ${pane.idx} error:`, err);
    }
  }

  function updatePaneQuote(pane, ltp, refPrice) {
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

    if (chgEl && refPrice > 0) {
      const diff = ltp - refPrice;
      const pct = (diff / refPrice) * 100;
      const isPos = diff >= 0;
      chgEl.className = `pane-chg ${isPos ? 'pos' : 'neg'}`;
      chgEl.textContent = `${isPos ? '+' : ''}${diff.toFixed(2)} (${isPos ? '+' : ''}${pct.toFixed(2)}%)`;
    }

    // Sync to scalper window if this pane is currently active
    if (pane.idx === activePaneIdx) {
      const scLtp = $('sc-ltp');
      const scChg = $('sc-chg');
      if (scLtp) scLtp.textContent = Number(ltp).toFixed(2);
      if (scChg && refPrice > 0) {
        const diff = ltp - refPrice;
        const pct = (diff / refPrice) * 100;
        const isPos = diff >= 0;
        scChg.className = `sc-chg ${isPos ? 'pos' : 'neg'}`;
        scChg.textContent = `${isPos ? '▲ +' : '▼ '}${diff.toFixed(2)} (${pct.toFixed(2)}%)`;
      }
    }
  }

  // --- Real-Time Fast Tick Polling Loop (Sub-Second 750ms) ---
  function startRealtimeTickLoop() {
    setInterval(async () => {
      // Determine which panes are active in current layout
      const visiblePanes = activeLayout === 1 ? [panes[0]] : (activeLayout === 2 ? [panes[0], panes[1]] : panes);
      const items = visiblePanes.map(p => ({ symbol: p.sym, token: p.token }));

      try {
        const data = await api('/api/chart/live-quotes', {
          method: 'POST',
          body: JSON.stringify({ items }),
        });

        if (data.quotes && Array.isArray(data.quotes)) {
          data.quotes.forEach(q => {
            const pane = visiblePanes.find(p => p.sym === q.symbol);
            if (!pane || !pane.candleSeries || !q.ltp) return;

            const ltp = q.ltp;
            const nowSec = Math.floor(Date.now() / 1000);
            const tfSec = pane.tf === '15s' ? 15 : (pane.tf === '1m' ? 60 : (pane.tf === '3m' ? 180 : (pane.tf === '5m' ? 300 : (pane.tf === '15m' ? 900 : 5))));
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
              updatePaneQuote(pane, ltp, pane.candles[0]?.open || ltp);
            } catch (_) {}
          });
        }
      } catch (_) {}
    }, 750);

    // Indices Ticker & Position P&L update every 2.5 seconds
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

        // Positions P&L
        const posData = await api('/api/positions');
        if (posData && Array.isArray(posData.positions)) {
          const totalPnl = posData.total_pnl || 0;
          const pnlEl = $('header-pnl-val');
          if (pnlEl) {
            const isPos = totalPnl >= 0;
            pnlEl.className = `pnl-val ${isPos ? 'pos' : 'neg'}`;
            pnlEl.textContent = `${isPos ? '+' : ''}₹${totalPnl.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
          }

          // Scalper active position info
          const activeSym = panes[activePaneIdx]?.sym;
          const matchPos = posData.positions.find(p => p.symbol === activeSym);
          const posSection = $('sc-position-section');
          const posBadge = $('sc-pos-badge');
          const posSum = $('sc-pos-summary');
          const posPnl = $('sc-pos-pnl');

          if (matchPos && Math.abs(matchPos.quantity || 0) > 0) {
            if (posSection) posSection.style.display = 'flex';
            if (posBadge) {
              posBadge.textContent = `${matchPos.quantity > 0 ? 'LONG' : 'SHORT'} ${Math.abs(matchPos.quantity)} Qty`;
              posBadge.style.color = '#38bdf8';
            }
            if (posSum) {
              posSum.textContent = `Position: ${Math.abs(matchPos.quantity)} units @ Avg ₹${Number(matchPos.avg_price || 0).toFixed(2)}`;
            }
            if (posPnl) {
              const pnl = matchPos.pnl || 0;
              const isP = pnl >= 0;
              posPnl.className = `sc-pnl-pill ${isP ? 'pos' : 'neg'}`;
              posPnl.textContent = `P&L: ${isP ? '+' : ''}₹${pnl.toFixed(2)}`;
            }
          } else {
            if (posBadge) {
              posBadge.textContent = 'No Position';
              posBadge.style.color = 'var(--text-dim)';
            }
          }
        }
      } catch (_) {}
    }, 2000);
  }

  // --- Scalper Form & Window Controls ---
  function updateScalperContract(pane) {
    const title = $('sc-contract-title');
    if (title) title.textContent = pane.sym;
    const ltpEl = $('sc-ltp');
    if (ltpEl && pane.lastLtp) ltpEl.textContent = Number(pane.lastLtp).toFixed(2);
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
      try {
        const res = await api('/api/positions/trail-to-cost', {
          method: 'POST',
          body: JSON.stringify({ symbol: pane.sym }),
        });
        toast(res.message || '🛡️ SL Trailed to Cost Price!', 3500);
      } catch (err) {
        toast(`Trail SL Failed: ${err.message}`, 4000);
      }
    });

    // Quick Action 2: Exit 50%
    $('sc-exit-50-btn')?.addEventListener('click', async () => {
      const pane = panes[activePaneIdx];
      try {
        const res = await api('/api/positions/exit-partial', {
          method: 'POST',
          body: JSON.stringify({ symbol: pane.sym, percentage: 50 }),
        });
        toast(res.message || '½ Closed 50% Position!', 3500);
      } catch (err) {
        toast(`Exit 50% Failed: ${err.message}`, 4000);
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

  // --- Indicator Toggles ---
  function setupIndicatorToggles() {
    const toggleInd = (btnId, key, updater) => {
      const btn = $(btnId);
      if (!btn) return;
      btn.addEventListener('click', () => {
        indicators[key] = !indicators[key];
        btn.classList.toggle('active', indicators[key]);
        panes.forEach(p => updater(p, indicators[key]));
      });
    };

    toggleInd('btn-ind-ema9', 'showEma9', (p, val) => {
      const ema9 = calculateEMA(p.candles, 9);
      if (p.ema9Series) p.ema9Series.setData(val ? ema9 : []);
    });

    toggleInd('btn-ind-ema21', 'showEma21', (p, val) => {
      const ema21 = calculateEMA(p.candles, 21);
      if (p.ema21Series) p.ema21Series.setData(val ? ema21 : []);
    });

    toggleInd('btn-ind-vol', 'showVol', (p, val) => {
      if (p.volSeries) p.volSeries.setData(val ? p.volumes : []);
    });

    toggleInd('btn-ind-vpvr', 'showVpvr', (p, val) => {
      if (val) recalculatePaneVPVR(p);
      else if (p.vpvrCtx && p.vpvrCanvas) p.vpvrCtx.clearRect(0, 0, p.vpvrCanvas.width, p.vpvrCanvas.height);
    });
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
    setupIndicatorToggles();
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
