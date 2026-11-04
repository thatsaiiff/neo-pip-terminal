(() => {
  'use strict';
  if (window.__neoPipBridgeInstalled) return;
  window.__neoPipBridgeInstalled = true;

  let lastSent = '';
  let candidate = null;
  let repeated = 0;
  let currentBest = null;
  let lastStatus = 'Searching for a selected instrument…';

  const instrumentPatterns = [
    { re: /\b(?:BANKNIFTY|MIDCPNIFTY|FINNIFTY|NIFTY|SENSEX|BANKEX)[A-Z0-9._-]{5,40}(?:CE|PE|FUT)\b/i, confidence: 0.96 },
    { re: /\b[A-Z][A-Z0-9&._-]{1,24}-(?:EQ|BE|SM|ST)\b/i, confidence: 0.93 },
    { re: /\b(?:BANKNIFTY|MIDCPNIFTY|FINNIFTY|NIFTY|SENSEX|BANKEX)\s+\d{1,2}\s+[A-Z]{3}\s+\d{2,4}\s+\d{4,6}\s+(?:CE|PE)\b/i, confidence: 0.78 }
  ];
  const sourceSelector = [
    '[data-symbol]', '[data-tradingsymbol]', '[data-testid*="symbol" i]', '[aria-label*="selected symbol" i]',
    '[class*="selected" i][class*="symbol" i]', '[class*="active" i][class*="symbol" i]',
    '[class*="instrument" i]', '[class*="scrip" i]', '[title]'
  ].join(',');

  function visible(el) {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0 && r.height > 0 && r.width < 1200 && r.height < 180;
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toUpperCase();
  }

  function fromCandidateText(text) {
    const clean = normalizeText(text);
    if (!clean || clean.length > 100) return null;
    for (const pattern of instrumentPatterns) {
      const match = clean.match(pattern.re);
      if (match && match[0]) {
        let symbol = match[0].replace(/\s+/g, ' ').trim();
        return { symbol, confidence: pattern.confidence, evidence: clean.slice(0, 90) };
      }
    }
    return null;
  }

  function getBestCandidate() {
    const candidates = [];
    const url = new URL(location.href);
    for (const key of ['trading_symbol', 'tradingsymbol', 'symbol', 'scrip', 'instrument']) {
      const value = url.searchParams.get(key);
      const result = value ? fromCandidateText(value) : null;
      if (result) candidates.push({ ...result, confidence: Math.min(0.98, result.confidence + 0.01) });
    }
    const titleResult = fromCandidateText(document.title);
    if (titleResult) candidates.push({ ...titleResult, confidence: Math.min(0.97, titleResult.confidence + 0.01) });

    const nodes = Array.from(document.querySelectorAll(sourceSelector)).slice(0, 1200);
    for (const node of nodes) {
      if (!visible(node)) continue;
      const tag = node.tagName.toLowerCase();
      const className = typeof node.className === 'string' ? node.className : '';
      const semantics = `${node.getAttribute('data-symbol') || ''} ${node.getAttribute('data-tradingsymbol') || ''} ${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''}`;
      const texts = [node.getAttribute('data-symbol'), node.getAttribute('data-tradingsymbol'), semantics, node.innerText];
      if (tag === 'input' || tag === 'textarea') continue; // Do not treat search text as the selected instrument.
      for (const text of texts) {
        const result = fromCandidateText(text);
        if (!result) continue;
        let score = result.confidence;
        const combined = `${className} ${semantics}`.toLowerCase();
        if (/selected|active|instrument|scrip|chart-header|symbol-name/.test(combined)) score += 0.05;
        if (/watchlist|search|suggestion|recent-search|history/.test(combined)) score -= 0.16;
        if (node.closest('[aria-selected="true"], [aria-current="true"], .active, .selected')) score += 0.05;
        candidates.push({ ...result, confidence: Math.max(0, Math.min(0.99, score)) });
      }
    }
    candidates.sort((a, b) => b.confidence - a.confidence);
    return candidates[0] || null;
  }

  function currentSegment() {
    const url = location.href.toLowerCase();
    if (url.includes('bse') || url.includes('sensex') || url.includes('bankex')) return 'bse_fo';
    if (url.includes('mcx')) return 'mcx_fo';
    return 'nse_fo';
  }

  function sendSymbol(item, manual = false) {
    if (!item?.symbol) return;
    chrome.runtime.sendMessage({
      type: 'NEO_PIP_SYMBOL', symbol: item.symbol, confidence: manual ? Math.max(item.confidence, 0.7) : item.confidence,
      exchange_segment: currentSegment(), manual
    }, response => {
      if (chrome.runtime.lastError) {
        lastStatus = 'Bridge unavailable — start Neo PIP locally.';
      } else if (response?.ok) {
        lastSent = item.symbol;
        lastStatus = `Sent ${item.symbol} to Neo PIP`;
      } else {
        lastStatus = response?.error || 'Bridge rejected symbol';
      }
      updateChip();
    });
  }

  let host;
  let shadow;
  let chip;
  let statusNode;
  let symbolNode;
  function makeChip() {
    host = document.createElement('div');
    host.id = 'neo-pip-symbol-bridge-host';
    Object.assign(host.style, { position: 'fixed', right: '16px', bottom: '18px', zIndex: '2147483647' });
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `:host{all:initial} .card{font:12px/1.35 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#f8f8f4;color:#171815;border:1px solid #d8d9cf;border-radius:8px;box-shadow:0 8px 30px #0002;padding:9px 10px;width:220px} .top{display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:700;font-size:11px;letter-spacing:.06em}.dot{height:6px;width:6px;background:#90bf28;border-radius:50%;display:inline-block;margin-right:5px}.symbol{font-size:13px;font-weight:650;margin:7px 0 4px;overflow-wrap:anywhere}.status{color:#77796f;font-size:10px;min-height:26px}.btn{width:100%;border:0;border-radius:5px;background:#1b1d17;color:#fff;height:30px;font-size:11px;font-weight:650;cursor:pointer}.btn:disabled{background:#d4d5cc;color:#77796f}.hint{margin-top:6px;font-size:9px;color:#8b8d84}`;
    const card = document.createElement('div'); card.className = 'card';
    const top = document.createElement('div'); top.className = 'top'; top.innerHTML = '<span><i class="dot"></i>NEO PIP BRIDGE</span><span>LOCAL</span>';
    symbolNode = document.createElement('div'); symbolNode.className = 'symbol'; symbolNode.textContent = 'No selected symbol';
    statusNode = document.createElement('div'); statusNode.className = 'status'; statusNode.textContent = lastStatus;
    chip = document.createElement('button'); chip.className = 'btn'; chip.textContent = 'Capture symbol'; chip.disabled = true;
    chip.addEventListener('click', () => { if (currentBest) sendSymbol({ ...currentBest, confidence: Math.max(currentBest.confidence, 0.7) }, true); });
    const hint = document.createElement('div'); hint.className = 'hint'; hint.textContent = 'Verify the ticket symbol and lot size before trading.';
    card.append(top, symbolNode, statusNode, chip, hint); shadow.append(style, card); document.documentElement.appendChild(host);
  }

  function updateChip() {
    if (!host) return;
    symbolNode.textContent = currentBest?.symbol || 'No selected symbol found';
    statusNode.textContent = lastStatus;
    chip.disabled = !currentBest;
    chip.textContent = currentBest ? 'Send symbol to terminal' : 'Waiting for symbol';
  }

  function scan() {
    const best = getBestCandidate();
    // A real selected-instrument change must replace the previous candidate, even if its score differs slightly.
    if (best && (!currentBest || best.symbol === currentBest.symbol || best.confidence >= 0.70)) currentBest = best;
    if (currentBest && currentBest.symbol === candidate) repeated += 1;
    else { candidate = currentBest?.symbol || null; repeated = 1; }
    // Auto-sync only very high-confidence exchange ticker formats, with repeat stability checks.
    if (currentBest && currentBest.confidence >= 0.91 && repeated >= 2 && currentBest.symbol !== lastSent) sendSymbol(currentBest, false);
    if (!currentBest) lastStatus = 'No confident ticker detected. Use Capture when a ticker is visible.';
    else if (currentBest.symbol === lastSent) lastStatus = `Last sent: ${lastSent}`;
    else lastStatus = currentBest.confidence >= 0.91 ? 'Likely ticker detected · auto-sync pending' : 'Possible ticker · capture manually to sync';
    updateChip();
  }

  makeChip();
  scan();
  const observer = new MutationObserver(() => scan());
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'title', 'class', 'data-symbol', 'data-tradingsymbol'] });
  setInterval(scan, 1600);
})();
