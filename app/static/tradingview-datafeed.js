/**
 * Neo PIP Terminal — TradingView Advanced Charts (Charting Library) Upstox Datafeed
 * Connects TradingView Technical Analysis Charts directly to Neo PIP Backend (/api/candles & /api/quotes & /ws)
 */
(function (global) {
  'use strict';

  const SUPPORTED_RESOLUTIONS = ['1', '3', '5', '15', '30', '60', '240', 'D'];

  const CONFIGURATION_DATA = {
    supported_resolutions: SUPPORTED_RESOLUTIONS,
    exchanges: [
      { value: 'NSE', name: 'National Stock Exchange (India)', desc: 'NSE India' },
      { value: 'BSE', name: 'Bombay Stock Exchange', desc: 'BSE India' },
      { value: 'MCX', name: 'Multi Commodity Exchange', desc: 'MCX India' },
      { value: 'FOREX', name: 'Forex Spot Markets', desc: 'Forex & Crypto' },
    ],
    symbols_types: [
      { name: 'Index', value: 'index' },
      { name: 'Stock', value: 'stock' },
      { name: 'Option', value: 'option' },
      { name: 'Forex', value: 'forex' },
      { name: 'Commodity', value: 'commodity' },
    ],
    supports_marks: false,
    supports_timescale_marks: false,
    supports_time: true,
  };

  class UpstoxTVDatafeed {
    constructor(baseUrl = '') {
      this.baseUrl = baseUrl.replace(/\/+$/, '');
      this.subscribers = new Map();
      this.lastBarsCache = new Map();
    }

    onReady(callback) {
      setTimeout(() => callback(CONFIGURATION_DATA), 0);
    }

    async searchSymbols(userInput, exchange, symbolType, onResultReadyCallback) {
      if (!userInput || userInput.trim().length < 2) {
        onResultReadyCallback([]);
        return;
      }
      try {
        const res = await fetch(`${this.baseUrl}/api/search?q=${encodeURIComponent(userInput)}`);
        const data = await res.json();
        const results = (data.results || data || []).map(item => {
          const sym = item.symbol || item.trading_symbol || item.name;
          const ex = item.exchange || (sym.includes('SENSEX') || sym.includes('BANKEX') ? 'BSE' : 'NSE');
          return {
            symbol: sym,
            full_name: `${ex}:${sym}`,
            description: item.name || sym,
            exchange: ex,
            ticker: sym,
            type: sym.includes('CE') || sym.includes('PE') ? 'option' : (sym.includes('FUT') ? 'futures' : 'stock'),
          };
        });
        onResultReadyCallback(results);
      } catch (err) {
        onResultReadyCallback([]);
      }
    }

    async resolveSymbol(symbolName, onSymbolResolvedCallback, onResolveErrorCallback) {
      try {
        const cleanSym = (symbolName || '').split(':').pop().trim().toUpperCase();
        const isBse = cleanSym.includes('SENSEX') || cleanSym.includes('BANKEX');
        const isFx = cleanSym.includes('USD') || cleanSym.includes('EUR') || cleanSym.includes('BTC') || cleanSym.includes('ETH');
        const isOption = cleanSym.includes('CE') || cleanSym.includes('PE');
        const isIndex = cleanSym === 'NIFTY 50' || cleanSym === 'SENSEX' || cleanSym === 'BANKNIFTY' || cleanSym === 'FINNIFTY';

        const symbolInfo = {
          ticker: cleanSym,
          name: cleanSym,
          description: cleanSym,
          type: isOption ? 'option' : (isIndex ? 'index' : (isFx ? 'forex' : 'stock')),
          session: isFx ? '24x7' : '0915-1530',
          timezone: isFx ? 'Etc/UTC' : 'Asia/Kolkata',
          exchange: isFx ? 'FOREX' : (isBse ? 'BSE' : 'NSE'),
          minmov: 5,
          pricescale: 100, // 0.05 tick size (5 / 100 = 0.05)
          has_intraday: true,
          has_daily: true,
          supported_resolutions: SUPPORTED_RESOLUTIONS,
          volume_precision: 0,
          data_status: 'streaming',
        };

        if (isFx) {
          symbolInfo.minmov = 1;
          symbolInfo.pricescale = cleanSym.includes('JPY') ? 1000 : 100000;
        }

        setTimeout(() => onSymbolResolvedCallback(symbolInfo), 0);
      } catch (err) {
        onResolveErrorCallback('Cannot resolve symbol: ' + err.message);
      }
    }

    async getBars(symbolInfo, resolution, periodParams, onHistoryCallback, onErrorCallback) {
      const { from, to, firstDataRequest } = periodParams;
      try {
        const intervalMap = {
          '1': '1m',
          '3': '3m',
          '5': '5m',
          '15': '15m',
          '30': '30m',
          '60': '1h',
          '240': '4h',
          'D': '1d',
          '1D': '1d',
        };
        const effTf = intervalMap[resolution] || '1m';
        const url = `${this.baseUrl}/api/candles?symbol=${encodeURIComponent(symbolInfo.ticker)}&interval=${effTf}&days=10`;
        const res = await fetch(url);
        const data = await res.json();
        const candles = data.candles || [];

        if (!candles.length) {
          onHistoryCallback([], { noData: true });
          return;
        }

        const bars = candles.map(c => ({
          time: c.time * 1000,
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
          volume: Number(c.volume || 0),
        })).filter(b => b.time >= from * 1000 && b.time <= to * 1000);

        if (firstDataRequest && bars.length > 0) {
          this.lastBarsCache.set(symbolInfo.ticker, bars[bars.length - 1]);
        }

        onHistoryCallback(bars, { noData: bars.length === 0 });
      } catch (err) {
        onErrorCallback(err.message);
      }
    }

    subscribeBars(symbolInfo, resolution, onRealtimeCallback, subscriberUID, onResetCacheNeededCallback) {
      this.subscribers.set(subscriberUID, {
        symbolInfo,
        resolution,
        callback: onRealtimeCallback,
      });

      // Poll quote updates every 800ms to drive streaming real-time bar updates
      if (!this._pollTimer) {
        this._pollTimer = setInterval(async () => {
          for (const [uid, sub] of this.subscribers.entries()) {
            try {
              const sym = sub.symbolInfo.ticker;
              const qRes = await fetch(`${this.baseUrl}/api/quotes?symbol=${encodeURIComponent(sym)}`);
              const qData = await qRes.json();
              const ltp = Number(qData.ltp || (qData.quotes && qData.quotes[sym] && qData.quotes[sym].ltp) || 0);
              if (ltp > 0) {
                const nowMs = Date.now();
                const barIntervalMs = (parseInt(sub.resolution) || 1) * 60 * 1000;
                const roundedTime = Math.floor(nowMs / barIntervalMs) * barIntervalMs;

                let lastBar = this.lastBarsCache.get(sym);
                if (!lastBar || roundedTime > lastBar.time) {
                  lastBar = {
                    time: roundedTime,
                    open: ltp,
                    high: ltp,
                    low: ltp,
                    close: ltp,
                    volume: 10,
                  };
                } else {
                  lastBar.high = Math.max(lastBar.high, ltp);
                  lastBar.low = Math.min(lastBar.low, ltp);
                  lastBar.close = ltp;
                  lastBar.volume += 1;
                }
                this.lastBarsCache.set(sym, lastBar);
                sub.callback({ ...lastBar });
              }
            } catch (_) {}
          }
        }, 800);
      }
    }

    unsubscribeBars(subscriberUID) {
      this.subscribers.delete(subscriberUID);
      if (this.subscribers.size === 0 && this._pollTimer) {
        clearInterval(this._pollTimer);
        this._pollTimer = null;
      }
    }
  }

  global.UpstoxTVDatafeed = UpstoxTVDatafeed;
})(typeof window !== 'undefined' ? window : this);
