"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "app", "static");
const output = path.join(root, "public");
const assets = [
  "index.html",
  "chart.html",
  "research.html",
  "styles.css",
  "app.js",
  "chart.css",
  "chart.js",
  "lightweight-charts.js",
  "trade-sounds.js",
  "viewport-guard.js",
  "chart-indicators.js",
  "chart-drawings.js",
  "tradingview-datafeed.js",
  "research.css",
  "research.js",
  "runtime-config.js",
  "research-underlying-template.csv",
  "research-options-template.csv",
];

fs.rmSync(output, { recursive: true, force: true });
for (const asset of assets) {
  const from = path.join(source, asset);
  if (!fs.statSync(from).isFile()) throw new Error(`Missing Vercel asset: ${asset}`);
  const target = path.join(output, asset.endsWith(".html") ? "" : "static", asset);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(from, target);
}

let backendUrl = "";
if (process.env.NEO_PIP_BACKEND_URL) {
  const backend = new URL(process.env.NEO_PIP_BACKEND_URL);
  if (backend.protocol !== "https:" || backend.pathname !== "/" || backend.search || backend.hash || backend.username || backend.password) {
    throw new Error("NEO_PIP_BACKEND_URL must be an HTTPS origin without credentials, path, query, or fragment.");
  }
  backendUrl = backend.origin;
}
fs.writeFileSync(
  path.join(output, "static", "runtime-config.js"),
  `window.NEO_PIP_CONFIG = Object.freeze(${JSON.stringify({ backendUrl, hosted: true })});\n`,
  "utf8",
);
const connectSources = ["'self'", ...(backendUrl ? [backendUrl] : []), "https://*.tradingview.com", "wss://*.tradingview.com"];
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://s3.tradingview.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  `connect-src ${connectSources.join(" ")}`,
  "frame-src 'self' https://s.tradingview.com https://www.tradingview.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");
for (const filename of ["index.html", "chart.html", "research.html"]) {
  const htmlPath = path.join(output, filename);
  const html = fs.readFileSync(htmlPath, "utf8");
  const meta = `\n  <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">`;
  fs.writeFileSync(htmlPath, html.replace("<head>", `<head>${meta}`), "utf8");
}
process.stdout.write(`Prepared ${assets.length} allowlisted Vercel assets.\n`);
