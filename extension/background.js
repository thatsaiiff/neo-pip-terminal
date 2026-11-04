importScripts('bridge-config.js');

const API = 'http://127.0.0.1:8000/api/bridge/symbol';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'NEO_PIP_SYMBOL' || !message.symbol) return false;
  const payload = {
    symbol: String(message.symbol).trim().toUpperCase(),
    exchange_segment: message.exchange_segment || 'nse_fo',
    source: message.manual ? 'chrome extension' : 'chrome extension',
    confidence: Number(message.confidence ?? 0.75)
  };
  fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': self.NEO_PIP_BRIDGE_TOKEN },
    body: JSON.stringify(payload),
    cache: 'no-store'
  }).then(async response => {
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.detail || `Bridge rejected (${response.status})`);
    sendResponse({ ok: true, result });
  }).catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});
