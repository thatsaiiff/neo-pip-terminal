// Neo PIP — Modular Indicator Math, Configurable EMA / Crossover Engine & Volume Profile (POC / VAH / VAL)
(function (global) {
  'use strict';

  const IND_STORAGE_KEY = 'neo_chart_ind_config_v1';

  const DEFAULT_IND_CONFIG = {
    showEmaFast: true,
    showEmaSlow: true,
    showCrossoverSignals: true,
    emaFastPeriod: 9,
    emaSlowPeriod: 15,
    showEmaMid: false,
    emaMidPeriod: 50,
    showEmaLong: false,
    emaLongPeriod: 200,
    showVwap: false,
    showSupertrend: false,
    showVpvr: false,
    vpvrMode: 'visible', // 'visible' | 'session'
    vpvrVaPct: 70,
    vpvrBins: 36,
    showVol: false,
    showBb: false,
  };

  function sanitizePeriod(val, fallback) {
    const n = Math.round(Number(val));
    if (!Number.isFinite(n) || n < 1) return fallback;
    return Math.max(1, Math.min(500, n));
  }

  function sanitizeVaPct(val, fallback = 70) {
    const n = Math.round(Number(val));
    if (!Number.isFinite(n) || n < 10) return fallback;
    return Math.max(10, Math.min(99, n));
  }

  function sanitizeBins(val, fallback = 36) {
    const n = Math.round(Number(val));
    if (!Number.isFinite(n) || n < 8) return fallback;
    return Math.max(8, Math.min(120, n));
  }

  function normalizeConfig(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    return {
      showEmaFast: src.showEmaFast !== undefined ? Boolean(src.showEmaFast) : DEFAULT_IND_CONFIG.showEmaFast,
      showEmaSlow: src.showEmaSlow !== undefined ? Boolean(src.showEmaSlow) : DEFAULT_IND_CONFIG.showEmaSlow,
      showCrossoverSignals: src.showCrossoverSignals !== undefined ? Boolean(src.showCrossoverSignals) : DEFAULT_IND_CONFIG.showCrossoverSignals,
      emaFastPeriod: sanitizePeriod(src.emaFastPeriod, DEFAULT_IND_CONFIG.emaFastPeriod),
      emaSlowPeriod: sanitizePeriod(src.emaSlowPeriod, DEFAULT_IND_CONFIG.emaSlowPeriod),
      showEmaMid: Boolean(src.showEmaMid),
      emaMidPeriod: sanitizePeriod(src.emaMidPeriod, DEFAULT_IND_CONFIG.emaMidPeriod),
      showEmaLong: Boolean(src.showEmaLong),
      emaLongPeriod: sanitizePeriod(src.emaLongPeriod, DEFAULT_IND_CONFIG.emaLongPeriod),
      showVwap: Boolean(src.showVwap),
      showSupertrend: Boolean(src.showSupertrend),
      showVpvr: Boolean(src.showVpvr),
      vpvrMode: src.vpvrMode === 'session' ? 'session' : 'visible',
      vpvrVaPct: sanitizeVaPct(src.vpvrVaPct, DEFAULT_IND_CONFIG.vpvrVaPct),
      vpvrBins: sanitizeBins(src.vpvrBins, DEFAULT_IND_CONFIG.vpvrBins),
      showVol: Boolean(src.showVol),
      showBb: Boolean(src.showBb),
    };
  }

  function loadIndicatorConfig() {
    try {
      const saved = global.localStorage && global.localStorage.getItem(IND_STORAGE_KEY);
      if (saved) {
        return normalizeConfig(JSON.parse(saved));
      }
    } catch (_) {}
    return normalizeConfig(DEFAULT_IND_CONFIG);
  }

  function saveIndicatorConfig(cfg) {
    const clean = normalizeConfig(cfg);
    try {
      if (global.localStorage) {
        global.localStorage.setItem(IND_STORAGE_KEY, JSON.stringify(clean));
      }
    } catch (_) {}
    return clean;
  }

  function calculateEMA(candles, period, decimals = 2) {
    const p = sanitizePeriod(period, 9);
    if (!candles || candles.length < p) return [];
    const k = 2 / (p + 1);
    const useExact = decimals === null;
    const factor = useExact ? 1 : Math.pow(10, Math.min(6, Math.max(2, Number(decimals) || 2)));
    const result = [];
    let sum = 0;
    for (let i = 0; i < p; i++) sum += Number(candles[i].close);
    let ema = sum / p;
    result.push({
      time: candles[p - 1].time,
      value: useExact ? ema : Math.round(ema * factor) / factor,
    });
    for (let i = p; i < candles.length; i++) {
      ema = (Number(candles[i].close) - ema) * k + ema;
      result.push({
        time: candles[i].time,
        value: useExact ? ema : Math.round(ema * factor) / factor,
      });
    }
    return result;
  }

  function calculateEMACrossoverSignals(candles, fastPeriod, slowPeriod, decimals = 2) {
    const fastP = sanitizePeriod(fastPeriod, 9);
    const slowP = sanitizePeriod(slowPeriod, 15);
    if (!candles || candles.length < Math.max(fastP, slowP) + 1) {
      return { markers: [], events: [], latestSignal: 'NEUTRAL', fastVal: null, slowVal: null, lastCrossTime: null };
    }

    // Compute unrounded EMAs so crossover detection matches exact mathematical crossings
    const fastArr = calculateEMA(candles, fastP, null);
    const slowArr = calculateEMA(candles, slowP, null);
    const slowMap = new Map();
    for (let i = 0; i < slowArr.length; i++) {
      slowMap.set(slowArr[i].time, slowArr[i].value);
    }

    const aligned = [];
    for (let i = 0; i < fastArr.length; i++) {
      const t = fastArr[i].time;
      if (slowMap.has(t)) {
        aligned.push({ time: t, fast: fastArr[i].value, slow: slowMap.get(t) });
      }
    }

    if (aligned.length === 0) {
      return { markers: [], events: [], latestSignal: 'NEUTRAL', fastVal: null, slowVal: null, lastCrossTime: null };
    }

    const lastPt = aligned[aligned.length - 1];
    const decFactor = Math.pow(10, Math.min(6, Math.max(2, Number(decimals) || 2)));
    const fastVal = Math.round(lastPt.fast * decFactor) / decFactor;
    const slowVal = Math.round(lastPt.slow * decFactor) / decFactor;

    let latestSignal = 'NEUTRAL';
    if (fastP !== slowP) {
      latestSignal = lastPt.fast > lastPt.slow ? 'BUY' : (lastPt.fast < lastPt.slow ? 'SELL' : 'NEUTRAL');
    }

    const events = [];
    const markers = [];
    if (fastP !== slowP) {
      for (let i = 1; i < aligned.length; i++) {
        const prev = aligned[i - 1];
        const cur = aligned[i];
        if (prev.fast <= prev.slow && cur.fast > cur.slow) {
          events.push({ time: cur.time, side: 'BUY', fast: cur.fast, slow: cur.slow });
          markers.push({
            time: cur.time,
            position: 'belowBar',
            color: '#00d084',
            shape: 'arrowUp',
            text: `▲ ${fastP}/${slowP}`,
          });
        } else if (prev.fast >= prev.slow && cur.fast < cur.slow) {
          events.push({ time: cur.time, side: 'SELL', fast: cur.fast, slow: cur.slow });
          markers.push({
            time: cur.time,
            position: 'aboveBar',
            color: '#ff4757',
            shape: 'arrowDown',
            text: `▼ ${fastP}/${slowP}`,
          });
        }
      }
    }

    // Keep markers concise (most recent 40 signals to preserve zero LWC lag)
    const boundedMarkers = markers.length > 40 ? markers.slice(-40) : markers;
    const lastCrossTime = events.length ? events[events.length - 1].time : null;
    return { markers: boundedMarkers, events, latestSignal, fastVal, slowVal, lastCrossTime };
  }

  function computeSingleVolumeProfile(candlesSlice, valueAreaPct = 70, binCount = 36) {
    if (!candlesSlice || candlesSlice.length === 0) {
      return {
        bins: [],
        pocPrice: null,
        vahPrice: null,
        valPrice: null,
        pocIdx: -1,
        vaLowIdx: -1,
        vaHighIdx: -1,
        maxVol: 0,
        totalVol: 0,
        valueAreaPct: sanitizeVaPct(valueAreaPct, 70),
        startTime: null,
        endTime: null,
        usedSyntheticActivity: false,
      };
    }

    const vaPct = sanitizeVaPct(valueAreaPct, 70);
    const nBins = sanitizeBins(binCount, 36);
    let minP = Infinity;
    let maxP = -Infinity;
    let hasRealVol = false;

    for (let i = 0; i < candlesSlice.length; i++) {
      const c = candlesSlice[i];
      const lo = Number(c.low);
      const hi = Number(c.high);
      if (Number.isFinite(lo) && lo < minP) minP = lo;
      if (Number.isFinite(hi) && hi > maxP) maxP = hi;
      if (Number(c.volume) > 0) hasRealVol = true;
    }

    if (!Number.isFinite(minP) || !Number.isFinite(maxP)) {
      return computeSingleVolumeProfile([], vaPct, nBins);
    }
    if (maxP <= minP) {
      const pad = Math.max(0.05, Math.abs(minP) * 0.001);
      minP -= pad;
      maxP += pad;
    }

    const binSize = (maxP - minP) / nBins;
    const bins = Array.from({ length: nBins }, (_, idx) => ({
      index: idx,
      priceLow: minP + idx * binSize,
      priceHigh: minP + (idx + 1) * binSize,
      priceMid: minP + (idx + 0.5) * binSize,
      buyVol: 0,
      sellVol: 0,
      totalVol: 0,
      inValueArea: false,
      isPoc: false,
    }));

    // Distribute candle volume cleanly across all bins spanned by [low, high]
    for (let i = 0; i < candlesSlice.length; i++) {
      const c = candlesSlice[i];
      const hi = Number(c.high);
      const lo = Number(c.low);
      const op = Number(c.open);
      const cl = Number(c.close);
      const rawVol = Number(c.volume || 0);
      const effVol = hasRealVol ? Math.max(0, rawVol) : Math.max(10, Math.round(((hi - lo) / binSize + 1) * 25));
      if (effVol <= 0) continue;

      const startBin = Math.max(0, Math.min(nBins - 1, Math.floor((lo - minP) / binSize)));
      const endBin = Math.max(startBin, Math.min(nBins - 1, Math.floor((hi - minP) / binSize)));
      const span = endBin - startBin + 1;
      const share = effVol / span;
      const isBull = cl >= op;

      for (let b = startBin; b <= endBin; b++) {
        if (isBull) bins[b].buyVol += share;
        else bins[b].sellVol += share;
        bins[b].totalVol += share;
      }
    }

    let maxVol = 0;
    let totalVol = 0;
    let pocIdx = 0;
    for (let i = 0; i < bins.length; i++) {
      totalVol += bins[i].totalVol;
      if (bins[i].totalVol > maxVol) {
        maxVol = bins[i].totalVol;
        pocIdx = i;
      }
    }

    if (totalVol <= 0) {
      return {
        bins,
        pocPrice: null,
        vahPrice: null,
        valPrice: null,
        pocIdx: -1,
        vaLowIdx: -1,
        vaHighIdx: -1,
        maxVol: 0,
        totalVol: 0,
        valueAreaPct: vaPct,
        startTime: candlesSlice[0].time,
        endTime: candlesSlice[candlesSlice.length - 1].time,
        usedSyntheticActivity: !hasRealVol,
      };
    }

    bins[pocIdx].isPoc = true;
    const pocPrice = bins[pocIdx].priceMid;

    // Standard TradingView dual-pointer Value Area expansion starting at POC
    const targetVol = totalVol * (vaPct / 100);
    let vaLowIdx = pocIdx;
    let vaHighIdx = pocIdx;
    let vaVol = bins[pocIdx].totalVol;
    bins[pocIdx].inValueArea = true;

    while (vaVol < targetVol && (vaLowIdx > 0 || vaHighIdx < nBins - 1)) {
      const up1 = vaHighIdx + 1 < nBins ? bins[vaHighIdx + 1].totalVol : -1;
      const up2 = vaHighIdx + 2 < nBins ? bins[vaHighIdx + 2].totalVol : 0;
      const dn1 = vaLowIdx - 1 >= 0 ? bins[vaLowIdx - 1].totalVol : -1;
      const dn2 = vaLowIdx - 2 >= 0 ? bins[vaLowIdx - 2].totalVol : 0;

      const canUp = up1 >= 0;
      const canDn = dn1 >= 0;
      if (!canUp && !canDn) break;

      const sumUp = canUp ? up1 + Math.max(0, up2) : -1;
      const sumDn = canDn ? dn1 + Math.max(0, dn2) : -1;

      if (canUp && (!canDn || sumUp >= sumDn)) {
        vaHighIdx += 1;
        bins[vaHighIdx].inValueArea = true;
        vaVol += bins[vaHighIdx].totalVol;
        if (vaVol < targetVol && vaHighIdx + 1 < nBins && bins[vaHighIdx + 1].totalVol > 0 && sumUp === up1 + up2) {
          vaHighIdx += 1;
          bins[vaHighIdx].inValueArea = true;
          vaVol += bins[vaHighIdx].totalVol;
        }
      } else if (canDn) {
        vaLowIdx -= 1;
        bins[vaLowIdx].inValueArea = true;
        vaVol += bins[vaLowIdx].totalVol;
        if (vaVol < targetVol && vaLowIdx - 1 >= 0 && bins[vaLowIdx - 1].totalVol > 0 && sumDn === dn1 + dn2) {
          vaLowIdx -= 1;
          bins[vaLowIdx].inValueArea = true;
          vaVol += bins[vaLowIdx].totalVol;
        }
      }
    }

    return {
      bins,
      pocPrice,
      vahPrice: bins[vaHighIdx].priceHigh,
      valPrice: bins[vaLowIdx].priceLow,
      pocIdx,
      vaLowIdx,
      vaHighIdx,
      maxVol,
      totalVol,
      valueAreaVol: vaVol,
      valueAreaPct: vaPct,
      startTime: candlesSlice[0].time,
      endTime: candlesSlice[candlesSlice.length - 1].time,
      usedSyntheticActivity: !hasRealVol,
    };
  }

  function getSessionKey(epochSec, marketMode) {
    const ms = Number(epochSec) * 1000;
    const offsetMs = marketMode === 'forex' ? 0 : 19800000; // UTC+5:30 IST for Indian sessions
    const d = new Date(ms + offsetMs);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function computeVolumeProfile(candles, opts = {}) {
    const mode = opts.mode === 'session' ? 'session' : 'visible';
    const vaPct = sanitizeVaPct(opts.valueAreaPct, 70);
    const nBins = sanitizeBins(opts.binCount, 36);
    const marketMode = opts.marketMode || 'indian';

    if (!candles || !candles.length) {
      return { mode, valueAreaPct: vaPct, profiles: [] };
    }

    if (mode === 'visible') {
      const p = computeSingleVolumeProfile(candles, vaPct, nBins);
      return {
        mode,
        valueAreaPct: vaPct,
        profiles: p.bins.length ? [p] : [],
      };
    }

    // Session-based Volume Profile: group visible candles by trading session day
    const groups = new Map();
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const sk = getSessionKey(c.time, marketMode);
      if (!groups.has(sk)) groups.set(sk, []);
      groups.get(sk).push(c);
    }

    const profiles = [];
    groups.forEach((slice, sessionKey) => {
      if (slice.length >= 2) {
        const p = computeSingleVolumeProfile(slice, vaPct, nBins);
        if (p.bins.length && p.totalVol > 0) {
          p.sessionKey = sessionKey;
          profiles.push(p);
        }
      }
    });

    if (!profiles.length) {
      const p = computeSingleVolumeProfile(candles, vaPct, nBins);
      if (p.bins.length) {
        p.sessionKey = getSessionKey(candles[0].time, marketMode);
        profiles.push(p);
      }
    }

    return {
      mode,
      valueAreaPct: vaPct,
      profiles: profiles.slice(-8), // Up to 8 recent visible sessions cleanly
    };
  }

  function renderProfileBlock(ctx, pane, prof, xLeft, xRight, decimals, isSessionMode) {
    if (!prof || !prof.bins || !prof.bins.length || prof.maxVol <= 0) return;
    const spanW = Math.max(24, xRight - xLeft);
    const maxBarW = isSessionMode ? Math.min(130, spanW * 0.42) : Math.min(150, spanW * 0.28);

    // 1. Shaded Value Area band between VAH and VAL
    if (prof.vahPrice !== null && prof.valPrice !== null) {
      const yVah = pane.candleSeries.priceToCoordinate(prof.vahPrice);
      const yVal = pane.candleSeries.priceToCoordinate(prof.valPrice);
      if (yVah !== null && yVal !== null) {
        const bandTop = Math.min(yVah, yVal);
        const bandH = Math.abs(yVal - yVah);
        ctx.fillStyle = 'rgba(56, 189, 248, 0.055)';
        ctx.fillRect(xLeft, bandTop, spanW, bandH);
      }
    }

    // 2. Price level volume histogram bars (VA vs non-VA clearly distinguished)
    for (let i = 0; i < prof.bins.length; i++) {
      const b = prof.bins[i];
      if (b.totalVol <= 0) continue;
      const yTop = pane.candleSeries.priceToCoordinate(b.priceHigh);
      const yBot = pane.candleSeries.priceToCoordinate(b.priceLow);
      if (yTop === null || yBot === null) continue;
      const y = Math.min(yTop, yBot);
      const h = Math.max(1.5, Math.abs(yBot - yTop) - 0.6);

      const buyW = (b.buyVol / prof.maxVol) * maxBarW;
      const sellW = (b.sellVol / prof.maxVol) * maxBarW;

      const buyAlpha = b.isPoc ? 0.85 : (b.inValueArea ? 0.62 : 0.24);
      const sellAlpha = b.isPoc ? 0.85 : (b.inValueArea ? 0.62 : 0.24);

      if (isSessionMode) {
        // Grow from left edge of session rightward
        ctx.fillStyle = `rgba(0, 196, 140, ${buyAlpha})`;
        ctx.fillRect(xLeft, y, buyW, h);
        ctx.fillStyle = `rgba(255, 79, 94, ${sellAlpha})`;
        ctx.fillRect(xLeft + buyW, y, sellW, h);
      } else {
        // Grow from right price scale edge leftward (TradingView VPVR style)
        ctx.fillStyle = `rgba(0, 196, 140, ${buyAlpha})`;
        ctx.fillRect(xRight - (buyW + sellW), y, buyW, h);
        ctx.fillStyle = `rgba(255, 79, 94, ${sellAlpha})`;
        ctx.fillRect(xRight - sellW, y, sellW, h);
      }

      if (b.isPoc) {
        const pocBarW = buyW + sellW;
        const pocBarX = isSessionMode ? xLeft : (xRight - pocBarW);
        ctx.strokeStyle = 'rgba(255, 183, 3, 0.9)';
        ctx.lineWidth = 1;
        ctx.strokeRect(pocBarX, y, Math.max(2, pocBarW), h);
      }
    }

    const drawLevelLine = (price, color, labelPrefix, dashPattern, lineWidth, alignRightLabel) => {
      if (price === null || !Number.isFinite(price)) return;
      const y = pane.candleSeries.priceToCoordinate(price);
      if (y === null || y < 6 || y > ctx.canvas.clientHeight - 6) return;

      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      if (dashPattern.length) ctx.setLineDash(dashPattern);
      ctx.beginPath();
      ctx.moveTo(xLeft, y);
      ctx.lineTo(xRight, y);
      ctx.stroke();
      ctx.setLineDash([]);

      const txt = `${labelPrefix} ${Number(price).toFixed(decimals)}`;
      ctx.font = '600 9.5px "DM Mono", monospace';
      const tw = ctx.measureText(txt).width + 10;
      const lx = alignRightLabel ? Math.max(xLeft + 4, xRight - tw - 6) : xLeft + 6;
      const ly = Math.max(10, Math.min(ctx.canvas.clientHeight - 16, y - 14));

      ctx.fillStyle = 'rgba(14, 17, 23, 0.9)';
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.fillRect(lx, ly, tw, 13);
      ctx.strokeRect(lx, ly, tw, 13);

      ctx.fillStyle = color;
      ctx.fillText(txt, lx + 5, ly + 9.5);
      ctx.restore();
    };

    // Distinct Value Area High, Value Area Low, and Point of Control lines + labels
    drawLevelLine(prof.vahPrice, '#38bdf8', `VAH (${prof.valueAreaPct}%)`, [4, 3], 1.2, !isSessionMode);
    drawLevelLine(prof.valPrice, '#a78bfa', 'VAL', [4, 3], 1.2, !isSessionMode);
    drawLevelLine(prof.pocPrice, '#ffb703', 'POC', [], 1.8, !isSessionMode);
  }

  function renderVolumeProfile(pane, vpData, opts = {}) {
    const canvas = pane && pane.vpvrCanvas;
    const ctx = pane && pane.vpvrCtx;
    if (!canvas || !ctx || !opts.enabled || !pane.candleSeries) {
      if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const cssW = Math.floor(rect.width || 0);
    const cssH = Math.floor(rect.height || 0);
    if (cssW < 20 || cssH < 20) return;

    const dpr = Math.min(2, global.devicePixelRatio || 1);
    const targetW = Math.floor(cssW * dpr);
    const targetH = Math.floor(cssH * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    if (!vpData || !vpData.profiles || !vpData.profiles.length) return;
    const decs = Number(opts.decimals) || 2;
    const ts = pane.chart && pane.chart.timeScale ? pane.chart.timeScale() : null;

    const timeToCoordExact = (targetTime) => {
      if (!ts || !pane.candles || !pane.candles.length) return null;
      const cs = pane.candles;
      const n = cs.length;
      if (targetTime <= cs[0].time) return ts.logicalToCoordinate(0);
      if (targetTime >= cs[n - 1].time) return ts.logicalToCoordinate(n - 1);
      let lo = 0;
      let hi = n - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (cs[mid].time === targetTime) return ts.logicalToCoordinate(mid);
        if (cs[mid].time < targetTime) lo = mid + 1;
        else hi = mid - 1;
      }
      return ts.logicalToCoordinate(Math.max(0, Math.min(n - 1, lo)));
    };

    if (vpData.mode === 'session' && ts) {
      vpData.profiles.forEach(prof => {
        const x1Raw = timeToCoordExact(prof.startTime);
        const x2Raw = timeToCoordExact(prof.endTime);
        if (x1Raw === null && x2Raw === null) return;
        const x1 = x1Raw !== null ? Math.max(0, x1Raw) : 0;
        const x2 = x2Raw !== null ? Math.min(cssW, x2Raw) : cssW;
        if (x2 >= 0 && x1 <= cssW && (x2 - x1) >= 14) {
          renderProfileBlock(ctx, pane, prof, x1, x2, decs, true);
        }
      });
    } else {
      renderProfileBlock(ctx, pane, vpData.profiles[vpData.profiles.length - 1], 0, cssW, decs, false);
    }
  }

  global.NeoChartIndicators = {
    IND_STORAGE_KEY,
    DEFAULT_IND_CONFIG,
    sanitizePeriod,
    sanitizeVaPct,
    sanitizeBins,
    loadIndicatorConfig,
    saveIndicatorConfig,
    calculateEMA,
    calculateEMACrossoverSignals,
    computeSingleVolumeProfile,
    computeVolumeProfile,
    renderVolumeProfile,
  };
})(window);
