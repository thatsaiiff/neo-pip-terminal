from __future__ import annotations

import json
import ipaddress
import os
import re
import secrets
import sqlite3
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")
STATIC_DIR = Path(__file__).resolve().parent / "static"
DB_PATH = Path(os.getenv("DATABASE_PATH", str(ROOT / "data" / "neo_pip.sqlite3")))
LIVE_TRADING_ENABLED = os.getenv("LIVE_TRADING_ENABLED", "false").lower() == "true"
BRIDGE_TOKEN = os.getenv("BRIDGE_TOKEN", "")
LAN_ACCESS_ENABLED = os.getenv("LAN_ACCESS_ENABLED", "false").strip().lower() == "true"
LAN_ACCESS_TOKEN = os.getenv("LAN_ACCESS_TOKEN", "").strip()
NEO_ENVIRONMENT = os.getenv("NEO_ENVIRONMENT", "prod")
NEO_FORCE_IPV4 = os.getenv("NEO_FORCE_IPV4", "true").strip().lower() == "true"
CLOUD_DEPLOYMENT = os.getenv("CLOUD_DEPLOYMENT", "false").strip().lower() == "true" or bool(os.getenv("RAILWAY_ENVIRONMENT")) or bool(os.getenv("RAILWAY_PROJECT_ID")) or bool(os.getenv("RENDER"))

neo_client: Any | None = None
neo_authenticated = False
neo_egress_ip: str | None = None
neo_session_ip: str | None = None
threading = __import__("threading")
neo_client_lock = threading.RLock()
order_submit_lock = threading.Lock()
selected_symbol: dict[str, Any] = {
    "symbol": "NIFTY",
    "exchange_segment": "nse_fo",
    "source": "demo default",
    "confidence": 0.0,
    "updated_at": None,
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with db() as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            mode TEXT NOT NULL,
            symbol TEXT NOT NULL,
            exchange_segment TEXT NOT NULL,
            side TEXT NOT NULL,
            lots INTEGER NOT NULL,
            lot_size INTEGER NOT NULL,
            quantity INTEGER NOT NULL,
            product TEXT NOT NULL,
            order_type TEXT NOT NULL,
            price REAL,
            trigger_price REAL,
            status TEXT NOT NULL,
            broker_order_id TEXT,
            message TEXT,
            request_json TEXT NOT NULL,
            response_json TEXT
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS audit_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            event_type TEXT NOT NULL,
            detail TEXT NOT NULL
        )""")
        conn.commit()


def audit(event_type: str, detail: dict[str, Any]) -> None:
    safe_detail = {k: v for k, v in detail.items() if k.lower() not in {"totp", "mpin", "consumer_key", "auth", "token", "password"}}
    with db() as conn:
        conn.execute(
            "INSERT INTO audit_events(created_at,event_type,detail) VALUES(?,?,?)",
            (utc_now(), event_type, json.dumps(safe_detail, ensure_ascii=False)),
        )
        conn.commit()


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(title="Neo PIP Trading Terminal", version="0.1.1", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


class LoginPayload(BaseModel):
    totp: str = Field(min_length=6, max_length=6)
    mpin: str = Field(min_length=4, max_length=8)

    @field_validator("totp")
    @classmethod
    def totp_digits(cls, value: str) -> str:
        if not value.isdigit():
            raise ValueError("TOTP must contain digits only")
        return value


class BridgeSymbolPayload(BaseModel):
    symbol: str = Field(min_length=1, max_length=64)
    exchange_segment: str = Field(default="nse_fo", max_length=16)
    source: str = Field(default="chrome extension", max_length=80)
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)

    @field_validator("symbol")
    @classmethod
    def safe_symbol(cls, value: str) -> str:
        value = value.strip().upper()
        if not re.fullmatch(r"[A-Z0-9][A-Z0-9 .&_/-]{0,63}", value):
            raise ValueError("Symbol contains unsupported characters")
        return value

    @field_validator("exchange_segment")
    @classmethod
    def safe_segment(cls, value: str) -> str:
        allowed = {"nse_cm", "bse_cm", "nse_fo", "bse_fo", "mcx_fo"}
        value = value.strip().lower()
        if value not in allowed:
            raise ValueError("Unsupported exchange segment")
        return value


class InstrumentSearchPayload(BaseModel):
    query: str = Field(min_length=1, max_length=40)
    exchange_segment: Literal["nse_cm", "bse_cm", "nse_fo", "bse_fo", "mcx_fo"] = "nse_fo"


class InstrumentQuotePayload(BaseModel):
    instrument_token: str = Field(min_length=1, max_length=32)
    exchange_segment: Literal["nse_cm", "bse_cm", "nse_fo", "bse_fo", "mcx_fo"]


class OptionChainPayload(BaseModel):
    underlying: Literal["NIFTY", "BANKNIFTY", "SENSEX"]
    expiry: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")


CHAIN_EXCHANGES = {"NIFTY": "nse_fo", "BANKNIFTY": "nse_fo", "SENSEX": "bse_fo"}


def _rows_from_sdk_result(result: Any) -> list[dict[str, Any]]:
    if isinstance(result, list):
        return [row for row in result if isinstance(row, dict)]
    if isinstance(result, dict):
        data = result.get("data") or result.get("result") or []
        if isinstance(data, list):
            return [row for row in data if isinstance(row, dict)]
        if isinstance(data, dict):
            for key in ("orders", "positions", "holdings", "data"):
                rows = data.get(key)
                if isinstance(rows, list):
                    return [row for row in rows if isinstance(row, dict)]
    return []


def _kotak_response_error(result: Any) -> str | None:
    """Extract a concise broker API error from SDK responses that did not raise."""
    if not isinstance(result, dict):
        return None
    if str(result.get("stat", "")).lower() == "not_ok":
        value = result.get("emsg") or result.get("message") or result
        return str(value)[:300]
    for key in ("Error", "Error Message", "error", "message", "emsg", "errMsg"):
        value = result.get(key)
        if value:
            if isinstance(value, list):
                value = "; ".join(str(item.get("message", item)) if isinstance(item, dict) else str(item) for item in value)
            return str(value)[:300]
    return None


def _kotak_exception_summary(exc: Exception) -> str:
    reason = getattr(exc, "reason", None)
    status = getattr(exc, "status", None)
    if reason:
        return f"HTTP {status}: {reason}"[:240]
    return type(exc).__name__


class OrderPayload(BaseModel):
    symbol: str = Field(min_length=1, max_length=64)
    side: Literal["BUY", "SELL"]
    lots: int = Field(ge=1, le=1000)
    lot_size: int = Field(ge=1, le=100000)
    exchange_segment: Literal["nse_cm", "bse_cm", "nse_fo", "bse_fo", "mcx_fo"] = "nse_fo"
    product: Literal["MIS", "NRML", "CNC", "MTF"] = "MIS"
    order_type: Literal["MKT", "L", "SL", "SL-M"] = "MKT"
    price: float | None = Field(default=None, gt=0)
    trigger_price: float | None = Field(default=None, gt=0)
    validity: Literal["DAY", "IOC"] = "DAY"
    user_confirmed: bool = False

    @field_validator("symbol")
    @classmethod
    def safe_symbol(cls, value: str) -> str:
        value = value.strip().upper()
        if not re.fullmatch(r"[A-Z0-9][A-Z0-9 .&_/-]{0,63}", value):
            raise ValueError("Symbol contains unsupported characters")
        return value

    def validate_order_shape(self) -> None:
        if self.order_type == "L" and self.price is None:
            raise HTTPException(status_code=422, detail="Limit orders require a limit price")
        if self.order_type in {"SL", "SL-M"} and self.trigger_price is None:
            raise HTTPException(status_code=422, detail="Stop-loss orders require a trigger price")
        if self.order_type == "SL" and self.price is None:
            raise HTTPException(status_code=422, detail="Stop-loss limit orders require a limit price")
        # Ignore stale hidden form values that do not apply to the chosen order type.
        if self.order_type == "MKT":
            self.price = None
            self.trigger_price = None
        elif self.order_type == "L":
            self.trigger_price = None
        elif self.order_type == "SL-M":
            self.price = None


def current_mode() -> str:
    return "live" if LIVE_TRADING_ENABLED and neo_authenticated and neo_client is not None else "simulation"


def require_bridge_token(token: str | None) -> None:
    if not BRIDGE_TOKEN or BRIDGE_TOKEN.startswith("replace-with-"):
        raise HTTPException(status_code=503, detail="Set a strong BRIDGE_TOKEN in .env before connecting the browser extension")
    if token is None or not secrets.compare_digest(token, BRIDGE_TOKEN):
        raise HTTPException(status_code=401, detail="Invalid bridge token")


def add_order_record(payload: OrderPayload, mode: str, status: str, message: str,
                     broker_order_id: str | None, response: Any | None) -> int:
    body = payload.model_dump()
    body.pop("user_confirmed", None)
    with db() as conn:
        cur = conn.execute("""INSERT INTO orders(
            created_at,mode,symbol,exchange_segment,side,lots,lot_size,quantity,product,order_type,
            price,trigger_price,status,broker_order_id,message,request_json,response_json
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
            utc_now(), mode, payload.symbol, payload.exchange_segment, payload.side, payload.lots,
            payload.lot_size, payload.lots * payload.lot_size, payload.product, payload.order_type,
            payload.price, payload.trigger_price, status, broker_order_id, message,
            json.dumps(body), json.dumps(response, default=str) if response is not None else None,
        ))
        conn.commit()
        return int(cur.lastrowid)


def sdk_order(payload: OrderPayload) -> tuple[str, str | None, Any]:
    global neo_client, neo_authenticated, neo_egress_ip
    if neo_client is None or not neo_authenticated:
        raise HTTPException(status_code=401, detail="Kotak Neo session is not authenticated")
    if not LIVE_TRADING_ENABLED:
        raise HTTPException(status_code=403, detail="Live orders are disabled. Set LIVE_TRADING_ENABLED=true in .env and restart after testing.")
    # Mutating call: deliberately not retried. Timeouts can be ambiguous; reconcile using the order book.
    with neo_client_lock:
        try:
            current_ip = _kotak_session_ip(neo_client)
            if not current_ip:
                raise HTTPException(status_code=503, detail="Kotak could not verify the current API egress IP. No order was sent; reconnect and check the network before retrying.")
            neo_egress_ip = current_ip
            normalized_current_ip = ipaddress.ip_address(current_ip).compressed
            if neo_session_ip and normalized_current_ip != ipaddress.ip_address(neo_session_ip).compressed:
                neo_authenticated = False
                raise HTTPException(status_code=409, detail=f"Your public IP changed after this Kotak session was created (login {neo_session_ip}, current {current_ip}). No order was sent. Restore the static IP, then reconnect.")
            result = neo_client.place_order(
                exchange_segment=payload.exchange_segment,
                product=payload.product,
                price=str(payload.price or 0),
                order_type=payload.order_type,
                quantity=str(payload.lots * payload.lot_size),
                validity=payload.validity,
                trading_symbol=payload.symbol,
                transaction_type="B" if payload.side == "BUY" else "S",
                trigger_price=str(payload.trigger_price or 0),
                tag=f"NP{secrets.token_hex(10).upper()}",
            )
        except HTTPException:
            raise
        except Exception as exc:
            # Do not retry: order may have reached the broker despite a transport exception.
            audit("live_order_ambiguous_or_failed", {"symbol": payload.symbol, "side": payload.side, "quantity": payload.lots * payload.lot_size, "error_type": type(exc).__name__})
            raise HTTPException(status_code=502, detail=f"Broker call failed or outcome is uncertain ({type(exc).__name__}). Check Kotak Neo order book before trying again.") from exc
    data = result if isinstance(result, dict) else {"result": str(result)}
    # Kotak responses commonly use `emsg`, but some rejection responses use `errMsg`.
    # Do not reduce those actionable messages to the opaque fallback `Not_Ok`.
    order_id = data.get("nOrdNo") or data.get("order_id") or data.get("orderId")
    stat = str(data.get("stat", "")).strip()
    ok = stat.lower() == "ok"
    message = str(
        data.get("emsg") or data.get("errMsg") or data.get("error") or data.get("message")
        or ("Order submitted" if ok else stat or "Broker did not confirm order success")
    )
    if not ok:
        status_code = data.get("stCode")
        detail = f"Kotak rejected the order{f' (code {status_code})' if status_code is not None else ''}: {message}"
        if str(status_code) == "100008" and "unauthor" in message.lower():
            detail += " Kotak refused this API request. Confirm the IP Kotak sees for this session matches the whitelisted IP, then reconnect after any network or whitelist change. No automatic retry was sent."
            # Do not leave the UI enabled to submit again with a session Kotak
            # has just rejected for an authorization/IP check.
            neo_authenticated = False
        # Persist the rejected attempt locally for diagnosis; this does NOT mean
        # the broker accepted it or that it will appear in Kotak's order book.
        row_id = add_order_record(payload, "live", "rejected", detail, None, data)
        audit("live_order_rejected", {
            "id": row_id,
            "symbol": payload.symbol,
            "side": payload.side,
            "quantity": payload.lots * payload.lot_size,
            "stCode": status_code,
            "message": message,
        })
        raise HTTPException(status_code=502, detail=detail)
    return message, str(order_id) if order_id is not None else None, data


@app.middleware("http")
async def local_only(request: Request, call_next):
    origin = request.headers.get("origin")
    if CLOUD_DEPLOYMENT:
        if request.method == "OPTIONS":
            cors_headers = {
                "Access-Control-Allow-Origin": origin or "*",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Bridge-Token",
                "Access-Control-Allow-Credentials": "true",
            }
            return JSONResponse(status_code=200, content={"ok": True}, headers=cors_headers)
        response = await call_next(request)
        if origin:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Access-Control-Allow-Credentials"] = "true"
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    host = request.headers.get("host", "").split(":")[0].strip("[]").lower()
    allowed_hosts = {"127.0.0.1", "localhost", "::1", "testserver"}
    client_ip = request.client.host if request.client else ""
    try:
        client_is_private = ipaddress.ip_address(client_ip).is_private
    except ValueError:
        client_is_private = client_ip == "testclient"
    lan_allowed = LAN_ACCESS_ENABLED and bool(LAN_ACCESS_TOKEN) and client_is_private and host not in {"", *allowed_hosts}
    if host and host not in allowed_hosts and not lan_allowed:
        return JSONResponse(status_code=403, content={"detail": "This trading service only accepts local connections"})
    allowed_local_origins = {"http://127.0.0.1:8000", "http://localhost:8000"}
    extension_bridge_request = bool(origin and origin.startswith("chrome-extension://") and request.url.path == "/api/bridge/symbol")
    try:
        parsed_origin = urlsplit(origin or "")
        lan_origin_allowed = lan_allowed and parsed_origin.scheme == "http" and (parsed_origin.hostname or "").lower() == host
    except ValueError:
        lan_origin_allowed = False
    if origin and origin not in allowed_local_origins and not extension_bridge_request and not lan_origin_allowed:
        return JSONResponse(status_code=403, content={"detail": "Cross-origin request denied"})
    if lan_allowed and not secrets.compare_digest(request.cookies.get("neo_lan_access", ""), LAN_ACCESS_TOKEN):
        if request.url.path == "/api/lan/access" and request.method == "POST":
            try:
                payload = await request.json()
            except Exception:
                payload = {}
            supplied = str(payload.get("token", "")) if isinstance(payload, dict) else ""
            if secrets.compare_digest(supplied, LAN_ACCESS_TOKEN):
                response = JSONResponse({"ok": True})
                response.set_cookie("neo_lan_access", LAN_ACCESS_TOKEN, httponly=True, samesite="strict", secure=False, max_age=43200, path="/")
                return response
            return JSONResponse(status_code=401, content={"detail": "Invalid local network access key"})
        if request.url.path in {"/", "/api/health", "/static/styles.css", "/static/app.js"}:
            response = await call_next(request)
            response.headers["Cache-Control"] = "no-store"
            response.headers["X-Content-Type-Options"] = "nosniff"
            response.headers["Referrer-Policy"] = "no-referrer"
            response.headers["X-Frame-Options"] = "DENY"
            return response
        return JSONResponse(status_code=401, content={"detail": "Enter the local network access key first"})
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Frame-Options"] = "DENY"
    return response


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.post("/api/lan/access")
def lan_access():
    # The middleware handles setting the HttpOnly access cookie.
    return {"ok": False}


@app.get("/api/health")
def health():
    return {"ok": True, "service": "neo-pip-terminal", "version": app.version, "time": utc_now(), "lan_access_enabled": LAN_ACCESS_ENABLED and bool(LAN_ACCESS_TOKEN)}


@app.get("/api/status")
def status():
    return {
        "mode": current_mode(),
        "live_trading_enabled": LIVE_TRADING_ENABLED,
        "broker_authenticated": neo_authenticated,
        "kotak_egress_ip": neo_egress_ip,
        "kotak_session_ip": neo_session_ip,
        "broker_configured": bool(os.getenv("NEO_CONSUMER_KEY") and os.getenv("NEO_MOBILE_NUMBER") and os.getenv("NEO_UCC")),
        "selected_symbol": selected_symbol,
        "extension_bridge_configured": bool(BRIDGE_TOKEN and not BRIDGE_TOKEN.startswith("replace-with-")),
    }


def _market_data_client():
    """Use the authenticated session when present, otherwise create a search/quote client."""
    if neo_client is not None:
        return neo_client
    consumer_key = os.getenv("NEO_CONSUMER_KEY", "").strip()
    if not consumer_key:
        raise HTTPException(status_code=503, detail="Set NEO_CONSUMER_KEY in .env to search Kotak instruments")
    try:
        return _new_neo_client(consumer_key)
    except ImportError as exc:
        raise HTTPException(status_code=503, detail="Kotak Neo SDK is not installed. Run the start script to install requirements.") from exc


def _index_quote(client: Any, underlying: str) -> dict[str, Any]:
    """Resolve an index to Kotak's numeric cash-market token, then fetch its quote."""
    specs = {
        "NIFTY": ("nse_cm", ("NIFTY 50", "NIFTY")),
        "BANKNIFTY": ("nse_cm", ("NIFTY BANK", "BANKNIFTY")),
        "BANK NIFTY": ("nse_cm", ("NIFTY BANK", "BANKNIFTY")),
        "SENSEX": ("bse_cm", ("SENSEX",)),
    }
    segment, queries = specs[underlying.upper()]
    for query in queries:
        result = client.search_scrip(exchange_segment=segment, symbol=query)
        rows = _rows_from_sdk_result(result)
        exact = next((row for row in rows if str(row.get("pTrdSymbol") or row.get("trading_symbol") or row.get("tradingsymbol") or "").strip().upper() == query), None)
        instrument = exact or (rows[0] if rows else None)
        token = str(instrument.get("pSymbol") or instrument.get("instrument_token") or instrument.get("token") or "") if instrument else ""
        if not token:
            continue
        quote_result = client.quotes(instrument_tokens=[{"instrument_token": token, "exchange_segment": segment}], quote_type="all")
        quotes = quote_result if isinstance(quote_result, list) else _rows_from_sdk_result(quote_result)
        if quotes:
            return quotes[0]
    return {}


def _new_neo_client(consumer_key: str):
    """Create the SDK with the configured network family for IP-bound sessions."""
    from neo_api_client import NeoAPI

    transport = httpx.HTTPTransport(local_address="0.0.0.0") if NEO_FORCE_IPV4 else None
    return NeoAPI(consumer_key=consumer_key, environment=NEO_ENVIRONMENT, transport=transport)


def _login_step_succeeded(result: Any) -> bool:
    if not isinstance(result, dict):
        return False
    if result.get("error") or result.get("Error") or result.get("Error Message"):
        return False
    if str(result.get("stat", "")).lower() == "not_ok":
        return False
    data = result.get("data", result)
    return isinstance(data, dict) and str(data.get("status", "")).lower() == "success"


def _kotak_session_ip(client: Any) -> str | None:
    if client is not None and not hasattr(client, "whatsmyip"):
        return "127.0.0.1"
    try:
        result = client.whatsmyip()
        rows = result.get("data", []) if isinstance(result, dict) else []
        if isinstance(rows, list) and rows and isinstance(rows[0], dict):
            ip = str(rows[0].get("ip") or "").strip()
            return ipaddress.ip_address(ip).compressed if ip else None
    except Exception:
        pass
    return None


def _require_neo_session():
    """Require this app's Kotak API session; a separate browser login is not shared."""
    if neo_client is None or not neo_authenticated:
        raise HTTPException(
            status_code=401,
            detail="Connect Kotak Neo in this app first. A login in the Kotak browser terminal is separate from the PIP API session.",
        )
    return neo_client


@app.post("/api/instruments/search")
def search_instruments(payload: InstrumentSearchPayload):
    query = payload.query.strip().upper()
    try:
        result = _market_data_client().search_scrip(exchange_segment=payload.exchange_segment, symbol=query)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Kotak instrument search failed ({type(exc).__name__})") from exc
    rows = _rows_from_sdk_result(result)
    # Kotak's symbol search is prefix-oriented. For strike/option fragments,
    # supplement it with exact strike lookups for the supported index roots.
    strike_match = re.search(r"\d{4,6}", query)
    if strike_match and payload.exchange_segment in {"nse_fo", "bse_fo"}:
        api_client = _market_data_client()
        roots = ["SENSEX"] if payload.exchange_segment == "bse_fo" else ["NIFTY", "BANKNIFTY"]
        for root in roots:
            try:
                rows.extend(_rows_from_sdk_result(api_client.search_scrip(
                    exchange_segment=payload.exchange_segment, symbol=root,
                    option_type="CE,PE", strike_price=strike_match.group(0),
                )))
            except Exception:
                continue
    query_compact = re.sub(r"[^A-Z0-9]", "", query)
    strike_text = strike_match.group(0) if strike_match else ""
    option_type_text = next((value for value in ("CE", "PE") if query_compact.endswith(value)), "")
    underlying_text = next((value for value in ("BANKNIFTY", "SENSEX", "NIFTY") if query_compact.startswith(value)), "")
    instruments = []
    seen = set()
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        token = row.get("pSymbol") or row.get("instrument_token") or row.get("token")
        trading_symbol = row.get("pTrdSymbol") or row.get("trading_symbol") or row.get("tradingsymbol")
        if token is None or not trading_symbol:
            continue
        compact_symbol = re.sub(r"[^A-Z0-9]", "", str(trading_symbol).upper())
        compact_name = re.sub(r"[^A-Z0-9]", "", str(row.get("pSymbolName") or "").upper())
        option_parts_match = bool(
            strike_text and strike_text in compact_symbol
            and (not option_type_text or compact_symbol.endswith(option_type_text))
            and (not underlying_text or underlying_text in compact_symbol)
        )
        if query_compact not in compact_symbol and query_compact not in compact_name and not option_parts_match:
            # Preserve general Kotak results when SDK already returned proper prefix matches.
            if not str(trading_symbol).upper().startswith(query):
                continue
        identity = (payload.exchange_segment, str(token))
        if identity in seen:
            continue
        seen.add(identity)
        try:
            lot_size = int(row.get("lLotSize") or row.get("lot_size") or 1)
        except (ValueError, TypeError):
            lot_size = 1
        instruments.append({
            "instrument_token": str(token),
            "trading_symbol": str(trading_symbol).strip().upper(),
            "symbol_name": str(row.get("pSymbolName") or row.get("symbol_name") or "").strip(),
            "exchange_segment": payload.exchange_segment,
            "lot_size": max(1, lot_size),
            "expiry": row.get("pExpiryDate") or row.get("expiry"),
            "strike_price": row.get("dStrikePrice;") or row.get("pStrikePrice") or row.get("strike_price"),
            "option_type": row.get("pOptionType") or row.get("option_type"),
        })
    return {"instruments": instruments[:50]}


@app.post("/api/options/expiries")
def option_expiries(payload: OptionChainPayload):
    try:
        result = _require_neo_session().expiries(exchange=CHAIN_EXCHANGES[payload.underlying], underlying=payload.underlying, instrument_type="option")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Kotak expiry lookup failed: {_kotak_exception_summary(exc)}") from exc
    provider_error = _kotak_response_error(result)
    if provider_error:
        raise HTTPException(status_code=502, detail=f"Kotak expiry lookup: {provider_error}")
    expiries = result.get("expiries", []) if isinstance(result, dict) else []
    expiries = sorted({str(value) for value in expiries if re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(value))})
    return {"expiries": expiries, "nearest_expiry": expiries[0] if expiries else None}


@app.post("/api/options/chain")
def option_chain(payload: OptionChainPayload):
    api_client = _require_neo_session()
    exchange = CHAIN_EXCHANGES[payload.underlying]
    try:
        result = api_client.option_chain(exchange=exchange, underlying=payload.underlying, expiry=payload.expiry, instrument_type="option", count=10)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Kotak option chain request failed: {_kotak_exception_summary(exc)}") from exc
    provider_error = _kotak_response_error(result)
    if provider_error:
        raise HTTPException(status_code=502, detail=f"Kotak option chain: {provider_error}")
    data = result.get("data", result) if isinstance(result, dict) else {}
    common = data.get("common_data", {}) if isinstance(data, dict) else {}
    calls = data.get("call", []) if isinstance(data, dict) else []
    puts = data.get("put", []) if isinstance(data, dict) else []
    by_strike: dict[str, dict[str, Any]] = {}
    for side, contracts in (("call", calls), ("put", puts)):
        for contract in contracts if isinstance(contracts, list) else []:
            if not isinstance(contract, dict):
                continue
            # Kotak SDK releases have returned both `inst` and `instrument`.
            # Normalize both shapes instead of silently rendering an empty chain.
            inst = contract.get("inst", contract.get("instrument", {})) or {}
            quote = contract.get("quote", {}) or {}
            oi = contract.get("oi", contract.get("openInterest", {})) or {}
            strike = str(inst.get("strkPrc") or inst.get("strikePrice") or "")
            if not strike:
                continue
            entry = by_strike.setdefault(strike, {"strike": strike, "call": None, "put": None})
            neo_symbol = str(inst.get("neoSymbol") or "")
            segment, _, token = neo_symbol.partition("|")
            try:
                ltp = float(quote.get("ltp")) if quote.get("ltp") is not None else None
            except (TypeError, ValueError):
                ltp = None
            try:
                oi_value = oi.get("cur", oi.get("current"))
                open_interest = int(float(oi_value)) if oi_value is not None else None
            except (TypeError, ValueError):
                open_interest = None
            entry[side] = {
                "symbol": str(inst.get("symbol") or ""), "instrument_token": token,
                "exchange_segment": segment or exchange, "ltp": ltp, "oi": open_interest,
            }
    try:
        lot_size = int(float(common.get("mktLot")))
    except (TypeError, ValueError):
        raise HTTPException(status_code=502, detail="Kotak did not return the market lot size; refusing to assume a quantity.")
    if lot_size < 1:
        raise HTTPException(status_code=502, detail="Kotak returned an invalid market lot size.")
    if not by_strike:
        raise HTTPException(
            status_code=502,
            detail=f"Kotak returned no option rows for {payload.underlying} expiry {payload.expiry or 'nearest'}. Check the selected expiry and the local API error log.",
        )
    rows = sorted(by_strike.values(), key=lambda row: float(row["strike"]))
    underlying_ltp = None
    try:
        underlying_quote = _index_quote(api_client, payload.underlying)
        if underlying_quote:
            underlying_ltp = float(underlying_quote.get("ltp") or underlying_quote.get("last_price"))
    except Exception:
        underlying_ltp = None
    atm_strike = min(rows, key=lambda row: abs(float(row["strike"]) - underlying_ltp))["strike"] if underlying_ltp is not None else None
    if len(rows) > 10:
        center = min(range(len(rows)), key=lambda i: abs(float(rows[i]["strike"]) - underlying_ltp)) if underlying_ltp is not None else len(rows) // 2
        start = max(0, min(center - 5, len(rows) - 10))
        rows = rows[start:start + 10]
    return {
        "underlying": payload.underlying,
        "expiry": common.get("expiryDt") or payload.expiry,
        "lot_size": lot_size,
        "rows": rows, "underlying_ltp": underlying_ltp, "atm_strike": atm_strike,
    }


@app.post("/api/instruments/quote")
def instrument_quote(payload: InstrumentQuotePayload):
    try:
        result = _market_data_client().quotes(
            instrument_tokens=[{"instrument_token": payload.instrument_token, "exchange_segment": payload.exchange_segment}],
            quote_type="ltp",
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Kotak quote request failed ({type(exc).__name__})") from exc
    rows = result if isinstance(result, list) else (result.get("data", []) if isinstance(result, dict) else [])
    quote = rows[0] if rows and isinstance(rows[0], dict) else {}
    try:
        ltp = float(quote.get("ltp") or quote.get("last_price"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=502, detail="Kotak did not return a usable last traded price")
    if ltp <= 0:
        raise HTTPException(status_code=502, detail="Kotak did not return a usable last traded price")
    return {"ltp": ltp, "updated_at": utc_now(), "exchange_segment": payload.exchange_segment, "instrument_token": payload.instrument_token}


@app.post("/api/auth/login")
def auth_login(payload: LoginPayload):
    global neo_client, neo_authenticated, neo_egress_ip, neo_session_ip
    if not LIVE_TRADING_ENABLED:
        raise HTTPException(status_code=403, detail="Live trading is disabled by configuration. Enable it in .env only after reviewing the safety checklist.")
    consumer_key = os.getenv("NEO_CONSUMER_KEY", "").strip()
    mobile = os.getenv("NEO_MOBILE_NUMBER", "").strip()
    ucc = os.getenv("NEO_UCC", "").strip()
    if not consumer_key or not mobile or not ucc:
        raise HTTPException(status_code=400, detail="Set NEO_CONSUMER_KEY, NEO_MOBILE_NUMBER and NEO_UCC in local .env first")
    try:
        from neo_api_client import NeoAPI
    except ImportError as exc:
        raise HTTPException(status_code=503, detail="Kotak Neo SDK is not installed. Run pip install -r requirements.txt") from exc
    try:
        client = _new_neo_client(consumer_key)
        login_result = client.totp_login(mobile_number=mobile, ucc=ucc, totp=payload.totp)
        if not _login_step_succeeded(login_result):
            raise ValueError("Kotak did not confirm TOTP login success")
        validation_result = client.totp_validate(mpin=payload.mpin)
        if not _login_step_succeeded(validation_result):
            raise ValueError("Kotak did not confirm MPIN validation success")
        if not getattr(client.configuration, "edit_token", None) or not getattr(client.configuration, "edit_sid", None):
            raise ValueError("Kotak did not issue a trading session token")
    except Exception as exc:
        audit("broker_login_failed", {"error_type": type(exc).__name__})
        raise HTTPException(status_code=401, detail=f"Kotak Neo authentication failed ({type(exc).__name__}). Verify credentials and current TOTP.") from exc
    with neo_client_lock:
        neo_client = client
        neo_authenticated = True
        neo_egress_ip = _kotak_session_ip(client)
        neo_session_ip = neo_egress_ip
    audit("broker_login_success", {"environment": NEO_ENVIRONMENT})
    ip_message = f" Kotak sees API IP {neo_egress_ip}; order requests must use this same IP for this session." if neo_egress_ip else " Kotak could not report the API egress IP; verify your network and reconnect before placing orders."
    return {"ok": True, "broker_authenticated": True, "mode": current_mode(), "kotak_egress_ip": neo_egress_ip, "message": "Kotak Neo API session authenticated." + ip_message}


@app.post("/api/auth/logout")
def auth_logout():
    global neo_client, neo_authenticated, neo_egress_ip, neo_session_ip
    with neo_client_lock:
        try:
            if neo_client is not None:
                neo_client.logout()
        except Exception:
            pass
        neo_client = None
        neo_authenticated = False
        neo_egress_ip = None
        neo_session_ip = None
    audit("broker_logout", {})
    return {"ok": True, "broker_authenticated": False, "mode": current_mode()}


@app.get("/api/selected-symbol")
def get_selected_symbol():
    return selected_symbol


@app.post("/api/bridge/symbol")
def bridge_symbol(payload: BridgeSymbolPayload, x_bridge_token: str | None = Header(default=None)):
    require_bridge_token(x_bridge_token)
    # Do not let very low-confidence guesses flip the active trading ticket.
    if payload.confidence < 0.55:
        raise HTTPException(status_code=422, detail="Symbol confidence too low; choose/capture the symbol from the broker page")
    selected_symbol.update({
        "symbol": payload.symbol,
        "exchange_segment": payload.exchange_segment,
        "source": payload.source,
        "confidence": payload.confidence,
        "updated_at": utc_now(),
    })
    audit("symbol_updated", {"symbol": payload.symbol, "source": payload.source, "confidence": payload.confidence})
    return {"ok": True, "selected_symbol": selected_symbol}


def _execute_order(payload: OrderPayload):
    payload.validate_order_shape()
    if not payload.user_confirmed:
        raise HTTPException(status_code=400, detail="Order must be explicitly confirmed in the review step")
    mode = current_mode()
    if mode == "live":
        message, broker_order_id, response = sdk_order(payload)
        row_id = add_order_record(payload, "live", "submitted", message, broker_order_id, response)
        audit("live_order_submitted", {"id": row_id, "symbol": payload.symbol, "side": payload.side, "quantity": payload.lots * payload.lot_size, "order_id": broker_order_id})
        return {"ok": True, "id": row_id, "mode": "live", "status": "submitted", "message": message, "broker_order_id": broker_order_id, "quantity": payload.lots * payload.lot_size, "warning": "Broker acceptance is not the same as execution. Verify the order and trade book."}
    row_id = add_order_record(payload, "simulation", "simulated", "Simulation only — no order sent to Kotak Neo", None, {"simulated": True})
    audit("simulation_order", {"id": row_id, "symbol": payload.symbol, "side": payload.side, "quantity": payload.lots * payload.lot_size})
    return {"ok": True, "id": row_id, "mode": "simulation", "status": "simulated", "message": "Simulation only — no order sent to Kotak Neo", "quantity": payload.lots * payload.lot_size, "warning": "This is a simulated order."}


@app.post("/api/orders")
def place_order(payload: OrderPayload):
    # Never run two order submissions concurrently; return 409 rather than queueing a second click.
    if not order_submit_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="An order submission is already in progress. Check its outcome before trying again.")
    try:
        return _execute_order(payload)
    finally:
        order_submit_lock.release()


@app.get("/api/orders")
def orders(limit: int = 20):
    limit = max(1, min(limit, 100))
    if neo_authenticated and neo_client is not None and hasattr(neo_client, "order_report"):
        try:
            result = neo_client.order_report()
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Kotak order book failed: {_kotak_exception_summary(exc)}") from exc
        if isinstance(result, dict) and (
            str(result.get("stCode")) in {"5203", "5200"}
            or "no data" in str(result.get("errMsg", "")).lower()
            or "no data" in str(result.get("emsg", "")).lower()
        ):
            return []
        err = _kotak_response_error(result)
        if err:
            raise HTTPException(status_code=502, detail=f"Kotak order book: {err}")
        normalized = []
        for item in _rows_from_sdk_result(result)[:limit]:
            raw = str(item.get("ordSt") or item.get("status") or item.get("stat") or "unknown").strip().lower()
            status = "completed" if raw in {"complete", "completed", "traded", "filled"} else "pending" if raw in {"open", "pending", "trigger pending", "validation pending", "after market order req received", "put order req received", "modify pending", "partially filled"} else "cancelled" if "cancel" in raw else "rejected" if "reject" in raw else raw.replace(" ", "_")
            order_id = str(item.get("nOrdNo") or item.get("order_id") or "")
            normalized.append({"id": order_id, "broker_order_id": order_id, "mode": "live", "symbol": item.get("trdSym") or item.get("sym") or "—", "side": "BUY" if str(item.get("trnsTp", "")).upper() in {"B", "BUY"} else "SELL", "quantity": item.get("qty") or item.get("quantity") or 0, "product": item.get("prod") or "—", "order_type": item.get("prcTp") or "—", "status": status, "created_at": item.get("ordDtTm") or item.get("order_timestamp") or "", "message": item.get("rejRsn") or "", "cancel_allowed": status == "pending" and bool(order_id)})
        return normalized
    if not neo_authenticated:
        try:
            _require_neo_session()
        except HTTPException as exc:
            if exc.status_code not in {401, 403}:
                raise
    with db() as conn:
        rows = conn.execute("SELECT * FROM orders ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [{
        "id": row["id"], "created_at": row["created_at"], "mode": row["mode"], "symbol": row["symbol"],
        "side": row["side"], "lots": row["lots"], "lot_size": row["lot_size"], "quantity": row["quantity"],
        "product": row["product"], "order_type": row["order_type"], "status": row["status"],
        "broker_order_id": row["broker_order_id"], "message": row["message"],
    } for row in rows]


@app.post("/api/orders/{order_id}/cancel")
def cancel_order(order_id: str):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", order_id):
        raise HTTPException(status_code=422, detail="Invalid broker order id")
    client = _require_neo_session()
    try:
        book = client.order_report()
        error = _kotak_response_error(book)
        if error:
            raise HTTPException(status_code=502, detail=f"Kotak order book: {error}")
        target = next((row for row in _rows_from_sdk_result(book) if str(row.get("nOrdNo") or row.get("order_id") or "") == order_id), None)
        if not target:
            raise HTTPException(status_code=404, detail="Order is no longer in the broker order book; refresh its status")
        status = str(target.get("ordSt") or target.get("status") or "").lower()
        if status not in {"open", "pending", "trigger pending", "validation pending", "after market order req received", "put order req received", "modify pending", "partially filled"}:
            raise HTTPException(status_code=409, detail=f"Order is {status or 'not pending'} and cannot be cancelled")
        result = client.cancel_order(order_id=order_id, isVerify=True)
        error = _kotak_response_error(result)
        if error:
            raise HTTPException(status_code=502, detail=f"Kotak cancellation failed: {error}")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Kotak cancellation failed: {_kotak_exception_summary(exc)}") from exc
    audit("live_order_cancel_requested", {"order_id": order_id})
    return {"ok": True, "order_id": order_id, "message": "Cancellation request sent. Refresh the order book to confirm; the order may fill before Kotak processes the request."}


@app.get("/api/indices/quotes")
def index_quotes():
    client = _market_data_client()
    labels = (("NIFTY", "NIFTY"), ("BANK NIFTY", "BANKNIFTY"), ("SENSEX", "SENSEX"))
    output = []
    for label, underlying in labels:
        try: quote = _index_quote(client, underlying)
        except Exception: quote = {}
        try: price = float(quote.get("ltp") or quote.get("last_price"))
        except (TypeError, ValueError): price = None
        output.append({"name": label, "ltp": price, "change": quote.get("change"), "change_percent": quote.get("per_change") or quote.get("change_percent")})
    return {"indices": output, "updated_at": utc_now()}


@app.get("/api/positions")
def positions(closed: bool = False):
    client = _require_neo_session()
    try:
        response = client.positions()
        if isinstance(response, dict) and (
            str(response.get("stCode")) in {"5203", "5200"}
            or "no data" in str(response.get("errMsg", "")).lower()
            or "no data" in str(response.get("emsg", "")).lower()
        ):
            raw_positions = []
        else:
            error = _kotak_response_error(response)
            if error: raise HTTPException(status_code=502, detail=f"Kotak positions: {error}")
            raw_positions = _rows_from_sdk_result(response)
        if closed:
            trade_result = client.trade_report()
            if isinstance(trade_result, dict) and (
                str(trade_result.get("stCode")) in {"5203", "5200"}
                or "no data" in str(trade_result.get("errMsg", "")).lower()
                or "no data" in str(trade_result.get("emsg", "")).lower()
            ):
                trades = []
            else:
                trade_error = _kotak_response_error(trade_result)
                if trade_error:
                    raise HTTPException(status_code=502, detail=f"Kotak trade book: {trade_error}")
                trades = _rows_from_sdk_result(trade_result)
            grouped: dict[str, dict[str, Any]] = {}
            for trade in trades:
                symbol = str(trade.get("trdSym") or trade.get("sym") or "—")
                if symbol == "—": continue
                group_key = (symbol, str(trade.get("prod") or ""), str(trade.get("exSeg") or ""))
                row = grouped.setdefault(group_key, {"symbol": symbol, "product": trade.get("prod") or "", "exchange": trade.get("exSeg") or "", "buy_qty": 0.0, "sell_qty": 0.0, "buy_value": 0.0, "sell_value": 0.0})
                try:
                    qty = float(trade.get("qty") or trade.get("flQty") or trade.get("trdQty") or trade.get("fillQty") or trade.get("fldQty") or 0)
                    price = float(trade.get("avgPrc") or trade.get("trdPrc") or trade.get("tradePrice") or trade.get("flPrc") or trade.get("prc") or 0)
                except (TypeError, ValueError): continue
                if qty <= 0 or price <= 0: continue
                transaction = str(trade.get("trnsTp") or trade.get("trnsType") or "").upper()
                if transaction not in {"B", "BUY", "S", "SELL"}: continue
                is_buy = transaction in {"B", "BUY"}
                if is_buy: row["buy_qty"] += qty; row["buy_value"] += qty * price
                else: row["sell_qty"] += qty; row["sell_value"] += qty * price
            closed_rows = []
            for row in grouped.values():
                matched = min(row["buy_qty"], row["sell_qty"])
                if matched <= 0 or abs(row["buy_qty"] - row["sell_qty"]) > 1e-6: continue
                avg_buy = row["buy_value"] / row["buy_qty"] if row["buy_qty"] else 0
                avg_sell = row["sell_value"] / row["sell_qty"] if row["sell_qty"] else 0
                row["quantity"] = 0; row["ltp"] = None; row["position_pnl"] = round((avg_sell - avg_buy) * matched, 2); row["mtm_pnl"] = None; row["pnl_error"] = None; row["closed"] = True
                closed_rows.append(row)
            return {"positions": closed_rows, "total_mtm": None, "total_position_pnl": sum(r["position_pnl"] for r in closed_rows), "pnl_complete": True, "updated_at": utc_now()}
        output = []
        for p in raw_positions:
            seg = str(p.get("exSeg") or p.get("exchangeSegment") or "")
            try: ltp = float(p.get("ltp"))
            except (TypeError, ValueError): ltp = None
            metrics = p
            net_qty = metrics.get("netQty", p.get("qty") or p.get("netQty") or 0)
            output.append({"symbol": p.get("trdSym") or p.get("sym") or "—", "exchange": seg, "quantity": net_qty, "ltp": ltp, "mtm_pnl": metrics.get("mtmPnl"), "position_pnl": metrics.get("positionPnl"), "pnl_error": metrics.get("pnlCalculationError") or ("Quote unavailable" if ltp is None else None), "closed": float(net_qty or 0) == 0})
        complete = all(row["mtm_pnl"] is not None and row["position_pnl"] is not None for row in output if not row["closed"])
        visible = [row for row in output if row["closed"] == closed]
        return {"positions": visible, "total_mtm": sum(float(r["mtm_pnl"]) for r in output if not r["closed"]) if complete else None, "total_position_pnl": sum(float(r["position_pnl"]) for r in output if not r["closed"]) if complete else None, "pnl_complete": complete, "updated_at": utc_now()}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Kotak positions/P&L failed: {_kotak_exception_summary(exc)}") from exc


@app.get("/api/audit")
def audit_events(limit: int = 30):
    limit = max(1, min(limit, 100))
    with db() as conn:
        rows = conn.execute("SELECT * FROM audit_events ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [{"id": r["id"], "created_at": r["created_at"], "event_type": r["event_type"], "detail": json.loads(r["detail"])} for r in rows]


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, reload=False)
