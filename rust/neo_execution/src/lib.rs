use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyAny, PyDict, PyList, PyModule};
use std::collections::HashSet;
use std::fs::File;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone)]
struct DispatchEvent {
    operation: String,
    tag: String,
    status: String,
    recorded_at_ms: u128,
}

#[derive(Default)]
struct RuntimeState {
    in_flight: HashSet<String>,
    recent: Vec<DispatchEvent>,
}

#[pyclass(module = "app.execution._neo_exec")]
struct ExecutionEngine {
    sequence: AtomicU64,
    state: Mutex<RuntimeState>,
}

#[pymethods]
impl ExecutionEngine {
    #[new]
    fn new() -> Self {
        Self {
            sequence: AtomicU64::new(1),
            state: Mutex::new(RuntimeState::default()),
        }
    }

    fn dispatch(
        &self,
        broker: &Bound<'_, PyAny>,
        operation: &str,
        request: &Bound<'_, PyDict>,
    ) -> PyResult<Py<PyAny>> {
        if operation != "place_order" && operation != "cancel_order" {
            return Err(PyValueError::new_err(
                "Rust execution gateway only permits Kotak place_order and cancel_order calls.",
            ));
        }

        let kwargs = request.copy()?;
        if operation == "place_order" {
            validate_order(&kwargs)?;
        } else {
            validate_cancel(&kwargs)?;
        }

        let tag = if operation == "place_order" {
            let tag = make_correlation_tag(&kwargs, self.sequence.fetch_add(1, Ordering::Relaxed));
            kwargs.set_item("tag", &tag)?;
            tag
        } else {
            kwargs
                .get_item("order_id")?
                .and_then(|value| value.extract::<String>().ok())
                .unwrap_or_else(|| "unknown-order".to_string())
        };

        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| PyRuntimeError::new_err("Rust execution state lock is unavailable."))?;
            if !state.in_flight.insert(tag.clone()) {
                return Err(PyValueError::new_err(
                    "A matching Kotak request is already in flight; reconcile its result before retrying.",
                ));
            }
            push_event(&mut state, operation, &tag, "IN_FLIGHT");
        }

        // The broker SDK call is made once. A Python/network exception is treated
        // as ambiguous by the caller and is never retried here.
        let result = broker.call_method(operation, (), Some(&kwargs));
        match result {
            Ok(response) => {
                let status = response_status(&response);
                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| PyRuntimeError::new_err("Rust execution state lock is unavailable."))?;
                state.in_flight.remove(&tag);
                push_event(&mut state, operation, &tag, status);
                Ok(response.unbind())
            }
            Err(error) => {
                if let Ok(mut state) = self.state.lock() {
                    state.in_flight.remove(&tag);
                    push_event(&mut state, operation, &tag, "UNKNOWN");
                }
                Err(error)
            }
        }
    }

    fn status(&self, py: Python<'_>) -> PyResult<Py<PyAny>> {
        let state = self
            .state
            .lock()
            .map_err(|_| PyRuntimeError::new_err("Rust execution state lock is unavailable."))?;
        let result = PyDict::new(py);
        result.set_item("available", true)?;
        result.set_item("runtime", "rust-pyo3")?;
        result.set_item("in_flight", state.in_flight.len())?;
        let recent = PyList::empty(py);
        for event in state.recent.iter().rev() {
            let row = PyDict::new(py);
            row.set_item("operation", &event.operation)?;
            row.set_item("correlation_tag", &event.tag)?;
            row.set_item("status", &event.status)?;
            row.set_item("recorded_at_ms", event.recorded_at_ms)?;
            recent.append(row)?;
        }
        result.set_item("recent_dispatches", recent)?;
        Ok(result.into_any().unbind())
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn push_event(state: &mut RuntimeState, operation: &str, tag: &str, status: &str) {
    state.recent.push(DispatchEvent {
        operation: operation.to_string(),
        tag: tag.to_string(),
        status: status.to_string(),
        recorded_at_ms: now_ms(),
    });
    if state.recent.len() > 100 {
        let excess = state.recent.len() - 100;
        state.recent.drain(0..excess);
    }
}

fn make_correlation_tag(request: &Bound<'_, PyDict>, sequence: u64) -> String {
    let hint = request
        .get_item("tag")
        .ok()
        .flatten()
        .and_then(|value| value.extract::<String>().ok())
        .unwrap_or_default();
    let mut prefix: String = hint
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .take(2)
        .map(|ch| ch.to_ascii_uppercase())
        .collect();
    if prefix.is_empty() {
        prefix.push_str("NP");
    }
    while prefix.len() < 2 {
        prefix.push('N');
    }
    let millis = now_ms() & 0xFFFF_FFFF_FFFF;
    format!("{prefix}{millis:012X}{:08X}", sequence & 0xFFFF_FFFF)
}

fn dict_string(dict: &Bound<'_, PyDict>, key: &str) -> PyResult<String> {
    dict.get_item(key)?
        .ok_or_else(|| PyValueError::new_err(format!("Kotak order is missing {key}.")))?
        .extract::<String>()
        .map_err(|_| PyValueError::new_err(format!("Kotak order field {key} must be text.")))
}

fn validate_order(request: &Bound<'_, PyDict>) -> PyResult<()> {
    let segment = dict_string(request, "exchange_segment")?.to_ascii_lowercase();
    if !["nse_cm", "bse_cm", "nse_fo", "bse_fo", "mcx_fo"].contains(&segment.as_str()) {
        return Err(PyValueError::new_err("Unsupported Kotak exchange segment."));
    }
    let product = dict_string(request, "product")?.to_ascii_uppercase();
    if !["CNC", "NRML", "MIS", "MTF"].contains(&product.as_str()) {
        return Err(PyValueError::new_err("Unsupported Kotak product."));
    }
    let order_type = dict_string(request, "order_type")?.to_ascii_uppercase();
    if !["MKT", "L", "SL", "SL-M"].contains(&order_type.as_str()) {
        return Err(PyValueError::new_err("Unsupported Kotak order type."));
    }
    let validity = dict_string(request, "validity")?.to_ascii_uppercase();
    if !["DAY", "IOC"].contains(&validity.as_str()) {
        return Err(PyValueError::new_err("Unsupported Kotak order validity."));
    }
    let side = dict_string(request, "transaction_type")?.to_ascii_uppercase();
    if !["B", "S", "BUY", "SELL"].contains(&side.as_str()) {
        return Err(PyValueError::new_err("Kotak transaction type must be buy or sell."));
    }
    let symbol = dict_string(request, "trading_symbol")?;
    if symbol.trim().is_empty() {
        return Err(PyValueError::new_err("Kotak trading symbol cannot be empty."));
    }
    let quantity = dict_string(request, "quantity")?
        .parse::<u64>()
        .map_err(|_| PyValueError::new_err("Kotak quantity must be a positive integer."))?;
    if quantity == 0 {
        return Err(PyValueError::new_err("Kotak quantity must be a positive integer."));
    }
    if order_type == "L" || order_type == "SL" {
        require_positive_number(request, "price")?;
    }
    if order_type == "SL" || order_type == "SL-M" {
        require_positive_number(request, "trigger_price")?;
    }
    Ok(())
}

fn require_positive_number(request: &Bound<'_, PyDict>, key: &str) -> PyResult<()> {
    let value = request
        .get_item(key)?
        .ok_or_else(|| PyValueError::new_err(format!("Kotak {key} is required for this order type.")))?;
    let numeric = if let Ok(value) = value.extract::<f64>() {
        value
    } else {
        value
            .extract::<String>()
            .map_err(|_| PyValueError::new_err(format!("Kotak {key} must be numeric.")))?
            .parse::<f64>()
            .map_err(|_| PyValueError::new_err(format!("Kotak {key} must be numeric.")))?
    };
    if !numeric.is_finite() || numeric <= 0.0 {
        return Err(PyValueError::new_err(format!("Kotak {key} must be positive.")));
    }
    Ok(())
}

fn validate_cancel(request: &Bound<'_, PyDict>) -> PyResult<()> {
    let order_id = dict_string(request, "order_id")?;
    if order_id.trim().is_empty() {
        return Err(PyValueError::new_err("Kotak cancel request needs an order id."));
    }
    Ok(())
}

fn response_status(response: &Bound<'_, PyAny>) -> &'static str {
    if let Ok(dict) = response.cast::<PyDict>() {
        if let Ok(Some(stat)) = dict.get_item("stat") {
            if let Ok(status) = stat.extract::<String>() {
                if status.eq_ignore_ascii_case("not_ok") {
                    return "REJECTED";
                }
                if status.eq_ignore_ascii_case("ok") {
                    return "ACCEPTED";
                }
            }
        }
    }
    "RESPONSE_RECEIVED"
}

#[pyfunction]
fn risk_halt_code(
    daily_net_pnl: f64,
    daily_loss_limit: f64,
    drawdown_pct: f64,
    max_drawdown_pct: f64,
    loss_streak: usize,
    max_consecutive_losses: usize,
    unresolved_orders: usize,
    unmarked_positions: usize,
) -> Option<String> {
    calculate_risk_halt_code(
        daily_net_pnl,
        daily_loss_limit,
        drawdown_pct,
        max_drawdown_pct,
        loss_streak,
        max_consecutive_losses,
        unresolved_orders,
        unmarked_positions,
    )
}

#[pyfunction]
fn size_option_position(
    py: Python<'_>,
    initial_capital: f64,
    risk_pct_per_trade: f64,
    entry_price: f64,
    stop_price: f64,
    lot_size: u64,
    max_lots: u64,
) -> PyResult<Py<PyAny>> {
    let sizing = calculate_option_position_size(
        initial_capital,
        risk_pct_per_trade,
        entry_price,
        stop_price,
        lot_size,
        max_lots,
    )
    .ok_or_else(|| PyValueError::new_err("Position size inputs must be finite and positive, with entry above stop."))?;
    let result = PyDict::new(py);
    result.set_item("risk_budget", sizing.0)?;
    result.set_item("risk_per_unit", sizing.1)?;
    result.set_item("risk_per_lot", sizing.1 * lot_size as f64)?;
    result.set_item("lots", sizing.2)?;
    result.set_item("quantity", sizing.2.saturating_mul(lot_size))?;
    result.set_item("risk_cash", sizing.1 * sizing.2.saturating_mul(lot_size) as f64)?;
    result.set_item("allowed", sizing.2 > 0)?;
    Ok(result.into_any().unbind())
}

fn calculate_option_position_size(
    initial_capital: f64,
    risk_pct_per_trade: f64,
    entry_price: f64,
    stop_price: f64,
    lot_size: u64,
    max_lots: u64,
) -> Option<(f64, f64, u64)> {
    if ![
        initial_capital,
        risk_pct_per_trade,
        entry_price,
        stop_price,
    ]
    .iter()
    .all(|value| value.is_finite() && *value > 0.0)
        || entry_price <= stop_price
        || lot_size == 0
        || max_lots == 0
    {
        return None;
    }
    let risk_budget = initial_capital * risk_pct_per_trade / 100.0;
    let risk_per_unit = entry_price - stop_price;
    let risk_per_lot = risk_per_unit * lot_size as f64;
    if !risk_budget.is_finite() || !risk_per_lot.is_finite() || risk_per_lot <= 0.0 {
        return None;
    }
    let risk_lots = (risk_budget / risk_per_lot).floor() as u64;
    Some((risk_budget, risk_per_unit, risk_lots.min(max_lots)))
}

fn calculate_risk_halt_code(
    daily_net_pnl: f64,
    daily_loss_limit: f64,
    drawdown_pct: f64,
    max_drawdown_pct: f64,
    loss_streak: usize,
    max_consecutive_losses: usize,
    unresolved_orders: usize,
    unmarked_positions: usize,
) -> Option<String> {
    if unresolved_orders > 0 {
        Some("ORDER_UNCERTAIN".to_string())
    } else if unmarked_positions > 0 {
        Some("MARKET_DATA".to_string())
    } else if daily_net_pnl <= -daily_loss_limit {
        Some("DAILY_LOSS".to_string())
    } else if drawdown_pct >= max_drawdown_pct {
        Some("MAX_DRAWDOWN".to_string())
    } else if loss_streak >= max_consecutive_losses {
        Some("LOSS_STREAK".to_string())
    } else {
        None
    }
}

#[pyfunction]
fn inspect_market_csv(py: Python<'_>, path: &str, kind: &str) -> PyResult<Py<PyAny>> {
    if kind != "underlying" && kind != "options" {
        return Err(PyValueError::new_err("CSV kind must be underlying or options."));
    }
    let file = File::open(path)
        .map_err(|_| PyValueError::new_err("CSV file could not be opened by the Rust inspector."))?;
    let file_bytes = file.metadata().map(|m| m.len()).unwrap_or_default();
    let mut reader = csv::ReaderBuilder::new().flexible(true).from_reader(file);
    let headers = reader
        .headers()
        .map_err(|_| PyValueError::new_err("CSV header could not be read."))?
        .iter()
        .map(normalize_header)
        .collect::<Vec<_>>();
    let index = |names: &[&str]| headers.iter().position(|header| names.contains(&header.as_str()));
    let time_i = index(&["time", "timestamp", "datetime"])
        .ok_or_else(|| PyValueError::new_err("CSV must contain a time, timestamp, or datetime column."))?;
    let open_i = index(&["open"]).ok_or_else(|| PyValueError::new_err("CSV is missing open."))?;
    let high_i = index(&["high"]).ok_or_else(|| PyValueError::new_err("CSV is missing high."))?;
    let low_i = index(&["low"]).ok_or_else(|| PyValueError::new_err("CSV is missing low."))?;
    let close_i = index(&["close"]).ok_or_else(|| PyValueError::new_err("CSV is missing close."))?;
    let key_i = index(&["instrument_key", "contract_id", "trading_symbol", "symbol"]);
    if kind == "options" {
        for (field, names) in [
            ("instrument key", &["instrument_key", "contract_id", "trading_symbol", "symbol"][..]),
            ("expiry", &["expiry"][..]),
            ("option type", &["option_type", "type"][..]),
            ("strike", &["strike", "strike_price"][..]),
            ("lot size", &["lot_size"][..]),
        ] {
            if index(names).is_none() {
                return Err(PyValueError::new_err(format!("Option CSV is missing {field}.")));
            }
        }
    }

    let mut row_count = 0usize;
    let mut invalid_ohlc = 0usize;
    let mut duplicate_bars = 0usize;
    let mut seen = HashSet::new();
    let mut first_time: Option<String> = None;
    let mut last_time: Option<String> = None;
    for record in reader.records() {
        let record = record.map_err(|_| PyValueError::new_err("CSV contains a malformed row."))?;
        if record.iter().all(|cell| cell.trim().is_empty()) {
            continue;
        }
        row_count += 1;
        let timestamp = record.get(time_i).unwrap_or_default().trim();
        let key = key_i
            .and_then(|i| record.get(i))
            .unwrap_or_default()
            .trim();
        let duplicate_key = format!("{key}\u{1f}{timestamp}");
        if !seen.insert(duplicate_key) {
            duplicate_bars += 1;
        }
        if !timestamp.is_empty() {
            if first_time.as_ref().map_or(true, |old| timestamp < old.as_str()) {
                first_time = Some(timestamp.to_string());
            }
            if last_time.as_ref().map_or(true, |old| timestamp > old.as_str()) {
                last_time = Some(timestamp.to_string());
            }
        }
        let open = parse_number(record.get(open_i));
        let high = parse_number(record.get(high_i));
        let low = parse_number(record.get(low_i));
        let close = parse_number(record.get(close_i));
        let valid = match (open, high, low, close) {
            (Some(o), Some(h), Some(l), Some(c)) => h >= o.max(l).max(c) && l <= o.min(h).min(c),
            _ => false,
        };
        if !valid {
            invalid_ohlc += 1;
        }
    }

    let result = PyDict::new(py);
    result.set_item("kind", kind)?;
    result.set_item("path_name", std::path::Path::new(path).file_name().and_then(|n| n.to_str()).unwrap_or(""))?;
    result.set_item("file_bytes", file_bytes)?;
    result.set_item("headers", headers)?;
    result.set_item("rows", row_count)?;
    result.set_item("invalid_ohlc", invalid_ohlc)?;
    result.set_item("duplicate_bars", duplicate_bars)?;
    result.set_item("valid_rows", row_count.saturating_sub(invalid_ohlc).saturating_sub(duplicate_bars))?;
    result.set_item("first_time", first_time)?;
    result.set_item("last_time", last_time)?;
    Ok(result.into_any().unbind())
}

fn normalize_header(value: &str) -> String {
    value
        .trim()
        .trim_start_matches('\u{feff}')
        .to_ascii_lowercase()
        .replace([' ', '-'], "_")
}

fn parse_number(value: Option<&str>) -> Option<f64> {
    value.and_then(|text| text.trim().parse::<f64>().ok()).filter(|number| number.is_finite())
}

#[pymodule]
fn _neo_exec(module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add_class::<ExecutionEngine>()?;
    module.add_function(wrap_pyfunction!(risk_halt_code, module)?)?;
    module.add_function(wrap_pyfunction!(size_option_position, module)?)?;
    module.add_function(wrap_pyfunction!(inspect_market_csv, module)?)?;
    module.add("RUST_ENGINE_VERSION", env!("CARGO_PKG_VERSION"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{calculate_option_position_size, calculate_risk_halt_code};

    #[test]
    fn risk_halt_priority_favors_unresolved_orders() {
        let code = calculate_risk_halt_code(-200_000.0, 100_000.0, 40.0, 30.0, 3, 3, 1, 1);
        assert_eq!(code.as_deref(), Some("ORDER_UNCERTAIN"));
    }

    #[test]
    fn risk_halt_checks_loss_drawdown_and_streak() {
        assert_eq!(calculate_risk_halt_code(-100.0, 100.0, 0.0, 30.0, 0, 3, 0, 0), Some("DAILY_LOSS".to_string()));
        assert_eq!(calculate_risk_halt_code(0.0, 100.0, 30.0, 30.0, 0, 3, 0, 0), Some("MAX_DRAWDOWN".to_string()));
        assert_eq!(calculate_risk_halt_code(0.0, 100.0, 0.0, 30.0, 3, 3, 0, 0), Some("LOSS_STREAK".to_string()));
        assert_eq!(calculate_risk_halt_code(0.0, 100.0, 0.0, 30.0, 0, 3, 0, 0), None);
    }

    #[test]
    fn position_size_respects_risk_budget_and_lot_cap() {
        assert_eq!(calculate_option_position_size(1_000_000.0, 0.5, 100.0, 90.0, 25, 10), Some((5_000.0, 10.0, 10)));
        assert_eq!(calculate_option_position_size(10_000.0, 0.5, 100.0, 90.0, 25, 10), Some((50.0, 10.0, 0)));
        assert_eq!(calculate_option_position_size(10_000.0, 0.5, 100.0, 100.0, 25, 10), None);
    }
}
