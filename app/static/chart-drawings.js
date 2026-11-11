// Neo PIP — Interactive Drawing Engine (Lightweight Charts v4 Overlay)
// Supports: Trendline, H-Line, V-Line, Ray, Extended Line, Rectangle, Price Range,
// Fibonacci Retracement, Fibonacci Extension, Trend-Based Fib Extension, Parallel Channel
(function (global) {
  'use strict';

  const DRAWINGS_STORAGE_PREFIX = 'neo_chart_drawings_v1:';

  const FIB_RETRACE_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const FIB_EXT_LEVELS = [0, 0.618, 1, 1.272, 1.618, 2, 2.618];
  const FIB_TREND_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618, 2.618];

  const TOOL_DEFS = {
    cursor:          { id: 'cursor',          label: 'Cursor',          points: 0, hint: 'Click any drawing to edit, drag, or delete' },
    trendline:       { id: 'trendline',       label: 'Trendline',       points: 2, hint: 'Click start point, then end point' },
    hline:           { id: 'hline',           label: 'Horizontal Line', points: 1, hint: 'Click price level to place horizontal line' },
    vline:           { id: 'vline',           label: 'Vertical Line',   points: 1, hint: 'Click bar time to place vertical line' },
    ray:             { id: 'ray',             label: 'Ray',             points: 2, hint: 'Click origin, then direction point' },
    extline:         { id: 'extline',         label: 'Extended Line',   points: 2, hint: 'Click 2 points to extend line across chart' },
    rect:            { id: 'rect',            label: 'Rectangle',       points: 2, hint: 'Click first corner, then opposite corner' },
    price_range:     { id: 'price_range',     label: 'Price Range',     points: 2, hint: 'Click base price, then target price to measure' },
    fib_retracement: { id: 'fib_retracement', label: 'Fib Retrace',     points: 2, hint: 'Click swing start (1), then swing end (0)' },
    fib_extension:   { id: 'fib_extension',   label: 'Fib Extension',   points: 2, hint: 'Click swing low/high, then impulse end' },
    fib_trend:       { id: 'fib_trend',       label: 'Fib Trend-Based', points: 3, hint: 'Click A (start), B (impulse end), then C (pullback)' },
    channel:         { id: 'channel',         label: 'Parallel Channel', points: 3, hint: 'Click 2 baseline points, then channel width' },
  };

  function makeId() {
    return 'drw_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  function storageKeyForSymbol(sym) {
    return DRAWINGS_STORAGE_PREFIX + String(sym || 'DEFAULT').trim().toUpperCase();
  }

  function loadDrawingsForSymbol(sym) {
    try {
      const raw = global.localStorage && global.localStorage.getItem(storageKeyForSymbol(sym));
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter(d => d && d.type && Array.isArray(d.points) && d.points.length > 0) : [];
    } catch (_) {
      return [];
    }
  }

  function saveDrawingsForSymbol(sym, list) {
    try {
      if (global.localStorage) {
        global.localStorage.setItem(storageKeyForSymbol(sym), JSON.stringify(Array.isArray(list) ? list : []));
      }
    } catch (_) {}
  }

  function estimateAvgStepSec(candles) {
    if (!candles || candles.length < 2) return 60;
    const sample = Math.min(20, candles.length - 1);
    const diffs = [];
    for (let i = candles.length - sample; i < candles.length; i++) {
      const d = candles[i].time - candles[i - 1].time;
      if (d > 0) diffs.push(d);
    }
    diffs.sort((a, b) => a - b);
    return diffs.length ? diffs[Math.floor(diffs.length / 2)] : 60;
  }

  function timeToLogical(pane, targetTime, ptMeta) {
    const cs = pane && pane.candles;
    if (!cs || !cs.length) return null;
    const n = cs.length;

    if (ptMeta && Number.isFinite(ptMeta.rightOffsetBars) && ptMeta.rightOffsetBars > 0 && targetTime >= cs[n - 1].time) {
      return (n - 1) + ptMeta.rightOffsetBars;
    }
    if (ptMeta && ptMeta.isLeftBeforeFirst && Number.isFinite(ptMeta.rightOffsetBars) && ptMeta.rightOffsetBars < 0 && targetTime <= cs[0].time) {
      return ptMeta.rightOffsetBars;
    }

    const avgStep = estimateAvgStepSec(cs);
    if (targetTime <= cs[0].time) {
      return (targetTime - cs[0].time) / avgStep;
    }
    if (targetTime >= cs[n - 1].time) {
      return (n - 1) + (targetTime - cs[n - 1].time) / avgStep;
    }

    let lo = 0;
    let hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cs[mid].time === targetTime) return mid;
      if (cs[mid].time < targetTime) lo = mid + 1;
      else hi = mid - 1;
    }
    const i0 = Math.max(0, lo - 1);
    const i1 = Math.min(n - 1, lo);
    const span = cs[i1].time - cs[i0].time;
    if (span <= 0) return i0;
    return i0 + (targetTime - cs[i0].time) / span;
  }

  function pixelToPoint(pane, x, y) {
    if (!pane || !pane.chart || !pane.candleSeries || !pane.candles || !pane.candles.length) return null;
    const ts = pane.chart.timeScale();
    const cs = pane.candles;
    const n = cs.length;
    const logical = ts.coordinateToLogical(x);
    const price = pane.candleSeries.coordinateToPrice(y);
    if (logical === null || !Number.isFinite(logical) || price === null || !Number.isFinite(price)) return null;

    let timeVal;
    let rightOffsetBars = 0;
    let isLeftBeforeFirst = false;

    if (logical <= 0) {
      const avgStep = estimateAvgStepSec(cs);
      timeVal = cs[0].time + logical * avgStep;
      rightOffsetBars = logical;
      isLeftBeforeFirst = logical < 0;
    } else if (logical >= n - 1) {
      const avgStep = estimateAvgStepSec(cs);
      rightOffsetBars = logical - (n - 1);
      timeVal = cs[n - 1].time + rightOffsetBars * avgStep;
    } else {
      const i0 = Math.floor(logical);
      const i1 = Math.min(n - 1, i0 + 1);
      const frac = logical - i0;
      timeVal = cs[i0].time + frac * (cs[i1].time - cs[i0].time);
    }

    return { time: timeVal, rightOffsetBars, isLeftBeforeFirst, price };
  }

  function shiftPointByLogicalPrice(pane, pt, dLogical, dPrice) {
    if (!pane || !pane.candles || !pane.candles.length) {
      return { ...pt, price: pt.price + dPrice };
    }
    const baseLogical = timeToLogical(pane, pt.time, pt);
    if (baseLogical === null) return { ...pt, price: pt.price + dPrice };
    const nextLogical = baseLogical + dLogical;
    const cs = pane.candles;
    const n = cs.length;
    const avgStep = estimateAvgStepSec(cs);

    let nextTime;
    let rightOffsetBars = 0;
    let isLeftBeforeFirst = false;

    if (nextLogical <= 0) {
      nextTime = cs[0].time + nextLogical * avgStep;
      rightOffsetBars = nextLogical;
      isLeftBeforeFirst = nextLogical < 0;
    } else if (nextLogical >= n - 1) {
      rightOffsetBars = nextLogical - (n - 1);
      nextTime = cs[n - 1].time + rightOffsetBars * avgStep;
    } else {
      const i0 = Math.floor(nextLogical);
      const i1 = Math.min(n - 1, i0 + 1);
      const frac = nextLogical - i0;
      nextTime = cs[i0].time + frac * (cs[i1].time - cs[i0].time);
    }

    return {
      time: nextTime,
      rightOffsetBars,
      isLeftBeforeFirst,
      price: pt.price + dPrice,
    };
  }

  function pointToPixel(pane, pt) {
    if (!pane || !pane.chart || !pane.candleSeries || !pane.candles || !pane.candles.length || !pt) return null;
    const ts = pane.chart.timeScale();
    const logical = timeToLogical(pane, pt.time, pt);
    if (logical === null) return null;
    const x = ts.logicalToCoordinate(logical);
    const y = pane.candleSeries.priceToCoordinate(pt.price);
    if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y, logical };
  }

  function distPointToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-6) return Math.hypot(px - x1, py - y1);
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  function distPointToRay(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-6) return Math.hypot(px - x1, py - y1);
    const t = Math.max(0, ((px - x1) * dx + (py - y1) * dy) / lenSq);
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  function distPointToLine(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return Math.hypot(px - x1, py - y1);
    return Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1) / len;
  }

  function clipInfiniteLineToBox(x1, y1, x2, y2, w, h, extendLeft, extendRight) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    if (Math.hypot(dx, dy) < 1e-4) return { ax: x1, ay: y1, bx: x2, by: y2 };
    const scale = (Math.max(w, h) * 3) / Math.hypot(dx, dy);
    const ax = extendLeft ? x1 - dx * scale : x1;
    const ay = extendLeft ? y1 - dy * scale : y1;
    const bx = extendRight ? x2 + dx * scale : x2;
    const by = extendRight ? y2 + dy * scale : y2;
    return { ax, ay, bx, by };
  }

  function formatPrice(val, decs) {
    return Number(val).toFixed(Math.max(0, Math.min(6, Number(decs) || 2)));
  }

  function drawPillBadge(ctx, text, x, y, bgColor, borderColor, textColor) {
    ctx.save();
    ctx.font = '600 10px "DM Mono", monospace';
    const w = ctx.measureText(text).width + 10;
    const h = 15;
    ctx.fillStyle = bgColor;
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, 3);
    else ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = textColor;
    ctx.fillText(text, x + 5, y + 10.5);
    ctx.restore();
  }

  function getChannelOffsetPx(pts) {
    // 3rd anchor controls parallel vertical price offset relative to line (p1 -> p2) at p3.x
    const p1 = pts[0];
    const p2 = pts[1];
    const p3 = pts[2];
    if (!p1 || !p2 || !p3) return 0;
    const dx = p2.x - p1.x;
    const baseYAtP3 = Math.abs(dx) < 1e-4 ? p1.y : p1.y + ((p3.x - p1.x) / dx) * (p2.y - p1.y);
    return p3.y - baseYAtP3;
  }

  function renderSingleDrawing(ctx, pane, drw, w, h, isSelected, opts) {
    const pxPts = drw.points.map(pt => pointToPixel(pane, pt)).filter(Boolean);
    if (!pxPts.length) return;

    const color = drw.color || '#ffb703';
    const lineWidth = Number(drw.lineWidth) || 1.75;
    const dashed = Boolean(drw.dashed);
    const decs = Number(opts.decimals) || 2;
    const curSym = opts.currencySymbol || '';

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = isSelected ? Math.max(2, lineWidth + 0.5) : lineWidth;
    ctx.setLineDash(dashed ? [6, 4] : []);

    const type = drw.type;
    if (type === 'trendline' && pxPts.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(pxPts[0].x, pxPts[0].y);
      ctx.lineTo(pxPts[1].x, pxPts[1].y);
      ctx.stroke();
    } else if (type === 'ray' && pxPts.length >= 2) {
      const seg = clipInfiniteLineToBox(pxPts[0].x, pxPts[0].y, pxPts[1].x, pxPts[1].y, w, h, false, true);
      ctx.beginPath();
      ctx.moveTo(seg.ax, seg.ay);
      ctx.lineTo(seg.bx, seg.by);
      ctx.stroke();
    } else if (type === 'extline' && pxPts.length >= 2) {
      const seg = clipInfiniteLineToBox(pxPts[0].x, pxPts[0].y, pxPts[1].x, pxPts[1].y, w, h, true, true);
      ctx.beginPath();
      ctx.moveTo(seg.ax, seg.ay);
      ctx.lineTo(seg.bx, seg.by);
      ctx.stroke();
    } else if (type === 'hline') {
      const y = pxPts[0].y;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.setLineDash([]);
      drawPillBadge(ctx, `${curSym}${formatPrice(drw.points[0].price, decs)}`, Math.max(8, w - 76), Math.max(6, Math.min(h - 20, y - 16)), 'rgba(14, 17, 23, 0.92)', color, color);
    } else if (type === 'vline') {
      const x = pxPts[0].x;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.setLineDash([]);
      const dt = new Date(Number(drw.points[0].time) * 1000);
      const tLbl = Number.isFinite(dt.getTime()) ? dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : 'Line';
      drawPillBadge(ctx, tLbl, Math.max(4, Math.min(w - 52, x + 4)), Math.max(6, h - 22), 'rgba(14, 17, 23, 0.92)', color, color);
    } else if (type === 'rect' && pxPts.length >= 2) {
      const rx = Math.min(pxPts[0].x, pxPts[1].x);
      const ry = Math.min(pxPts[0].y, pxPts[1].y);
      const rw = Math.abs(pxPts[1].x - pxPts[0].x);
      const rh = Math.abs(pxPts[1].y - pxPts[0].y);
      ctx.fillStyle = `${color}22`;
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeRect(rx, ry, rw, rh);
    } else if (type === 'price_range' && pxPts.length >= 2) {
      const rx = Math.min(pxPts[0].x, pxPts[1].x);
      const ry = Math.min(pxPts[0].y, pxPts[1].y);
      const rw = Math.max(12, Math.abs(pxPts[1].x - pxPts[0].x));
      const rh = Math.abs(pxPts[1].y - pxPts[0].y);
      const dP = drw.points[1].price - drw.points[0].price;
      const isUp = dP >= 0;
      const tone = isUp ? '#00d084' : '#ff4757';
      const pct = drw.points[0].price > 0 ? (dP / drw.points[0].price) * 100 : 0;
      const l1 = pxPts[0].logical;
      const l2 = pxPts[1].logical;
      const bars = Math.max(0, Math.round(Math.abs((l2 || 0) - (l1 || 0))));

      ctx.fillStyle = isUp ? 'rgba(0, 176, 116, 0.14)' : 'rgba(255, 71, 87, 0.14)';
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = tone;
      ctx.strokeRect(rx, ry, rw, rh);

      // Center vertical arrow indicating move direction
      const midX = rx + rw / 2;
      ctx.beginPath();
      ctx.moveTo(midX, pxPts[0].y);
      ctx.lineTo(midX, pxPts[1].y);
      ctx.stroke();

      const lbl = `${isUp ? '+' : ''}${formatPrice(dP, decs)} (${isUp ? '+' : ''}${pct.toFixed(2)}%) • ${bars} bars`;
      drawPillBadge(ctx, lbl, Math.max(6, Math.min(w - 175, rx + 4)), Math.max(6, Math.min(h - 20, isUp ? ry - 18 : ry + rh + 4)), 'rgba(14, 17, 23, 0.94)', tone, tone);
    } else if ((type === 'fib_retracement' || type === 'fib_extension') && pxPts.length >= 2) {
      const pA = drw.points[0].price;
      const pB = drw.points[1].price;
      const xMin = Math.min(pxPts[0].x, pxPts[1].x);
      const xMax = Math.max(xMin + 90, Math.max(pxPts[0].x, pxPts[1].x), Math.min(w - 10, xMin + 240));
      const levels = type === 'fib_retracement' ? FIB_RETRACE_LEVELS : FIB_EXT_LEVELS;
      const fibColors = ['#94a3b8', '#38bdf8', '#22c55e', '#facc15', '#ffb703', '#fb923c', '#f43f5e', '#a78bfa'];

      // Connector diagonal between anchor points
      ctx.save();
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.65)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(pxPts[0].x, pxPts[0].y);
      ctx.lineTo(pxPts[1].x, pxPts[1].y);
      ctx.stroke();
      ctx.restore();

      const yGoldenA = type === 'fib_retracement'
        ? pane.candleSeries.priceToCoordinate(pB + (pA - pB) * 0.382)
        : pane.candleSeries.priceToCoordinate(pA + (pB - pA) * 1.0);
      const yGoldenB = type === 'fib_retracement'
        ? pane.candleSeries.priceToCoordinate(pB + (pA - pB) * 0.618)
        : pane.candleSeries.priceToCoordinate(pA + (pB - pA) * 1.618);
      if (yGoldenA !== null && yGoldenB !== null) {
        ctx.fillStyle = 'rgba(255, 183, 3, 0.08)';
        ctx.fillRect(xMin, Math.min(yGoldenA, yGoldenB), xMax - xMin, Math.abs(yGoldenB - yGoldenA));
      }

      levels.forEach((ratio, idx) => {
        const lvlPrice = type === 'fib_retracement'
          ? pB + (pA - pB) * ratio
          : pA + (pB - pA) * ratio;
        const ly = pane.candleSeries.priceToCoordinate(lvlPrice);
        if (ly === null || ly < -10 || ly > h + 10) return;
        const cLine = fibColors[idx % fibColors.length];
        ctx.save();
        ctx.strokeStyle = cLine;
        ctx.lineWidth = (ratio === 0.618 || ratio === 1.618 || ratio === 0.5) ? 1.5 : 1;
        ctx.setLineDash(dashed ? [5, 3] : []);
        ctx.beginPath();
        ctx.moveTo(xMin, ly);
        ctx.lineTo(xMax, ly);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = '600 9.5px "DM Mono", monospace';
        ctx.fillStyle = cLine;
        ctx.fillText(`${ratio} (${curSym}${formatPrice(lvlPrice, decs)})`, xMin + 4, ly - 3);
        ctx.restore();
      });
    } else if (type === 'fib_trend') {
      if (pxPts.length >= 2) {
        ctx.save();
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.7)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(pxPts[0].x, pxPts[0].y);
        ctx.lineTo(pxPts[1].x, pxPts[1].y);
        if (pxPts.length >= 3) ctx.lineTo(pxPts[2].x, pxPts[2].y);
        ctx.stroke();
        ctx.restore();
      }
      if (pxPts.length >= 3) {
        const imp = drw.points[1].price - drw.points[0].price;
        const baseC = drw.points[2].price;
        const xStart = Math.min(pxPts[0].x, pxPts[2].x);
        const xEnd = Math.max(xStart + 120, pxPts[2].x + 140, Math.min(w - 10, xStart + 260));
        const fibColors = ['#94a3b8', '#38bdf8', '#22c55e', '#facc15', '#ffb703', '#fb923c', '#f43f5e', '#c084fc', '#e879f9', '#fb7185'];

        const yZ1 = pane.candleSeries.priceToCoordinate(baseC + imp * 1.0);
        const yZ2 = pane.candleSeries.priceToCoordinate(baseC + imp * 1.618);
        if (yZ1 !== null && yZ2 !== null) {
          ctx.fillStyle = 'rgba(167, 139, 250, 0.08)';
          ctx.fillRect(xStart, Math.min(yZ1, yZ2), xEnd - xStart, Math.abs(yZ2 - yZ1));
        }

        FIB_TREND_LEVELS.forEach((ratio, idx) => {
          const lvlPrice = baseC + imp * ratio;
          const ly = pane.candleSeries.priceToCoordinate(lvlPrice);
          if (ly === null || ly < -10 || ly > h + 10) return;
          const cLine = fibColors[idx % fibColors.length];
          ctx.save();
          ctx.strokeStyle = cLine;
          ctx.lineWidth = (ratio === 1 || ratio === 1.618 || ratio === 0.618) ? 1.5 : 1;
          ctx.beginPath();
          ctx.moveTo(xStart, ly);
          ctx.lineTo(xEnd, ly);
          ctx.stroke();
          ctx.font = '600 9.5px "DM Mono", monospace';
          ctx.fillStyle = cLine;
          ctx.fillText(`${ratio} (${curSym}${formatPrice(lvlPrice, decs)})`, xStart + 4, ly - 3);
          ctx.restore();
        });
      }
    } else if (type === 'channel' && pxPts.length >= 2) {
      if (pxPts.length === 2) {
        ctx.beginPath();
        ctx.moveTo(pxPts[0].x, pxPts[0].y);
        ctx.lineTo(pxPts[1].x, pxPts[1].y);
        ctx.stroke();
      } else {
        const dy = getChannelOffsetPx(pxPts);
        ctx.fillStyle = `${color}1c`;
        ctx.beginPath();
        ctx.moveTo(pxPts[0].x, pxPts[0].y);
        ctx.lineTo(pxPts[1].x, pxPts[1].y);
        ctx.lineTo(pxPts[1].x, pxPts[1].y + dy);
        ctx.lineTo(pxPts[0].x, pxPts[0].y + dy);
        ctx.closePath();
        ctx.fill();

        // Primary trendline
        ctx.beginPath();
        ctx.moveTo(pxPts[0].x, pxPts[0].y);
        ctx.lineTo(pxPts[1].x, pxPts[1].y);
        ctx.stroke();

        // Parallel boundary
        ctx.beginPath();
        ctx.moveTo(pxPts[0].x, pxPts[0].y + dy);
        ctx.lineTo(pxPts[1].x, pxPts[1].y + dy);
        ctx.stroke();

        // Dashed 50% channel midline
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pxPts[0].x, pxPts[0].y + dy * 0.5);
        ctx.lineTo(pxPts[1].x, pxPts[1].y + dy * 0.5);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Draw interactive anchor handles when selected or in active draft
    if (isSelected || drw._isDraft) {
      ctx.setLineDash([]);
      pxPts.forEach(pt => {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#0e1117';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.strokeStyle = color;
        ctx.stroke();
      });
    }

    ctx.restore();
  }

  function hitTestSingleDrawing(pane, drw, mx, my, w, h, tol) {
    const pxPts = drw.points.map(pt => pointToPixel(pane, pt)).filter(Boolean);
    if (!pxPts.length) return null;

    // Anchor handle hit first (supports exact vertex resizing)
    let bestAnchor = null;
    for (let i = 0; i < pxPts.length; i++) {
      const d = Math.hypot(mx - pxPts[i].x, my - pxPts[i].y);
      if (d <= tol + 3 && (!bestAnchor || d < bestAnchor.dist)) {
        bestAnchor = { mode: 'point', pointIdx: i, dist: d, isAnchor: true };
      }
    }
    if (bestAnchor) return bestAnchor;

    const t = drw.type;
    if (t === 'trendline' && pxPts.length >= 2) {
      const d = distPointToSegment(mx, my, pxPts[0].x, pxPts[0].y, pxPts[1].x, pxPts[1].y);
      if (d <= tol) return { mode: 'move', dist: d };
    } else if (t === 'ray' && pxPts.length >= 2) {
      const d = distPointToRay(mx, my, pxPts[0].x, pxPts[0].y, pxPts[1].x, pxPts[1].y);
      if (d <= tol) return { mode: 'move', dist: d };
    } else if (t === 'extline' && pxPts.length >= 2) {
      const d = distPointToLine(mx, my, pxPts[0].x, pxPts[0].y, pxPts[1].x, pxPts[1].y);
      if (d <= tol) return { mode: 'move', dist: d };
    } else if (t === 'hline') {
      const d = Math.abs(my - pxPts[0].y);
      if (d <= tol) return { mode: 'move', dist: d };
    } else if (t === 'vline') {
      const d = Math.abs(mx - pxPts[0].x);
      if (d <= tol) return { mode: 'move', dist: d };
    } else if ((t === 'rect' || t === 'price_range') && pxPts.length >= 2) {
      const rx = Math.min(pxPts[0].x, pxPts[1].x);
      const ry = Math.min(pxPts[0].y, pxPts[1].y);
      const rx2 = Math.max(pxPts[0].x, pxPts[1].x);
      const ry2 = Math.max(pxPts[0].y, pxPts[1].y);
      const dEdge = Math.min(
        distPointToSegment(mx, my, rx, ry, rx2, ry),
        distPointToSegment(mx, my, rx2, ry, rx2, ry2),
        distPointToSegment(mx, my, rx2, ry2, rx, ry2),
        distPointToSegment(mx, my, rx, ry2, rx, ry)
      );
      if (dEdge <= tol) return { mode: 'move', dist: dEdge };
      if (mx >= rx && mx <= rx2 && my >= ry && my <= ry2) return { mode: 'move', dist: tol + 2 };
    } else if ((t === 'fib_retracement' || t === 'fib_extension' || t === 'fib_trend') && pxPts.length >= 2) {
      let bestFib = distPointToSegment(mx, my, pxPts[0].x, pxPts[0].y, pxPts[1].x, pxPts[1].y);
      const pA = drw.points[0].price;
      const pB = drw.points[1].price;
      const xMin = Math.min(...pxPts.map(p => p.x));
      const xMax = Math.max(xMin + 90, ...pxPts.map(p => p.x), Math.min(w - 10, xMin + 240));
      const ratios = t === 'fib_retracement' ? FIB_RETRACE_LEVELS : (t === 'fib_extension' ? FIB_EXT_LEVELS : FIB_TREND_LEVELS);
      if (mx >= xMin - tol && mx <= xMax + tol) {
        for (const ratio of ratios) {
          const lvlPrice = t === 'fib_retracement'
            ? pB + (pA - pB) * ratio
            : (t === 'fib_extension' ? pA + (pB - pA) * ratio : (drw.points[2] ? drw.points[2].price + (pB - pA) * ratio : pA));
          const ly = pane.candleSeries.priceToCoordinate(lvlPrice);
          if (ly !== null) bestFib = Math.min(bestFib, Math.abs(my - ly));
        }
      }
      if (bestFib <= tol) return { mode: 'move', dist: bestFib };
    } else if (t === 'channel' && pxPts.length >= 3) {
      const dy = getChannelOffsetPx(pxPts);
      const dTop = distPointToSegment(mx, my, pxPts[0].x, pxPts[0].y, pxPts[1].x, pxPts[1].y);
      const dBot = distPointToSegment(mx, my, pxPts[0].x, pxPts[0].y + dy, pxPts[1].x, pxPts[1].y + dy);
      const dEdge = Math.min(dTop, dBot);
      if (dEdge <= tol) return { mode: 'move', dist: dEdge };
      const minX = Math.min(pxPts[0].x, pxPts[1].x);
      const maxX = Math.max(pxPts[0].x, pxPts[1].x);
      if (mx >= minX && mx <= maxX) {
        const frac = Math.abs(pxPts[1].x - pxPts[0].x) < 1e-4 ? 0 : (mx - pxPts[0].x) / (pxPts[1].x - pxPts[0].x);
        const yBase = pxPts[0].y + frac * (pxPts[1].y - pxPts[0].y);
        const yLo = Math.min(yBase, yBase + dy);
        const yHi = Math.max(yBase, yBase + dy);
        if (my >= yLo && my <= yHi) return { mode: 'move', dist: tol + 2 };
      }
    }
    return null;
  }

  function createDrawingManager(opts) {
    const getDecimals = opts.getDecimals || (() => 2);
    const getCurrency = opts.getCurrency || (() => '');
    const getActivePane = opts.getActivePane;
    const onStateChange = opts.onStateChange || (() => {});

    let activeTool = 'cursor';
    let keepDrawingMode = false;
    let defaultColor = '#ffb703';
    let selectedId = null;
    let draftState = null; // { paneIdx, type, points: [...], startPx: {x, y}, hoverPt }
    let dragState = null;  // { paneIdx, drawingId, mode, pointIdx, startLogical, startPrice, origPoints }
    const paneDrawings = new Map(); // symUpper -> Array<Drawing>
    const registeredPanes = new Set();

    function restoreAllChartsInteractive() {
      registeredPanes.forEach(p => {
        if (p && p.chart) {
          try { p.chart.applyOptions({ handleScroll: true, handleScale: true }); } catch (_) {}
        }
      });
    }

    function getDrawings(sym) {
      const key = String(sym || '').trim().toUpperCase();
      if (!key) return [];
      if (!paneDrawings.has(key)) {
        paneDrawings.set(key, loadDrawingsForSymbol(key));
      }
      return paneDrawings.get(key);
    }

    function commitDrawings(sym) {
      const key = String(sym || '').trim().toUpperCase();
      if (!key) return;
      saveDrawingsForSymbol(key, paneDrawings.get(key) || []);
    }

    function getSelectedDrawing(pane) {
      if (!pane || !selectedId) return null;
      return getDrawings(pane.sym).find(d => d.id === selectedId) || null;
    }

    function notifyChange() {
      const ap = typeof getActivePane === 'function' ? getActivePane() : null;
      onStateChange({
        activeTool,
        keepDrawingMode,
        selectedDrawing: getSelectedDrawing(ap),
        draft: draftState,
      });
    }

    function ensureCanvas(pane) {
      if (!pane || !pane.canvasWrap) return null;
      let canvas = pane.drawCanvas;
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.className = 'drawing-overlay-canvas';
        canvas.id = `p${pane.idx + 1}-drawing-canvas`;
        pane.canvasWrap.appendChild(canvas);
        pane.drawCanvas = canvas;
        pane.drawCtx = canvas.getContext('2d');
      }
      return canvas;
    }

    function renderPane(pane) {
      if (!pane || !pane.chart || !pane.candleSeries) return;
      const canvas = ensureCanvas(pane);
      if (!canvas || !pane.drawCtx) return;

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

      const ctx = pane.drawCtx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      if (!pane.candles || !pane.candles.length) return;
      const list = getDrawings(pane.sym);
      const renderOpts = {
        decimals: getDecimals(pane.sym),
        currencySymbol: getCurrency(pane.sym),
      };

      for (let i = 0; i < list.length; i++) {
        renderSingleDrawing(ctx, pane, list[i], cssW, cssH, list[i].id === selectedId, renderOpts);
      }

      if (draftState && draftState.paneIdx === pane.idx && draftState.points.length) {
        const previewPts = draftState.hoverPt
          ? [...draftState.points, draftState.hoverPt]
          : [...draftState.points];
        renderSingleDrawing(
          ctx,
          pane,
          { id: 'draft', type: draftState.type, points: previewPts, color: defaultColor, lineWidth: 1.75, dashed: false, _isDraft: true },
          cssW,
          cssH,
          true,
          renderOpts
        );
      }
    }

    function setTool(toolId) {
      activeTool = TOOL_DEFS[toolId] ? toolId : 'cursor';
      draftState = null;
      if (activeTool === 'cursor') restoreAllChartsInteractive();
      document.querySelectorAll('.pane-chart-wrap').forEach(el => {
        el.classList.toggle('is-drawing-mode', activeTool !== 'cursor');
      });
      notifyChange();
    }

    function setKeepMode(on) {
      keepDrawingMode = Boolean(on);
      notifyChange();
    }

    function cancelDraft(panes) {
      draftState = null;
      restoreAllChartsInteractive();
      (panes || Array.from(registeredPanes)).forEach(renderPane);
      notifyChange();
    }

    function deleteSelected(pane) {
      if (!pane || !selectedId) return false;
      const list = getDrawings(pane.sym);
      const idx = list.findIndex(d => d.id === selectedId);
      if (idx === -1) return false;
      list.splice(idx, 1);
      selectedId = null;
      commitDrawings(pane.sym);
      renderPane(pane);
      notifyChange();
      return true;
    }

    function undoLast(pane) {
      if (!pane) return false;
      const list = getDrawings(pane.sym);
      if (!list.length) return false;
      const removed = list.pop();
      if (removed && removed.id === selectedId) selectedId = null;
      commitDrawings(pane.sym);
      renderPane(pane);
      notifyChange();
      return true;
    }

    function clearSymbolDrawings(pane) {
      if (!pane) return;
      const key = String(pane.sym || '').trim().toUpperCase();
      paneDrawings.set(key, []);
      selectedId = null;
      draftState = null;
      commitDrawings(key);
      renderPane(pane);
      notifyChange();
    }

    function updateSelectedStyle(pane, patch) {
      const drw = getSelectedDrawing(pane);
      if (!drw) return false;
      if (patch.color) drw.color = patch.color;
      if (patch.lineWidth !== undefined) drw.lineWidth = Number(patch.lineWidth) || 1.75;
      if (patch.dashed !== undefined) drw.dashed = Boolean(patch.dashed);
      commitDrawings(pane.sym);
      renderPane(pane);
      notifyChange();
      return true;
    }

    function commitPointToDraft(pane, pt) {
      const def = TOOL_DEFS[activeTool];
      if (!def) return;
      if (def.points === 1) {
        const drw = {
          id: makeId(),
          type: activeTool,
          points: [pt],
          color: defaultColor,
          lineWidth: 1.75,
          dashed: false,
        };
        getDrawings(pane.sym).push(drw);
        commitDrawings(pane.sym);
        selectedId = drw.id;
        draftState = null;
        restoreAllChartsInteractive();
        if (!keepDrawingMode) setTool('cursor');
        else notifyChange();
        renderPane(pane);
        return;
      }

      if (!draftState || draftState.paneIdx !== pane.idx || draftState.type !== activeTool) {
        draftState = { paneIdx: pane.idx, type: activeTool, points: [pt], hoverPt: pt, startPx: null };
        renderPane(pane);
        notifyChange();
        return;
      }

      draftState.points.push(pt);
      if (draftState.points.length >= def.points) {
        const drw = {
          id: makeId(),
          type: draftState.type,
          points: draftState.points,
          color: defaultColor,
          lineWidth: 1.75,
          dashed: false,
        };
        getDrawings(pane.sym).push(drw);
        commitDrawings(pane.sym);
        selectedId = drw.id;
        draftState = null;
        restoreAllChartsInteractive();
        if (!keepDrawingMode) setTool('cursor');
        else notifyChange();
      } else {
        notifyChange();
      }
      renderPane(pane);
    }

    function bindPaneInteractions(pane) {
      if (!pane || !pane.canvasWrap) return;
      registeredPanes.add(pane);
      if (pane._drawBound) return;
      pane._drawBound = true;
      const wrap = pane.canvasWrap;

      const setChartInteractive = enabled => {
        if (!pane.chart) return;
        try {
          pane.chart.applyOptions({ handleScroll: enabled, handleScale: enabled });
        } catch (_) {}
      };

      // Prevent Lightweight Charts mouse pan from intercepting while placing or dragging a drawing
      wrap.addEventListener('mousedown', e => {
        if (activeTool !== 'cursor' || (dragState && dragState.paneIdx === pane.idx)) {
          if (e.target && e.target.closest && e.target.closest('.pane-opt-quick-bar, .yaxis-plus-btn, .trade-price-line, .drawing-style-bar, .chart-draw-palette')) return;
          e.stopPropagation();
          if (e.cancelable) e.preventDefault();
        }
      }, true);

      wrap.addEventListener('pointerdown', e => {
        if (!pane.candles || !pane.candles.length) return;
        if (e.target && e.target.closest && e.target.closest('.pane-opt-quick-bar, .yaxis-plus-btn, .trade-price-line, .drawing-style-bar, .chart-draw-palette')) return;

        const rect = wrap.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const pt = pixelToPoint(pane, x, y);
        if (!pt) return;

        // Placement mode for active drawing tool (supports both click-click and drag-release)
        if (activeTool !== 'cursor') {
          e.stopPropagation();
          if (e.cancelable) e.preventDefault();
          setChartInteractive(false);
          const wasEmpty = !draftState || draftState.paneIdx !== pane.idx || draftState.type !== activeTool;
          commitPointToDraft(pane, pt);
          if (wasEmpty && draftState) {
            draftState.startPx = { x, y };
          }
          return;
        }

        // Cursor mode: hit-test existing drawings for selection, anchor resize, or whole-body move
        const list = getDrawings(pane.sym);
        const tol = e.pointerType === 'touch' ? 18 : 11;
        const w = Math.floor(rect.width || 0);
        const h = Math.floor(rect.height || 0);

        let hit = null;
        let bestScore = Infinity;
        for (let i = list.length - 1; i >= 0; i--) {
          const res = hitTestSingleDrawing(pane, list[i], x, y, w, h, tol);
          if (!res) continue;
          const isSelectedBonus = list[i].id === selectedId && res.isAnchor ? -100 : 0;
          const score = (res.isAnchor ? res.dist - 50 : res.dist) + isSelectedBonus;
          if (score < bestScore) {
            bestScore = score;
            hit = { drw: list[i], ...res };
          }
        }

        if (hit) {
          e.stopPropagation();
          if (e.cancelable) e.preventDefault();
          selectedId = hit.drw.id;
          const startLog = timeToLogical(pane, pt.time, pt);
          dragState = {
            paneIdx: pane.idx,
            drawingId: hit.drw.id,
            mode: hit.mode,
            pointIdx: hit.pointIdx,
            startLogical: startLog,
            startPrice: pt.price,
            origPoints: hit.drw.points.map(p => ({ ...p })),
          };
          setChartInteractive(false);
          try { if (wrap.setPointerCapture) wrap.setPointerCapture(e.pointerId); } catch (_) {}
          renderPane(pane);
          notifyChange();
        } else if (selectedId) {
          selectedId = null;
          renderPane(pane);
          notifyChange();
        }
      }, true);

      global.addEventListener('pointermove', e => {
        if (!pane.candles || !pane.candles.length) return;
        const rect = wrap.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        if (draftState && draftState.paneIdx === pane.idx) {
          const pt = pixelToPoint(pane, x, y);
          if (pt) {
            draftState.hoverPt = pt;
            renderPane(pane);
          }
          return;
        }

        if (dragState && dragState.paneIdx === pane.idx) {
          if (e.cancelable) e.preventDefault();
          const pt = pixelToPoint(pane, x, y);
          if (!pt) return;
          const list = getDrawings(pane.sym);
          const drw = list.find(d => d.id === dragState.drawingId);
          if (!drw) return;

          if (dragState.mode === 'point' && drw.points[dragState.pointIdx]) {
            drw.points[dragState.pointIdx] = pt;
          } else if (dragState.mode === 'move') {
            const curLog = timeToLogical(pane, pt.time, pt);
            const dLog = (curLog !== null && dragState.startLogical !== null) ? (curLog - dragState.startLogical) : 0;
            const dP = pt.price - dragState.startPrice;
            drw.points = dragState.origPoints.map(orig => shiftPointByLogicalPrice(pane, orig, dLog, dP));
          }
          renderPane(pane);
          return;
        }

        // Subtle cursor feedback when hovering a drawing edge/handle inside pane bounds
        if (activeTool === 'cursor' && x >= 0 && x <= rect.width && y >= 0 && y <= rect.height) {
          const list = getDrawings(pane.sym);
          if (!list.length) return;
          const w = Math.floor(rect.width || 0);
          const h = Math.floor(rect.height || 0);
          let over = false;
          for (let i = list.length - 1; i >= 0; i--) {
            if (hitTestSingleDrawing(pane, list[i], x, y, w, h, 9)) {
              over = true;
              break;
            }
          }
          wrap.classList.toggle('is-hover-drawing', over);
        }
      }, true);

      const endDrag = e => {
        if (draftState && draftState.paneIdx === pane.idx && draftState.startPx && e && Number.isFinite(e.clientX)) {
          const rect = wrap.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          if (Math.hypot(x - draftState.startPx.x, y - draftState.startPx.y) >= 18) {
            const pt = pixelToPoint(pane, x, y);
            draftState.startPx = null;
            if (pt) {
              commitPointToDraft(pane, pt);
              return;
            }
          } else {
            draftState.startPx = null;
          }
        }
        if (dragState && dragState.paneIdx === pane.idx) {
          commitDrawings(pane.sym);
          dragState = null;
          setChartInteractive(true);
          try { if (e && wrap.releasePointerCapture) wrap.releasePointerCapture(e.pointerId); } catch (_) {}
          renderPane(pane);
          notifyChange();
        }
      };
      global.addEventListener('pointerup', endDrag, true);
      global.addEventListener('pointercancel', endDrag, true);
    }

    return {
      TOOL_DEFS,
      getActiveTool: () => activeTool,
      getSelectedId: () => selectedId,
      getKeepMode: () => keepDrawingMode,
      getDrawings,
      setTool,
      setKeepMode,
      setDefaultColor: c => { defaultColor = c || defaultColor; },
      cancelDraft,
      deleteSelected,
      undoLast,
      clearSymbolDrawings,
      updateSelectedStyle,
      bindPaneInteractions,
      renderPane,
      getSelectedDrawing,
      // Expose pure math helpers for direct automated testing
      _pixelToPoint: pixelToPoint,
      _pointToPixel: pointToPixel,
      _hitTestSingleDrawing: hitTestSingleDrawing,
    };
  }

  global.NeoChartDrawings = {
    TOOL_DEFS,
    FIB_RETRACE_LEVELS,
    FIB_EXT_LEVELS,
    FIB_TREND_LEVELS,
    createDrawingManager,
    loadDrawingsForSymbol,
    saveDrawingsForSymbol,
  };
})(window);
