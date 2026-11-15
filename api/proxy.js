const { Readable } = require("node:stream");

const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "authorization",
  "content-type",
  "cookie",
  "x-bridge-token",
  "x-market",
  "x-owner-token",
  "x-request-id",
];

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function trustedFrontendOrigins() {
  const configured = (process.env.NEO_PIP_FRONTEND_ORIGINS || "https://neo-pip-terminal.vercel.app")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const name of ["VERCEL_URL", "VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_BRANCH_URL"]) {
    const host = process.env[name];
    if (host) configured.push(`https://${host}`);
  }
  return new Set(configured);
}

function jsonError(res, status, message) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ detail: message }));
}

module.exports = async function proxyApi(req, res) {
  const backendSetting = process.env.NEO_PIP_BACKEND_URL || "";
  let backend;
  try {
    backend = new URL(backendSetting);
  } catch (_) {
    jsonError(res, 503, "The secure Oracle backend URL is not configured on Vercel.");
    return;
  }

  if (backend.protocol !== "https:" || backend.pathname !== "/" || backend.search || backend.hash) {
    jsonError(res, 503, "NEO_PIP_BACKEND_URL must be an HTTPS origin without a path.");
    return;
  }

  const origin = req.headers.origin;
  const allowedOrigins = trustedFrontendOrigins();
  if (origin && !allowedOrigins.has(origin)) {
    jsonError(res, 403, "This frontend origin is not allowed.");
    return;
  }
  if (!origin && req.headers["sec-fetch-site"] === "cross-site") {
    jsonError(res, 403, "Cross-site API requests are not allowed.");
    return;
  }

  const incomingUrl = new URL(req.url || "/", `https://${req.headers.host || "neo-pip-terminal.vercel.app"}`);
  const requestPath = incomingUrl.searchParams.get("__neo_api_path") || incomingUrl.pathname;
  const pathSegments = requestPath.split("/");
  if (
    !requestPath.startsWith("/api/") ||
    pathSegments.some((segment) => segment === "." || segment === "..") ||
    /[?#\\]|%2f|%5c|%2e/i.test(requestPath)
  ) {
    jsonError(res, 404, "API route not found.");
    return;
  }

  const upstreamUrl = new URL(requestPath, backend);
  incomingUrl.searchParams.delete("__neo_api_path");
  upstreamUrl.search = incomingUrl.searchParams.toString();
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === "string" && value.length) headers.set(name, value);
  }
  if (origin) headers.set("origin", origin);
  headers.set("x-forwarded-proto", "https");
  headers.set("x-forwarded-host", req.headers.host || "neo-pip-terminal.vercel.app");

  const method = String(req.method || "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  try {
    const upstream = await fetch(upstreamUrl, {
      method,
      headers,
      body: hasBody ? req : undefined,
      ...(hasBody ? { duplex: "half" } : {}),
      redirect: "manual",
    });

    res.statusCode = upstream.status;
    res.setHeader("Cache-Control", "no-store");
    for (const [name, value] of upstream.headers) {
      if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && name.toLowerCase() !== "set-cookie") {
        res.setHeader(name, value);
      }
    }
    const cookies = upstream.headers.getSetCookie?.();
    if (cookies?.length) res.setHeader("Set-Cookie", cookies);

    if (!upstream.body || method === "HEAD") {
      res.end();
      return;
    }
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) {
    console.error("Oracle API proxy failed", error?.name || "Error");
    if (!res.headersSent) jsonError(res, 502, "The secure Oracle backend could not be reached.");
    else res.destroy(error);
  }
};

module.exports.config = { api: { bodyParser: false } };
